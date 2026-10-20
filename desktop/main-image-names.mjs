import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {findInfoFile,readProductInfo} from '../engine/doudian/prepare-product.mjs';
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const backupName = '.wq-main-image-backups';
async function inside(root, product) {
 const realRoot=await fs.realpath(root), realProduct=await fs.realpath(product);
 if(path.dirname(realProduct)!==realRoot || (await fs.lstat(product)).isSymbolicLink())throw Error('商品必须是当前素材库下的直接子目录');
 const dir=path.join(realProduct,'主图');
 if((await fs.lstat(dir)).isSymbolicLink() || !(await fs.stat(dir)).isDirectory())throw Error('主图必须是普通文件夹');
 return {product:realProduct,dir};
}
export async function planMainImageNames(root, product) {
 const location=await inside(root,product),dir=location.dir;
 const backups=path.join(location.product,backupName);
 try {if((await fs.lstat(backups)).isSymbolicLink())throw Error('备份目录不能是符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const entry of await fs.readdir(backups,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
  if(!entry.isDirectory())throw Error('主图备份目录结构异常，请人工核实');
  const journal=JSON.parse(await fs.readFile(path.join(backups,entry.name,'manifest.json'),'utf8'));
  if(!['complete','rolled-back'].includes(journal.status))throw Error('检测到上次主图改名中断，请先根据主图备份记录人工恢复');
 }
 const infoFiles=[];
 for(const folder of [location.product,path.join(location.product,'商品信息')])
  for(const e of await fs.readdir(folder,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;}))if(e.isFile())infoFiles.push(path.join(folder,e.name));
 const infoFile=await findInfoFile(infoFiles,location.product);
 if(!infoFile || infoFile.error)throw Error('请先提供唯一的商品信息文件');
 const info=await readProductInfo(infoFile,location.product);
 if((info.product??info).assetMode!=='directory')throw Error('一键编号适用于当前Excel目录模板；旧版显式图片路径模板需先迁移，避免改名后引用失效');
 const entries=await fs.readdir(dir,{withFileTypes:true});
 if(entries.some(e=>!e.name.startsWith('.')&&!e.isFile()))throw Error('主图文件夹不能包含子文件夹或符号链接');
 const images=entries.filter(e=>e.isFile()&&!e.name.startsWith('.')&&/\.(jpe?g|png)$/i.test(e.name))
  .sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true})||(a.name<b.name?-1:1));
 if(entries.some(e=>!e.name.startsWith('.')&&/\.(webp|gif|bmp|avif)$/i.test(e.name)))throw Error('主图含未支持格式，请先转换成JPG或PNG，再编号');
 if(!images.length || images.length>99)throw Error('主图需要1至99张JPG或PNG图片');
 const mapping=[];
 for(const [i,e] of images.entries())mapping.push({from:e.name,to:String(i+1).padStart(2,'0')+path.extname(e.name),sha256:digest(await fs.readFile(path.join(dir,e.name)))});
 const names=new Set(mapping.map(e=>e.from.toLowerCase()));
 if(names.size!==mapping.length)throw Error('存在仅大小写不同的文件名，无法安全跨系统编号');
 for(const m of mapping)if(entries.some(e=>e.name.toLowerCase()===m.to.toLowerCase()&&!names.has(e.name.toLowerCase())))throw Error(`编号目标已被其他文件占用：${m.to}`);
 const infoHash=digest(await fs.readFile(infoFile));
 return {...location,mapping,signature:digest(JSON.stringify({mapping,infoFile,infoHash})),changed:mapping.some(m=>m.from!==m.to)};
}
export async function applyMainImageNames(root, product, expectedSignature, {io=fs}={}) {
 const plan=await planMainImageNames(root,product);
 if(plan.signature!==expectedSignature)throw Error('主图或商品信息已变化，请重新查看编号顺序');
 if(!plan.changed)return {changed:false,count:plan.mapping.length};
 const backup=path.join(plan.product,backupName,crypto.randomUUID());
 await io.mkdir(backup,{recursive:true});
 const journal={status:'pending',at:new Date().toISOString(),mapping:plan.mapping};
 const save=()=>fs.writeFile(path.join(backup,'manifest.json'),JSON.stringify(journal,null,2));
 await save();
 const moved=[],created=[];
 try {
  for(const m of plan.mapping){
   if(digest(await io.readFile(path.join(plan.dir,m.from)))!==m.sha256)throw Error('编号时主图被外部修改，已停止');
   await io.rename(path.join(plan.dir,m.from),path.join(backup,m.from));moved.push(m);
  }
  for(const m of plan.mapping){await io.copyFile(path.join(backup,m.from),path.join(plan.dir,m.to),constants.COPYFILE_EXCL);created.push(m);}
  for(const m of plan.mapping)if(digest(await io.readFile(path.join(plan.dir,m.to)))!==m.sha256)throw Error('主图改名后内容校验失败');
  journal.status='complete';await save();
  return {changed:true,count:plan.mapping.length,backup};
 }catch(error){
  try {
   for(const m of created) {
    const file=path.join(plan.dir,m.to);
    if(digest(await io.readFile(file))!==m.sha256)throw Error('回滚时目标图片已变化');
    await io.unlink(file);
   }
   for(const m of moved)await io.copyFile(path.join(backup,m.from),path.join(plan.dir,m.from),constants.COPYFILE_EXCL);
   journal.status='rolled-back';await save();
  }catch {throw Error(`编号中断，原图保留在 ${backup}；请人工恢复后再操作。${error.message}`);}
  throw Error(`编号未完成，已恢复原名。${error.message}`);
 }
}
