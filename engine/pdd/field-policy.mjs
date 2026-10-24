// Ground truth: the user-opened 时尚套装 draft, inspected 2026-10-21.
// Orange “重要” is a recommendation; only the separate Form_itemRequired mark
// denotes a required field. Browser checks also inspect the current page.
import {isKnit} from './categories.mjs';
import {materialComponents} from './composition.mjs';
export const REQUIRED_BASIC=['商品标题','完整类目路径','商品参考价（元）'];
export const requiredBasic=basic=>[...REQUIRED_BASIC,...(isKnit(basic)?[]:['成分含量'])];
export const REQUIRED_SERVICE=['商品类型','是否二手','是否定制','发货模式','运费模板'];
export const missing=value=>value===null||value===undefined||String(value).trim()===''||/^(?:不填写|不适用|无|【.*】)$/.test(String(value).trim())||/待填写|待确认|待补充/.test(String(value));
export function requiredKey(sheet,key,values){
  if(sheet==='基础信息')return requiredBasic(values).includes(key)||!isKnit(values)&&key==='材质'&&missing(values['面料俗称'])||values['满件折扣']==='启用'&&['满件数量','折扣（几折）'].includes(key);
  return REQUIRED_SERVICE.includes(key)||key==='承诺发货时间/时效'&&values['发货模式']==='时段预售'||key==='预售起止日期/时段'&&values['发货模式']==='定时预售';
}
export function readRequiredDom(){
  const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  return [...document.querySelectorAll('form [class*="Form_itemLabelContent"]')].filter(visible).map(label=>({
    field:label.innerText.trim().replace(/^重要/,''),
    required:!!label.parentElement.querySelector('[class*="Form_itemRequired"]'),
    important:label.innerText.startsWith('重要'),rowId:label.closest('[data-testid="beast-core-form-item"]')?.id||'',
  }));
}
export async function assertRequiredAttributeInput(driver,config){
  const fields=await driver.read(readRequiredDom),basic=config.pdd.basic;
  for(const field of fields.filter(f=>f.required&&f.rowId.startsWith('basic.propertys.'))){
    if(field.field==='材质成分'){materialComponents(basic);continue;}
    if(missing(basic[field.field])&&!(field.field==='材质'&&!missing(basic['面料俗称'])))
      throw Error('当前类目必填属性未提供：'+field.field+'；请补充商品表基础信息');
  }
  return fields;
}
export async function assertRequiredMediaInput(driver,config){
  const fields=await driver.read(readRequiredDom),p=config.product;
  const values={'包装标签图':p.materialTagImages?.length,'商品视频':p.video,'商品讲解视频':p.explanationVideo,'商详视频':p.detailVideo,'白底图':p.whiteBackgroundImage,'长图':p.longImage};
  for(const field of fields.filter(f=>f.required&&Object.hasOwn(values,f.field)))if(!values[field.field])throw Error('当前类目已将'+field.field+'设为必填，请补充此项素材');
}
