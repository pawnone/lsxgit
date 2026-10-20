import {packager} from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const paths=await packager({dir:root,out:path.join(root,'release'),name:'文青尚品',platform:'win32',arch:'x64',
 electronZipDir:process.env.WQ_ELECTRON_ZIP_DIR,
 electronVersion:pkg.devDependencies.electron,appVersion:pkg.version,overwrite:true,prune:true,asar:false,
 // Packager 20 uses resedit and supports metadata editing without Wine.
 win32metadata:{CompanyName:"文青尚品",ProductName:"文青尚品"},
 ignore:[/^\/\.git(?:\/|$)/,/^\/(?:test|scripts|screenshots|dist|release|output|\.native-test-data)(?:\/|$)/,/^\/check-demo\.mjs$/,/^\/demo-check\.json$/]});
for(const dir of paths){
 await fs.copyFile(path.join(root,'scripts/windows-setup.ps1'),path.join(dir,'install-shortcuts.ps1'));
 await fs.writeFile(path.join(dir,'安装快捷方式.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shortcuts.ps1"\r\npause\r\n','utf8');
 console.log(dir);
}
