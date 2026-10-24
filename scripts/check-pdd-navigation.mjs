// Offline PDD regressions: every request is intercepted, no merchant context.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {BrowserManager} from '../desktop/browser-manager.mjs';
import {PddDriver} from '../engine/pdd/dom-driver.mjs';
import {openSelectedCategory} from '../engine/pdd/category-entry.mjs';
import {waitForField} from '../engine/pdd/attributes.mjs';
import {draftSaveNoticeDom} from '../engine/pdd/save-notice.mjs';
import {verifyMediaPersistence} from '../engine/pdd/media-persistence.mjs';
import {png} from '../test/pdd-fixtures.mjs';
const browser=await chromium.launch({executablePath:await new BrowserManager({}).detectExecutable(),headless:true});
const checks=[];
try{
  const ctx=await browser.newContext({viewport:{width:900,height:700}});
  await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
  const p=await ctx.newPage();await p.goto('https://mms.pinduoduo.com/goods/category');
  const header='<div class="user-name-name"><span class="user-name-text">合成店铺</span></div>';
  const d=new PddDriver({page:p,expectedShop:'合成店铺'});
  const category='女装/女士精品 > 套装/学生校服/工作制服 > 时尚套装';
  for(const auto of [true,false]){
    await p.evaluate(()=>history.replaceState({},'', '/goods/category'));
    await p.setContent(header+'<form><div class="cateItemCard_chooseCategory" data-tracking-viewid="choose_cate" data-tracking-params="exact">'+category+'</div><button type="button" id="bottomSubmitBtnId">下一步</button></form>');
    await p.evaluate(({auto,category})=>{
      window.nextClicks=0;
      const edit=()=>{history.pushState({},'', '/goods/goods_add/index');document.querySelector('form').innerHTML='<div><span>'+category+'</span></div>';};
      const card=document.querySelector('[data-tracking-viewid="choose_cate"]');
      card.onclick=()=>{card.classList.add('cateItemCard_checked');if(auto)edit();};
      document.querySelector('button').onclick=()=>{window.nextClicks++;edit();};
    },{auto,category});
    assert.equal((await openSelectedCategory(d,category)).selectedCategory,category);
    assert.equal(await p.evaluate(()=>window.nextClicks),auto?0:1);
    checks.push(auto?'选推荐后自动进入编辑页，不再点已消失的下一步':'保留下一步的旧版页面正常进入并核对实际类目');
  }
  await p.setContent(header+'<form></form>');
  await p.evaluate(()=>setTimeout(()=>{document.querySelector('form').innerHTML='<div data-testid="beast-core-form-item" id="basic.propertys.material"><label class="Form_itemLabelContent_test">材质</label><input type="text" disabled value="涤纶（聚酯纤维）"></div>';},150));
  assert.equal((await waitForField(d,'材质')).inputs[0].value,'涤纶（聚酯纤维）');
  checks.push('面料联动的材质延迟出现时等待真实字段，不提前判定缺失');
  await p.setContent(header+'<form style="width:1400px;height:900px"><div style="margin-left:1280px;padding-top:200px"><button type="button" id="offscreen">停用尺码表</button></div></form>');
  await d.exposeFormControl('#offscreen');
  const visible=await p.locator('#offscreen').boundingBox();assert(visible.x+visible.width/2<900);assert(await p.evaluate(()=>scrollX)>0);
  checks.push('窄窗口先横向滚动，使右侧控件可点击，不误判为弹层遮挡');
  await p.setContent('<style>html,body{height:100%;margin:0}</style>'+header+'<form style="width:1400px;height:4000px"><div style="margin-left:1280px;padding-top:2400px"><button type="button" id="scrolled">停用尺码表</button></div></form>');
  await p.evaluate(()=>scrollTo(0,2200));await d.exposeFormControl('#scrolled');
  const scrolled=await p.locator('#scrolled').boundingBox();assert(scrolled.x+scrolled.width/2<900);
  checks.push('文档已纵向滚动且根元素边界在屏幕外时，仍可继续横向滚动');
  await p.setContent(header+'<div data-testid="beast-core-modal-body"><h3>保存成功!</h3>提交商品信息且发布成功后方可生效</div>');
  assert.equal((await p.evaluate(draftSaveNoticeDom)).kind,'draft-save-modal');
  checks.push('识别实际后台保存成功弹框，无须重复点击保存');
  await p.setContent(header+'<div data-testid="beast-core-modal-body"><h3>保存成功!</h3>其他模板已更新</div>');
  assert.equal(await p.evaluate(draftSaveNoticeDom),null);checks.push('其他设置的保存成功提示不能冒充商品草稿成功');
  await p.setContent(header+'<div data-testid="beast-core-modal-body" style="display:none"><h3>保存成功!</h3>提交商品信息且发布成功后方可生效</div>');
  assert.equal(await p.evaluate(draftSaveNoticeDom),null);checks.push('已隐藏的历史弹框不能作为本次保存证据');
  for(const [name,rgb]of [['before',[60,80,100]],['converted',[61,80,100]],['wrong',[65,85,105]]]){
    const url=name==='before'?'https://pfs.pinduoduo.com/before.jpeg':'https://img.pddpic.com/mms-goods-image/'+name+'.jpeg';
    await ctx.route(url,r=>r.fulfill({contentType:'image/png',headers:{'access-control-allow-origin':'*'},body:png(256,256,rgb)}));
  }
  const old='https://pfs.pinduoduo.com/before.jpeg',converted='https://img.pddpic.com/mms-goods-image/converted.jpeg',wrong='https://img.pddpic.com/mms-goods-image/wrong.jpeg';
  assert.equal((await verifyMediaPersistence(d,[old],[converted])).length,1);checks.push('保存后地址转换及轻微重新压缩，按实际图片内容核对');
  await assert.rejects(verifyMediaPersistence(d,[old],[wrong]),/内容或顺序/);checks.push('同尺寸不同图片仍拒绝确认，不能只比较数量');
  await assert.rejects(verifyMediaPersistence(d,[old],[]),/数量/);
  await assert.rejects(verifyMediaPersistence(d,[old],['https://example.com/wrong.jpeg']),/非预期/);
  checks.push('保存后缺图或地址转到其他来源时拒绝确认');
  console.log(JSON.stringify({checks:checks.length,names:checks,merchantMutation:false}));
}finally{await browser.close();}
