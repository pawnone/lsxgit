import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

export const egoScriptEntry=file=>`await import(${JSON.stringify(pathToFileURL(file).href)});`;

export function egoExecutableCandidates({platform=process.platform,home=os.homedir(),env=process.env}={}){
  if(platform!=='win32')return[path.join(home,'.local/bin/ego-browser'),'/usr/local/bin/ego-browser'];
  const dirs=[path.win32.join(home,'.local','bin'),...(env.PATH||env.Path||'').split(';')];
  return [...new Set(dirs.filter(Boolean).map(dir=>dir.replace(/^"|"$/g,'')))].flatMap(dir=>['.exe','.cmd','.bat','.ps1'].map(ext=>path.win32.join(dir,'ego-browser'+ext)));
}

// cross-spawn handles Windows command shims; PowerShell scripts need their own
// host. Arguments stay separate from the UTF-8 browser script sent over stdin.
export function egoCommand(executable,args,{platform=process.platform,env=process.env}={}){
  if(platform==='win32'&&/\.ps1$/i.test(executable))return{
    command:path.win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',executable,...args],
  };
  return{command:executable,args};
}
