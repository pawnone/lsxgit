import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import spawn from 'cross-spawn';
import {EgoRunner} from './ego-runner.mjs';
import {egoCommand,egoScriptEntry} from './ego-command.mjs';

function command(executable,args,stdin=''){
  return new Promise((resolve,reject)=>{
    const invocation=egoCommand(executable,args),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(invocation.command,invocation.args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    let output='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},30000);
    for(const stream of [child.stdout,child.stderr]){stream.setEncoding('utf8');stream.on('data',chunk=>{output=(output+chunk).slice(-200000);});}
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(code!==0||timedOut)reject(Error((timedOut?'Ego环境检查超时':'Ego环境检查失败')+'：'+output.slice(-1500)));else resolve(output);});
    child.stdin.on('error',()=>{});child.stdin.end(stdin);
  });
}
export async function probeEgo({root,executable}={}){
  const runner=new EgoRunner({root,executable}),file=await runner.detectExecutable();
  const guide=await command(file,['skill']);if(!/\[ego-browser:skill\] end of guide/.test(guide))throw Error('Ego版本不兼容：未提供完整的官方Page API使用指南');
  const probe=fileURLToPath(new URL('./ego-probe.mjs',import.meta.url));
  const output=await command(file,['nodejs'],egoScriptEntry(probe));
  const line=output.split(/\r?\n/).find(line=>line.startsWith('WQ_EGO_PROBE '));if(!line)throw Error('Ego未返回本次环境检测结果');
  const sdk=JSON.parse(line.slice(13));if(!sdk.ok)throw Error('当前Ego缺少本版本需要的接口：'+sdk.missing.join('、'));
  return{ok:true,executable:file,pageApi:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv[2]!=='--probe-ego')throw Error('只支持 --probe-ego 环境检查');
    const root=process.platform==='win32'?path.join(process.env.APPDATA,'文青尚品','ego-requests'):path.join(os.homedir(),'Library','Application Support','文青尚品','ego-requests');
    const ego=await probeEgo({root,executable:process.argv[3]});
    const {default:ExcelJS}=await import('exceljs');const w=new ExcelJS.Workbook();await w.xlsx.readFile(fileURLToPath(new URL('./assets/pdd-templates/拼多多商品信息模板_针织衫.xlsx',import.meta.url)));
    if(w.getWorksheet('基础信息').getCell('B4').value!=='针织衫')throw Error('App内置模板不完整，请重新解压完整交付包');
    let templateProducts;
    if(process.platform==='win32'){
      const {scanProducts}=await import('../engine/pdd/product.mjs');
      const samples=await scanProducts(fileURLToPath(new URL('../../../拼多多模板素材库/',import.meta.url)));
      if(samples.errors.length||samples.products.length!==2||samples.products.some(p=>!p.ok))throw Error('随包的拼多多模板素材库不完整或商品表校验未通过');
      templateProducts=samples.products.map(p=>({code:p.itemCode,sku:p.config.skuMatrix.length}));
    }
    const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
    console.log('WQ_ENV_RESULT '+JSON.stringify({ok:true,appVersion:pkg.version,platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron,templateProducts,...ego}));
  }catch(e){console.error('WQ_ENV_RESULT '+JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
}
