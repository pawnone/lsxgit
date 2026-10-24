import {packager} from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {scanProducts,inputFiles} from '../engine/pdd/product.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const installer=process.env.WQ_EGO_INSTALLER;
if(!installer||!path.isAbsolute(installer))throw Error('请用WQ_EGO_INSTALLER指定用户提供的Ego Windows安装包');
const installerBytes=await fs.readFile(installer),installerSha256=crypto.createHash('sha256').update(installerBytes).digest('hex');
if(installerSha256!=='88ddf980821be2a7c745bec0e16b6ce623d3117c02df7720c2a57c35edb70f33')throw Error('安装包与本次核对的Ego 0.6.0.16引导器不一致');
const materials=process.env.WQ_PDD_MATERIALS;
if(!materials||!path.isAbsolute(materials))throw Error('请用WQ_PDD_MATERIALS指定用户要求随包的拼多多素材库');
const library=await scanProducts(materials);
if(library.errors.length||library.products.length!==2||library.products.some(p=>!p.ok))throw Error('随包模板素材库必须是已检查的两个有效商品');

const paths=await packager({dir:root,out:path.join(root,'release'),name:'文青尚品',platform:'win32',arch:'x64',
 electronZipDir:process.env.WQ_ELECTRON_ZIP_DIR,
 electronVersion:pkg.devDependencies.electron,appVersion:pkg.version,overwrite:true,prune:true,asar:false,
 // Packager 20 uses resedit and supports metadata editing without Wine.
 win32metadata:{CompanyName:"文青尚品",ProductName:"文青尚品"},
 ignore:[/^\/\.git(?:\/|$)/,/^\/(?:test|scripts|screenshots|dist|release|output|\.native-test-data)(?:\/|$)/,/^\/check-demo\.mjs$/,/^\/demo-check\.json$/]});
for(const dir of paths){
 await fs.copyFile(path.join(root,'scripts/windows-setup.ps1'),path.join(dir,'install-shortcuts.ps1'));
 await fs.copyFile(path.join(root,'scripts/windows-environment.ps1'),path.join(dir,'setup-environment.ps1'));
 await fs.copyFile(path.join(root,'scripts/windows-environment.cmd'),path.join(dir,'一键配置环境.cmd'));
 await fs.mkdir(path.join(dir,'environment'),{recursive:true});
 await fs.copyFile(installer,path.join(dir,'environment','ego-lite-setup.exe'));
 await fs.writeFile(path.join(dir,'environment-manifest.json'),JSON.stringify({schema:1,appVersion:pkg.version,platform:'win32',arch:'x64',egoInstaller:{file:'ego-lite-setup.exe',version:'0.6.0.16',sha256:installerSha256,kind:'bootstrapper',source:'user-provided'}},null,2));
 await fs.copyFile(path.join(root,'Windows交付与环境配置.md'),path.join(dir,'先读我-Windows.md'));
 await fs.copyFile(path.join(root,'Windows详情上传排查提示词.txt'),path.join(dir,'Windows详情上传排查提示词.txt'));
 const sampleRoot=path.join(dir,'拼多多模板素材库'),manifest=[];
 for(const product of library.products)for(const file of await inputFiles(product.materialRoot)){
   const relative=path.relative(materials,file),target=path.join(sampleRoot,relative),bytes=await fs.readFile(file);
   await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
   manifest.push({file:relative.split(path.sep).join('/'),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 }
 const copied=await scanProducts(sampleRoot);
 if(copied.errors.length||copied.products.length!==2||copied.products.some(p=>!p.ok||!library.products.some(source=>source.id===p.id&&source.inputHash===p.inputHash)))throw Error('素材库复制后校验不一致');
 await fs.writeFile(path.join(dir,'模板素材清单.json'),JSON.stringify({products:copied.products.map(p=>({code:p.itemCode,sku:p.config.skuMatrix.length,category:p.config.product.categoryPath})),files:manifest},null,2));

 await fs.writeFile(path.join(dir,'安装快捷方式.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shortcuts.ps1"\r\npause\r\n','utf8');
 console.log(dir);
}
