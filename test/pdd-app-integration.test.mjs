import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ListingService} from '../desktop/service.mjs';
import {classifyShop} from '../engine/pdd/shop-observation.mjs';

test('PDD identity requires one exact name across all observed pages',()=>{
  assert.equal(classifyShop([{names:['甲店']},{names:['甲店']}],'甲店').status,'verified');
  assert.equal(classifyShop([{names:['甲店旗舰店']}],'甲店').status,'mismatch');
  assert.equal(classifyShop([{names:[]}],'甲店').status,'login-required');
  assert.equal(classifyShop([{names:['甲店']},{names:['乙店']}],'甲店').status,'ambiguous');
});
test('platform switching keeps separate roots, clears selections and routes scans',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wq-platform-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const scans=[];
  const service=new ListingService({root:path.join(dir,'data'),runner:{call:async(op,p)=>{assert.equal(op,'scan');scans.push(p);return{products:[],errors:[]};}},browser:{}});
  await service.init();
  const dou=await service.addShop('甲店','dou'),pdd=await service.addShop('甲店','pdd');
  await fs.mkdir(path.join(dir,'dou'));await fs.mkdir(path.join(dir,'pdd'));
  await service.setRoot(path.join(dir,'dou'));
  await service.setPlatform('pdd');
  assert.equal(service.config.materialsRoot,'');assert.deepEqual(service.config.selectedShopIds,[]);
  await assert.rejects(service.select({shopIds:[dou.id]}),/选择无效/);
  await service.select({shopIds:[pdd.id]});await service.setRoot(path.join(dir,'pdd'));
  assert.equal(scans.at(-1).platform,'pdd');
  await service.setPlatform('dou');assert.equal(service.config.materialsRoot,path.join(dir,'dou'));
  assert.equal(scans.at(-1).platform,'dou');
  service.running=true;await assert.rejects(service.setPlatform('pdd'),/当前有任务/);
});
test('PDD login and verification use the PDD shop instead of the Dou gate',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wq-pdd-login-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const seen=[];
  const browser={open:async s=>seen.push(['open',s.platform]),observe:async s=>({status:'verified',actualName:s.name,loggedIn:true}),verify:async s=>{seen.push(['verify',s.platform]);return{evidence:['matched']};}};
  const service=new ListingService({root:dir,browser,runner:{}});await service.init();
  const shop=await service.addShop('甲店','pdd');await service.openLogin(shop.id);await service.verify(shop.id);
  assert.deepEqual(seen,[['open','pdd'],['verify','pdd']]);assert.equal(shop.verified,true);
});
