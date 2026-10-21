import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {findInfoFile,readProductInfo} from './prepare-product.mjs';

export async function scanProducts(root, output, {cdpUrl='http://127.0.0.1:9223',outputDir='./output/v2-doudian',platform='doudian',expectedShop=''}={}) {
  if(platform!=='doudian') throw new Error('第二版仅实现抖店适配，其他平台尚未开放');
  root=path.resolve(root);output=path.resolve(output);
  const products=[],errors=[],codes=new Set();
  let contents;try{contents=await fs.readdir(root,{withFileTypes:true});}catch(e){throw new Error(`无法读取总素材库「${root}」：${e.code}。请选择菜单5设置本机存在且可读取的文件夹`);}
  const entries=contents.filter(e=>!e.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
  for(const entry of entries){
    if(!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir=path.join(root,entry.name);
    try {
      if(entry.isSymbolicLink()) throw new Error('商品目录不能是符号链接');
      const files=[];
      for(const folder of [dir,path.join(dir,'商品信息')]){
        let items;try{items=await fs.readdir(folder,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
        for(const item of items) if(item.isFile()) files.push(path.join(folder,item.name));
      }
      const file=await findInfoFile(files,dir);
      if(!file||file.error)throw new Error(file?.error||'缺少商品信息文件；每个直接子目录必须是一个商品');
      const info=await readProductInfo(file,dir),p=info.product??info;
      if(p.targetPlatform&&p.targetPlatform!==platform)throw new Error('商品平台与本批执行平台不一致');
      const code=String(p.itemCode??'').trim().normalize('NFC');
      if(!code||/【|待填写|待确认/.test(code))throw new Error('缺少真实货号，无法生成稳定商品编号');
      const key=code.toLowerCase();
      if(codes.has(key))throw new Error(`重复货号：${code}`);
      codes.add(key);
      const id='dou-'+crypto.createHash('sha256').update(key).digest('hex').slice(0,16);
      products.push({id,platform,itemCode:code,title:p.title,categoryPath:p.categoryPath,materialRoot:path.relative(path.dirname(output),dir).split(path.sep).join('/')});
    }catch(e){errors.push({folder:dir,error:e.message});}
  }
  if(!products.length && !errors.length) errors.push({folder:root,error:'没有找到商品子文件夹；请在总素材库下放商品01、商品02等目录，每个目录包含商品信息/商品信息.xlsx及主图等素材' });
  // 失败时撤销旧清单，防止误跑上次扫描结果；保存错误报告供修正。
  await fs.mkdir(path.dirname(output),{recursive:true});
  const report={ok:!errors.length,root,products,errors,scannedAt:new Date().toISOString()};
  await fs.writeFile(output+'.scan-report.json',JSON.stringify(report,null,2));
  if(errors.length){await fs.rm(output,{force:true});throw new Error(`扫描失败：${errors.map(e=>`${e.folder}：${e.error}`).join('\n')}`);}
  const manifest={version:1,platform,expectedShop,draftOnly:true,cdpUrl,outputDir,products};
  await fs.writeFile(output+'.tmp',JSON.stringify(manifest,null,2));await fs.rename(output+'.tmp',output);
  console.log(`扫描到 ${products.length} 个商品；清单：${output}`);
  return manifest;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
  try{if(!args.includes('--root')||!args.includes('--output'))throw new Error('用法：node scan-products.mjs --root 本批素材目录 --output batch.generated.json');await scanProducts(value('--root'),value('--output'));}catch(e){console.error(e.message);process.exitCode=1;}
}
