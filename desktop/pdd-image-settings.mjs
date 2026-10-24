import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import {inputFiles} from '../engine/pdd/product.mjs';
import {discoverMaterials} from '../engine/pdd/material-discovery.mjs';
import {workbookCandidates} from '../engine/pdd/workbook-reader.mjs';
import {MAIN_FIRST,normalizeImageRef} from '../engine/pdd/image-order.mjs';
import {workbookLayout,fieldTable} from '../engine/pdd/workbook-layout.mjs';

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const backupsName='.wq-image-settings';
const relative=(root,file)=>path.relative(root,file).split(path.sep).join('/');
const within=(root,file)=>file===root||(!path.relative(root,file).startsWith('..'+path.sep)&&path.relative(root,file)!=='..'&&!path.isAbsolute(path.relative(root,file)));
async function scope(root,product){
  const base=await fs.realpath(root),dir=await fs.realpath(product);
  if(!within(base,dir)||(await fs.lstat(product)).isSymbolicLink())throw Error('商品不在当前素材库内');
  return dir;
}
const value=cell=>cell.value===null?'':typeof cell.value==='string'||typeof cell.value==='number'?String(cell.value).trim():null;
function fieldRow(sheet,key){
  const table=fieldTable(sheet),found=table.rows.filter(row=>row.key===key);
  if(found.length>1)throw Error('基础信息存在重复字段：'+key);
  return found[0]?{row:sheet.getRow(found[0].row),cell:sheet.getCell(found[0].row,table.columns.value)}:null;
}
async function checkLock(workbook){
  const folder=path.dirname(workbook),name=path.basename(workbook);
  const names=await fs.readdir(folder);
  if(names.includes('~$'+name)||names.includes('.~lock.'+name+'#'))throw Error('商品信息表可能仍在 Excel/WPS 中打开，请保存并关闭后再次确认首图；尚未修改文件');
}

// Complete original copies are retained before restoring any interrupted write.
// Only files whose bytes match the journal may be replaced; external edits stop
// recovery, leaving the backup available rather than overwriting newer data.
async function recoverInterrupted(dir,backup,journal){
  const wb=path.resolve(dir,journal.workbook||'');
  if(!within(dir,wb)||!Array.isArray(journal.mapping)||!journal.mapping.length)throw Error('图片设置恢复记录无效');
  await checkLock(wb);
  const currentWorkbook=await fs.readFile(wb),originalWorkbook=await fs.readFile(path.join(backup,'workbook.xlsx'));
  if(sha(originalWorkbook)!==journal.workbookHash||![journal.workbookHash,journal.nextHash].includes(sha(currentWorkbook)))throw Error('商品表已被外部修改，不能自动恢复图片设置；备份：'+backup);
  const originals=[],allowed=new Map();
  for(const [i,m] of journal.mapping.entries()){
    const from=path.resolve(dir,m.from),to=path.resolve(dir,m.to);
    if(!within(dir,from)||!within(dir,to))throw Error('图片恢复路径超出商品目录');
    const copy=path.join(backup,'image-'+i+path.extname(from));
    let bytes=await fs.readFile(copy).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!bytes)bytes=await fs.readFile(from);
    if(sha(bytes)!==m.sha256)throw Error('原图恢复依据不完整，备份：'+backup);
    originals.push({from,copy,bytes});
    for(const file of [from,to]){const set=allowed.get(file)||new Set();set.add(m.sha256);allowed.set(file,set);}
  }
  const existing=[];
  for(const [file,hashes] of allowed){
    const stat=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!stat)continue;
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('恢复位置出现非普通文件：'+file);
    const bytes=await fs.readFile(file),hash=sha(bytes);
    if(!hashes.has(hash))throw Error('主图已被外部修改，不能自动恢复；备份：'+backup);
    existing.push({file,hash});
  }
  for(const o of originals)await fs.writeFile(o.copy,o.bytes,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  for(const e of existing){if(sha(await fs.readFile(e.file))!==e.hash)throw Error('恢复时图片再次变化，请核对备份：'+backup);await fs.unlink(e.file);}
  for(const o of originals)await fs.copyFile(o.copy,o.from,fs.constants.COPYFILE_EXCL);
  const live=sha(await fs.readFile(wb));
  if(![journal.workbookHash,journal.nextHash].includes(live))throw Error('恢复时商品表已被外部修改，备份：'+backup);
  if(live!==journal.workbookHash)await fs.writeFile(wb,originalWorkbook);
  journal.status='rolled-back';journal.recoveredAt=new Date().toISOString();
  await fs.writeFile(path.join(backup,'manifest.json'),JSON.stringify(journal,null,2));
}

