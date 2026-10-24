// Reuse a verified, identical Electron runtime when the packager's release
// metadata endpoint is unavailable. No binary, dependency or permission changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const execFile=promisify(execFileCallback);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin')throw Error('仅供Mac本地封装');
const source=process.env.WQ_CACHED_MAC_APP;
if(!source||!path.isAbsolute(source))throw Error('请指定已验证的WQ_CACHED_MAC_APP');
await execFile('/usr/bin/codesign',['--verify','--deep','--strict',source]);
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const cachedPkg=JSON.parse(await fs.readFile(path.join(source,'Contents/Resources/app/package.json'),'utf8'));
if(JSON.stringify(cachedPkg.dependencies)!==JSON.stringify(pkg.dependencies))throw Error('依赖已改变，不能复用原依赖目录');
const runtimeInfo=path.join(source,'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist');
const {stdout:runtime}=await execFile('/usr/libexec/PlistBuddy',['-c','Print :CFBundleVersion',runtimeInfo]);
if(runtime.trim()!==pkg.devDependencies.electron)throw Error('缓存的Electron版本与锁定版本不符');
const staging=await fs.mkdtemp(path.join(root,'release/.mac-repack-'));
const app=path.join(staging,'文青尚品.app');
await execFile('/usr/bin/ditto',[source,app]);
const dest=path.join(app,'Contents/Resources/app');
for(const dir of ['desktop','engine']){
  await fs.rm(path.join(dest,dir),{recursive:true,force:true});
  await execFile('/usr/bin/ditto',[path.join(root,dir),path.join(dest,dir)]);
}
for(const name of ['package.json','package-lock.json','README.md','AGENTS.md','THIRD_PARTY_NOTICES.md'])await fs.copyFile(path.join(root,name),path.join(dest,name));
const info=path.join(app,'Contents/Info.plist');
await execFile('/usr/libexec/PlistBuddy',['-c','Set :CFBundleShortVersionString '+pkg.version,info]);
await execFile('/usr/libexec/PlistBuddy',['-c','Set :CFBundleVersion '+pkg.version.split('-')[0],info]);
await execFile('/usr/bin/codesign',['--force','--sign','-','--entitlements',path.join(root,'desktop/assets/development-entitlements.plist'),app]);
await execFile('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const out=path.join(root,'release/文青尚品-darwin-'+process.arch);
await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out,{recursive:true});
await fs.rename(app,path.join(out,'文青尚品.app'));await fs.rmdir(staging);
console.log(JSON.stringify({version:pkg.version,electron:runtime.trim(),out,cachedRuntime:true,signatureVerified:true}));
