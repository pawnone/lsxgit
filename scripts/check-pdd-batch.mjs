// Native multi-file selection and interleaved video/form work, with all merchant
// requests intercepted locally. No account, real materials or draft is touched.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {BrowserManager} from '../desktop/browser-manager.mjs';
import {png} from '../test/pdd-fixtures.mjs';
import {PddDriver} from '../engine/pdd/dom-driver.mjs';
import {executionHash} from '../engine/pdd/frozen-input.mjs';
import {fillEntry} from '../engine/pdd/category-entry.mjs';
import {stageMainUploadSlots} from '../engine/pdd/upload-slots.mjs';
import {cycleImages} from '../engine/pdd/image-order.mjs';
import {detailImagePlan,uploadMediaPlan} from '../engine/pdd/media.mjs';
import {beginCompleteMedia,verifyMediaReceipts} from '../engine/pdd/full-media.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-pdd-batch-')),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const checks=[];let browser;
try{
  await fs.mkdir(path.join(root,'主图'));await fs.mkdir(path.join(root,'商品信息'));
  const sources=[];for(let i=0;i<6;i++){
    const file=path.join(root,'主图',String(i+1).padStart(2,'0')+'.png');sources.push(file);
    await fs.writeFile(file,png(512,512,[20+i*35,40+i*15,60+i*10]));
  }
  const size=path.join(root,'size.png'),video=path.join(root,'video.mp4');
  await fs.writeFile(size,png(512,768,[240,240,240]));await fs.writeFile(video,'synthetic-video');
  await fs.writeFile(path.join(root,'商品信息','fixture.xlsx'),'fixture');
  const inputFiles=[...sources,size,video],records=[];
  for(const file of inputFiles){const bytes=await fs.readFile(file);records.push({file:path.relative(root,file),sha256:sha(bytes),bytes:bytes.length});}
  const config={platform:'pdd',draftOnly:true,materialRoot:root,product:{id:'fixture',title:'批量上传合成商品',
    mainImages:cycleImages(sources,sources[2],10),sourceMainImages:sources,imageOrder:{firstRef:'03',first:sources[2]},sizeImage:size,detailImages:[],materialTagImages:[],video},skuMatrix:[],
    input:{inputHash:'b'.repeat(64),infoFile:'fixture.xlsx',workbookSha256:sha('fixture'),files:records,imageInfo:[]}};
  const validation={ok:true,errors:[],inputHash:config.input.inputHash,executionHash:executionHash(config)};
  const details=detailImagePlan(config.product),bytesBySlot=new Map();
  for(const [kind,list]of [['main',config.product.mainImages],['details',details]])for(const [i,f]of list.entries())bytesBySlot.set(kind+'/'+String(i+1).padStart(2,'0')+'.png',await fs.readFile(f));
  const executablePath=await new BrowserManager({executable:process.env.WQ_TEST_CHROME}).detectExecutable();
  browser=await chromium.launch({executablePath,headless:true});
  const context=await browser.newContext();
  await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:'<html></html>'});
    const key=url.pathname.replace('/mms-goods-image/test/','');
    return route.fulfill({contentType:'image/png',body:bytesBySlot.get(key)||png(512,512,[30,30,30]),headers:{'access-control-allow-origin':'*'}});
  });
  const page=await context.newPage(),events=[];
  const driver=new PddDriver({page,expectedShop:'本地批量测试店',onEvent:e=>events.push(e)});
  const head='<div class="user-name-name"><span class="user-name-text">本地批量测试店</span></div>';
  const title=value=>'<div data-testid="beast-core-form-item"><label class="Form_itemLabelContent_test">商品标题</label><input placeholder="商品标题组成：商品" type="text" value="'+value+'"></div>';
  await page.goto('https://mms.pinduoduo.com/goods/category');
  await page.setContent(head+'<form>'+title('')+'<span id="counter">(0/10)</span><input multiple type="file" data-tracking-click-viewid="local_upload"><div id="main"></div><button id="bottomSubmitBtnId">下一步</button></form>'+`<script>
    window.mainCalls=0;document.querySelector('input[type=file]').addEventListener('change',e=>{
      window.mainCalls++;window.mainFiles=[...e.target.files].map(f=>f.name);
      for(const f of e.target.files){const el=document.createElement('div');el.className='MaterialModalButton_v2_imageBox_test';el.style='width:24px;height:24px;background-image:url(https://img.pddpic.com/mms-goods-image/test/main/'+f.name+')';document.querySelector('#main').append(el);}
      document.querySelector('#counter').textContent='('+e.target.files.length+'/10)';
    });</script>`);
  const slots=await stageMainUploadSlots(config,path.join(root,'main-cache'));
  const entry=await fillEntry(driver,config,{validation,uploadFiles:slots});
  assert.equal(await page.evaluate(()=>window.mainCalls),1);assert.equal(entry.imageOrder.length,10);checks.push('6张不重复原图一次选择10个主图槽位，所选03为第一张，逐位置内容通过');
  assert.equal(details.length,17);assert.equal(details[0],size);assert.equal(details[1],sources[2]);checks.push('无详情文件夹也生成17张，尺码图仅首位一次，第二张共用03');
  const editor=(mode='normal')=>head+'<form>'+title(config.product.title)+
    '<input id="form-field" type="text"><div class="quick_decoration_v2_sortableWrapper_test"><p id="detail-counter">已上传0/50张</p><button type="button" id="detail-upload">本地上传<input type="file" multiple data-tracking-click-viewid="detail_img_localfile_upload"></button><div id="detail-previews"></div></div>'+
    '<div id="basic.carousel_video"><input type="file" data-tracking-click-viewid="merchandise_video_localfile_upload"><div class="video-cards"></div><span id="video-status"></span></div></form>'+`<script>
    window.detailCalls=0;window.detailBatches=[];window.detailFiles=[];window.videoCalls=0;window.formDuringUpload=false;window.uploadButtonClicked=false;
    document.querySelector('#detail-upload').addEventListener('click',()=>{window.uploadButtonClicked=true;});
    window.onDetails=e=>{
      ${mode==='requires-click'?'if(!window.uploadButtonClicked)return;':''}
      window.videoCompleteAtDetails=document.querySelector('#video-status').textContent!=='上传中';
      window.detailCalls++;window.detailBatches.push([...e.target.files].map(f=>f.name));window.detailFiles.push(...[...e.target.files].map(f=>f.name));
      const selected=[...e.target.files];${mode==='reversed'?'selected.reverse();':''}
      // Complete server previews in reverse time order but retain reserved slots.
      for(const [i,file]of selected.entries()){
        const image=document.createElement('img');image.setAttribute('data-tracking-click-viewid','el_preview_business_details');document.querySelector('#detail-previews').append(image);
        setTimeout(()=>{image.src='https://img.pddpic.com/mms-goods-image/test/details/'+file.name;},(selected.length-i)*8);
      }document.querySelector('#detail-counter').textContent='已上传'+window.detailFiles.length+'/50张';
      ${mode==='failure'?"const error=document.createElement('div');error.textContent='上传失败：图片服务暂不可用';document.querySelector('.quick_decoration_v2_sortableWrapper_test').append(error);":''}
      ${mode==='rerender'?"const old=e.target;setTimeout(()=>{const fresh=old.cloneNode();fresh.addEventListener('change',window.onDetails);old.replaceWith(fresh);},100);":''}
      ${mode==='transient'?"const error=document.createElement('div');error.textContent='上传失败';document.querySelector('.quick_decoration_v2_sortableWrapper_test').append(error);setTimeout(()=>error.remove(),1200);":''}
    };document.querySelector('input[data-tracking-click-viewid="detail_img_localfile_upload"]').addEventListener('change',window.onDetails);
    document.querySelector('input[data-tracking-click-viewid="merchandise_video_localfile_upload"]').addEventListener('change',()=>{
      window.videoCalls++;document.querySelector('#video-status').textContent='上传中';
      setTimeout(()=>{document.querySelector('#video-status').textContent='';const image=document.createElement('img');image.className='card-img';image.src='https://img.pddpic.com/mms-goods-image/test/cover.png';document.querySelector('.video-cards').append(image);},1800);
    });
    document.querySelector('#form-field').addEventListener('input',()=>{window.formDuringUpload=document.querySelector('#video-status').textContent==='上传中';});
    </script>`;
  await page.goto('https://mms.pinduoduo.com/goods/goods_add/index?id=123&goods_id=456&type=edit');
  await page.setContent(editor());
  const session=await beginCompleteMedia(driver,config,validation,path.join(root,'receipts'));
  let receipts;
  try{
    await session.startVideo();
    const pendingNames=await fs.readdir(path.join(root,'receipts'));assert.equal(pendingNames.length,1);
    const receiptDir=path.join(root,'receipts',pendingNames[0]),videoReceipt=(await fs.readdir(receiptDir)).find(f=>/^[a-f0-9]{64}\.json$/.test(f));
    assert.equal(JSON.parse(await fs.readFile(path.join(receiptDir,videoReceipt),'utf8')).status,'pending');checks.push('视频开始填表前已保存待确认意图，崩溃也不会丢失上传状态');
    await driver.fill('#form-field','视频上传时填写');
    assert.equal(await page.evaluate(()=>window.formDuringUpload),true);checks.push('视频只提交一次，尚未完成时已开始填写表单');
    receipts=await session.finish();
    assert.equal(await page.evaluate(()=>window.detailCalls),4);assert.deepEqual(await page.evaluate(()=>window.detailBatches.map(b=>b.length)),[5,5,5,2]);assert.equal(await page.evaluate(()=>window.videoCalls),1);
    assert.equal(await page.evaluate(()=>window.videoCompleteAtDetails),true);checks.push('视频与填表重叠，详情开始前视频已完成，两个上传区不再重叠');
    assert.equal(receipts.find(r=>r.key==='details').imageOrder.length,17);assert.deepEqual(receipts.find(r=>r.key==='details').imageOrder.map(r=>r.slot),Array.from({length:17},(_,i)=>i+1));checks.push('17张详情按5+5+5+2批量选择，每批核对累计前缀，尺码首位一次，顺序正确');
    await verifyMediaReceipts(driver,receipts,{config,validation});checks.push('视频和详情全部完成后才取得完整确认回执');
  }finally{await session.close();}
  assert.equal(driver.guardChecks.size,0);checks.push('成功后移除上传观察器与运行锁');
  await page.setContent(editor('requires-click'));
  await page.locator('#detail-upload input').setInputFiles([sources[0]]);
  assert.equal(await page.evaluate(()=>window.detailCalls),0);checks.push('复现控件只接收文件但未点击本地上传时，详情保持0张');
  await page.setContent(editor('requires-click'));
  const css=s=>s.replace(/^loc=css:/,'');let chooserCalls=0;
  const egoPage={evaluate:(...a)=>page.evaluate(...a),url:()=>page.url(),
    hover:(s,o)=>page.locator(css(s)).hover(o),click:(s,o)=>page.locator(css(s)).click(o),
    waitForFunction:(...a)=>page.waitForFunction(...a),
    waitForFileChooser:async o=>{chooserCalls++;const chooser=await page.waitForEvent('filechooser',o);return{setFiles:f=>chooser.setFiles(f)};},
    setInputFiles:()=>assert.fail('详情必须通过本地上传按钮和文件选择器')};
  const egoDriver=new PddDriver({page:egoPage,kind:'ego',expectedShop:'本地批量测试店',onEvent:e=>events.push(e)});
  let nativeReceipt;
  const native=await uploadMediaPlan(egoDriver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async r=>{nativeReceipt=r;}});
  assert.equal(chooserCalls,4);assert.equal(await page.evaluate(()=>window.detailCalls),4);assert.equal(native.selection.count,2);assert.equal(native.imageOrder.length,17);assert(native.selection.images.every(v=>v.width>0&&v.height>0));assert(native.uploadFiles.every(f=>f.bytes>0&&f.pathLength>0));
  checks.push('Ego接口经4次真实文件选择器完成17张，每次不超过5张，记录浏览器字节和尺寸，全部内容通过');
  await page.setContent(editor('rerender'));
  const rerender=await uploadMediaPlan(egoDriver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async()=>{}});
  assert.equal(rerender.urls.length,17);assert.equal(await page.evaluate(()=>window.detailCalls),4);
  checks.push('每批完成后原input被替换，后续批次重新定位同一详情区仍完成17张');
  await page.setContent(editor());
  const realSetFiles=driver.setFiles.bind(driver);let unreadable;
  driver.setFiles=async(selector,files)=>page.locator(selector).setInputFiles(files.map(f=>({name:path.basename(f),mimeType:'image/png',buffer:Buffer.alloc(0)})));
  try{await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async r=>{unreadable=r;}}),/浏览器读取上传图片失败/);}
  finally{driver.setFiles=realSetFiles;}
  assert.equal(unreadable.status,'pending');assert.equal(unreadable.selection.files[0].bytes,0);assert(unreadable.uploadFiles[0].bytes>0);assert.equal(await page.evaluate(()=>window.detailCalls),1);
  checks.push('模拟浏览器只收到文件名却无法读取图片，立即报具体解码错误、保留字节对照、不再上传后续批次');
  await page.setContent(editor());
  let altered;
  driver.setFiles=async(selector,files)=>page.locator(selector).setInputFiles(await Promise.all(files.map(async f=>({name:path.basename(f),mimeType:'image/png',buffer:Buffer.concat([await fs.readFile(f),Buffer.from('extra')])}))));
  try{await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async r=>{altered=r;}}),/浏览器读取结果不一致/);}
  finally{driver.setFiles=realSetFiles;}
  assert.equal(altered.status,'pending');assert(altered.selectionError.includes('字节'));assert.equal(await page.evaluate(()=>window.detailCalls),1);
  checks.push('浏览器文件尺寸可解码但字节数与冻结副本不符时停止，不能只凭文件名放行');
  await page.setContent(editor());
  await page.evaluate(()=>document.addEventListener('change',e=>e.stopImmediatePropagation(),true));
  await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async r=>{nativeReceipt=r;}}),/未能确认本次文件选择事件/);
  assert.equal(nativeReceipt.status,'pending');assert(nativeReceipt.selectionError);assert.equal(await page.evaluate(()=>window.detailCalls),0);
  checks.push('未收到本次原生选择事件时停止并保留pending，不空等120秒或自动重传');
  await page.setContent(editor());
  let partial;
  await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async r=>{
    partial=r;if(r.status==='confirmed'&&r.identity.files.length===5)throw Error('simulated stop after first confirmed batch');
  }}),/simulated stop/);
  assert.equal(partial.status,'confirmed');assert.equal(await page.evaluate(()=>window.detailCalls),1);
  const resumed=await uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},receipt:partial,persist:async()=>{}});
  assert.equal(resumed.urls.length,17);assert.equal(resumed.imageOrder.length,17);assert.equal(await page.evaluate(()=>window.detailCalls),4);
  assert.deepEqual(await page.evaluate(()=>window.detailFiles),Array.from({length:17},(_,i)=>String(i+1).padStart(2,'0')+'.png'));
  checks.push('只有明确confirmed的5张前缀才允许追加，后续不再选择尺码图或重复首批文件');
  await page.setContent(editor());
  let secondFailure;
  driver.setFiles=async(selector,files)=>{
    if(await page.evaluate(()=>window.detailCalls)===1)await page.evaluate(()=>{
      const error=document.createElement('p');error.textContent='尺寸错误：高度不符合要求';document.querySelector('.quick_decoration_v2_sortableWrapper_test').append(error);
    });
    return realSetFiles(selector,files);
  };
  try{await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async r=>{secondFailure=r;}}),/尺寸错误：高度不符合要求/);}
  finally{driver.setFiles=realSetFiles;}
  assert.equal(secondFailure.status,'pending');assert.equal(secondFailure.identity.files.length,10);assert.equal(secondFailure.previous.status,'confirmed');assert.equal(secondFailure.previous.identity.files.length,5);
  assert.equal(await page.evaluate(()=>window.detailCalls),2);
  await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},receipt:secondFailure,persist:async()=>{}}),/未确认/);
  assert.equal(await page.evaluate(()=>window.detailCalls),2);
  checks.push('第二批出现具体尺寸错误立即停止，首批回执保留，后两批不上传，未知第二批不可自动重传');
  await page.setContent(editor('reversed'));
  let pending;
  await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async r=>{pending=r;}}),/内容或顺序不符/);
  assert.equal(pending.status,'pending');assert.equal(await page.evaluate(()=>window.detailCalls),1);checks.push('实际首图错位被内容检查识别，保留待核实回执且不重传');
  await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},receipt:pending,persist:async()=>{}}),/未确认/);checks.push('未知批量结果不能自动重放');
  await page.setContent(editor('failure'));
  let failedUpload;
  await assert.rejects(uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async r=>{failedUpload=r;}}),/详情图上传失败：上传失败：图片服务暂不可用/);
  assert.equal(failedUpload.status,'pending');assert.equal(failedUpload.failure.state.errorText,'上传失败：图片服务暂不可用');
  assert.equal(await page.evaluate(()=>window.detailCalls),1);checks.push('真实上传错误保留具体平台提示和当时状态，保持pending且不重传');
  await page.setContent(editor('transient'));
  const transient=await uploadMediaPlan(driver,{config,validation,plan:{key:'details',kind:'details',files:details},persist:async()=>{}});
  assert.equal(transient.status,'confirmed');assert.equal(transient.uploadObservations.length,4);assert.equal(transient.imageOrder.length,17);
  assert.equal(await page.evaluate(()=>window.detailCalls),4);checks.push('每批处理中短暂失败提示清除后，只核对原批次内容，不重传、不提前确认');
  await page.setContent(editor());
  const failed=await beginCompleteMedia(driver,config,validation,path.join(root,'failed-receipts'));
  try{
    await failed.startVideo();
    await page.evaluate(()=>{const e=document.createElement('div');e.className='video-card-error';e.textContent='视频上传失败';document.querySelector('.video-cards').append(e);});
    await assert.rejects(driver.fill('#form-field','不能填写'),/上传失败/);
    assert.equal(await page.locator('#form-field').inputValue(),'');checks.push('填表前发现视频失败立即停止，不继续输入或重复上传');
  }finally{await failed.close();}
  assert.equal(driver.guardChecks.size,0);
  // Three style regions must all receive their native selection before the
  // shared wait. Each pending receipt still binds its own style and source.
  const styleNames=['上衣','裤子','上衣+裤子'];
  const styleConfig={...config,product:{...config.product,video:null,mainImageMap:Object.fromEntries(sources.map((f,i)=>[String(i+1).padStart(2,'0'),f]))},skuMatrix:styleNames.map((style,i)=>({style,styleNote:'',size:'S',sizeNote:'',image:String(i+1).padStart(2,'0'),stock:10,groupPriceCents:9990,singlePriceCents:15990,code:'STYLE-'+i,state:'启用'}))};
  const styleValidation={...validation,executionHash:executionHash(styleConfig)};
  for(let i=0;i<3;i++)bytesBySlot.set('styles/'+i+'.png',await fs.readFile(sources[i]));
  const styleEditor=async(failure=false)=>{
    await page.setContent(editor());
    await page.evaluate(({names,failure})=>{
      const spec=document.createElement('div');spec.id='newSpec';window.styleCalls=[];
      const table=document.createElement('div');table.className='TB_innerMiddle_test';table.innerHTML='<table><thead><tr>'+['颜色分类','尺码','库存','拼单价(元)','单买价(元)','预览图','规格编码','状态'].map(t=>'<th>'+t+'</th>').join('')+'</tr></thead></table><table><tbody></tbody></table>';
      for(const [i,name]of names.entries()){
        const card=document.createElement('div');card.className='new-spec-single-color';card.innerHTML='<input placeholder="选择或输入主色"><input placeholder="备注"><input type="file">';card.querySelector('input').value=name;spec.append(card);
        const row=document.createElement('tr');row.dataset.testid='beast-core-table-body-tr';row.innerHTML='<td><span class="sku-row-title">'+name+'</span></td><td><span class="sku-row-title">S</span></td><td><input type="text" value="10"></td><td><input type="text" value="99.9"></td><td><input type="text" value="159.9"></td><td class="sku-preview-cell"><div class="MaterialModalButton_imgContainer_test"></div></td><td><input type="text" value="STYLE-'+i+'"></td><td><div class="sku-status-word">已启用</div><div data-testid="beast-core-switch"></div></td>';table.querySelector('tbody').append(row);
        card.querySelector('input[type="file"]').onchange=()=>{
          window.styleCalls.push(name);
          if(failure){const error=document.createElement('span');error.textContent='尺寸不符合';card.append(error);return;}
          const waiting=document.createElement('span');waiting.textContent='上传中';card.append(waiting);
          setTimeout(()=>{waiting.remove();const preview=document.createElement('div');preview.className='MaterialModalButton_imgContainer_test';preview.style.backgroundImage='url(https://img.pddpic.com/mms-goods-image/test/styles/'+i+'.png)';card.append(preview);row.querySelector('.sku-preview-cell div').style.backgroundImage=preview.style.backgroundImage;},700);
        };
      }
      document.querySelector('form').append(spec,table);
    },{names:styleNames,failure});
  };
  await styleEditor();const eventStart=events.length;
  const styleSession=await beginCompleteMedia(driver,styleConfig,styleValidation,path.join(root,'style-receipts'));
  try{
    const styleReceipts=await styleSession.finish();assert.equal(styleReceipts.filter(r=>r.key.startsWith('style:')).length,3);
    assert.deepEqual(await page.evaluate(()=>window.styleCalls),styleNames);
    const steps=events.slice(eventStart).filter(e=>e.type==='step-start').map(e=>e.name),shared=steps.indexOf('统一等待并核对3款式图');
    for(const name of styleNames)assert(steps.indexOf('启动款式图上传：'+name)<shared);
    assert(shared>=0);checks.push('三款图片先依次提交，后台处理重叠；最后统一等待，三份内容回执及SKU预览分别核对');
  }finally{await styleSession.close();}
  assert.equal(driver.guardChecks.size,0);
  await styleEditor(true);const brokenStyles=await beginCompleteMedia(driver,styleConfig,styleValidation,path.join(root,'broken-style-receipts'));
  try{await assert.rejects(brokenStyles.finish(),/款式图上传失败.*尺寸不符合/);assert.deepEqual(await page.evaluate(()=>window.styleCalls),[styleNames[0]]);}
  finally{await brokenStyles.close();}
  assert.equal(driver.guardChecks.size,0);checks.push('款式上传明确失败会在下次操作前停止，清除观察器与锁，原提交不重传');
  await page.setContent(editor());
  const noVideo={...config,product:{...config.product,video:null}},noVideoValidation={...validation,executionHash:executionHash(noVideo)};
  const optional=await beginCompleteMedia(driver,noVideo,noVideoValidation,path.join(root,'optional-receipts'));
  try{
    await optional.startVideo();assert.equal(driver.guardChecks.size,0);await driver.fill('#form-field','无视频也可填写');
    const confirmed=await optional.finish();assert.equal(confirmed.length,1);assert.equal(await page.evaluate(()=>window.videoCalls),0);checks.push('无视频时直接跳过，表单与批量详情仍正常完成');
  }finally{await optional.close();}
  assert.equal((await fs.readdir(path.join(root,'主图'))).length,6);
  for(const record of records)assert.equal(sha(await fs.readFile(path.join(root,record.file))),record.sha256);
  checks.push('仅6张不重复主图，无详情目录，所有原素材字节与文件名不变');
  assert.equal(context.pages().length,1);checks.push('整个检查只复用一个工作页');
  const result={checks:checks.length,names:checks,merchantMutation:false};
  const audit=process.env.WQ_AUDIT_DIR||'output/pdd-045-audit';await fs.mkdir(audit,{recursive:true});
  await fs.writeFile(path.join(audit,'batch-test.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(browser)await browser.close();await fs.rm(root,{recursive:true,force:true});}
