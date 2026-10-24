import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
export async function assertMainUploadSlots(config,files){
  if(files.length!==config.product.mainImages.length)throw Error('主图上传槽位数量与冻结计划不同');
  await assertUploadSlots(config,config.product.mainImages,files);
}
export async function assertUploadSlots(config,sources,files){
  if(files.length!==sources.length)throw Error('上传槽位数量与冻结计划不同');
  for(const [i,source] of sources.entries()){
    const relative=path.relative(config.materialRoot,source).split(path.sep).join('/');
    const record=config.input.files.find(f=>f.file===relative);
    if(!record||digest(await fs.readFile(files[i]))!==record.sha256)throw Error('上传槽位内容与原图不同：'+(i+1));
  }
}
export async function stageImageUploadSlots(config,sources,folder){
  await fs.mkdir(folder,{recursive:true});
  const files=[];
  for(const [i,source] of sources.entries()){
    const file=path.join(folder,String(i+1).padStart(2,'0')+path.extname(source));
    await fs.copyFile(source,file,fs.constants.COPYFILE_EXCL);files.push(file);
  }
  await assertUploadSlots(config,sources,files);
  return files;
}
export async function stageMediaUploadSlots(config,sources,cacheDir,{platform=process.platform,tempRoot=os.tmpdir()}={}){
  // Windows browser file readers may not share Node's long-path support.
  const temporary=platform==='win32'||!cacheDir;
  const folder=temporary?await fs.mkdtemp(path.join(tempRoot,'wq-')):cacheDir;
  if(platform==='win32'&&path.join(folder,'01.jpeg').length>=240)
    throw Error('Windows临时上传目录过长；请将TEMP设置到较短的可写目录后重新创建任务');
  return {files:await stageImageUploadSlots(config,sources,folder),temporary:temporary?folder:null};
}
export async function stageMainUploadSlots(config,outputDir){
  const sources=config.product.mainImages;
  // Configured ordering also needs slot filenames: a platform that sorts the
  // chooser's filenames must not undo the user's chosen first image.
  if(!config.product.imageOrder&&new Set(sources).size===sources.length)return sources;
  const folder=path.join(outputDir,'main-upload-slots');await fs.mkdir(folder,{recursive:true});
  const files=[];
  for(const [i,source] of sources.entries()){
    const file=path.join(folder,String(i+1).padStart(2,'0')+path.extname(source));
    await fs.copyFile(source,file,fs.constants.COPYFILE_EXCL);files.push(file);
  }
  await assertMainUploadSlots(config,files);
  await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(sources.map((source,i)=>({slot:i+1,source,upload:files[i]})),null,2),{flag:'wx'});
  return files;
}
