import ExcelJS from 'exceljs';
import {KNIT_CATEGORY,SUIT_CATEGORY,KNIT_ATTRIBUTES} from '../engine/doudian/category-rules.mjs';
import {baseFields} from '../engine/doudian/excel-product.mjs';
export function addKnitAttributes(book,values={}){
 if(book.getWorksheet('类目属性'))throw Error('已有类目属性工作表，停止重复导入');
 const s=book.addWorksheet('类目属性',{views:[{state:'frozen',ySplit:4}],properties:{tabColor:{argb:'FF2563EB'}}});
 s.columns=[{width:26},{width:36},{width:12},{width:64}];
 s.mergeCells('A1:D1');s.getCell('A1').value='针织衫 / 毛衣 / 羊毛衫 · 类目属性';s.getRow(1).height=34;
 s.getCell('A2').value='完整类目路径';s.mergeCells('B2:D2');s.getCell('B2').value=KNIT_CATEGORY;s.getRow(2).height=32;
 s.mergeCells('A3:D3');s.getCell('A3').value='只填黄色格。空白选填项不主动填写后台；平台实际要求必填时会停止提示。多选用顿号“、”分隔。品牌、货号、组合件数、适用年龄、风格仍填在基础信息，不重复填写。';s.getRow(3).height=52;
 s.getRow(4).values=['字段名称','填写内容','控件类型','填写说明'];
 const types={single:'单选',multi:'多选',text:'文本',number:'数字'};
 for(const [i,f]of KNIT_ATTRIBUTES.entries()){
  const r=s.getRow(i+5);r.values=[f.label,values[f.label]??'',types[f.type],f.note];r.height=34;
  r.getCell(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF1CE'}};
  r.getCell(2).font={name:'微软雅黑',size:11,color:{argb:'FF174DB2'}};
  r.getCell(2).numFmt=f.type==='number'?'0.##':'@';
  r.getCell(2).note='来源：用户提供的针织衫后台属性截图。按商品真实资料和平台精确选项填写，空白不推断。';
  r.getCell(2).dataValidation=f.type==='number'?{type:'decimal',operator:'greaterThan',formulae:[0],allowBlank:true,showErrorMessage:true,error:'请填写大于0的数字，不带g单位'}:{type:'textLength',operator:'lessThanOrEqual',formulae:[300],allowBlank:true,showErrorMessage:true,error:'请填写300字以内的文本'};
 }
 s.eachRow((r,n)=>r.eachCell({includeEmpty:true},(c,col)=>{
  c.alignment={vertical:'middle',wrapText:true};
  if(!(n>=5&&col===2))c.font={name:'微软雅黑',size:n===1?16:11,bold:n<=4,color:{argb:n===1||n===4?'FFFFFFFF':'FF223047'}};
  if(n===1||n===4)c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF173A68'}};
  c.border={bottom:{style:'hair',color:{argb:'FFDCE3EC'}}};
 }));
 s.pageSetup={orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0};
 return s;
}
export function mergeKnitIntoBase(book){
 const b=book.getWorksheet('基础信息');if(!b)throw Error('缺少基础信息工作表');
 if(b.getCell('B7').value!==KNIT_CATEGORY)throw Error('仅合并针织衫模板');
 const legacy=book.getWorksheet('类目属性'),values={},seen=new Set();
 function collect(sheet,from){for(let r=from;r<=sheet.rowCount;r++){
  const label=sheet.getCell(r,1).value,v=sheet.getCell(r,2).value;
  if((label==null||label==='')&&(v==null||v===''))continue;
  if(!KNIT_ATTRIBUTES.some(f=>f.label===label))throw Error('不能覆盖未识别的基础信息内容：'+label);
  if(seen.has(label))throw Error('属性在多处重复：'+label);seen.add(label);values[label]=v;
 }}
 collect(b,22);if(legacy){if(legacy.getCell('B2').value!==KNIT_CATEGORY)throw Error('旧工作表类目不符');collect(legacy,5);}
 if(seen.size&&seen.size!==KNIT_ATTRIBUTES.length)throw Error('属性行不完整，停止迁移');
 const merged=b.getCell('C3').value==='填写要求';
 if(!merged)for(let r=4;r<=21;r++)b.getCell(r,4).value=b.getCell(r,3).value;
 b.getCell('A3').value='字段名称';b.getCell('B3').value='填写内容';b.getCell('C3').value='填写要求';b.getCell('D3').value='填写说明';
 b.columns=[{width:28},{width:48},{width:12},{width:62}];
 if(b.getCell('A1').isMerged)b.unMergeCells('A1');b.mergeCells('A1:D1');
 b.views=[{state:'frozen',ySplit:3}];
 for(let r=4;r<=21;r++)b.getCell(r,3).value='必填';
 for(const [i,f]of KNIT_ATTRIBUTES.entries()){
  const row=i+22;b.getCell(row,1).value=f.label;b.getCell(row,2).value=values[f.label]??null;b.getCell(row,3).value='选填';b.getCell(row,4).value=f.note;
  b.getCell(row,1).style=structuredClone(b.getCell('A21').style);b.getCell(row,2).style=structuredClone(b.getCell('B21').style);
  b.getCell(row,2).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF1CE'}};
  b.getCell(row,2).numFmt=f.type==='number'?'0.##':'@';
  b.getCell(row,2).dataValidation=f.type==='number'?{type:'decimal',operator:'greaterThan',formulae:[0],allowBlank:true,showErrorMessage:true,error:'请填大于0的数字，不带g单位'}:{type:'textLength',operator:'lessThanOrEqual',formulae:[300],allowBlank:true};
  b.getCell(row,2).note='按真实商品和平台选项填写；选填空白不推断。';
 }
 for(let r=3;r<=21+KNIT_ATTRIBUTES.length;r++){
  b.getRow(r).height=r===3?28:36;
  for(let c=1;c<=4;c++){const cell=b.getCell(r,c);cell.alignment={vertical:'middle',wrapText:true};if(c===3||c===4)cell.font={name:'微软雅黑',size:11,color:{argb:'FF334155'}};}
  if(r===3)for(let c=1;c<=4;c++){b.getCell(r,c).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF173A68'}};b.getCell(r,c).font={name:'微软雅黑',size:11,bold:true,color:{argb:'FFFFFFFF'}};}
 }
 b.pageSetup={orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0};
 if(legacy)book.removeWorksheet(legacy.id);
 const guide=book.getWorksheet('填写指南');if(guide)guide.getCell('B4').value='商品属性全部在基础信息填写：必填项补齐，选填项按实际填写；款式尺码、商家编码仍使用各自工作表。';
 book.views=[{activeTab:0,firstSheet:0}];
 return b;
}
export async function blankTemplateFrom(source,category,out){
 const book=new ExcelJS.Workbook();await book.xlsx.readFile(source);
 const b=book.getWorksheet('基础信息');
 for(const [i]of baseFields.entries())b.getCell(i+4,2).value=null;
 b.getCell('B7').value=category;
 if(b.getCell('C3').value==='填写要求')b.getCell('D7').value='填写本模板对应的完整类目路径';else b.getCell('C7').value='填写本模板对应的完整类目路径';
 for(const [key,value]of Object.entries({B2:'抖店',B18:'保存草稿'}))b.getCell(key).value=value;
 if(book.getWorksheet('类目属性'))book.removeWorksheet(book.getWorksheet('类目属性').id);
 if(b.rowCount>21)b.spliceRows(22,b.rowCount-21);
 const specs=book.getWorksheet('款式与尺码');
 for(const [from,to,cols]of [[5,14,4],[19,30,5]])for(let r=from;r<=to;r++)for(let c=1;c<=cols;c++)specs.getCell(r,c).value=null;
 const adjustments=book.getWorksheet('个别尺码调整（选填）');if(adjustments)for(let r=5;r<=24;r++)for(let c=1;c<=5;c++)adjustments.getCell(r,c).value=null;
 const codes=book.getWorksheet('商家编码');if(codes){for(let r=2;r<=codes.rowCount;r++)for(let c=1;c<=3;c++)codes.getCell(r,c).value=null;}
 const guide=book.getWorksheet('填写指南');if(guide){guide.getCell('B4').value='商品属性全部在基础信息填写；款式尺码、商家编码仍使用各自工作表。';guide.getCell('B12').value=category+'、5张主图、现货预售混合、单一材质100%；最终只保存草稿';guide.getCell('B13').value='仅预填对应类目、抖店与保存草稿，其他值按真实商品填写。';}
 if(category===KNIT_CATEGORY)mergeKnitIntoBase(book);
 else if(category!==SUIT_CATEGORY)throw Error('未知模板类目');
 await book.xlsx.writeFile(out);
}
