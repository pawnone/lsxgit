import {KNIT_CATEGORY,KNIT_ATTRIBUTES,normalizeCategoryAttributes} from './category-rules.mjs';
export function desiredAttributes(config){
 const p=config.product;
 const extras=normalizeCategoryAttributes(p.categoryPath,p.categoryAttributes);
 const result=[['组合件数',[p.pieceCount],{type:'single'}],['适用年龄',[p.applicableAge],{type:'single'}],['风格',String(p.style||'').split('、').map(s=>s.trim()).filter(Boolean),{type:'multi',max:5}]];
 for(const [field,values,rule]of result)if(!values.length||values.some(v=>typeof v!=='string'||!v.trim())||new Set(values).size!==values.length||rule.max&&values.length>rule.max)throw new Error(`商品信息缺少${field}或选项重复/超限，禁止沿用页面默认值`);
 if(extras)for(const rule of KNIT_ATTRIBUTES)if(Object.hasOwn(extras,rule.label))result.push([rule.label,Array.isArray(extras[rule.label])?extras[rule.label]:[String(extras[rule.label])],rule]);
 return result;
}
async function selected(field){
 const content=field.locator('.ecom-g-select-selection-item-content');
 return (await content.count()?await content.allTextContents():await field.locator('.ecom-g-select-selection-item').allTextContents()).map(v=>v.trim());
}
const same=(a,b)=>a.length===b.length&&[...a].sort().every((v,i)=>v===[...b].sort()[i]);
function region(page,label){return page.locator(`[attr-field-id="${label}"]`);}
async function uniqueField(page,label){
 const field=region(page,label);await field.first().waitFor({state:'visible',timeout:10000});
 if(await field.count()!==1)throw Error(`属性定位不唯一：${label}，已停止`);
 return field;
}
async function textInput(field,label){
 const input=field.locator('input:not([type="hidden"]):not([type="search"]):not([type="checkbox"]):not([type="radio"]),textarea');
 if(await input.count()!==1)throw Error(`属性输入框不唯一：${label}`);return input;
}
export async function verifyAttributeRequirements(page,config){
 if(config.product.categoryPath!==KNIT_CATEGORY)return;
 const filled=new Set(desiredAttributes(config).map(a=>a[0]));
 for(const rule of KNIT_ATTRIBUTES){
  const field=region(page,rule.label);
  if(await field.count()===0)continue;
  const required=await field.first().evaluate(el=>!!el.querySelector('[required],[aria-required="true"],label[class*="required"],[class*="label-required"]')||/^[\s*＊]*[*＊]/.test(el.innerText));
  if(required&&!filled.has(rule.label))throw Error(`平台要求填写“${rule.label}”，请补齐Excel基础信息中的对应字段后重新检查`);
 }
}
export async function verifyProductAttributes(page,config){
 await verifyAttributeRequirements(page,config);
 for(const [label,values,rule]of desiredAttributes(config)){
  const field=await uniqueField(page,label);
  if(['text','number'].includes(rule.type)){
   const actual=await (await textInput(field,label)).inputValue();
   if(rule.type==='number'?actual===''||Number(actual)!==Number(values[0]):actual!==values[0])throw Error(`保存前${label}不符：${actual}，应为${values[0]}`);
  }else if(!same(await selected(field),values))throw Error(`保存前${label}不符，已停止`);
 }
}
async function choose(page,field,label,value){
 const combo=field.getByRole('combobox');
 if(await combo.count()!==1)throw Error(`属性选择控件不唯一：${label}`);
 if(await combo.getAttribute('aria-expanded')!=='true')await field.locator('.ecom-g-select-selector').click({timeout:10000});
 if(await combo.evaluate(e=>e.tagName==='INPUT'&&!e.readOnly&&!e.disabled))await combo.fill(value,{timeout:10000});
 const listId=await combo.getAttribute('aria-controls')||await combo.getAttribute('aria-owns');
 const visiblePopups=page.locator('.ecom-g-select-dropdown:visible');
 const popup=listId?visiblePopups.filter({has:page.locator(`[id=${JSON.stringify(listId)}]`)}):visiblePopups;
 await popup.first().waitFor({state:'visible',timeout:5000});
 if(await popup.count()!==1)throw Error(`属性下拉弹层不唯一：${label}`);
 const option=popup.locator('.ecom-g-select-item-option').filter({has:page.getByText(value,{exact:true})});
 try{await option.first().waitFor({state:'visible',timeout:5000});}
 catch{throw Error(`“${label}”没有可用的精确选项“${value}”，请按该类目后台选项修改Excel`);}
 if(await option.count()!==1)throw Error(`“${label}”的选项“${value}”不唯一`);
 if(await option.getAttribute('aria-disabled')==='true'||await option.evaluate(e=>e.classList.contains('ecom-g-select-item-option-disabled')))throw Error(`属性选项不可用：${label}/${value}`);
 await option.click({timeout:10000});
}
export async function fillSingleSelectField(page,label,value){
 const field=await uniqueField(page,label);
 if(!same(await selected(field),[value])){
  await choose(page,field,label,value);
  await page.keyboard.press('Escape');
  await field.getByRole('combobox').blur();
 }
 const actual=await selected(field);
 if(!same(actual,[value]))throw Error(`${label}填写回读失败：实际${actual.join('、')}，应为${value}`);
 return {field:label,value:actual[0]};
}
export async function fillProductAttributes(page,config){
 const desired=desiredAttributes(config);await verifyAttributeRequirements(page,config);
 for(const [label,values,rule]of desired){
  const field=await uniqueField(page,label);
  if(['text','number'].includes(rule.type)){
   const input=await textInput(field,label);await input.fill(values[0],{timeout:10000});await input.blur();
  }else{
   if(same(await selected(field),values))continue;
   if(rule.type==='multi'){
    const remove=field.locator('.ecom-g-select-selection-item-remove');
    for(let n=0;await remove.count();n++){if(n>30)throw Error(`无法清空旧属性：${label}`);await remove.first().click({timeout:10000});}
    for(const value of values)await choose(page,field,label,value);
   }else await choose(page,field,label,values[0]);
   await page.keyboard.press('Escape');await field.getByText(label,{exact:true}).click();
   if(!same(await selected(field),values))throw Error(`${label}填写回读失败，已停止`);
  }
 }
 await verifyProductAttributes(page,config);
}
