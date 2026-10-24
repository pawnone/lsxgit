// Installed UI + actual queue service, isolated synthetic materials and browser.
// No merchant network, Ego ownership changes, uploads or real draft writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
const installed=process.env.WQ_TEST_APP;
if(!installed)throw Error('请指定WQ_TEST_APP');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'wenqing-recreate-native-'));
const env={...process.env,WQ_APP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
let app;const checks=[];
const check=(name,value)=>{assert(value,name);checks.push(name);};
try{
  app=await electron.launch({executablePath:installed,args:[],env,timeout:30000});
  const win=await app.firstWindow();await win.getByRole('heading',{name:'批量上架',exact:true}).waitFor();
  const errors=[];win.on('pageerror',e=>errors.push(e.message));
  const old=await app.evaluate(async({app,ipcMain,BrowserWindow})=>{
    const fs=process.getBuiltinModule('node:fs/promises'),path=process.getBuiltinModule('node:path');
    const require=process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
    const loader=path.join(app.getPath('userData'),'fixture-loader.cjs');
    const moduleUrl=process.getBuiltinModule('node:url').pathToFileURL(path.join(app.getAppPath(),'desktop/service.mjs')).href;
    await fs.writeFile(loader,'module.exports = import('+JSON.stringify(moduleUrl)+');');
    const {ListingService}=await require(loader);
    const root=path.join(app.getPath('userData'),'isolated-fixture'),inputHash='d'.repeat(64);
    const runner={call:async()=>({ok:true,inputHash})};
    const browser={verify:async()=>({endpoint:'ego:synthetic'}),runPdd:async(shop,p,{onEvent})=>{
      globalThis.__progress=onEvent;
      onEvent({type:'step-start',name:'合成详情上传'});
      await new Promise(resolve=>{globalThis.__finishRun=resolve;});
      onEvent({type:'step-complete',name:'合成详情上传',durationMs:2000});
      const receiptFile=path.join(p.outputDir,'draft-save-'+inputHash+'.json');
      await fs.writeFile(receiptFile,JSON.stringify({status:'confirmed',inputHash,evidence:['synthetic only']}));
      return{ok:true,saved:{status:'confirmed',receiptFile,evidence:['synthetic only']}};
    }};
    const s=new ListingService({root,runner,browser,version:app.getVersion()});await s.init();await s.setPlatform('pdd');
    const shop=await s.addShop('合成恢复测试店','pdd');Object.assign(shop,{loggedIn:true,verified:true,actualName:shop.name});
    s.catalog=[{id:'SYNTHETIC',ok:true,materialRoot:root,warnings:[],config:{platform:'pdd',product:{id:'SYNTHETIC',title:'合成恢复测试商品',itemCode:'SYNTHETIC',mainImages:[],categoryPath:'合成类目'},skuMatrix:[{groupPriceCents:1990}],pdd:{basic:{},service:{}}}}];
    await s.select({shopIds:[shop.id],productIds:['SYNTHETIC']});await s.check();
    const task=s.preflight.tasks[0];await fs.mkdir(task.outputDir,{recursive:true});
    const receipt=path.join(task.outputDir,'draft-save-'+inputHash+'.json');await fs.writeFile(receipt,JSON.stringify({status:'pending',inputHash}));
    await fs.writeFile(path.join(task.outputDir,'intent.json'),JSON.stringify({status:'needs-review'}));
    s.history=[{id:'old-pending',startedAt:new Date().toISOString(),status:'needs-review',index:0,tasks:[{...task,status:'needs-review'}],error:'旧任务结果待核实',logs:[]}];s.run=structuredClone(s.history[0]);s.preflight=null;
    globalThis.__fixtureService=s;
    const send=()=>BrowserWindow.getAllWindows()[0].webContents.send('wqapp:state',s.snapshot());s.on('state',send);
    ipcMain.removeHandler('wqapp:call');ipcMain.handle('wqapp:call',async(e,{op,payload:p})=>{
      try{if(op==='check')await s.check({mode:p.mode});else if(op==='start')await s.start(p.token);else if(op!=='state')throw Error('fixture forbids operation '+op);return{ok:true,result:s.snapshot()};}
      catch(error){return{ok:false,error:error.message};}
    });send();return{receipt,bytes:await fs.readFile(receipt,'utf8'),attemptId:task.attemptId};
  });
  await win.getByText('合成恢复测试商品',{exact:true}).waitFor();
  await win.getByRole('button',{name:'检查本批素材',exact:true}).click();
  await win.locator('.error-box').filter({hasText:'上次结果未确认'}).waitFor();checks.push('普通检查仍保留旧结果未知门禁');
  await win.getByRole('button',{name:'重新创建草稿',exact:true}).click();
  const dialog=win.getByRole('dialog');await dialog.getByRole('button',{name:'确认，重新创建草稿',exact:true}).waitFor();
  check('重建按钮直接进入新任务确认，旧待核实不阻断', (await dialog.innerText()).includes('重建优先'));
  check('开始重建检查后清除上一操作的错误浮层',await win.locator('#toast').evaluate(e=>!e.classList.contains('show')));
  const plan=await app.evaluate(()=>globalThis.__fixtureService.preflight);
  check('重建任务获得独立ID与输出目录',plan.mode==='recreate'&&plan.tasks[0].attemptId!==old.attemptId);
  await dialog.getByRole('button',{name:'确认，重新创建草稿',exact:true}).click();
  await win.getByRole('dialog').waitFor({state:'detached'});
  await win.locator('[data-live-logs]').getByText('开始：合成详情上传',{exact:true}).waitFor();
  check('运行尚未完成时已显示当前步骤',await app.evaluate(()=>globalThis.__fixtureService.run.status==='running'));
  await app.evaluate(()=>globalThis.__progress({type:'log',text:'第1张上传完成，仍在运行'}));
  await win.locator('[data-live-logs]').getByText('第1张上传完成，仍在运行',{exact:true}).waitFor();checks.push('运行中的脚本输出实时到达界面');
  await win.getByRole('button',{name:'查看完整日志',exact:true}).click();
  await win.locator('#full-run-log').getByText('第1张上传完成，仍在运行',{exact:true}).waitFor();
  await app.evaluate(()=>globalThis.__progress({type:'log',text:'第2张上传完成'}));
  await win.locator('#full-run-log').getByText('第2张上传完成',{exact:true}).waitFor();checks.push('完整日志抽屉在打开时继续实时更新');
  await win.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await win.getByRole('dialog').waitFor({state:'detached'});
  await app.evaluate(()=>{for(let i=0;i<35;i++)globalThis.__progress({type:'log',text:'可滚动的合成日志 '+i});});
  await win.locator('[data-live-logs]').getByText('可滚动的合成日志 34',{exact:true}).waitFor();
  await win.locator('[data-live-logs]').evaluate(e=>{e.scrollTop=0;});
  await app.evaluate(()=>globalThis.__progress({type:'log',text:'保留阅读位置'}));
  await win.locator('[data-live-logs]').getByText('保留阅读位置',{exact:true}).waitFor();
  check('查看较早日志时新消息不会强行拉回底部',await win.locator('[data-live-logs]').evaluate(e=>e.scrollTop<10));
  await app.evaluate(()=>globalThis.__finishRun());
  for(let n=0;n<100;n++){if(await app.evaluate(()=>!globalThis.__fixtureService.running))break;await new Promise(r=>setTimeout(r,50));}
  check('重建任务完成，不再回到旧待核实状态',await app.evaluate(()=>globalThis.__fixtureService.run.status==='complete'));
  await win.locator('[data-live-logs]').getByText('完成：合成详情上传（2.0秒）',{exact:true}).waitFor();checks.push('完成步骤与耗时留在日志中');
  check('旧待核实回执逐字节保留',await fs.readFile(old.receipt,'utf8')===old.bytes);
  check('新任务完成后旧历史仍为原始待核实',await app.evaluate(()=>globalThis.__fixtureService.history.some(r=>r.id==='old-pending'&&r.status==='needs-review')));
  check('渲染页面没有运行错误',errors.length===0);
  const output=path.resolve('output/pdd-042-recreate-check');await fs.mkdir(output,{recursive:true});await win.screenshot({path:path.join(output,'recreate-and-live-logs.png')});
  const result={checks:checks.length,names:checks,merchantMutation:false,realEgoControl:false};await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(app)await app.close();await fs.rm(data,{recursive:true,force:true});}
