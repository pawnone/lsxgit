export const SUIT_CATEGORY='服装 > 女装 > 时尚套装';
export const KNIT_CATEGORY='服装 > 女装 > 针织衫/毛衣/羊毛衫';
export const SUPPORTED_CATEGORIES=[SUIT_CATEGORY,KNIT_CATEGORY];
const single=['厚度','领型','服装版型','袖型','衣门襟','袖长','衣长','款式','适用人群','产地','毛线粗细','商品类型','安全等级','是否加大码','腰型','弹力','下摆设计','是否商场同款'];
const multi=['功能','流行元素','服饰工艺','图案','适用季节','里料材质','辅料材质'];
export const KNIT_ATTRIBUTES=[
 ...single.map(label=>({label,type:'single',note:'选填；填写平台完整选项，不按商品名称推断'})),
 ...multi.map(label=>({label,type:'multi',max:5,note:'选填；多个选项用顿号“、”分隔，最多5项'})),
 {label:'上市时间',type:'text',note:'选填；按平台要求填写文本，不填Excel日期或公式'},
 {label:'里料材质成分含量',type:'text',note:'选填；与里料材质保持一致，例如棉90% 麻10%'},
 {label:'克重',type:'number',note:'选填；填写大于0的数字，单位g，不输入单位'},
];
export function assertCategory(category){
 if(!SUPPORTED_CATEGORIES.includes(category))throw Error(`尚未适配类目：${category||'未填写'}；当前支持时尚套装与针织衫/毛衣/羊毛衫`);
}
export function normalizeCategoryAttributes(category,raw){
 assertCategory(category);
 if(category===SUIT_CATEGORY){
  if(raw && Object.values(raw).some(v=>v!==''&&v!=null&&(!Array.isArray(v)||v.length)))throw Error('时尚套装不能使用针织衫类目属性，请使用对应模板');
  return undefined;
 }
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('针织衫属性资料缺失，请使用基础信息合并版针织衫模板');
 for(const key of Object.keys(raw))if(!KNIT_ATTRIBUTES.some(f=>f.label===key))throw Error(`基础信息包含未支持属性字段：${key}`);
 const result={};
 for(const f of KNIT_ATTRIBUTES){
  const value=raw[f.label];
  if(value==null||value===''||Array.isArray(value)&&value.length===0)continue;
  if(/【|待填写|待确认/.test(String(value)))throw Error(`基础信息属性未填写：${f.label}`);
  if(f.type==='multi'){
   if(!Array.isArray(value)&&typeof value!=='string')throw Error(`${f.label}请填写文本，多个选项用顿号分隔`);
   const values=(Array.isArray(value)?value:String(value).split('、')).map(v=>typeof v==='string'?v.trim():'');
   if(values.some(v=>!v)||values.length>f.max||new Set(values).size!==values.length)throw Error(`${f.label}选项不能为空或重复，最多${f.max}项`);
   result[f.label]=values;
  }else if(f.type==='number'){
   if(!/^(\d+)(\.\d+)?$/.test(String(value))||!Number.isFinite(Number(value))||Number(value)<=0)throw Error(`${f.label}必须填写大于0的数字（单位g）`);
   result[f.label]=Number(value);
  }else{
   if(typeof value!=='string' || !value.trim() || f.type==='single'&&value.includes('、'))throw Error(`${f.label}请填写${f.type==='single'?'单个平台完整选项':'文本'}`);
   if(value.length>300)throw Error(`${f.label}内容过长`);
   result[f.label]=value.trim();
  }
 }
 return result;
}
