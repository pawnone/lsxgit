import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {parseWorkbook} from './core/prepare-product.mjs';
import {missing,requiredKey,requiredBasic,REQUIRED_SERVICE} from './field-policy.mjs';
import {normalizeWorkbook} from './workbook-layout.mjs';
import {isKnit,SET_CATEGORY,KNIT_CATEGORY,categoryOnlyFields} from './categories.mjs';
import {materialComponents} from './composition.mjs';

const named=name=>/pdd商品信息表\.xlsx$/i.test(name)||/^商品信息(?:表)?\.xlsx$/i.test(name);
export function workbookCandidates(files,root){
  const allowed=files.filter(f=>/\.xlsx$/i.test(f)&&!path.basename(f).startsWith('~$')&&
    [root,path.join(root,'商品信息'),path.join(root,'商品资料'),path.join(root,'基本信息')].includes(path.dirname(f)));
  const recognized=allowed.filter(f=>named(path.basename(f)));
  return recognized.length?recognized:allowed.filter(f=>!/备份|backup/i.test(path.basename(f)));
}
export async function readWorkbook(root,files){
  const candidates=workbookCandidates(files,root);
  if(candidates.length!==1)throw Error('商品信息需要唯一一份可识别的Excel（可放商品根目录或商品信息目录），找到'+candidates.length+'份：'+candidates.map(f=>path.relative(root,f)).join('、'));
  const source=new ExcelJS.Workbook();await source.xlsx.readFile(candidates[0]);
  const normalized=normalizeWorkbook(source),wb=normalized.workbook;
  // The observed merchant editor fixes the promotion threshold at two items.
  // A compact sheet needs only its rate; explicit legacy enable/disable fields
  // still take precedence. Runtime readback checks the actual fixed threshold.
  const basic=wb.getWorksheet('基础信息');
  const inputIssues=[],ignoredFields=[];
  if(basic){
    const fields=new Map();basic.eachRow(row=>fields.set(row.getCell(1).value,row));
    const type=fields.get('商品类型'),category=fields.get('完整类目路径');let selectedCategory=category?.getCell(2).value;
    if(type){
      const selected=String(type.getCell(2).value||'').trim(),mapped={'时尚套装':SET_CATEGORY,'针织衫':KNIT_CATEGORY}[selected];
      if(!mapped)inputIssues.push({cell:'基础信息!B'+type.number,message:'商品类型请选择“时尚套装”或“针织衫”'});
      else{
        selectedCategory=mapped;
        const value=category?.getCell(2).value;
        // Category is derived from the current type, never a formula's stale cache.
        if(typeof value==='string'&&value.trim()&&value.trim()!==mapped)inputIssues.push({cell:'基础信息!B'+category.number,message:'完整类目路径与商品类型冲突，请核对两处数据'});
        if(category)category.getCell(2).value=mapped;else basic.addRow(['完整类目路径',mapped]);
      }
      for(const key of ['商品货号','折扣（几折）'])if(missing(fields.get(key)?.getCell(2).value))inputIssues.push({cell:'基础信息:' +key,message:key+'为当前模板必填项'});
    }
    const rate=fields.get('折扣（几折）')?.getCell(2).value,mode=fields.get('满件折扣');
    const enabled=missing(mode?.getCell(2).value)?!missing(rate):mode.getCell(2).value==='启用';
    if(!mode)basic.addRow(['满件折扣',enabled?'启用':'停用']);else if(missing(mode.getCell(2).value))mode.getCell(2).value=enabled?'启用':'停用';
    if(enabled&&!fields.has('满件数量'))basic.addRow(['满件数量',2]);
    if(Object.hasOwn(categoryOnlyFields,selectedCategory))for(const [category,keys]of Object.entries(categoryOnlyFields)){
      if(category===selectedCategory)continue;
      for(const key of keys){const row=fields.get(key);if(!row)continue;if(!missing(row.getCell(2).value))ignoredFields.push(key);row.values=[];}
    }
  }
  const raw=parseWorkbook(wb),locations=new Map();raw.issues.push(...inputIssues);
  const rate=raw.basic['折扣（几折）'];
  if(!missing(rate)&&(!Number.isFinite(Number(rate))||Number(rate)<5||Number(rate)>9.9))raw.issues.push({cell:'基础信息:折扣（几折）',message:'折扣须为5.0～9.9折'});
  for(const name of ['基础信息','服务与承诺']){
    const sheet=wb.getWorksheet(name);
    sheet?.eachRow(row=>{if(typeof row.getCell(1).value==='string')locations.set(name+'!B'+row.number,{sheet:name,key:row.getCell(1).value.trim()});});
  }
  const controls={'适用平台':'拼多多','平台尺码表':'停用','详情尺码图':'保留','最终操作':'保存草稿','资料已核对':'是'};
  raw.issues=raw.issues.filter(issue=>{
    if(issue.message==='缺少工作表'&&issue.cell==='个别尺码调整（选填）')return false;
    const loc=locations.get(issue.cell);
    if(loc&&issue.message.endsWith('尚未填写完整'))return requiredKey(loc.sheet,loc.key,loc.sheet==='基础信息'?raw.basic:raw.service);
    for(const [key,value] of Object.entries(controls))if(issue.message===key+'必须为“'+value+'”'&&missing(raw.basic[key]))return false;
    if(issue.message==='缺少必需字段行'){
      const [sheet,key]=issue.cell.split(':');return key==='商品业务标识'?false:requiredKey(sheet,key,sheet==='基础信息'?raw.basic:raw.service);
    }
    if(/规格编码前缀或覆盖编码缺失|主图编号必须为两位文本/.test(issue.message))return false; // Optional SKU columns; resolve explicitly below.
    if(issue.message==='状态必须为启用或停用'){
      const [sheet,address]=issue.cell.split('!');
      if(missing(wb.getWorksheet(sheet)?.getCell(address).value))return false;
    }
    return true;
  });
  for(const [sheet,values,keys] of [['基础信息',raw.basic,requiredBasic(raw.basic)],['服务与承诺',raw.service,REQUIRED_SERVICE]])for(const key of keys)
    if(missing(values[key])&&!raw.issues.some(i=>i.cell===(sheet+':'+key)||i.message===key+'尚未填写完整'))raw.issues.push({cell:sheet+':'+key,message:key+'为当前类目必填项'});
  if(isKnit(raw.basic)){try{materialComponents(raw.basic);}catch(e){raw.issues.push({cell:'基础信息:材质成分',message:e.message});}}
  else if(missing(raw.basic['材质'])&&missing(raw.basic['面料俗称']))raw.issues.push({cell:'基础信息:材质',message:'材质为必填；可提供面料俗称供平台派生材质'});
  for(const values of [raw.basic,raw.service])for(const key of Object.keys(values))if(missing(values[key])&&!requiredKey(values===raw.basic?'基础信息':'服务与承诺',key,values))delete values[key];
  for(const sku of raw.skus){
    sku.code=missing(sku.code)||/^(?:不填写|不适用|无)\s/.test(String(sku.code))?'':String(sku.code);
    sku.image=missing(sku.image)?null:/^\d{1,2}$/.test(String(sku.image))?String(sku.image).padStart(2,'0'):String(sku.image);
    if(missing(sku.state))sku.state=null;
  }
  raw.basic['商品业务标识'] ||=raw.basic['商品货号']||path.basename(root);
  raw.issues=raw.issues.map(issue=>({...issue,cell:normalized.addresses.get(issue.cell)||issue.cell||'商品信息'}));
  return{...raw,ignoredFields,infoFile:path.basename(candidates[0]),infoPath:path.relative(root,candidates[0]).split(path.sep).join('/')};
}
