import ExcelJS from 'exceljs';
import {KNIT_CATEGORY,KNIT_ATTRIBUTES,normalizeCategoryAttributes,assertCategory} from './category-rules.mjs';
export const baseFields=[
 ['商品名称','title','必填'],['货号','itemCode','必填；两个商品不能重复'],['品牌','brand','必填；无品牌请填无品牌'],['完整类目路径','categoryPath','支持时尚套装、针织衫/毛衣/羊毛衫；填写完整路径'],['材质名称','material','按吊牌精确填写'],['材质含量（%）','materialPercent','填写1–100的数字，例如100，不输入百分号'],['现货库存','inStock','每个SKU最终库存，填写非负整数'],['预售库存','preSale','每个SKU最终库存，填写非负整数'],['发货模式','shippingMode','当前支持现货预售混合'],['现货发货时间','inStockDelivery','已确认48小时'],['预售周期','preSaleDelivery','例如15天'],['库存计数','stockCountMode','已确认下单减库存'],['运费模板','freightTemplate','填写店铺实际模板名称'],['售后政策','returnPolicy','填写店铺实际选项名称'],['最终操作','operation','固定保存草稿，不发布'],['组合件数','pieceCount','必填，使用平台选项：单件、两件等'],['适用年龄','applicableAge','必填，填写平台完整年龄选项，不自动换算'],['风格','style','必填，填写平台风格名称；多个用顿号分隔']];
