import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {fillSingleSelectField} from '../engine/doudian/product-attributes.mjs';
const browser=await chromium.launch({channel:'chrome',headless:true});const checks=[];
try{
 const page=await browser.newPage();
 const fixture=(options=['限售','包邮'])=>`<div attr-field-id="运费模板"><label>运费模板</label><div class="ecom-g-select-selector"><input role="combobox" aria-controls="freight-list" readonly><span class="ecom-g-select-selection-item">限售</span></div></div><div class="ecom-g-select-dropdown" style="display:none"><div id="freight-list" role="listbox"></div>${options.map(v=>'<div class="ecom-g-select-item-option"><span>'+v+'</span></div>').join('')}</div><script>document.querySelector('.ecom-g-select-selector').onclick=()=>{document.querySelector('.ecom-g-select-dropdown').style.display='block';};for(const o of document.querySelectorAll('.ecom-g-select-item-option'))o.onclick=()=>{document.querySelector('.ecom-g-select-selection-item').textContent=o.textContent;document.querySelector('.ecom-g-select-dropdown').style.display='none';};</script>`;
 await page.setContent(fixture());assert.equal((await fillSingleSelectField(page,'运费模板','包邮')).value,'包邮');checks.push('默认限售时主动选择Excel包邮并回读，只读下拉可用');
 await fillSingleSelectField(page,'运费模板','包邮');assert.equal(await page.locator('.ecom-g-select-dropdown').isVisible(),false);checks.push('目标值已正确时保持，不重复操作');
 await page.setContent(fixture(['限售']));await assert.rejects(fillSingleSelectField(page,'运费模板','包邮'),/没有可用的精确选项/);checks.push('目标运费模板不存在时阻断');
 await page.setContent(fixture(['包邮','包邮']));await assert.rejects(fillSingleSelectField(page,'运费模板','包邮'),/strict mode|不唯一/);checks.push('重名运费模板阻断，不随机选取');
 console.log(JSON.stringify({checks,merchantMutation:false}));
}finally{await browser.close();}
