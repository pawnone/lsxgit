import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {planMainImageNames,applyMainImageNames} from '../desktop/main-image-names.mjs';
import {ListingService} from '../desktop/service.mjs';
async function fixture(t,names=['图10.jpg','图2.PNG','图1.jpeg','04.jpg','05.png']){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wq-image-names-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const product=path.join(root,'商品01'),dir=path.join(product,'主图');await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(product,'商品信息.json'),JSON.stringify({assetMode:'directory',itemCode:'fixture'}));
 for(const name of names)await fs.writeFile(path.join(dir,name),'original bytes: '+name);
 return {root,product,dir};
}
test('natural ordering, mixed extensions, existing numbered files: retain every byte and original backups',async t=>{
 const f=await fixture(t);const p=await planMainImageNames(f.root,f.product);
 assert.deepEqual(p.mapping.map(m=>m.from),['04.jpg','05.png','图1.jpeg','图2.PNG','图10.jpg']);
 const originals=await Promise.all(p.mapping.map(m=>fs.readFile(path.join(f.dir,m.from))));
 const r=await applyMainImageNames(f.root,f.product,p.signature);
 for(const [i,m] of p.mapping.entries()){
  assert.deepEqual(await fs.readFile(path.join(f.dir,m.to)),originals[i]);
  assert.deepEqual(await fs.readFile(path.join(r.backup,m.from)),originals[i]);
 }
 assert.equal((await fs.readdir(f.dir)).length,5);
 assert.equal(JSON.parse(await fs.readFile(path.join(r.backup,'manifest.json'))).status,'complete');
 const again=await planMainImageNames(f.root,f.product);assert.equal(again.changed,false);
 assert.equal((await applyMainImageNames(f.root,f.product,again.signature)).changed,false);
});
test('same destination names can be shifted without overwriting other originals',async t=>{
 const f=await fixture(t,['01.jpg','02.jpg','00.jpg']);const p=await planMainImageNames(f.root,f.product);
 await applyMainImageNames(f.root,f.product,p.signature);
 assert.equal(await fs.readFile(path.join(f.dir,'02.jpg'),'utf8'),'original bytes: 01.jpg');
 assert.equal(await fs.readFile(path.join(f.dir,'01.jpg'),'utf8'),'original bytes: 00.jpg');
});
test('changed file invalidates preview before mutation',async t=>{
 const f=await fixture(t);const p=await planMainImageNames(f.root,f.product);
 await fs.writeFile(path.join(f.dir,p.mapping[0].from),'changed');
 await assert.rejects(applyMainImageNames(f.root,f.product,p.signature),/已变化/);
 assert.deepEqual((await fs.readdir(f.dir)).sort(),p.mapping.map(m=>m.from).sort());
});
test('ambiguous directories, symbolic links and legacy references are rejected',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.dir,'01.jpg'));
 await assert.rejects(planMainImageNames(f.root,f.product),/子文件夹/);
 await fs.rmdir(path.join(f.dir,'01.jpg'));
 await fs.symlink(path.join(f.dir,'04.jpg'),path.join(f.dir,'alias.jpg'));
 await assert.rejects(planMainImageNames(f.root,f.product),/符号链接/);
 await fs.unlink(path.join(f.dir,'alias.jpg'));
 await fs.writeFile(path.join(f.product,'商品信息.json'),JSON.stringify({mainImages:['主图/04.jpg']}));
 await assert.rejects(planMainImageNames(f.root,f.product),/旧版显式图片路径/);
});
test('interrupted journal blocks replay and foreign product folders are rejected',async t=>{
 const f=await fixture(t),b=path.join(f.product,'.wq-main-image-backups','interrupted');await fs.mkdir(b,{recursive:true});
 await fs.writeFile(path.join(b,'manifest.json'),JSON.stringify({status:'pending'}));
 await assert.rejects(planMainImageNames(f.root,f.product),/中断/);
 await assert.rejects(planMainImageNames(f.product,f.product),/直接子目录/);
});
test('service accepts only catalog product IDs and blocks rename while running or paused',async t=>{
 const f=await fixture(t);const s=new ListingService({root:path.join(f.root,'appdata')});
 s.config.materialsRoot=f.root;s.catalog=[{id:'p1',materialRoot:f.product,config:{product:{},skuMatrix:[]}}];
 await assert.rejects(s.mainImageNames('other'),/未找到/);
 s.running=true;await assert.rejects(s.mainImageNames('p1'),/当前有任务/);s.running=false;
 const plan=await s.mainImageNames('p1');assert.equal(plan.mapping.length,5);
 await assert.rejects(s.mainImageNames('p1','bad-token'),/预览已失效/);
 s.preflight={token:'old',tasks:[]};
 await s.mainImageNames('p1',plan.token);assert.equal(s.preflight,null);
});
test('partial destination copy failure restores original names and keeps backup evidence',async t=>{
 const f=await fixture(t);const p=await planMainImageNames(f.root,f.product);let copies=0;
 const io={...fs,copyFile:async(...args)=>{if(++copies===2)throw Error('simulated disk failure');return fs.copyFile(...args);}};
 await assert.rejects(applyMainImageNames(f.root,f.product,p.signature,{io}),/已恢复原名/);
 for(const m of p.mapping)assert.equal(await fs.readFile(path.join(f.dir,m.from),'utf8'),'original bytes: '+m.from);
 assert.deepEqual((await fs.readdir(f.dir)).sort(),p.mapping.map(m=>m.from).sort());
 const dirs=await fs.readdir(path.join(f.product,'.wq-main-image-backups'));
 const journal=JSON.parse(await fs.readFile(path.join(f.product,'.wq-main-image-backups',dirs[0],'manifest.json')));
 assert.equal(journal.status,'rolled-back');
});
