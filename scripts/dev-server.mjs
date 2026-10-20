import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const defaultRoot=path.resolve(here,'../demo');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.json':'application/json; charset=utf-8'};
export function createDemoServer(rootDir=defaultRoot){
 const root=path.resolve(rootDir);
 return http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end('Method not allowed');return;}
  let pathname;
  try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(pathname.includes('\0'))throw Error('null');}
  catch{res.writeHead(400);res.end('Invalid URL');return;}
  if(pathname==='/')pathname='/desktop.html';
  const target=path.resolve(root,'.'+pathname);
  if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403);res.end('Forbidden');return;}
  try{
   const stat=await fs.stat(target);if(!stat.isFile())throw Object.assign(Error('not file'),{code:'ENOENT'});
   const content=await fs.readFile(target);res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Content-Length':content.length});
   res.end(req.method==='HEAD'?undefined:content);
  }catch(e){res.writeHead(e.code==='ENOENT'||e.code==='ENOTDIR'?404:500);res.end(e.code==='ENOENT'||e.code==='ENOTDIR'?'Not found':'Unable to read demo file');}
 });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const port=Number(process.env.PORT??5173),host=process.env.HOST||'127.0.0.1';
 if(!Number.isInteger(port)||port<0||port>65535){console.error('PORT必须为0～65535之间的整数');process.exitCode=1;}
 else{
  const server=createDemoServer();
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`端口${port}已占用，请设置其他PORT后重试。`:`启动失败：${e.message}`);process.exitCode=1;});
  server.listen(port,host,()=>{const actual=server.address().port;console.log(`文青尚品 Demo：http://${host}:${actual}/`);console.log('仅界面演示，不连接店铺、不执行上架。Ctrl+C停止。');});
 }
}
