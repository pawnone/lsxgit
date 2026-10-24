// Contract checks use local intercepted HTML shaped from the inspected draft.
// No user browser, real upload, draft save or external request is involved.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {BrowserManager} from '../desktop/browser-manager.mjs';
import {PddDriver} from '../engine/pdd/dom-driver.mjs';
import {readRequiredDom,assertRequiredAttributeInput,assertRequiredMediaInput} from '../engine/pdd/field-policy.mjs';
import {configureServices,serviceControl} from '../engine/pdd/service-contract.mjs';
import {productPageState} from '../engine/pdd/run-draft.mjs';
const browser=await chromium.launch({executablePath:await new BrowserManager().detectExecutable(),headless:true});
const header='<div class="user-name-name"><span class="user-name-text">本地校验店</span></div>';
const field=(name,id,content,required=false)=>`<div data-testid="beast-core-form-item" id="${id}"><div class="Form_itemLabelWrapper_test">${required?'<span class="Form_itemRequired_test">*</span>':''}<label class="Form_itemLabelContent_test">${name}</label></div>${content}</div>`;
const radio=(name,checked=true)=>`<label data-testid="beast-core-radio"><input type="radio" ${checked?'checked':''}>${name}</label>`;
const checks=[];
try{
  const context=await browser.newContext();
  await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<html></html>'}):route.abort());
  const page=await context.newPage();await page.goto('https://mms.pinduoduo.com/goods/goods_add/index?goods_id=synthetic');
  const driver=new PddDriver({page,expectedShop:'本地校验店'});
  const config={product:{title:'合成商品',categoryPath:'女装 > 时尚套装',mainImages:['synthetic.png'],materialTagImages:[]},pdd:{basic:{'材质':'涤纶','成分含量':'100%','商品参考价（元）':50,'满件折扣':'启用','满件数量':2,'折扣（几折）':9.5},service:{'商品类型':'普通商品','是否二手':'非二手','是否定制':'非定制','发货模式':'时段预售','承诺发货时间/时效':'10天内发货','运费模板':'合成模板'}}};
  const attributes=field('<span>重要</span>品牌','basic.propertys.0.value','<input type="text" value="">')+
    field('材质','basic.propertys.1.value','<input type="text" disabled value="涤纶">',true)+field('成分含量','basic.propertys.2.value','<input type="text" value="100%">',true);
  await page.setContent(header+'<form>'+attributes+field('包装标签图','basic.pack_label_image','')+field('商品视频','basic.carousel_video','')+'</form>');
  assert.deepEqual((await driver.read(readRequiredDom)).filter(f=>f.required).map(f=>f.field),['材质','成分含量']);
  await assertRequiredAttributeInput(driver,config);await assertRequiredMediaInput(driver,config);checks.push('橙色重要不等于必填，缺少选填品牌、包装标签和视频不阻断');
  await page.setContent(header+'<form>'+attributes+field('包装标签图','basic.pack_label_image','',true)+'</form>');
  await assert.rejects(assertRequiredMediaInput(driver,config),/当前类目.*必填/);checks.push('类目实际增加必填媒体时动态阻断，不把所有类目都当选填');
  await page.setContent(header+'<form>'+attributes+field('新必填属性','basic.propertys.20.value','',true)+'</form>');
  await assert.rejects(assertRequiredAttributeInput(driver,config),/新必填属性/);checks.push('动态新增必填属性不会因固定字段清单被漏掉');

  const service=field('商品类型','service.goods_type',radio('普通商品'),true)+field('是否二手','service.second_hand',radio('非二手'),true)+field('是否定制','service.is_customized',radio('非定制'),true)+
    field('是否预售','service.is_pre_sale',radio('时段预售'),true)+field('预售时间','service.group_time_second','<input type="text" value="10天">',true)+
    '<div id="cost_template_id">'+field('运费模板','service.is_default_template_id',radio('合成模板'),true)+'<p>包邮配送区域</p><p>北京</p></div>'+
    field('商品参考价','sku.market_price','<input type="text" value="50">',true)+field('满件折扣','sku.batch_discount','<span class="price-text">满2件 9.5 折<span class="edit">修改</span></span>',true);
  await page.setContent(header+'<form>'+service+'</form>');
  await configureServices(driver,config,{verifyOnly:true});checks.push('缺少选填服务、商品编码、拼单人数和运费规则说明仍可完成必填服务复核');
  // Keep presale seeded/locked here; interactive dropdown coverage has its own
  // native suite. These cases isolate product code and reference-price writes.
  const nativeService=service.replace('<input type="text" value="10天">','<div data-testid="beast-core-select-header"><span class="ST_selectValueSingle_test"><input type="text" disabled readonly value="10天"></span></div>');
  const goodsCodeForm=()=>header+'<form>'+nativeService+'<div id="sku.out_goods_sn"><input type="text" value=""></div></form>';
  for(const code of ['ITEM-001','001-ITEM-002']){
    await page.setContent(goodsCodeForm());
    const mapped=structuredClone(config);mapped.pdd.basic['商品货号']=code;mapped.pdd.basic['商品编码']='不填写';
    const results=await configureServices(driver,mapped);
    assert.equal(await page.locator('[id="sku.out_goods_sn"] input').inputValue(),code);
    assert.deepEqual(results.find(r=>r.field==='商品编码'),{field:'商品编码',value:code,source:'商品货号'});
    await configureServices(driver,mapped,{verifyOnly:true});
  }
  checks.push('商品编码沿用表内商品货号，旧编码“不填写”不再拦截，两商品独立对应且保留前导零');
  const mapped=structuredClone(config);mapped.pdd.basic['商品货号']='ITEM-EXACT';mapped.pdd.basic['商品编码']='旧独立编码';
  await configureServices(driver,mapped);assert.equal(await page.locator('[id="sku.out_goods_sn"] input').inputValue(),'ITEM-EXACT');
  await page.locator('[id="sku.out_goods_sn"] input').fill('OTHER');await assert.rejects(configureServices(driver,mapped,{verifyOnly:true}),/商品编码回读不一致/);
  assert.equal(await page.locator('[id="sku.out_goods_sn"] input').inputValue(),'OTHER');checks.push('货号优先于旧独立编码，保存后回读不符会停止，只读核对不改值');
  await page.setContent(goodsCodeForm());const legacy=structuredClone(config);legacy.pdd.basic['商品编码']='001-LEGACY';await configureServices(driver,legacy);
  assert.equal(await page.locator('[id="sku.out_goods_sn"] input').inputValue(),'001-LEGACY');checks.push('仅有旧商品编码而没有货号的旧表仍兼容，不从商品ID或文件夹名生成编码');
  const changedPrice=structuredClone(config);changedPrice.pdd.basic['商品参考价（元）']=88.8;await configureServices(driver,changedPrice);
  assert.equal(await page.locator('[id="sku.market_price"] input').inputValue(),'88.8');await configureServices(driver,changedPrice,{verifyOnly:true});checks.push('商品参考价填写商品表当前值并回读，不固定为299.9或沿用旧页面价格');
  const editableService=service.replace('<span class="price-text">满2件 9.5 折<span class="edit">修改</span></span>','<span>满2件</span><input type="text" value="9.5">折');
  await page.setContent(header+'<form><div id="goods-service"><div id="expand" class="text-v2">展开修改</div><section hidden>'+editableService+'</section></div></form>');
  await page.evaluate(()=>{document.getElementById('expand').onclick=()=>{document.querySelector('#goods-service section').hidden=false;document.getElementById('expand').remove();};});
  await configureServices(driver,config,{verifyOnly:true});
  assert.equal(await page.locator('#expand').count(),0);checks.push('服务展开入口为div也能打开，折扣从实际输入值读取');
  await page.locator('[id="sku.batch_discount"] input').fill('9.4');
  await assert.rejects(configureServices(driver,config,{verifyOnly:true}),/满件折扣/);checks.push('折扣输入与商品表不同，保存前复核拒绝通过');
  await page.setContent(header+'<form><label data-testid="beast-core-checkbox"><input type="checkbox" disabled checked>7天无理由退货</label></form>');
  const promise=await serviceControl(driver,'7天无理由退货');assert(promise.inputs[0].disabled&&promise.choices[0].checked);checks.push('平台强制选中的7天退货按真实控件读取');

  await page.setContent(header+'<form><div>商品分类<span>女装 > 时尚套装</span><a>修改分类</a></div>'+field('商品标题','basic.goods_name','<input type="text" value="合成商品">',true)+field('商品轮播图','basic.carousel_gallery','<div class="MaterialModalButton_v2_imageBox_test" style="background-image:url(https://img.pddpic.com/mms-goods-image/test/one.png)"></div>',true)+'</form>');
  assert.equal((await productPageState(driver,config)).mainUrls.length,1);checks.push('主图按真实1～10张数量核对，类目头部不依赖不存在的商品类目表单行');
  console.log(JSON.stringify({checks:checks.length,names:checks,merchantMutation:false}));
}finally{await browser.close();}
