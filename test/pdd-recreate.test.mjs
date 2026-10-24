import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareEgoPage} from '../engine/pdd/run-draft.mjs';
import {ListingService} from '../desktop/service.mjs';
import {writeJson} from '../desktop/storage.mjs';
import {EgoRunner} from '../desktop/ego-runner.mjs';

test('explicit PDD recreation reuses its owned page even at the eight-page cap, preserving old metadata',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-rebuild-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let creates=0;
  const owned={label:'p2'},tabs=Array.from({length:8},(_,i)=>({label:'p'+(i+1)}));
  const task={newPage:async()=>{creates++;throw Error('Page budget reached (8/8)');},tabs:async()=>tabs,page:label=>{assert.equal(label,'p2');return owned;}};
  for(const phase of ['failed','running','saving','needs-review','confirmed']){
    const dir=path.join(root,phase);await fs.mkdir(dir);
    const prior={phase,attemptId:'old',label:'p2',error:'old error'};
    if(phase!=='confirmed')await assert.rejects(prepareEgoPage(task,{prior,outputDir:dir,attemptId:'fresh'}),/未确认/);
    const r=await prepareEgoPage(task,{prior,outputDir:dir,attemptId:'fresh',recreate:true});
    assert.equal(r.page,owned);assert.equal(r.reused,true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'previous-workspace.json'),'utf8')),prior);
    assert.equal(prior.attemptId,'old');
    await assert.rejects(prepareEgoPage(task,{prior,outputDir:dir,attemptId:'old',recreate:true}),/同一个任务/);
  }
  let prior={phase:'confirmed',attemptId:'seed',label:'p2'};
  for(let n=0;n<12;n++){
    const outputDir=path.join(root,'repeat-'+n);await fs.mkdir(outputDir);
    const result=await prepareEgoPage(task,{prior,outputDir,attemptId:'attempt-'+n,recreate:true});
    assert(result.reused);prior={phase:'confirmed',label:result.page.label,attemptId:'attempt-'+n};
  }
  assert.equal(creates,0);assert.equal(tabs.length,8);
  const missing={...prior,label:'closed'};
  await assert.rejects(prepareEgoPage(task,{prior:missing,outputDir:root,attemptId:'new'}),/工作页已关闭.*页面数量已满/);
});

test('recreate overrides pending history and receipts, preserves their bytes and emits progress before completion',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-priority-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const inputHash='c'.repeat(64);let finish,dispatch;
  const browser={verify:async()=>({endpoint:'ego:fixture'}),runPdd:async(shop,p,{onEvent})=>{
    dispatch=p;onEvent({type:'step-start',name:'上传详情'});onEvent({type:'log',text:'详情第1张上传完成'});
    await new Promise(resolve=>{finish=resolve;});
    onEvent({type:'step-complete',name:'上传详情',durationMs:1500});
    const receiptFile=path.join(p.outputDir,'draft-save-'+inputHash+'.json');
    await writeJson(receiptFile,{status:'confirmed',inputHash,evidence:['synthetic']});
    return{ok:true,saved:{status:'confirmed',receiptFile,evidence:['synthetic']}};
  }};
  const service=new ListingService({root,browser,runner:{call:async()=>({ok:true,inputHash})}});
  await service.init();await service.setPlatform('pdd');const shop=await service.addShop('合成店','pdd');Object.assign(shop,{loggedIn:true,verified:true,actualName:shop.name});
  service.catalog=[{id:'P',ok:true,config:{platform:'pdd',product:{id:'P',title:'合成商品',itemCode:'P'},skuMatrix:[],pdd:{basic:{},service:{}}}}];
  await service.select({shopIds:[shop.id],productIds:['P']});await service.check();const old=service.preflight.tasks[0];
  const receipt=path.join(old.outputDir,'draft-save-'+inputHash+'.json');await writeJson(receipt,{status:'pending',inputHash});
  await writeJson(path.join(old.outputDir,'intent.json'),{status:'needs-review'});
  service.history.push({id:'old',status:'needs-review',startedAt:new Date().toISOString(),tasks:[{...old,status:'needs-review'}]});
  const before=await fs.readFile(receipt,'utf8');await assert.rejects(service.check(),/上次结果未确认/);
  await service.check({mode:'recreate'});const plan=service.preflight;
  assert.equal(plan.tasks[0].status,'recreate-ready');assert.notEqual(plan.tasks[0].attemptId,old.attemptId);
  await service.start(plan.token);
  for(let n=0;n<100&&!finish;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert(finish);assert.equal(service.run.status,'running');assert.equal(dispatch.recreate,true);
  assert(service.run.logs.some(l=>l.text==='开始：上传详情'));assert(service.run.logs.some(l=>l.text==='详情第1张上传完成'));
  finish();await service.drivePromise;assert.equal(service.run.status,'complete');
  assert.equal(await fs.readFile(receipt,'utf8'),before);assert(service.run.logs.some(l=>l.text.includes('完成：上传详情')));
});

test('Ego journal delivers before a buffered CLI exits; stderr and journal events are not duplicated',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-journal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const exe=path.join(root,'fake-ego.mjs');
  await fs.writeFile(exe,`#!/usr/bin/env node
import fs from 'node:fs/promises';
let script='';for await(const c of process.stdin)script+=c;
const match=script.match(/runEgoRequest\\(("(?:\\\\.|[^"\\\\])*"),("(?:\\\\.|[^"\\\\])*")\\)/);
const result=JSON.parse(match[2]),event={type:'step-start',name:'尚未结束时已可见',seq:1};
await fs.appendFile(result+'.events.jsonl',JSON.stringify(event)+'\\n');
await new Promise(resolve=>setTimeout(resolve,500));
process.stderr.write('WQ_EVENT '+JSON.stringify(event)+'\\n普通脚本错误输出\\n');
await fs.writeFile(result,JSON.stringify({ok:true,result:{done:true}}));
`,{mode:0o700});
  const events=[];let complete=false,show;
  const visible=new Promise(resolve=>{show=resolve;});
  const promise=new EgoRunner({root:path.join(root,'requests'),executable:exe}).call('observe',{}, {onEvent:event=>{events.push({...event,whileRunning:!complete});if(event.name==='尚未结束时已可见')show();}}).then(r=>{complete=true;return r;});
  await Promise.race([visible,promise.then(()=>{throw Error('进程结束前没有收到实时事件');})]);
  assert(events.some(e=>e.name==='尚未结束时已可见'));assert.equal(complete,false);
  assert.deepEqual(await promise,{done:true});
  assert.equal(events.filter(e=>e.seq===1).length,1);assert(events.some(e=>e.text==='普通脚本错误输出'));
});
