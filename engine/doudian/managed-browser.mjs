import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
export function shopProfile(shop,root=path.join(os.homedir(),'.doudian-auto-listing')){
 if(!shop?.trim())throw new Error('请先填写目标店铺完整名称；无需填写端口');
 return path.join(root,'shops',createHash('sha256').update(shop.trim()).digest('hex').slice(0,24));
}
// Read only this shop's dedicated profile. Never scan ports or copy login data.
export async function managedEndpoint(profile){
 let lines;try{lines=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);}catch{return null;}
 if(!/^\d+$/.test(lines[0])||+lines[0]<1||+lines[0]>65535||!/^\/devtools\/browser\/[\w-]+$/.test(lines[1]||''))return null;
 const endpoint=`http://127.0.0.1:${lines[0]}`;
 try{const response=await fetch(endpoint+'/json/version',{signal:AbortSignal.timeout(1000),redirect:'error'});if(!response.ok)return null;const data=await response.json();const ws=new URL(data.webSocketDebuggerUrl);return ws.pathname===lines[1]&&['127.0.0.1','localhost'].includes(ws.hostname)&&ws.port===lines[0]?endpoint:null;}catch{return null;}
}
export async function requireManagedEndpoint(shop){
 const endpoint=await managedEndpoint(shopProfile(shop));
 if(!endpoint)throw new Error('目标店铺专用浏览器尚未就绪，请先执行 --browser（或菜单1），登录后再核对店铺；无需配置端口');
 return endpoint;
}
