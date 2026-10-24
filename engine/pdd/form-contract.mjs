import {fieldState,selectField,selectMultiField,fillTextField,waitForField} from './attributes.mjs';
import {assertSelected} from './core/form-review.mjs';
import {pricingState} from './pricing.mjs';
import {specificationState} from './specs.mjs';
import {missing,assertRequiredAttributeInput} from './field-policy.mjs';
import {isKnit,setSingles,knitSingles} from './categories.mjs';
import {materialComponents,configureComposition} from './composition.mjs';
const explicit=value=>!missing(value);
export function attributePlan(config){
  const basic=config.pdd.basic;
  const knit=isKnit(basic),singles=knit?knitSingles:setSingles;
  const plans=singles.filter(k=>explicit(basic[k])).map(field=>({field,value:String(basic[field]),kind:'single'}));
  if(knit){const position=plans.findIndex(p=>!['品牌','面料俗称'].includes(p.field));plans.splice(position<0?plans.length:position,0,{field:'材质成分',value:materialComponents(basic),kind:'composition'});}
  const elements=knit?'流行元素/工艺':'流行元素',elementValue=basic[elements]||basic['流行元素'];
  if(explicit(elementValue))plans.push({field:elements,value:String(elementValue).split(/[、,，]/).map(s=>s.trim()),kind:'multiple'});
  if(explicit(basic['商品货号']))plans.push({field:'商品货号',value:String(basic['商品货号']),kind:'text'});
  return plans;
}
export async function fillAttributes(driver,config){
  await assertRequiredAttributeInput(driver,config);
  const results=[];
  for(const p of attributePlan(config)){
    if(p.kind==='composition'){results.push(await driver.step('填写属性：材质成分',()=>configureComposition(driver,p.value)));continue;}
    const state=await waitForField(driver,p.field);
    try{assertSelected(p.value,state);results.push({field:p.field,alreadySelected:true});continue;}catch{}
    results.push(p.kind==='multiple'?await selectMultiField(driver,p.field,p.value):p.kind==='text'?await fillTextField(driver,p.field,p.value):await selectField(driver,p.field,p.value));
  }
  return results;
}
export async function verifyAttributes(driver,config){
  await assertRequiredAttributeInput(driver,config);
  const result=[];
  for(const p of attributePlan(config)){if(p.kind==='composition'){result.push(await configureComposition(driver,p.value,{verifyOnly:true}));continue;}const state=await fieldState(driver,p.field);assertSelected(p.value,state);result.push({field:p.field,value:p.value});}
  return result;
}
export async function verifySpecifications(driver,config){
  const state=await specificationState(driver);
  const styles=[...new Set(config.skuMatrix.map(s=>s.style))].map(name=>({name,note:config.skuMatrix.find(s=>s.style===name).styleNote||''}));
  const sizes=[...new Set(config.skuMatrix.map(s=>s.size))].map(name=>({name,note:config.skuMatrix.find(s=>s.size===name).sizeNote||''}));
  const actualStyles=state.colors.filter(s=>s.name).map(({name,note})=>({name,note:note||''}));
  const actualSizes=state.sizes.filter(s=>s.checked).map(({name,note})=>({name,note:note||''}));
  const ordered=list=>[...list].sort((a,b)=>a.name.localeCompare(b.name));
  if(JSON.stringify(ordered(styles))!==JSON.stringify(ordered(actualStyles))||JSON.stringify(ordered(sizes))!==JSON.stringify(ordered(actualSizes)))throw Error('规格名称、备注或数量与商品表不符');
  const rows=await pricingState(driver,config.skuMatrix);
  for(const row of rows){const expected=config.skuMatrix.find(s=>s.style===row.style&&s.size===row.size);for(const key of ['stock','groupPriceCents','singlePriceCents','code','state'])if((key!=='code'||expected.code)&&(key!=='state'||expected.state)&&row[key]!==expected[key])throw Error('SKU回读不一致：'+row.style+'/'+row.size+'/'+key);}
  return{styles:actualStyles,sizes:actualSizes,skuCount:rows.length};
}
