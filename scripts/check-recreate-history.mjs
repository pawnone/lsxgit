// Reproduce the user's blocked history on a private copy. Only the material
// reader uses real files; browser verification is an explicit offline fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {ProcessRunner} from '../desktop/process-runner.mjs';
const installed=process.env.WQ_TEST_APP;if(!installed)throw Error('请指定WQ_TEST_APP');
const bundle=path.resolve(installed,'../../Resources/app');
const {ListingService}=await import(pathToFileURL(path.join(bundle,'desktop/service.mjs')));
const original=path.join(os.homedir(),'Library/Application Support/文青尚品'),root=await fs.mkdtemp(path.join(os.tmpdir(),'wenqing-real-history-'));
try{
  for(const name of ['config.json','runs','tasks'])await fs.cp(path.join(original,name),path.join(root,name),{recursive:true});
  const runner=new ProcessRunner({execPath:installed,electron:true,worker:path.join(bundle,'desktop/worker.mjs')});
  const service=new ListingService({root,runner,browser:{verify:async()=>({endpoint:'offline:fixture'})}});await service.init();
  assert.equal(service.config.platform,'pdd');await service.scan();
  const shop=service.config.shops.find(s=>s.platform==='pdd'),product=service.catalog.find(p=>p.ok);assert(shop&&product);
  Object.assign(shop,{loggedIn:true,verified:true,actualName:shop.name,securityBlocked:false});
  await service.select({shopIds:[shop.id],productIds:[product.id]});
  await assert.rejects(service.check(),/上次结果未确认/);
  const old=service.history.flatMap(r=>r.tasks).filter(t=>t.shopId===shop.id&&t.productId===product.id);
  assert(old.some(t=>t.status==='needs-review'));
  await service.check({mode:'recreate'});const task=service.preflight.tasks[0];
  assert.equal(task.status,'recreate-ready');assert(!old.some(t=>t.attemptId===task.attemptId));assert(task.outputDir.startsWith(root+path.sep));
  assert(service.history.flatMap(r=>r.tasks).some(t=>t.shopId===shop.id&&t.productId===product.id&&t.status==='needs-review'));
  console.log(JSON.stringify({checks:5,realBlockedHistoryReproduced:true,recreatePreflightPassed:true,sku:task.sku,independentAttempt:true,oldHistoryPreserved:true,startedNewDraft:false,merchantMutation:false,realEgoControl:false}));
}finally{await fs.rm(root,{recursive:true,force:true});}
