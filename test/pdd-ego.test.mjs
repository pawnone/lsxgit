import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserManager} from '../desktop/browser-manager.mjs';
import {EgoRunner} from '../desktop/ego-runner.mjs';
import {ListingService} from '../desktop/service.mjs';
import {assertServiceRange} from '../engine/pdd/service-contract.mjs';
import {connectSpace,egoMessage,egoFailure,runEgoRequest} from '../engine/pdd/ego-entry.mjs';

test('refresh never takes user control; explicit verification resumes a handed-off space',async t=>{
  const names=['listTaskSpaces','claimTaskSpace','takeOverTaskSpace','taskSpace'];
  const old=Object.fromEntries(names.map(n=>[n,globalThis[n]]));t.after(()=>{for(const n of names)if(old[n]===undefined)delete globalThis[n];else globalThis[n]=old[n];});
  const payload={workspaceName:'文青尚品 · 拼多多 · unit'};const calls=[];
  globalThis.listTaskSpaces=async()=>[{id:19,name:payload.workspaceName,ownership:'agent'}];
  globalThis.takeOverTaskSpace=async id=>calls.push(['takeOver',id]);
  globalThis.taskSpace=async id=>calls.push(['resume',id]);
  globalThis.claimTaskSpace=()=>assert.fail('not a user-owned space');
  await connectSpace(payload,false);await connectSpace(payload,true);
  assert.deepEqual(calls,[['resume',19],['takeOver',19]]);
  assert.match(egoMessage('task.listTabs: Control of this task space is with the user'),/点击“核对”/);
  assert.equal(egoMessage('JavaScript evaluation failed at line 0, column 0: Error: 滚动区域不唯一\n at anonymous:1'),'滚动区域不唯一');
});

