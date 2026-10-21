import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fillProductAttributes,verifyProductAttributes} from '../engine/doudian/product-attributes.mjs';
import {SUIT_CATEGORY,KNIT_CATEGORY} from '../engine/doudian/category-rules.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-category-dom-'));
const ctx=await chromium.launchPersistentContext(root,{channel:'chrome',headless:true});
const checks=[];
try{
 const page=ctx.pages()[0];
 await page.setContent(`<html><body><script>
 const definitions=[['组合件数','single',['单件','两件']],['适用年龄','single',['24-40周岁','29周岁（含）-39周岁（不含）']],['风格','multi',['休闲风','通勤风']],['领型','single',['翻领','圆领']],['适用季节','multi',['秋季','冬季','夏季']],['克重','number',[]],['上市时间','text',[]]];
 for(const [label,type,options]of definitions){
  const field=document.createElement('div');field.setAttribute('attr-field-id',label);field.style='padding:10px';
  field.innerHTML='<label>'+label+'</label>';
  if(type==='text'||type==='number'){
   const input=document.createElement('input');input.type='text';field.append(input);
  }else{
   const selector=document.createElement('div');selector.className='ecom-g-select-selector';
   const chips=document.createElement('span');const input=document.createElement('input');input.type='search';input.setAttribute('role','combobox');input.setAttribute('aria-expanded','false');
   // Test non-searchable platform selects as well.
   if(label==='领型')input.readOnly=true;
   selector.append(chips,input);field.append(selector);
   let values=type==='multi'?['夏季'].filter(v=>options.includes(v)):[];
   function render(){chips.replaceChildren();for(const value of values){const tag=document.createElement('span');tag.className='ecom-g-select-selection-item';const text=document.createElement('span');text.className='ecom-g-select-selection-item-content';text.textContent=value;tag.append(text);if(type==='multi'){const remove=document.createElement('button');remove.className='ecom-g-select-selection-item-remove';remove.textContent='×';remove.onclick=e=>{e.stopPropagation();values=values.filter(v=>v!==value);render();};tag.append(remove);}chips.append(tag);}}
   render();
   const dropdown=document.createElement('div');dropdown.className='ecom-g-select-dropdown';dropdown.style.display='none';
   function open(){document.querySelectorAll('.ecom-g-select-dropdown').forEach(d=>d.style.display='none');dropdown.style.display='block';input.setAttribute('aria-expanded','true');}
   selector.onclick=open;
   for(const value of options){const option=document.createElement('div');option.className='ecom-g-select-item-option';const text=document.createElement('span');text.textContent=value;option.append(text);option.onclick=()=>{values=type==='multi'?[...new Set([...values,value])]:[value];render();if(type==='single'){dropdown.style.display='none';input.setAttribute('aria-expanded','false');}};dropdown.append(option);}
   input.oninput=()=>{for(const o of dropdown.children)o.style.display=o.textContent.includes(input.value)?'block':'none';};
   document.body.append(dropdown);
   document.addEventListener('keydown',e=>{if(e.key==='Escape'){dropdown.style.display='none';input.setAttribute('aria-expanded','false');}});
  }
  document.body.append(field);
 }
 </script></body></html>`);
 const knit={product:{categoryPath:KNIT_CATEGORY,pieceCount:'单件',applicableAge:'24-40周岁',style:'休闲风',categoryAttributes:{'领型':'翻领','适用季节':['秋季','冬季'],'克重':350,'上市时间':'2026年秋季'}}};
 await fillProductAttributes(page,knit);await verifyProductAttributes(page,knit);checks.push('针织衫单选、多选、只读下拉、文本、克重填写与回读');
 assert.equal(await page.locator('[attr-field-id="适用季节"] .ecom-g-select-selection-item-content').allTextContents().then(a=>a.includes('夏季')),false);checks.push('多选清除原页面值，不叠加错误默认值');
 const wrong=structuredClone(knit);wrong.product.categoryAttributes['领型']='不存在的选项';await assert.rejects(fillProductAttributes(page,wrong),/没有可用的精确选项/);checks.push('未知下拉值明确报错，不模糊选择');
 await page.keyboard.press('Escape');
 await page.locator('[attr-field-id="克重"] input').fill('999');await assert.rejects(verifyProductAttributes(page,knit),/克重不符/);checks.push('保存前拦截属性被人工改动');
 await page.locator('[attr-field-id="克重"] input').evaluate(e=>e.required=true);
 const missing=structuredClone(knit);delete missing.product.categoryAttributes['克重'];await assert.rejects(fillProductAttributes(page,missing),/平台要求填写“克重”/);checks.push('平台实际必填缺失时停止并提示Excel字段');
 await page.locator('[attr-field-id="克重"] input').evaluate(e=>e.required=false);
 await fillProductAttributes(page,{product:{categoryPath:SUIT_CATEGORY,pieceCount:'两件',applicableAge:'29周岁（含）-39周岁（不含）',style:'通勤风'}});checks.push('套装共用属性规则回归通过');
 console.log(JSON.stringify({checks,merchantMutation:false}));
}finally{await ctx.close();await fs.rm(root,{recursive:true,force:true});}
