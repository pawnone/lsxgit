import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {stageMediaUploadSlots} from '../engine/pdd/upload-slots.mjs';
import {png} from './pdd-fixtures.mjs';

test('Windows uses short temporary slots, preserves repeated bytes, and leaves the source intact',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-cache-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'原图.png'),bytes=png(),sha256=crypto.createHash('sha256').update(bytes).digest('hex');await fs.writeFile(file,bytes);
  const config={materialRoot:root,input:{files:[{file:'原图.png',sha256}]}};
  const deep=path.join(root,'a'.repeat(64),'b'.repeat(64)+'-slots');
  const slots=await stageMediaUploadSlots(config,Array(17).fill(file),deep,{platform:'win32',tempRoot:root});
  assert.equal(slots.files.length,17);assert.equal(new Set(slots.files).size,17);
  assert(slots.temporary);assert(slots.files.every(f=>f.length<240&&!f.includes('a'.repeat(64))));
  for(const f of slots.files)assert.deepEqual(await fs.readFile(f),bytes);
  assert.deepEqual(await fs.readFile(file),bytes);await assert.rejects(fs.stat(deep),{code:'ENOENT'});
  const existing=path.join(root,'mac-cache');const mac=await stageMediaUploadSlots(config,[file],existing,{platform:'darwin'});
  assert.equal(mac.temporary,null);assert.equal(mac.files[0],path.join(existing,'01.png'));
});
test('overlong Windows TEMP stops before copying or dispatching instead of relying on long-path opt-in',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-cache-long-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const tempRoot=path.join(root,'a'.repeat(100),'b'.repeat(100),'c'.repeat(20));await fs.mkdir(tempRoot,{recursive:true});
  await assert.rejects(stageMediaUploadSlots({},['missing.png'],null,{platform:'win32',tempRoot}),/临时上传目录过长/);
});