test('PDD connects through Ego and never launches automated Chrome',async()=>{
  const manager=new BrowserManager({root:'/tmp/wq-unit/browser-profiles',runner:{call:()=>assert.fail('must not use Chrome')}});
  const calls=[];manager.ego={call:async(op,p)=>{calls.push({op,p});return{status:'verified',actualName:p.expectedShop};}};
  manager.detectExecutable=()=>assert.fail('must not launch Chrome');
  const shop={name:'甲店',platform:'pdd',workspaceToken:'unique-unit-token'};
  await manager.open(shop);await manager.observe(shop);await manager.verify(shop);
  assert.deepEqual(calls.map(c=>c.op),['open','observe','verify']);
  assert(calls.every(c=>c.p.workspaceName==='文青尚品 · 拼多多 · 甲店 · unique-u'&&c.p.expectedShop==='甲店'));
  assert.throws(()=>assertServiceRange({pdd:{basic:{},service:{'7天无理由退货':'待确认'}}}),/必填服务/);
});
test('Ego错误区分用户控制、空间失效、断连和权限，不把隐藏或失效归为人工操作',()=>{
  for(const [raw,code]of [
    ['Control of this task space is with the user','EGO_USER_CONTROL'],
    ['task space 19 is inactive','EGO_SPACE_INACTIVE'],
    ['original task has ended','EGO_SPACE_INACTIVE'],
    ['WebSocket connection closed unexpectedly','EGO_CONNECTION_LOST'],
    ['ECONNRESET','EGO_CONNECTION_LOST'],
    ['permission denied','EGO_PERMISSION_DENIED'],
    ['window is hidden','EGO_OPERATION_FAILED']]){
    const result=egoFailure(raw);assert.equal(result.code,code);assert.equal(result.diagnostic,raw);
    if(code!=='EGO_USER_CONTROL')assert(!result.message.includes('控制权交给用户'));
  }
});
test('Ego命令非零退出保留退出码，刷新显示连接异常而不是用户接管',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-ego-exit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'fake-ego.mjs');await fs.writeFile(executable,'#!/usr/bin/env node\nconsole.error("browser disconnected");process.exit(23);',{mode:0o700});
  const requests=path.join(root,'requests'),runner=new EgoRunner({root:requests,executable}),payload={workspaceName:'文青尚品 · 拼多多 · fake-exit'};
  await assert.rejects(runner.call('run',payload),e=>e.code==='EGO_CONNECTION_LOST'&&e.diagnostic.exitCode===23);
  const dir=(await fs.readdir(requests,{withFileTypes:true})).find(e=>e.isDirectory()&&e.name!=='control').name;
  assert.equal(JSON.parse(await fs.readFile(path.join(requests,dir,'process-exit.json'),'utf8')).exitCode,23);
  await fs.rm(executable);assert.equal((await runner.call('observe',payload)).status,'connection-error');
});
test('实时事件回调失败只结束Ego子进程，不从stdout事件抛到App主进程',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-ego-event-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'fake-ego.mjs');await fs.writeFile(executable,'#!/usr/bin/env node\nconsole.log("event boundary fixture");setTimeout(()=>{},10000);',{mode:0o700});
  const runner=new EgoRunner({root:path.join(root,'requests'),executable});
  await assert.rejects(runner.call('observe',{}, {onEvent:()=>{throw Error('synthetic callback failure');}}),e=>e.code==='EGO_EVENT_FAILED');
  assert.equal(typeof await runner.detectExecutable(),'string');
});
test('CLI非零退出仍优先保留本次结构化空间失效原因，不误报用户接管',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-ego-inactive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'fake-ego.mjs');
  await fs.writeFile(executable,`#!/usr/bin/env node
import fs from 'node:fs/promises';let script='';for await(const chunk of process.stdin)script+=chunk;
const match=script.match(/runEgoRequest\\(("(?:\\\\.|[^"\\\\])*"),("(?:\\\\.|[^"\\\\])*")\\)/);
await fs.writeFile(JSON.parse(match[2]),JSON.stringify({ok:false,error:'Ego 工作空间已失效',code:'EGO_SPACE_INACTIVE',diagnostic:'task space is inactive'}));process.exit(1);
`,{mode:0o700});
  const runner=new EgoRunner({root:path.join(root,'requests'),executable}),payload={workspaceName:'文青尚品 · 拼多多 · inactive'};
  await assert.rejects(runner.call('run',payload),e=>e.code==='EGO_SPACE_INACTIVE'&&e.diagnostic==='task space is inactive');
  assert.equal((await runner.call('observe',payload)).status,'connection-error');
});
test('PDD confirmed queue routes only to Ego with the frozen validation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-ego-queue-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const inputHash='a'.repeat(64),calls=[];
  const runner={call:async(op)=>{if(op==='run')assert.fail('PDD must not use Dou worker');assert.equal(op,'validate');return{ok:true,inputHash,executionHash:'b'.repeat(64)};}};
  const browser={verify:async()=>({endpoint:'ego:test'}),runPdd:async(shop,p)=>{calls.push({shop,p});return{ok:true,saved:{status:'confirmed',receiptFile:'unit-receipt',evidence:['unit evidence']}};}};
  const service=new ListingService({root,runner,browser});await service.init();await service.setPlatform('pdd');
  const shop=await service.addShop('甲店','pdd');Object.assign(shop,{verified:true,loggedIn:true,actualName:'甲店'});
  service.catalog=[{id:'product',ok:true,config:{platform:'pdd',draftOnly:true,product:{id:'P',itemCode:'P',title:'测试'},skuMatrix:[],pdd:{basic:{},service:{}},input:{inputHash}}}];
  await service.select({shopIds:[shop.id],productIds:['product']});await service.check();await service.start(service.preflight.token);await service.drivePromise;
  assert.equal(service.run.status,'complete');assert.equal(calls.length,1);assert.equal(calls[0].p.validation.inputHash,inputHash);assert.equal(calls[0].p.expectedShop,'甲店');
});
test('Ego bridge keeps product input in a data file and reads structured results',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-ego-protocol-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'fake-ego.mjs');
  await fs.writeFile(executable,`#!/usr/bin/env node
import fs from 'node:fs/promises';
let script='';for await(const b of process.stdin)script+=b;
const match=script.match(/runEgoRequest\\(("(?:\\\\.|[^"\\\\])*"),("(?:\\\\.|[^"\\\\])*")\\)/);
if(!match)throw Error('invalid bridge request');
const req=JSON.parse(await fs.readFile(JSON.parse(match[1]),'utf8'));
if(script.includes('MALICIOUS'))throw Error('data became executable code');
console.log('WQ_EVENT '+JSON.stringify({type:'step-start',name:'测试'}));
await fs.writeFile(JSON.parse(match[2]),JSON.stringify({ok:true,result:req.payload}));
`,{mode:0o700});
  const events=[],runner=new EgoRunner({root:path.join(root,'requests'),executable});
  const data={title:'MALICIOUS $(touch nope) `touch nope` 中文\n第二行'};
  assert.deepEqual(await runner.call('observe',data,{onEvent:e=>events.push(e)}),data);assert.equal(events[0].name,'测试');
  await assert.rejects(runner.call('shell',{}),/未开放/);
  const manual={workspaceName:'文青尚品 · 拼多多 · manual-unit'};
  await runner.call('open',manual);
  // Once handed off, refresh must not even start the CLI again.
  await fs.rm(executable);
  assert.equal((await runner.call('observe',manual)).status,'awaiting-user');
});
test('拼多多断连保留错误码和未运行商品，队列退出后仍可使用App服务',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-ego-stop-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const inputHash='c'.repeat(64),runner={call:async op=>{assert.equal(op,'validate');return{ok:true,inputHash,executionHash:'d'.repeat(64)};}};
  let calls=0;const browser={verify:async()=>({endpoint:'ego:fixture'}),runPdd:async()=>{calls++;throw Object.assign(Error('Ego 连接中断'),{code:'EGO_CONNECTION_LOST',diagnostic:{exitCode:23}});}};
  const service=new ListingService({root,runner,browser});await service.init();await service.setPlatform('pdd');
  const shop=await service.addShop('合成店','pdd');Object.assign(shop,{verified:true,loggedIn:true,actualName:shop.name});
  service.catalog=[1,2].map(n=>({id:'p'+n,ok:true,config:{platform:'pdd',draftOnly:true,product:{id:'P'+n,itemCode:'P'+n,title:'合成商品'+n},skuMatrix:[],pdd:{basic:{},service:{}},input:{inputHash}}}));
  await service.select({shopIds:[shop.id],productIds:['p1','p2']});await service.check();await service.start(service.preflight.token);await service.drivePromise;
  assert.equal(calls,1);assert.equal(service.running,false);assert.equal(service.run.status,'needs-review');assert.equal(service.run.tasks[1].status,'not-run');
  assert.equal(service.run.tasks[0].errorCode,'EGO_CONNECTION_LOST');assert.equal(service.run.tasks[0].diagnostic.exitCode,23);
  assert.equal(shop.loginStatus,'connection-error');assert.equal(shop.verified,false);
  await service.addShop('服务仍可用','pdd');assert.equal(service.snapshot().config.shops.length,2);
});

