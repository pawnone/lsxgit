// Native compound ingredient and category controls. All requests are local;
// no merchant session, actual product or saved draft is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {BrowserManager} from '../desktop/browser-manager.mjs';
import {PddDriver} from '../engine/pdd/dom-driver.mjs';
import {configureComposition,compositionState} from '../engine/pdd/composition.mjs';
import {selectRecommendedCategory} from '../engine/pdd/category-entry.mjs';
import {KNIT_CATEGORY,SET_CATEGORY} from '../engine/pdd/categories.mjs';
import {ensureSizeStandard,specificationState} from '../engine/pdd/specs.mjs';
const browser=await chromium.launch({executablePath:await new BrowserManager({}).detectExecutable(),headless:true}),checks=[];
try{
  const context=await browser.newContext();await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html></html>'}));
  const page=await context.newPage();await page.goto('https://mms.pinduoduo.com/local-composition-test');
  const driver=new PddDriver({page,expectedShop:'本地成分测试店'}),header='<span class="user-name-name"><span class="user-name-text">本地成分测试店</span></span>';
  await page.setContent(header+'<form><div data-testid="beast-core-form-item" id="basic.propertys.variable.value"><label class="Form_itemLabelContent_test">材质成分</label><div class="IngredientList_addBtnWrapper_test"><button type="button">添加材质成分</button></div><div id="selected"></div></div></form>');
  await page.evaluate(()=>{
    window.actions=[];
    document.querySelector('button').onclick=()=>{
      const panel=document.createElement('div');panel.className='IngredientList_searchPanel_test';panel.innerHTML='<input placeholder="请输入搜索内容"><div class="options"></div><button type="button" class="BTN_primary_test">确定(0/7)</button>';
      const selected=new Set(),options=['涤纶（聚酯纤维）','腈纶'];
      for(const name of options){const label=document.createElement('label');label.dataset.testid='beast-core-checkbox';label.innerHTML='<input type="checkbox">'+name;label.querySelector('input').onchange=e=>{e.target.checked?selected.add(name):selected.delete(name);panel.querySelector('button').textContent='确定('+selected.size+'/7)';window.actions.push(name);};panel.querySelector('.options').append(label);}
      panel.querySelector('input').oninput=e=>{for(const label of panel.querySelectorAll('label'))label.style.display=label.innerText.includes(e.target.value)?'':'none';};
      panel.querySelector('button').onclick=()=>{
        for(const name of selected){const row=document.createElement('div');row.className='IngredientList_selectedItem_test';row.innerHTML='<input data-testid="beast-core-select-htmlInput" disabled readonly><input data-testid="beast-core-inputNumber-htmlInput" placeholder="含量">%';row.querySelector('input').value=name;const number=row.querySelector('input[placeholder="含量"]');number.onblur=()=>{if(number.value!=='')number.value=Number(number.value).toFixed(1);};document.querySelector('#selected').append(row);}panel.remove();
      };document.body.append(panel);
    };
  });
  const expected=[{name:'涤纶（聚酯纤维）',percent:40},{name:'腈纶',percent:60}];
  const nativeClick=driver.click.bind(driver);let relocated=0;
  driver.click=async(selector,options={})=>{
    if(options.label==='勾选精确匹配的商品材质'){
      await page.evaluate(()=>{const e=document.createElement('label');e.dataset.testid='beast-core-checkbox';e.textContent='搜索结果更新';document.querySelector('.IngredientList_searchPanel_test .options').prepend(e);});relocated++;
    }
    return nativeClick(selector,options);
  };
  await configureComposition(driver,expected);assert.deepEqual((await compositionState(driver)).items.map(({name,percent})=>({name,percent})),expected);assert.deepEqual(await page.evaluate(()=>window.actions),expected.map(v=>v.name));checks.push('逐项原生勾选两种材质，一次确认；格式化40.0和60.0按实际数值核对');
  assert.equal(relocated,2);driver.click=nativeClick;checks.push('搜索结果在定位后插入新行，仍按精确材质文字点击，不依赖旧行号');
  await configureComposition(driver,expected,{verifyOnly:true});assert.equal((await page.evaluate(()=>window.actions)).length,2);checks.push('只读核对不重选、不改值');
  await assert.rejects(configureComposition(driver,[expected[0]]),/其他材质成分/);checks.push('已有未知材质时拒绝覆盖');
  await page.locator('[placeholder="含量"]').first().fill('35');await assert.rejects(configureComposition(driver,expected,{verifyOnly:true}),/百分比回读不一致/);assert.equal(await page.locator('[placeholder="含量"]').first().inputValue(),'35');checks.push('保存回读发现百分比改变时停止，只读核对不会修饰结果');
  await page.setContent(header+'<form><div id="cards"><div class="cateItemCard_chooseCategory_test" data-tracking-viewid="choose_cate" data-tracking-params="set">'+SET_CATEGORY+'</div></div><button type="button">查看更多推荐</button></form>');
  await page.evaluate(category=>{window.more=0;window.choices=[];document.querySelector('button').onclick=()=>{window.more++;const e=document.createElement('div');e.className='cateItemCard_chooseCategory_test';e.dataset.trackingViewid='choose_cate';e.dataset.trackingParams='knit';e.innerText=category;e.onclick=()=>{window.choices.push(e.innerText);e.classList.add('cateItemCard_checked_test');};document.querySelector('#cards').append(e);};},KNIT_CATEGORY);
  await selectRecommendedCategory(driver,KNIT_CATEGORY);assert.equal(await page.evaluate(()=>window.more),1);assert.deepEqual(await page.evaluate(()=>window.choices),[KNIT_CATEGORY]);checks.push('目标类目不在前三项时展开更多推荐，只点击完整路径精确匹配项');
  await page.setContent(header+'<form><div class="cateItemCard_chooseCategory_test" data-tracking-viewid="choose_cate" data-tracking-params="cate_list=old&choosen_cate=8490">'+SET_CATEGORY+'</div></form>');
  await page.evaluate(()=>{const card=document.querySelector('[data-tracking-viewid="choose_cate"]'),get=card.getAttribute.bind(card);let changed=false;window.categoryClicks=0;card.getAttribute=name=>{const v=get(name);if(name==='data-tracking-params'&&!changed){changed=true;queueMicrotask(()=>card.setAttribute(name,'cate_list=changed&choosen_cate=8490'));}return v;};card.onclick=()=>{window.categoryClicks++;card.classList.add('cateItemCard_checked_test');};});
  await selectRecommendedCategory(driver,SET_CATEGORY);assert.equal(await page.evaluate(()=>window.categoryClicks),1);checks.push('推荐列表埋点参数变化不使类目目标失效，完整路径和稳定ID共同核对');
  const click=driver.click.bind(driver);
  driver.click=async()=>{await page.evaluate(category=>{history.pushState({},'','/goods/goods_add/index?id=local');document.querySelector('form').innerHTML='<div>'+category+'</div>';},SET_CATEGORY);throw Error('Locator matched 0 elements');};
  await selectRecommendedCategory(driver,SET_CATEGORY);driver.click=click;checks.push('点击回执丢失但实际已进入正确类目时按真实页面继续，不重新点击');
  await assert.rejects(selectRecommendedCategory(driver,KNIT_CATEGORY),/实际类目与商品表不符/);checks.push('提前进入其他类目时仍停止，不把URL变化当作成功');
  const sizeFixture=async(checked=false)=>{
    await page.setContent(header+'<form><div id="newSpec"><div class="sizeStandardWrapper_sizeStandardWrapper_test"><label data-testid="beast-core-radio"><input type="radio">中国码</label><div id="sizes"></div></div></div></form>');
    await page.evaluate(checked=>{
      const show=names=>{document.querySelector('#sizes').innerHTML=names.map(name=>'<div class="normal-check"><label data-testid="beast-core-checkbox"><input type="checkbox"><span class="check-wrapper">'+name+'</span></label></div>').join('');};
      show(['150/72A']);document.querySelector('#sizes input').checked=checked;window.sizeSwitches=0;
      document.querySelector('label[data-testid="beast-core-radio"]').onclick=()=>{window.sizeSwitches++;show(['S','M','L','XL']);};
    },checked);
  };
  await sizeFixture();await ensureSizeStandard(driver,['S','M','L','XL']);assert.deepEqual((await specificationState(driver)).sizes.map(s=>s.name),['S','M','L','XL']);await ensureSizeStandard(driver,['S','M']);assert.equal(await page.evaluate(()=>window.sizeSwitches),1);checks.push('针织衫默认数字尺码时只切一次中国码，按S/M/L/XL原值填写');
  await sizeFixture(true);await assert.rejects(ensureSizeStandard(driver,['S']),/已有选中规格/);assert.equal(await page.evaluate(()=>window.sizeSwitches),0);checks.push('已有其他尺码时不切制式、不清除数据');
  assert.equal(context.pages().length,1);
  const result={checks:checks.length,names:checks,merchantMutation:false},out=process.env.WQ_AUDIT_DIR||'output/pdd-047-audit';await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'composition-test.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
