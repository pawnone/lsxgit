import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {imageFixture} from './pdd-fixtures.mjs';
import {planPddImageSettings,applyPddImageSettings} from '../desktop/pdd-image-settings.mjs';
import {prepareProduct,validateConfig} from '../engine/pdd/product.mjs';
import {detailImagePlan,mediaPlan} from '../engine/pdd/media.mjs';
import {stageMainUploadSlots,assertMainUploadSlots} from '../engine/pdd/upload-slots.mjs';
import {ListingService} from '../desktop/service.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

async function fixture(t,options){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wq-image-settings-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'商品');await fs.mkdir(dir);return {root,...await imageFixture(dir,options)};}
test('编号、首图及SKU引用一次保存，保留原图内容和其他工作表',async t=>{
  const f=await fixture(t,{names:['00.png','01.png','02.png','相机3.png','相机10.png'],ref:'02'});
  f.wb.getWorksheet('个别尺码调整（选填）').getCell('G2').value='01';await f.wb.xlsx.writeFile(f.file);
  const before=new Map(await Promise.all(f.names.map(async n=>[n,await fs.readFile(path.join(f.main,n))])));
  const p=await planPddImageSettings(f.root,f.dir);assert.equal(p.changed,true);
  const r=await applyPddImageSettings(f.root,f.dir,p.signature,'03');
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(f.file);
  assert.equal(wb.getWorksheet('款式与尺码').getCell('F2').value,'03');
  assert.equal(wb.getWorksheet('个别尺码调整（选填）').getCell('G2').value,'02');
  assert.equal(wb.getWorksheet('个别尺码调整（选填）').getCell('F2').value,'USER-EXACT-CODE');
  assert.equal(wb.getWorksheet('原始备注').state,'hidden');assert.equal(wb.getWorksheet('原始备注').getCell('C1').value,'保留的原说明');
  assert.deepEqual(await fs.readFile(path.join(f.main,'03.png')),before.get('02.png'));
  assert.deepEqual(await fs.readFile(path.join(r.backup,'image-2.png')),before.get('02.png'));
  const product=await prepareProduct(f.dir);assert(product.ok,JSON.stringify(product.errors));
  assert.equal(product.config.skuMatrix[0].image,'02'); // Per-size override remains the same physical original.
  assert.equal(mediaPlan(product.config).find(p=>p.kind==='style').files[0],path.join(f.main,'02.png'));
});
test('5张原图生成10轮播/17详情，共用同一首图且SKU不随上传排序变化',async t=>{
  const f=await fixture(t);const p=await planPddImageSettings(f.root,f.dir);
  await applyPddImageSettings(f.root,f.dir,p.signature,'03');
  const r=await prepareProduct(f.dir);assert(r.ok,JSON.stringify(r.errors));
  assert.deepEqual(r.config.product.mainImages.map(f=>path.basename(f)),['03','04','05','01','02','03','04','05','01','02'].map(n=>n+'.png'));
  const details=detailImagePlan(r.config.product);assert.equal(details.length,17);assert.equal(details.filter(f=>f===r.config.product.sizeImage).length,1);
  assert.equal(path.basename(details[1]),'03.png');assert.equal(r.config.skuMatrix[0].image,'02');
  assert.equal((await validateConfig(r.config)).ok,true);
  const uploads=await stageMainUploadSlots(r.config,path.join(f.root,'task-cache'));
  assert.equal(new Set(uploads).size,10);await assertMainUploadSlots(r.config,uploads);
  assert.equal((await fs.readdir(f.main)).length,5);
  await fs.writeFile(uploads[0],'changed');await assert.rejects(assertMainUploadSlots(r.config,uploads),/内容与原图不同/);
});
test('预览不改文件，外部修改会使确认失效，已保存设置重复确认不产生备份',async t=>{
  const f=await fixture(t);const bytes=await fs.readFile(f.file);const plan=await planPddImageSettings(f.root,f.dir);
  assert.deepEqual(await fs.readFile(f.file),bytes);assert.deepEqual((await fs.readdir(f.main)).sort(),f.names.sort());
  await applyPddImageSettings(f.root,f.dir,plan.signature,'02');
  const p=await planPddImageSettings(f.root,f.dir);assert.deepEqual(p.selected,'02');
  const noChange=await applyPddImageSettings(f.root,f.dir,p.signature,p.selected);assert.equal(noChange.changed,false);
  assert.equal((await fs.readdir(path.join(f.dir,'.wq-image-settings'))).length,1);
  await fs.appendFile(path.join(f.main,'01.png'),'external');await assert.rejects(applyPddImageSettings(f.root,f.dir,p.signature,p.selected),/已变化/);
});
test('写表失败时恢复文件名和Excel，Excel锁及未知图片引用提前提示',async t=>{
  const f=await fixture(t);const before=await fs.readFile(f.file),plan=await planPddImageSettings(f.root,f.dir);
  const io={...fs,rename:async(from,to)=>{if(to===f.file)throw Error('synthetic write failure');return fs.rename(from,to);}};
  await assert.rejects(applyPddImageSettings(f.root,f.dir,plan.signature,'01',{io}),/已恢复/);
  assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual((await fs.readdir(f.main)).sort(),f.names.sort());
  const next=await planPddImageSettings(f.root,f.dir);await fs.writeFile(path.join(f.dir,'~$商品信息表.xlsx'),'lock');
  await assert.rejects(applyPddImageSettings(f.root,f.dir,next.signature,next.selected),/保存并关闭/);
  await fs.unlink(path.join(f.dir,'~$商品信息表.xlsx'));
  f.wb.getWorksheet('款式与尺码').getCell('F2').value='99';await f.wb.xlsx.writeFile(f.file);
  await assert.rejects(planPddImageSettings(f.root,f.dir),/F2.*不存在/);
});
test('商品根目录、目录别名可编号；非法首图配置在预检报错，尺码和选填素材可缺少',async t=>{
  const f=await fixture(t,{folder:'轮播图'});const p=await planPddImageSettings(f.dir,f.dir);
  await applyPddImageSettings(f.dir,f.dir,p.signature,'01');
  await fs.rm(path.join(f.dir,'尺码图'),{recursive:true});const product=await prepareProduct(f.dir);assert(product.ok,JSON.stringify(product.errors));
  assert.equal(detailImagePlan(product.config.product).length,17);assert.equal(path.basename(detailImagePlan(product.config.product)[0]),'01.png');
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(f.file);wb.getWorksheet('基础信息').eachRow(r=>{if(r.getCell(1).value==='首图编号')r.getCell(2).value='99';});await wb.xlsx.writeFile(f.file);
  assert((await prepareProduct(f.dir)).errors.some(e=>/首图编号.*99/.test(e.message)));
});
test('主图设置服务只接受当前商品、失效预览不可提交、运行中禁止修改',async t=>{
  const f=await fixture(t);const s=new ListingService({root:path.join(f.root,'appdata')});await s.init();s.config.platform='pdd';s.config.materialsRoot=f.root;
  s.catalog=[await prepareProduct(f.dir)];const id=s.catalog[0].id;
  const plan=await s.imageSettings(id);assert.equal(plan.pictures.length,5);
  await assert.rejects(s.imageSettings('unknown'),/未找到/);
  await assert.rejects(s.imageSettings(id,'expired',plan.selected),/失效/);
  s.running=true;await assert.rejects(s.imageSettings(id),/当前有任务/);
});
test('编号中进程崩溃后重新打开能从原图和表格备份恢复，再次可保存',async t=>{
  const f=await fixture(t),bytes=await fs.readFile(f.file);
  const moduleUrl=new URL('../desktop/pdd-image-settings.mjs',import.meta.url).href;
  const code=`import fs from 'node:fs/promises';import {planPddImageSettings,applyPddImageSettings} from ${JSON.stringify(moduleUrl)};
const [root,dir]=process.argv.slice(1);const p=await planPddImageSettings(root,dir);let moves=0;
await applyPddImageSettings(root,dir,p.signature,'03',{io:{...fs,rename:async(...args)=>{await fs.rename(...args);if(++moves===2)process.exit(73);}}});`;
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',code,f.root,f.dir]),e=>e.code===73);
  const recovered=await planPddImageSettings(f.root,f.dir);assert.equal(recovered.recovered,true);
  assert.deepEqual((await fs.readdir(f.main)).sort(),f.names.sort());assert.deepEqual(await fs.readFile(f.file),bytes);
  await applyPddImageSettings(f.root,f.dir,recovered.signature,'03');
  assert.equal((await prepareProduct(f.dir)).ok,true);
});
test('一键编号与选首图是两个独立动作；首图只存一格，详情跟随',async t=>{
  const f=await fixture(t),s=new ListingService({root:path.join(f.root,'appdata')});await s.init();s.config.platform='pdd';s.config.materialsRoot=f.root;
  s.catalog=[await prepareProduct(f.dir)];const id=s.catalog[0].id;
  await s.numberPddImages(id);
  assert.equal((await prepareProduct(f.dir)).config.product.imageOrder.implicit,true);
  const p=await s.imageSettings(id);await s.imageSettings(id,p.token,'03');
  const prepared=await prepareProduct(f.dir);
  assert.equal(path.basename(prepared.config.product.mainImages[0]),'03.png');
  assert.equal(path.basename(detailImagePlan(prepared.config.product)[1]),'03.png');
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(f.file);
  const rows=[];wb.getWorksheet('基础信息').eachRow(r=>{if(String(r.getCell(1).value).includes('首图'))rows.push(r.values.slice(1,3));});
  assert.deepEqual(rows,[['首图编号','03']]);
  assert.equal((await s.numberPddImages(id)).changed,false);
});
test('未编号也能选首图，选图不偷偷改文件名，随后编号仍保留同一图片',async t=>{
  const f=await fixture(t);const before=(await fs.readdir(f.main)).sort();
  let p=await planPddImageSettings(f.root,f.dir);
  await applyPddImageSettings(f.root,f.dir,p.signature,'03',{rename:false});
  assert.deepEqual((await fs.readdir(f.main)).sort(),before);
  let product=await prepareProduct(f.dir);assert.equal(path.basename(product.config.product.mainImages[0]),'相机3.png');
  assert.equal(path.basename(detailImagePlan(product.config.product)[1]),'相机3.png');
  p=await planPddImageSettings(f.root,f.dir);await applyPddImageSettings(f.root,f.dir,p.signature,p.selected,{rename:true,setFirst:false});
  product=await prepareProduct(f.dir);assert.equal(product.config.product.imageOrder.firstRef,'03');
  assert.equal(path.basename(product.config.product.mainImages[0]),'03.png');
});
test('10张不同原图重排后也用上传槽位名称，平台按文件名排序仍保持所选首图',async t=>{
  const f=await fixture(t,{names:Array.from({length:10},(_,i)=>String(i+1).padStart(2,'0')+'.png')});
  const plan=await planPddImageSettings(f.root,f.dir);await applyPddImageSettings(f.root,f.dir,plan.signature,'03',{rename:false});
  const p=await prepareProduct(f.dir),slots=await stageMainUploadSlots(p.config,path.join(f.root,'slots'));
  assert.equal(path.basename(slots[0]),'01.png');
  assert.deepEqual(await fs.readFile(slots[0]),await fs.readFile(path.join(f.main,'03.png')));
  await assertMainUploadSlots(p.config,slots);
});
test('原模板例外调整表第22行合并说明不是SKU图片引用，编号及写回仍保留说明',async t=>{
  const f=await fixture(t),sheet=f.wb.getWorksheet('个别尺码调整（选填）');
  sheet.mergeCells('A22:H22');sheet.getCell('A22').value='只填写差异项；空值继承款式值，库存0有效。';await f.wb.xlsx.writeFile(f.file);
  const p=await planPddImageSettings(f.root,f.dir);await applyPddImageSettings(f.root,f.dir,p.signature,'02');
  const check=new ExcelJS.Workbook();await check.xlsx.readFile(f.file);
  assert.equal(check.getWorksheet(sheet.name).getCell('G22').value,'只填写差异项；空值继承款式值，库存0有效。');
  assert.equal((await prepareProduct(f.dir)).ok,true);
});