test('explicit recreation takes control at the start of its round, without retrying after a failure',async t=>{
  const names=['listTaskSpaces','takeOverTaskSpace','taskSpace'];const old=Object.fromEntries(names.map(n=>[n,globalThis[n]]));
  t.after(()=>{for(const n of names)if(old[n]===undefined)delete globalThis[n];else globalThis[n]=old[n];});
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-start-control-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const payload={workspaceName:'文青尚品 · 拼多多 · synthetic-recreate',expectedShop:'合成店',recreate:true,config:{platform:'intentionally-invalid'}};
  let takeovers=0;
  const task={tabs:async()=>[{label:'p1',url:'https://mms.pinduoduo.com/goods/goods_list'}],page:()=>({evaluate:async()=>({blocked:false,names:['合成店'],url:'https://mms.pinduoduo.com/goods/goods_list'})})};
  globalThis.listTaskSpaces=async()=>[{id:19,name:payload.workspaceName,ownership:'agent'}];
  globalThis.takeOverTaskSpace=async()=>{takeovers++;return task;};globalThis.taskSpace=()=>assert.fail('must use explicit takeover at recreation start');
  const request=path.join(root,'request.json'),result=path.join(root,'result.json');await fs.writeFile(request,JSON.stringify({op:'run',payload}));
  await runEgoRequest(request,result);
  const response=JSON.parse(await fs.readFile(result,'utf8'));assert.equal(response.ok,false);assert.match(response.error,/冻结输入或店铺身份/);assert.equal(takeovers,1);
  const events=(await fs.readFile(result+'.events.jsonl','utf8')).trim().split('\n').map(JSON.parse);assert.equal(events[0].text,'正在连接本店 Ego 工作空间');assert(events.at(-1).text.startsWith('操作停止：'));
});