export async function planPddImageSettings(root,product){
  const dir=await scope(root,product),backupRoot=path.join(dir,backupsName);
  try{if((await fs.lstat(backupRoot)).isSymbolicLink())throw Error('图片设置备份目录不能是符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}
  let recovered=false;
  for(const entry of await fs.readdir(backupRoot,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
    if(!entry.isDirectory())throw Error('图片设置备份目录异常');
    const file=path.join(backupRoot,entry.name,'manifest.json');
    const text=await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(text===null)continue; // No mutation is dispatched before the journal exists.
    const journal=JSON.parse(text);
    if(!['complete','rolled-back'].includes(journal.status)){await recoverInterrupted(dir,path.dirname(file),journal);recovered=true;}
  }
  const files=await inputFiles(dir),candidates=workbookCandidates(files,dir);
  if(candidates.length!==1)throw Error('需要唯一一份商品信息 Excel，才能同步图片引用');
  const workbook=candidates[0],bytes=await fs.readFile(workbook);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);
  const layout=workbookLayout(wb),basic=layout.basic?.sheet;
  if(!basic)throw Error('商品表缺少“基础信息”工作表');
  const source=discoverMaterials(dir,files).main.filter(f=>/\.(?:png|jpe?g)$/i.test(f));
  if(!source.length||source.length>10)throw Error('请提供1～10张主图；新素材通常只需5张');
  const stems=new Map(),mapping=[];
  for(const [index,file] of source.entries()){
    const stem=path.basename(file,path.extname(file)),filename=path.basename(file);
    if(stems.has(stem))throw Error('主图名称或编号重复，无法确定表格引用：'+stem);
    stems.set(stem,file);
    const to=path.join(path.dirname(file),String(index+1).padStart(2,'0')+path.extname(file));
    mapping.push({id:String(index+1).padStart(2,'0'),from:relative(dir,file),to:relative(dir,to),file,sha256:sha(await fs.readFile(file)),filename});
  }
  const destinations=new Set();
  for(const m of mapping){
    const key=m.to.normalize('NFKC').toLowerCase();
    if(destinations.has(key))throw Error('主图编号目标重复：'+m.to);destinations.add(key);
    const dest=path.join(dir,m.to);
    if(!source.includes(dest)&&files.some(f=>f.normalize('NFKC').toLowerCase()===dest.normalize('NFKC').toLowerCase()))throw Error('编号目标被其他文件占用：'+m.to);
  }
  const resolve=raw=>{
    const ref=normalizeImageRef(raw);if(!ref)return null;
    const exact=mapping.filter(m=>path.basename(m.file,path.extname(m.file))===ref||m.filename===ref||m.from===ref);
    if(exact.length>1)throw Error('图片引用不明确：'+ref);
    return exact[0]||(/^\d{2}$/.test(ref)?mapping[Number(ref)-1]:null)||null;
  };
  const references=[];
  const styles=layout.styles;
  if(styles?.columns.image)for(const r of styles.rows){
    const cell=styles.sheet.getCell(r,styles.columns.image);
    references.push({sheet:styles.sheet.name,address:cell.address,old:value(cell)});
  }
  const overrides=layout.adjustments;
  // Match the existing v0.1.2 reader's data range; row 22 is a merged help note.
  if(overrides?.columns.image)for(const r of overrides.rows){const cell=overrides.sheet.getCell(r,overrides.columns.image);references.push({sheet:overrides.sheet.name,address:cell.address,old:value(cell)});}
  for(const ref of references){
    if(ref.old===null)throw Error(ref.sheet+'!'+ref.address+' 只接受图片编号或文本，不能自动修改公式');
    const match=resolve(ref.old);
    if(ref.old&&!match&&!/^(?:不填写|不适用|无|【.*】)$/.test(ref.old))throw Error(ref.sheet+'!'+ref.address+' 的图片引用“'+ref.old+'”不存在，请先核对，未改动原文件');
    ref.next=match?match.id:ref.old;
  }
  const firstRow=fieldRow(basic,MAIN_FIRST),firstValue=firstRow?value(firstRow.cell):'';
  if(firstValue===null)throw Error('首图编号只接受编号或文件名，不能自动改写公式');
  const selected=resolve(firstValue)?.id||mapping[0].id;
  if(firstRow&&firstValue)references.push({sheet:basic.name,address:firstRow.cell.address,old:firstValue,next:resolve(firstValue)?.id||firstValue});
  const signature=sha(JSON.stringify({dir,workbook,workbookHash:sha(bytes),mapping,references}));
  return {dir,workbook,workbookHash:sha(bytes),signature,mapping,references,selected,recovered,changed:mapping.some(m=>m.from!==m.to),
    uniqueCount:new Set(mapping.map(m=>m.sha256)).size};
}

export async function applyPddImageSettings(root,product,signature,selection,{io=fs,rename=true,setFirst=true}={}){
  const plan=await planPddImageSettings(root,product);
  if(plan.signature!==signature)throw Error('图片或商品表已变化，请重新点击首图按钮');
  const selected=plan.mapping.find(m=>m.id===selection);
  if(!selected)throw Error('请选择一张首图');
  const original=await fs.readFile(plan.workbook);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(original);
  let tableChanged=false;
  for(const r of plan.references)if(rename&&r.old!==r.next){wb.getWorksheet(r.sheet).getCell(r.address).value=r.next;tableChanged=true;}
  const table=workbookLayout(wb).basic,basic=table.sheet;
  if(setFirst){
    const field=MAIN_FIRST;
    const stem=path.basename(selected.file,path.extname(selected.file));
    const ref=rename?selection:/^\d{1,2}$/.test(stem)?normalizeImageRef(stem):selected.filename;
    let row=fieldRow(basic,field);
    if(!row){
      const last=basic.lastRow,newRow=basic.addRow([]);
      if(last)for(let c=1;c<=basic.columnCount;c++)newRow.getCell(c).style=structuredClone(last.getCell(c).style);
      newRow.getCell(table.columns.key).value=field;newRow.getCell(table.columns.value).value=ref;
      if(table.columns.note)newRow.getCell(table.columns.note).value='主图首张与详情尺码表后的首张商品图共用此图';
      newRow.height=last?.height;row={row:newRow,cell:newRow.getCell(table.columns.value)};tableChanged=true;
    }else if(value(row.cell)!==ref){row.cell.value=ref;tableChanged=true;}
    row.cell.numFmt='@';
  }
  const renameChanged=rename&&plan.changed;
  if(!tableChanged&&!renameChanged)return {changed:false,count:plan.mapping.length,selected:selection};
  await checkLock(plan.workbook);
  const backup=path.join(plan.dir,backupsName,crypto.randomUUID());await fs.mkdir(backup,{recursive:true});
  await fs.writeFile(path.join(backup,'workbook.xlsx'),original,{flag:'wx'});
  const next=Buffer.from(await wb.xlsx.writeBuffer()),nextHash=sha(next);
  await fs.writeFile(path.join(backup,'next.xlsx'),next,{flag:'wx'});
  const journal={status:'pending',at:new Date().toISOString(),workbook:relative(plan.dir,plan.workbook),workbookHash:plan.workbookHash,nextHash,mapping:plan.mapping.map(({file,filename,...m})=>m),selection};
  const save=()=>fs.writeFile(path.join(backup,'manifest.json'),JSON.stringify(journal,null,2));
  await save();
  const moved=[],created=[];let wroteWorkbook=false;
  try{
    if(sha(await fs.readFile(plan.workbook))!==plan.workbookHash)throw Error('保存时商品表已被外部修改');
    for(const m of plan.mapping)if(sha(await fs.readFile(m.file))!==m.sha256)throw Error('保存时主图已被外部修改');
    await checkLock(plan.workbook);
    if(renameChanged){
      for(const [i,m] of plan.mapping.entries()){
        await io.rename(m.file,path.join(backup,'image-'+i+path.extname(m.file)));moved.push(m);
      }
      for(const [i,m] of plan.mapping.entries()){
        await io.copyFile(path.join(backup,'image-'+i+path.extname(m.file)),path.join(plan.dir,m.to),fs.constants.COPYFILE_EXCL);created.push(m);
      }
      for(const m of plan.mapping)if(sha(await fs.readFile(path.join(plan.dir,m.to)))!==m.sha256)throw Error('编号后图片内容校验失败');
    }
    if(tableChanged){
      if(sha(await fs.readFile(plan.workbook))!==plan.workbookHash)throw Error('保存时商品表已被外部修改');
      await io.rename(path.join(backup,'next.xlsx'),plan.workbook);wroteWorkbook=true;
      if(sha(await fs.readFile(plan.workbook))!==nextHash)throw Error('商品表写入校验失败');
    }
    journal.status='complete';await save();
    return {changed:true,count:plan.mapping.length,selected:selection,backup};
  }catch(error){
    try{
      if(wroteWorkbook){
        if(sha(await fs.readFile(plan.workbook))!==nextHash)throw Error('回滚时商品表已被外部修改');
        await fs.copyFile(path.join(backup,'workbook.xlsx'),plan.workbook);
      }
      for(const m of created){
        const file=path.join(plan.dir,m.to);
        if(sha(await fs.readFile(file))!==m.sha256)throw Error('回滚时图片已被外部修改');
        await fs.unlink(file);
      }
      for(const m of moved){
        const index=plan.mapping.indexOf(m);
        await fs.copyFile(path.join(backup,'image-'+index+path.extname(m.file)),m.file,fs.constants.COPYFILE_EXCL);
      }
      journal.status='rolled-back';await save();
    }catch{throw Error('设置写入中断，原图与商品表备份在 '+backup+'，请先恢复。'+error.message);}
    throw Error('主图设置未完成，已恢复改名前的图片和商品表。'+error.message);
  }
}
