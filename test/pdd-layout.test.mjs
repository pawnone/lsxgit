import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {imageFixture} from './pdd-fixtures.mjs';
import {prepareProduct,scanProducts,KNIT_CATEGORY} from '../engine/pdd/product.mjs';
import {readWorkbook} from '../engine/pdd/workbook-reader.mjs';
import {planPddImageSettings,applyPddImageSettings} from '../desktop/pdd-image-settings.mjs';

async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wq-layout-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'商品');await fs.mkdir(dir);return{root,...await imageFixture(dir)};
}
function moveFields(sheet){
  const rows=sheet.getSheetValues().slice(1).filter(Boolean).map(row=>row.slice(1));
  sheet.eachRow(row=>{row.values=[];});sheet.getRow(3).values=['说明','填写值','字段'];
  rows.slice(1).reverse().forEach((row,index)=>{sheet.getRow(5+index*2).values=[row[2]||'',row[1],row[0]];});
  sheet.getColumn(2).numFmt='0.00';sheet.getColumn(3).font={name:'Arial',size:17};
}
function compactSpecs(wb,{reverse=false,sizeFirst=false}={}){
  const sheet=wb.getWorksheet('款式与尺码'),header=sheet.getRow(1).values.slice(1),style=sheet.getRow(2).values.slice(1);
  sheet.eachRow(row=>{row.values=[];});const put=(row,values)=>{const array=Array(8).fill(null);values.forEach((v,i)=>array[i]=v);sheet.getRow(row).values=reverse?array.reverse():array;};
  if(sizeFirst){put(2,['尺码','备注']);put(3,['M','备注']);put(5,header);put(6,style);}
  else{put(3,header);put(4,style);put(6,['尺码','备注']);put(7,['M','备注']);}
}
test('删空行、调整行列和单元格样式后仍读取同一SKU数据，源文件不改',async t=>{
  const f=await fixture(t),before=await prepareProduct(f.dir);
  moveFields(f.wb.getWorksheet('基础信息'));moveFields(f.wb.getWorksheet('服务与承诺'));compactSpecs(f.wb,{reverse:true,sizeFirst:true});
  f.wb.getWorksheet('基础信息').name='商品资料';f.wb.getWorksheet('服务与承诺').name='发货及服务';f.wb.getWorksheet('款式与尺码').name='规格资料';
  await f.wb.xlsx.writeFile(f.file);const bytes=await fs.readFile(f.file),after=await prepareProduct(f.dir);
  assert.equal(after.ok,true,JSON.stringify(after.errors));assert.deepEqual(after.config.skuMatrix,before.config.skuMatrix);assert.deepEqual(after.config.pdd.basic,before.config.pdd.basic);
  assert.deepEqual(await fs.readFile(f.file),bytes);
});
test('精简表只保留折扣数值，后台固定满2件；不要求重复开关和数量',async t=>{
  const f=await fixture(t),basic=f.wb.getWorksheet('基础信息');let row;basic.eachRow(r=>{if(r.getCell(1).value==='满件折扣')row=r.number;});basic.spliceRows(row,1);basic.addRow(['折扣（几折）',9.5]);
  compactSpecs(f.wb);f.wb.removeWorksheet('个别尺码调整（选填）');await f.wb.xlsx.writeFile(f.file);
  const p=await prepareProduct(f.dir);assert.equal(p.ok,true,JSON.stringify(p.errors));assert.equal(p.config.pdd.basic['满件折扣'],'启用');assert.equal(p.config.pdd.basic['满件数量'],2);assert.equal(p.config.skuMatrix.length,1);
});
test('确实少一个价格时只定位真实数据单元格，零库存仍有效',async t=>{
  const f=await fixture(t);compactSpecs(f.wb,{reverse:true});const s=f.wb.getWorksheet('款式与尺码');s.getCell('F4').value=null;s.getCell('D4').value=0;
  await f.wb.xlsx.writeFile(f.file);const p=await prepareProduct(f.dir);assert.equal(p.ok,false);assert(p.errors.some(e=>e.field==='款式与尺码!F4'&&e.message.includes('拼单价')));assert.equal(p.config.skuMatrix[0].stock,0);
});
test('数据列标题重复或真实缺失时停止，不猜列、不误读尺码为款式',async t=>{
  const f=await fixture(t),s=f.wb.getWorksheet('款式与尺码');s.getCell('D1').value='拼单价';await f.wb.xlsx.writeFile(f.file);
  await assert.rejects(readWorkbook(f.dir,[f.file]),/列标题重复/);s.getCell('C1').value='';s.getCell('D1').value='单买价';await f.wb.xlsx.writeFile(f.file);
  await assert.rejects(readWorkbook(f.dir,[f.file]),/缺少数据列.*拼单价/);
});
test('超过当前款式上限会明确报数量，不静默截断额外数据',async t=>{
  const f=await fixture(t),s=f.wb.getWorksheet('款式与尺码');s.spliceRows(3,0,...Array.from({length:10},(_,i)=>['款式'+i,'',19.9,29.9,0,'02','CODE-'+i,'启用']));await f.wb.xlsx.writeFile(f.file);
  await assert.rejects(readWorkbook(f.dir,[f.file]),/最多支持10个款式.*不会截断/);
});
test('首图按钮及编号写回跟随移动后的列，不覆盖价格或尺码',async t=>{
  const f=await fixture(t);moveFields(f.wb.getWorksheet('基础信息'));compactSpecs(f.wb,{reverse:true});await f.wb.xlsx.writeFile(f.file);
  const plan=await planPddImageSettings(f.root,f.dir);assert(plan.references.some(r=>r.address==='C4'));
  await applyPddImageSettings(f.root,f.dir,plan.signature,'03');const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(f.file);const s=wb.getWorksheet('款式与尺码');assert.equal(s.getCell('C4').value,'02');assert.equal(s.getCell('F4').value,19.9);assert.equal(s.getCell('H7').value,'M');
  const p=await prepareProduct(f.dir);assert.equal(p.ok,true,JSON.stringify(p.errors));assert.equal(path.basename(p.config.product.mainImages[0]),'03.png');
});
test('没有首图控制行或详情文件夹仍由主图生成10/17，两类商品可同批扫描',async t=>{
  const f=await fixture(t);const other=path.join(f.root,'上衣');await fs.mkdir(other);const second=await imageFixture(other);const basic=second.wb.getWorksheet('基础信息');basic.eachRow(row=>{if(['商品货号','商品业务标识'].includes(row.getCell(1).value))row.getCell(2).value='KNIT-ONLY';if(row.getCell(1).value==='完整类目路径')row.getCell(2).value=KNIT_CATEGORY;});await second.wb.xlsx.writeFile(second.file);
  basic.addRow(['材质成分','涤纶100%']);await second.wb.xlsx.writeFile(second.file);
  const r=await scanProducts(f.root);assert.equal(r.errors.length,0);assert.equal(r.products.length,2);for(const p of r.products){assert.equal(p.ok,true,JSON.stringify(p.errors));assert.equal(p.config.product.mainImages.length,10);assert.equal(p.config.product.imageOrder.implicit,true);}
});
