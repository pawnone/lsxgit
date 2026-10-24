import fs from 'node:fs/promises';
import path from 'node:path';
import {PddDriver} from './dom-driver.mjs';
import {assertFrozenFiles,executionHash} from './frozen-input.mjs';
import {fillEntry,requestCategory,openSelectedCategory} from './category-entry.mjs';
import {fillAttributes,verifyAttributes,verifySpecifications} from './form-contract.mjs';
import {createSpecifications,disablePlatformSizeChart} from './specs.mjs';
import {fillPricing} from './pricing.mjs';
import {beginCompleteMedia,verifyMediaReceipts} from './full-media.mjs';
import {configureServices,assertServiceRange} from './service-contract.mjs';
import {saveTransaction} from './save-transaction.mjs';
import {draftSaveNoticeDom} from './save-notice.mjs';
import {stageMainUploadSlots} from './upload-slots.mjs';

const readJson=file=>fs.readFile(file,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
// Task attempts remain independent, while the shop owns a single working tab.
// Explicit recreation preserves the old evidence before navigating that tab.
export async function prepareEgoPage(task,{prior,outputDir,attemptId,batchId,recreate=false}){
  const unsaved=prior?.phase==='failed'&&prior.safeToContinue===true&&batchId&&prior.batchId===batchId;
  if(prior&&prior.phase!=='confirmed'&&!recreate&&!unsaved)throw Error('原工作页尚未确认；需要独立重做时，请使用“重新创建草稿”');
  if(prior&&prior.attemptId===attemptId)throw Error('不能重复执行同一个任务，请点击“重新创建草稿”建立新任务');
  if(prior&&(recreate||unsaved))await fs.writeFile(path.join(outputDir,'previous-workspace.json'),JSON.stringify(prior,null,2),{flag:'wx'});
  if(prior?.label){
    const matching=(await task.tabs()).filter(t=>t.label===prior.label);
    if(matching.length===1)return{page:task.page(prior.label),reused:true};
  }
  try{return{page:await task.newPage(),reused:false};}
  catch(e){if(/Page budget reached/.test(e.message))throw Error('本店工作页已关闭，Ego 页面数量已满；请关闭一个不再使用的页面后重建。尚未开始上传或保存。');throw e;}
}
export async function productPageState(driver,config) {
  await driver.guard();
  const state=await driver.read(expectedCategory=>{
    const rows=[...document.querySelectorAll('form [data-testid="beast-core-form-item"]')];
    const label=r=>r.querySelector('[class*="Form_itemLabelContent"]')?.innerText.trim().replace(/^[*\s]+/,'');
    const title=rows.filter(r=>label(r)==='商品标题').flatMap(r=>[...r.querySelectorAll('input[type="text"]')].map(e=>e.value));
    let category=rows.filter(r=>['商品类目','商品分类'].includes(label(r))).map(r=>r.innerText.replace(/^商品(?:类目|分类)\s*/, '').replace(/修改(?:分类)?\s*$/,'').trim().replace(/\s*>\s*/g,' > '));
    if(!category.length){
      const norm=text=>text.trim().replace(/\s*>\s*/g,' > ');
      const matches=[...document.querySelectorAll('form span,form div')].filter(e=>e.getClientRects().length&&norm(e.innerText)===expectedCategory&&!Array.from(e.children).some(child=>norm(child.innerText||'')===expectedCategory));
      category=matches.map(e=>norm(e.innerText));
    }
    const main=rows.filter(r=>['商品轮播图','轮播图','商品主图'].includes(label(r)));
    if(main.length!==1)throw Error('未找到唯一商品轮播图区域');
    const urls=[...main[0].querySelectorAll('[class*="MaterialModalButton_v2_imageBox"]')].map(e=>e.style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1]).map(raw=>{try{const u=new URL(raw);return u.protocol==='https:'&&(u.hostname==='pfs.pinduoduo.com'||u.hostname==='img.pddpic.com'&&/^\/(?:mms-goods-image|mms-material-img|goods\/images)\//.test(u.pathname))?u.origin+u.pathname:null;}catch{return null;}});
    return{title,category,mainUrls:urls};
  },config.product.categoryPath);
  if(state.title.length!==1||state.title[0]!==config.product.title)throw Error('商品标题回读不一致');
  if(state.category.length!==1||state.category[0]!==config.product.categoryPath)throw Error('实际商品类目回读不一致');
  if(state.mainUrls.length!==config.product.mainImages.length||state.mainUrls.some(u=>!u))throw Error('主图尚未按本次素材数量完整显示');
  return state;
}
export async function reviewPddDraft(driver,config,validation,receipts) {
  await assertFrozenFiles(config);
  const product=await productPageState(driver,config);
  const attributes=await verifyAttributes(driver,config),specifications=await verifySpecifications(driver,config);
  const services=await configureServices(driver,config,{verifyOnly:true});
  await verifyMediaReceipts(driver,receipts,{config,validation});
  return{product,attributes,specifications,services,mediaKeys:receipts.map(r=>r.key)};
}
export async function executePddDraft({task,payload,onEvent=async()=>{}}) {
  const {config,validation,expectedHash,expectedShop,outputDir,attemptId,batchId,workspaceFile}=payload;
  if(config.platform!=='pdd'||!config.draftOnly||config.expectedShop!==expectedShop||!validation?.ok||validation.inputHash!==expectedHash||config.input.inputHash!==expectedHash||validation.executionHash!==executionHash(config))throw Error('拼多多冻结输入或店铺身份不符');
  assertServiceRange(config);await assertFrozenFiles(config);
  await fs.mkdir(outputDir,{recursive:true});
  const prior=await readJson(workspaceFile);
  let page,driver;
  const mark=async changes=>{await fs.mkdir(path.dirname(workspaceFile),{recursive:true});await fs.writeFile(workspaceFile,JSON.stringify({attemptId,batchId,previousAttemptId:prior?.attemptId||null,...changes},null,2));};
  try{
    const workspace=await prepareEgoPage(task,{prior,outputDir,attemptId,batchId,recreate:payload.recreate===true});
    page=workspace.page;
    if(workspace.reused){
      const previousDriver=new PddDriver({page,kind:'ego',expectedShop,onEvent});
      await previousDriver.guard();
      if(payload.recreate)await fs.writeFile(path.join(outputDir,'previous-page.json'),JSON.stringify(await page.evaluate(()=>({url:location.href,title:document.title,at:new Date().toISOString()})),null,2));
    }
    await mark({phase:'running',label:page.label});
    await page.goto('https://mms.pinduoduo.com/goods/category');
    driver=new PddDriver({page,kind:'ego',expectedShop,onEvent});
    await driver.wait(()=>document.querySelectorAll('form input[placeholder^="商品标题组成"]').length===1&&
      [...document.querySelectorAll('.user-name-name .user-name-text')].some(e=>e.innerText.trim()&&e.getClientRects().length),undefined,45000);
    await onEvent({type:'workspace',created:!workspace.reused,reused:workspace.reused});
    const uploadFiles=await stageMainUploadSlots(config,outputDir);
    if(config.product.imageOrder)await onEvent({type:'log',text:'使用主图复用规则：'+config.product.sourceMainImages.length+'张原图，轮播10张、详情17张；原图未复制到素材库'});
    const entry=await fillEntry(driver,config,{validation,uploadFiles});
    const entryEvidence={attemptId,inputHash:expectedHash,imageOrder:entry.imageOrder,temporaryMainUrls:entry.uploaded.map(raw=>{const u=new URL(raw.match(/^url\(["']?(.*?)["']?\)$/)?.[1]);return u.origin+u.pathname;}),at:new Date().toISOString()};
    await fs.writeFile(path.join(outputDir,'entry-upload.json'),JSON.stringify(entryEvidence,null,2));
    await driver.step('进入商品类目选择',()=>requestCategory(driver));
    await driver.step('核对并进入商品类目',()=>openSelectedCategory(driver,config.product.categoryPath));
    await driver.wait(()=>document.querySelectorAll('#newSpec').length===1,undefined,45000);
    const media=await beginCompleteMedia(driver,config,validation,path.join(outputDir,'media'));
    let receipts;
    try{
      await media.startVideo();
      await fillAttributes(driver,config);
      await createSpecifications(driver,config.skuMatrix);
      await disablePlatformSizeChart(driver);
      await fillPricing(driver,config.skuMatrix);
      await driver.step('填写服务、运费与参考价',()=>configureServices(driver,config));
      receipts=await media.finish();
    }finally{await media.close();}
    // Category entry uses temporary pfs URLs; the edit page converts these to
    // mms-goods-image URLs. Bind persistence/order checks to the edit page's
    // actual pre-save URLs, rather than comparing two different storage stages.
    let before;
    const currentUrl=await page.url(),url=new URL(currentUrl);
    if(!/^\d+$/.test(url.searchParams.get('goods_id')||'')||!/^\d+$/.test(url.searchParams.get('id')||''))throw Error('缺少本次草稿编辑标识，停止保存');
    const editUrl=new URL('https://mms.pinduoduo.com/goods/goods_add/index');
    for(const key of ['id','goods_id'])editUrl.searchParams.set(key,url.searchParams.get(key));editUrl.searchParams.set('type','edit');
    const saved=await saveTransaction({outputDir,inputHash:expectedHash,expectedShop,productId:config.product.id,onEvent,
      beforeSave:async()=>{
        before=await driver.step('保存前统一核对',()=>reviewPddDraft(driver,config,validation,receipts));
        await fs.writeFile(path.join(outputDir,'before-save.json'),JSON.stringify(before,null,2));
        const button=await driver.read(()=>[...document.querySelectorAll('button[data-tracking-viewid="save_draft"],button[data-tracking-click-viewid="save_draft"]')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText.trim(),disabled:e.disabled})));
        if(button.length!==1||button[0].text!=='保存草稿'||button[0].disabled)throw Error('没有唯一可用的保存草稿按钮');
        const old=await driver.read(draftSaveNoticeDom);
        if(old)throw Error('页面已有历史成功提示，不能作为本次保存证据');
        return{ok:true,stage:'before-save',evidence:[{url:currentUrl,...before}]};
      },
      dispatch:async()=>{
        await mark({phase:'saving',label:page.label});driver.saveEnabled=true;
        try{await driver.click('button[data-tracking-viewid="save_draft"],button[data-tracking-click-viewid="save_draft"]',{label:'保存本次商品草稿'});}finally{driver.saveEnabled=false;}
        await page.waitForFunction(draftSaveNoticeDom,undefined,{timeout:20000});
        return{url:editUrl.href,at:new Date().toISOString(),acknowledgement:await driver.read(draftSaveNoticeDom)};
      }});
    await mark({phase:'confirmed',label:page.label});
    const result={ok:true,saved,finishedAt:new Date().toISOString()};
    await fs.writeFile(path.join(outputDir,'last-run.json'),JSON.stringify(result,null,2));return result;
  }catch(e){
    if(driver)driver.saveEnabled=false;
    const receipt=await readJson(path.join(outputDir,`draft-save-${expectedHash}.json`));
    let safeToContinue=false;
    if(driver&&!receipt&&!/SAFETY_BLOCKED|登录|店铺|权限|由你控制|工作空间|冻结|资料.*改变|文件.*改变|日志|记录|ENOSPC|EACCES|EIO|closed|disconnect/i.test(e.message)){
      try{await driver.guard();safeToContinue=true;}catch{}
    }
    if(page)await mark({phase:receipt?.status==='confirmed'?'confirmed':receipt?'needs-review':'failed',label:page.label,error:e.message,safeToContinue});
    await fs.writeFile(path.join(outputDir,'product-failure.json'),JSON.stringify({inputHash:expectedHash,attemptId,batchId,safeToContinue,error:e.message,at:new Date().toISOString()},null,2),{flag:'wx'});
    await fs.writeFile(path.join(outputDir,'last-run.json'),JSON.stringify({ok:false,error:e.message,finishedAt:new Date().toISOString()},null,2));throw e;
  }
}
