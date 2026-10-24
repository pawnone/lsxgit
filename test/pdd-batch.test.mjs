import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {ListingService} from '../desktop/service.mjs';import {writeJson} from '../desktop/storage.mjs';import {prepareEgoPage} from '../engine/pdd/run-draft.mjs';
async function setup(t,fail){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-pdd-batch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const seen=[];
  const service=new ListingService({root,runner:{call:async(_op,p)=>({ok:true,inputHash:p.config.testHash})},browser:{verify:async()=>({endpoint:'ego:fixture'}),runPdd:async(_shop,p)=>{
    seen.push(p);if(seen.length===1)await fail(p);
    const receiptFile=path.join(p.outputDir,'draft-save-'+p.expectedHash+'.json');await writeJson(receiptFile,{status:'confirmed',inputHash:p.expectedHash,evidence:['offline fixture']});return{ok:true,saved:{status:'confirmed',receiptFile,evidence:['offline fixture']}};
  }}});
  await service.init();await service.setPlatform('pdd');const shop=await service.addShop('离线合成店','pdd');Object.assign(shop,{loggedIn:true,verified:true,actualName:shop.name});
  service.catalog=[1,2].map(n=>({id:'p'+n,ok:true,config:{platform:'pdd',product:{id:'p'+n,title:'合成'+n,itemCode:'p'+n},skuMatrix:[],pdd:{basic:{},service:{}},testHash:String(n).repeat(64)}}));
  await service.select({shopIds:[shop.id],productIds:['p1','p2']});await service.check();await service.start(service.preflight.token);await service.drivePromise;return{service,seen};
}
test('普通失败有明确未保存证据时，下一商品继续且批次显示部分失败',async t=>{
  const {service:s,seen}=await setup(t,async p=>{await writeJson(path.join(p.outputDir,'product-failure.json'),{safeToContinue:true,inputHash:p.expectedHash,attemptId:p.attemptId,batchId:p.batchId});throw Error('字段选项不存在');});
  assert.equal(seen.length,2);assert.equal(s.run.status,'complete-with-errors');assert.deepEqual(s.run.tasks.map(t=>t.status),['failed','confirmed']);assert(s.run.logs.some(e=>e.text.includes('继续下一件')));
});
for(const mode of ['pending','missing-proof','wrong-proof','safety','control'])test(mode+' 不跳过、不自动重试',async t=>{
  const {service:s,seen}=await setup(t,async p=>{
    if(mode==='pending')await writeJson(path.join(p.outputDir,'draft-save-'+p.expectedHash+'.json'),{status:'pending'});
    if(mode!=='missing-proof')await writeJson(path.join(p.outputDir,'product-failure.json'),{safeToContinue:!['safety','control'].includes(mode),inputHash:p.expectedHash,attemptId:mode==='wrong-proof'?'old':p.attemptId,batchId:p.batchId});
    throw Error(mode==='safety'?'SAFETY_BLOCKED：验证码':mode==='control'?'Ego 工作空间由你控制':'字段操作失败');
  });assert.equal(seen.length,1);assert.equal(s.run.tasks[1].status,'not-run');assert.notEqual(s.run.status,'complete-with-errors');if(mode==='pending')assert.equal(s.run.tasks[0].status,'needs-review');
});
test('只有同批已确认未保存的失败页可复用，跨批和未知保存页仍阻断',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-pdd-reuse-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const page={label:'p15'},task={tabs:async()=>[{label:'p15'}],page:()=>page,newPage:()=>assert.fail('必须复用同页')};const prior={attemptId:'first',batchId:'batch',phase:'failed',safeToContinue:true,label:'p15'};
  assert.equal((await prepareEgoPage(task,{prior,attemptId:'second',batchId:'batch',outputDir:root})).page,page);
  await assert.rejects(prepareEgoPage(task,{prior,attemptId:'second',batchId:'other',outputDir:root}),/未确认/);
  await assert.rejects(prepareEgoPage(task,{prior:{...prior,phase:'needs-review'},attemptId:'second',batchId:'batch',outputDir:root}),/未确认/);
});
test('执行器只为店铺仍匹配且未触发保存的普通错误签发继续证据',async t=>{
  const {imageFixture}=await import('./pdd-fixtures.mjs');const {prepareProduct}=await import('../engine/pdd/product.mjs');const {executionHash}=await import('../engine/pdd/frozen-input.mjs');const {executePddDraft}=await import('../engine/pdd/run-draft.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-pdd-proof-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await imageFixture(root);const p=await prepareProduct(root),config=p.config;
  config.expectedShop='离线合成店';Object.assign(config.pdd.service,{'发货模式':'时段预售','承诺发货时间/时效':'10天内发货'});
  for(const mode of ['ordinary','mismatch','pending']){
    const outputDir=path.join(root,'out-'+mode);await fs.mkdir(outputDir);let failing=false;
    const page={label:'p15',goto:async()=>{},evaluate:async()=>({url:'https://mms.pinduoduo.com/goods/category',names:[mode==='mismatch'&&failing?'另一店':'离线合成店'],blocked:false}),waitForFunction:async()=>{failing=true;if(mode==='pending')await writeJson(path.join(outputDir,'draft-save-'+p.inputHash+'.json'),{status:'pending'});throw Error('平台字段缺失');}};
    const payload={config,expectedHash:p.inputHash,expectedShop:config.expectedShop,validation:{ok:true,inputHash:p.inputHash,executionHash:executionHash(config)},outputDir,attemptId:mode,batchId:'batch',workspaceFile:path.join(outputDir,'workspace.json')};
    await assert.rejects(executePddDraft({task:{newPage:async()=>page},payload}),mode==='mismatch'?/店铺身份不符/:/平台字段缺失/);
    const proof=JSON.parse(await fs.readFile(path.join(outputDir,'product-failure.json'),'utf8'));assert.equal(proof.safeToContinue,mode==='ordinary');
    assert.equal(proof.attemptId,mode);assert.equal(proof.inputHash,p.inputHash);
  }
});
