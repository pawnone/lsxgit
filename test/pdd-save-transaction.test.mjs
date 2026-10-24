import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {saveTransaction} from '../engine/pdd/save-transaction.mjs';

async function fixture(t){
  const outputDir=await fs.mkdtemp(path.join(os.tmpdir(),'pdd-save-'));
  t.after(()=>fs.rm(outputDir,{recursive:true,force:true}));
  return{outputDir,inputHash:'a'.repeat(64),expectedShop:'合成测试店',productId:'fixture',
    beforeSave:async()=>({ok:true,stage:'before-save',evidence:['保存前全部字段一致']}),
    dispatch:async()=>({acknowledgement:{kind:'draft-specific-message',text:'保存草稿成功'}})};
}
test('pre-save review and fresh save acknowledgement confirm without reopening; rerun never clicks',async t=>{
  const p=await fixture(t);let count=0;const dispatch=p.dispatch;
  p.dispatch=async()=>{
    count++;
    const r=JSON.parse(await fs.readFile(path.join(p.outputDir,`draft-save-${p.inputHash}.json`),'utf8'));
    assert.equal(r.status,'pending');return dispatch();
  };
  p.verifyPersisted=async()=>assert.fail('must not reopen or review after saving');
  const result=await saveTransaction(p);
  assert.equal(result.status,'confirmed');assert.equal(result.verification.stage,'before-save');
  assert.equal(result.saveAcknowledgement.acknowledgement.text,'保存草稿成功');
  await assert.rejects(saveTransaction(p),/已有保存记录/);assert.equal(count,1);
});
test('failed field review stops before creating a save intent or clicking',async t=>{
  const p=await fixture(t);p.beforeSave=async()=>{throw Error('SKU differs');};
  p.dispatch=async()=>assert.fail('no click');
  await assert.rejects(saveTransaction(p),/SKU differs/);assert.deepEqual(await fs.readdir(p.outputDir),[]);
});
test('missing or wrong-stage pre-save evidence cannot click save',async t=>{
  const p=await fixture(t);p.dispatch=async()=>assert.fail('no click');
  for(const result of [undefined,{ok:true,evidence:['没有核对阶段']},{ok:true,stage:'before-save',evidence:[]}]){
    p.beforeSave=async()=>result;await assert.rejects(saveTransaction(p),/保存前未获得完整核对结果/);
    assert.deepEqual(await fs.readdir(p.outputDir),[]);
  }
});
test('timeout after click remains pending and cannot replay',async t=>{
  const p=await fixture(t);let count=0;p.dispatch=async()=>{count++;throw Error('timeout');};
  await assert.rejects(saveTransaction(p),/未确认/);await assert.rejects(saveTransaction(p),/已有保存记录/);assert.equal(count,1);
  assert.equal(JSON.parse(await fs.readFile(path.join(p.outputDir,`draft-save-${p.inputHash}.json`),'utf8')).status,'pending');
});
test('missing or generic success acknowledgement cannot confirm a draft',async t=>{
  for(const acknowledgement of [undefined,{kind:'generic',text:'操作成功'},{kind:'draft-save-modal',text:''}]){
    const p=await fixture(t);p.dispatch=async()=>({acknowledgement});
    await assert.rejects(saveTransaction(p),/未获得本次草稿保存成功提示/);
    assert.equal(JSON.parse(await fs.readFile(path.join(p.outputDir,`draft-save-${p.inputHash}.json`),'utf8')).status,'pending');
  }
});