export async function readExcelProduct(file) {
 const book=new ExcelJS.Workbook();await book.xlsx.readFile(file);
 const sheet=name=>{const s=book.getWorksheet(name);if(!s)throw new Error(`Excel缺少工作表：${name}`);return s;};
 for(const s of book.worksheets)s.eachRow(row=>row.eachCell(c=>{if(c.value&&typeof c.value==='object'&&('formula'in c.value||'sharedFormula'in c.value||'error'in c.value))throw new Error(`${s.name}!${c.address} 请填实际值，不使用公式或错误值`);}));
 const value=c=>{let v=c.value;if(v?.richText)v=v.richText.map(x=>x.text).join('');if(v==null)return '';if(typeof v!=='string'&&typeof v!=='number')throw new Error(`${c.worksheet.name}!${c.address} 类型无效`);return typeof v==='string'?v.trim():v;};
 const required=(v,label)=>{if(v===''||/【|待填写|待确认/.test(String(v)))throw new Error(`Excel未填写：${label}`);return v;};
 const number=(v,label,integer=false)=>{required(v,label);if(!/^(\d+)(\.\d+)?$/.test(String(v)))throw new Error(`${label} 必须填非负数字`);const n=Number(v);if(!Number.isFinite(n)||(integer&&!Number.isInteger(n)))throw new Error(`${label} 数字无效`);return n;};
 const b=sheet('基础信息'),f={};
 const simple=book.getWorksheet('素材说明')?.getCell('A1').value==='素材自动识别';
 const selectedPlatform=['上架平台','适用平台'].includes(value(b.getCell('A2')))?String(value(b.getCell('B2'))):'抖店';
 if(selectedPlatform!=='抖店')throw new Error(`平台“${selectedPlatform}”尚未接入，当前只能选择抖店；不会套用抖店规则执行`);
 if(simple && !['上架平台','适用平台'].includes(value(b.getCell('A2'))))throw new Error('缺少上架平台选项');
const missing=[];
baseFields.forEach(([label,key],i)=>{const row=i+4;if(value(b.getCell(row,1))!==label)throw new Error(`基础信息!A${row} 标签已改变，应为：${label}`);const v=value(b.getCell(row,2));if(v===''||/【|待填写|待确认/.test(String(v)))missing.push(`${label}（基础信息!B${row}）`);else f[key]=v;});
if(missing.length)throw new Error(`Excel未填写：${missing.join('、')}；请补齐后重新预检`);
 assertCategory(String(f.categoryPath));
 let categoryAttributes;
 const legacy=book.getWorksheet('类目属性');
 const inlineRows=[];
 for(let r=22;r<=b.rowCount;r++){
  const label=value(b.getCell(r,1)),v=value(b.getCell(r,2));
  if(label===''&&v==='')continue;
  inlineRows.push({label,v,row:r});
 }
 if(String(f.categoryPath)===KNIT_CATEGORY){
  if(inlineRows.length&&legacy)throw Error('针织衫属性同时存在于基础信息和旧工作表，请合并后只保留一处，避免重复填写');
  let rows,source;
  if(inlineRows.length){rows=inlineRows;source='基础信息';}
  else if(legacy){
   if(value(legacy.getCell('A2'))!=='完整类目路径'||value(legacy.getCell('B2'))!==f.categoryPath)throw Error('旧类目属性工作表与基础信息的类目路径不一致');
   if(value(legacy.getCell('A4'))!=='字段名称'||value(legacy.getCell('B4'))!=='填写内容')throw Error('旧类目属性表头应为字段名称、填写内容');
   rows=[];source='类目属性';
   for(let r=5;r<=legacy.rowCount;r++){const label=value(legacy.getCell(r,1)),v=value(legacy.getCell(r,2));if(label!==''||v!=='')rows.push({label,v,row:r});}
  }else throw Error('针织衫基础信息缺少属性字段，请使用合并版针织衫模板（仍兼容旧类目属性工作表）');
  const raw={},seen=new Set();
  for(const {label,v,row}of rows){
   if(!KNIT_ATTRIBUTES.some(f=>f.label===label))throw Error(source+'!A'+row+' 未知属性字段：'+label);
   if(seen.has(label))throw Error('属性字段重复：'+label);seen.add(label);raw[label]=v;
  }
  const missing=KNIT_ATTRIBUTES.filter(f=>!seen.has(f.label));
  if(missing.length)throw Error('模板缺少属性字段行：'+missing.map(f=>f.label).join('、'));
  categoryAttributes=normalizeCategoryAttributes(String(f.categoryPath),raw);
 }else{
  if(inlineRows.length)throw Error('时尚套装基础信息包含其他类目的属性，请使用对应套装模板');
  if(legacy){
   if(value(legacy.getCell('B2'))!==f.categoryPath)throw Error('旧类目属性工作表与基础信息的类目路径不一致');
   for(let r=5;r<=legacy.rowCount;r++)if(value(legacy.getCell(r,2))!=='')throw Error('时尚套装不能填写针织衫属性');
  }
 }
 if(f.operation!=='保存草稿')throw new Error('仅允许保存草稿');
 const materialPercent=number(f.materialPercent,'材质含量');if(materialPercent<=0||materialPercent>100)throw new Error('材质含量必须大于0且不超过100');
 const specs=sheet('款式与尺码'),colors=[],sizes=[],sizeChart=[],skuMatrix=[];
 const compact=value(specs.getCell('C4'))==='统一售价（元）';
 const imageColumn=compact&&value(specs.getCell('D4'))==='对应主图编号';
 for(const [row,label]of (compact?[[4,'款式名称'],[18,'尺码']]:[[4,'款式名称'],[18,'尺码'],[34,'款式名称（需完全一致）']]))if(value(specs.getCell(row,1))!==label)throw new Error('款式与尺码表结构已改变，请不要插入或删除行');
 specs.eachRow((row,r)=>{if(r>(compact?31:54)&&row.values.some(v=>v!=null&&v!==''))throw new Error('填写超出模板容量，请扩展模板后再运行');});
 const rows=(from,to,cols,fn,source=specs)=>{for(let r=from;r<=to;r++){const vals=Array.from({length:cols},(_,i)=>value(source.getCell(r,i+1)));if(vals.some(v=>v!==''))fn(vals,r);}};
 rows(5,14,compact&&!imageColumn?3:4,([name,remark,third,fourth],r)=>{const actualColor=compact?'':third,price=compact?third:fourth;colors.push({name:required(name,`款式第${r}行名称`),remark:required(remark,`款式第${r}行备注`),actualColor,...(imageColumn?{mainImageNo:String(required(fourth,`款式第${r}行对应主图编号`)).padStart(2,'0')} : {}),price:number(price,`款式第${r}行价格`)});});
 rows(19,30,5,([name,h1,h2,w1,w2],r)=>{required(name,`尺码第${r}行`);const height=[number(h1,'身高下限'),number(h2,'身高上限')],weight=[number(w1,'体重下限'),number(w2,'体重上限')];if(height[0]<=0||weight[0]<=0||height[0]>height[1]||weight[0]>weight[1])throw new Error(`尺码第${r}行区间无效`);sizes.push({name:String(name),remark:`${weight[0]}–${weight[1]}斤`});sizeChart.push({size:String(name),height,weight});});
 const adjustments=compact?sheet('个别尺码调整（选填）'):specs;
 if(compact)adjustments.eachRow((row,r)=>{if(r>24&&row.values.some(v=>v!=null&&v!==''))throw new Error('个别尺码调整超出20条容量');});
 rows(compact?5:35,compact?24:54,5,([color,size,price,inStock,preSale],r)=>{const row={color:required(color,`个别尺码调整第${r}行款式`),size:String(required(size,`个别尺码调整第${r}行尺码`))};for(const [key,v]of Object.entries({price,inStock,preSale}))if(v!=='')row[key]=number(v,`个别尺码调整第${r}行${key}`,key!=='price');if(Object.keys(row).length===2)throw new Error(`个别尺码调整第${r}行未填写覆盖值`);skuMatrix.push(row);},adjustments);
 if(!colors.length||!sizes.length)throw new Error('至少填写一个款式和一个尺码');
 const codes=book.getWorksheet('商家编码');
 if(codes){
  if([1,2,3].map(c=>value(codes.getCell(1,c))).join('|')!=='款式名称|尺码|商家编码')throw new Error('商家编码表应为款式名称、尺码、商家编码三列；请删除重复价格列');
  const seen=new Set(),usedCodes=new Set();
  for(let r=2;r<=codes.rowCount;r++){
   const color=value(codes.getCell(r,1)),size=value(codes.getCell(r,2)),code=codes.getCell(r,3).value;
   if(color===''&&size===''&&(code==null||code===''))continue;
   const c=colors.find(c=>c.name===color),sz=sizes.find(s=>s.name===String(size));const key=JSON.stringify([color,String(size)]);
   if(!c||!sz||seen.has(key))throw new Error(`商家编码!第${r}行款式尺码未知或重复`);seen.add(key);
   if(typeof code!=='string'||!code.trim())throw new Error(`商家编码!C${r} 必须填写文本编码；数字编码也请使用文本格式，避免丢失前导零`);
   if(usedCodes.has(code))throw new Error(`商家编码!C${r} 编码重复`);usedCodes.add(code);
   let row=skuMatrix.find(x=>x.color===color&&x.size===String(size));
   if(!row){row={color,size:String(size)};skuMatrix.push(row);}row.merchantCode=code;
  }
  if(seen.size!==colors.length*sizes.length)throw new Error('商家编码表必须覆盖全部款式与尺码');
 }
 let mediaInfo;
 if(simple) mediaInfo={assetMode:'directory',targetPlatform:'doudian'};
 else {
 const media=sheet('图片与视频'),get=r=>value(media.getCell(r,2));
 for(const [r,label]of [[4,'主图1'],[5,'主图2'],[6,'主图3'],[7,'主图4'],[8,'主图5'],[10,'吊牌/水洗标'],[12,'是否有白底图'],[13,'白底图路径'],[16,'是否有视频'],[17,'视频路径']])if(value(media.getCell(r,1))!==label)throw new Error('图片与视频表结构已改变');
 const flag=(r,label)=>{const v=get(r);if(!['有','无'].includes(v))throw new Error(`${label}请选择有或无`);return v;};
 const optional=(flagRow,pathRow,label)=>{const yes=flag(flagRow,label)==='有',v=get(pathRow);if(yes)return required(v,label+'路径')==='无'?(()=>{throw new Error(label+'已选有但路径为无');})():String(v);if(v!==''&&v!=='无')throw new Error(label+'已选无，请清空路径或填无');return '';};
 mediaInfo={mainImages:[4,5,6,7,8].map(r=>String(required(get(r),`主图${r-3}路径`))),materialTagImage:String(required(get(10),'吊牌图路径')),whiteBackgroundImage:optional(12,13,'白底图'),whiteBackgroundFor:String(get(14)),video:optional(16,17,'视频'),videoDeclaredNone:get(16)==='无'};
 }
 return {...(categoryAttributes!==undefined?{categoryAttributes}:{}),title:String(f.title),itemCode:String(f.itemCode),brand:String(f.brand),categoryPath:String(f.categoryPath),material:String(f.material),materialPercent,pieceCount:String(f.pieceCount),applicableAge:String(f.applicableAge),style:String(f.style),composition:`${materialPercent}% ${f.material}`,...mediaInfo,colors,sizes,sizeChart,skuMatrix,inventory:{shippingMode:f.shippingMode,inStockDelivery:f.inStockDelivery,preSaleDelivery:f.preSaleDelivery,inStock:number(f.inStock,'现货库存',true),preSale:number(f.preSale,'预售库存',true),stockOperation:'set-final-value',stockCountMode:f.stockCountMode},service:{freightTemplate:f.freightTemplate,returnPolicy:f.returnPolicy}};
}
