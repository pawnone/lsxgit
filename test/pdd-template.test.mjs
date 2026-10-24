import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {imageFixture} from './pdd-fixtures.mjs';
import {prepareProduct,KNIT_CATEGORY,SUPPORTED_CATEGORY} from '../engine/pdd/product.mjs';
import {assertFrozenFiles} from '../engine/pdd/frozen-input.mjs';

async function fixture(t,type='时尚套装'){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wq-template-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const f=await imageFixture(dir),s=f.wb.getWorksheet('基础信息');
  const values=s.getSheetValues().slice(2).filter(Boolean).map(r=>r.slice(1));
  s.eachRow(r=>{r.values=[];});s.getCell('A4').value='商品类型';s.getCell('B4').value=type;
  s.getCell('A5').value='完整类目路径';s.mergeCells('B5:D5');s.getCell('B5').value={formula:'IF(B4="时尚套装","old set","old knit")',result:type==='针织衫'?SUPPORTED_CATEGORY:KNIT_CATEGORY};
  s.mergeCells('A6:D6');s.getCell('A6').value={formula:'"提示文字，不是商品数据"',result:'基础信息待填'};
  s.getRow(9).values=['字段','填写值','填写要求','说明 / 填写示例'];s.mergeCells('A10:D10');s.getCell('A10').value='01 商品与价格';
  for(const [key,value]of values.filter(r=>!['完整类目路径','满件折扣'].includes(r[0])))s.addRow([key,value,{formula:'"必填"',result:'必填'},'旧说明参考价299.9、折扣9.5，不作为数据']);
  s.addRow(['折扣（几折）',9.9]);
  if(type==='针织衫')s.addRow(['材质成分',{richText:[{font:{bold:true},text:'涤纶'},{font:{italic:true},text:'100%'}]}]);
  await f.wb.xlsx.writeFile(f.file);return{...f,basic:s};
}
const field=(s,key)=>{let found;s.eachRow(r=>{if(r.getCell(1).value===key)found=r.getCell(2);});return found;};
test('新模板按商品类型派生类目，不使用历史公式缓存或提示；富文本读取真实文字',async t=>{
  for(const type of ['时尚套装','针织衫']){
    const f=await fixture(t,type),p=await prepareProduct(f.dir);assert.equal(p.ok,true,JSON.stringify(p.errors));
    assert.equal(p.config.product.categoryPath,type==='针织衫'?KNIT_CATEGORY:SUPPORTED_CATEGORY);
    assert.equal(p.config.pdd.basic['折扣（几折）'],9.9);assert.equal(p.config.pdd.basic['商品参考价（元）'],50);
    assert.equal(p.config.skuMatrix[0].styleNote,'原备注');assert(!Object.keys(p.config.pdd.basic).some(k=>/待填|商品与价格/.test(k)));
    if(type==='针织衫')assert.equal(p.config.pdd.basic['材质成分'],'涤纶100%');
  }
});
test('样式、说明及行顺序变化不改变商品指纹，但冻结后改文件仍阻断',async t=>{
  const f=await fixture(t),before=await prepareProduct(f.dir);const s=f.basic;
  s.getColumn(2).font={name:'Arial',size:20};s.getCell('D11').value='新说明：不能覆盖实际值';
  const row=s.getRow(11).values;s.spliceRows(11,1);s.addRow(row);
  await f.wb.xlsx.writeFile(f.file);const after=await prepareProduct(f.dir);
  assert.equal(after.ok,true,JSON.stringify(after.errors));assert.equal(after.inputHash,before.inputHash);assert.notEqual(after.config.input.workbookSha256,before.config.input.workbookSha256);
  await assert.rejects(assertFrozenFiles(before.config),/已改变/);await assertFrozenFiles(after.config);
});
test('价格公式缓存不作为实际值，缺货号与折扣集中列出',async t=>{
  const f=await fixture(t);field(f.basic,'商品参考价（元）').value={formula:'1+49',result:50};field(f.basic,'商品货号').value=null;field(f.basic,'折扣（几折）').value=null;
  await f.wb.xlsx.writeFile(f.file);const p=await prepareProduct(f.dir);assert.equal(p.ok,false);
  assert(p.errors.some(e=>e.message.includes('不接受公式')));assert(p.errors.some(e=>e.message.includes('商品货号')));assert(p.errors.some(e=>e.message.includes('折扣（几折）')));
});
test('未知类型、显式类目冲突与超范围折扣均阻断；不猜测类别',async t=>{
  const f=await fixture(t);f.basic.getCell('B4').value='衬衫';await f.wb.xlsx.writeFile(f.file);assert((await prepareProduct(f.dir)).errors.some(e=>e.message.includes('商品类型请选择')));
  f.basic.getCell('B4').value='时尚套装';f.basic.getCell('B5').value=KNIT_CATEGORY;field(f.basic,'折扣（几折）').value=10;await f.wb.xlsx.writeFile(f.file);const p=await prepareProduct(f.dir);assert(p.errors.some(e=>e.message.includes('冲突')));assert(p.errors.some(e=>e.message.includes('5.0～9.9')));
});
test('非当前类目字段有旧值甚至公式时忽略，切换后缺少新必填则阻断；颜色不参与判断',async t=>{
  const f=await fixture(t,'针织衫');field(f.basic,'成分含量').value={formula:'1/0',result:{error:'#DIV/0!'}};field(f.basic,'材质').value='旧类目字段';
  f.basic.getColumn(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF000000'}};await f.wb.xlsx.writeFile(f.file);
  const knit=await prepareProduct(f.dir);assert.equal(knit.ok,true,JSON.stringify(knit.errors));assert.equal(knit.config.pdd.basic['成分含量'],undefined);assert.equal(knit.config.pdd.basic['材质'],undefined);
  field(f.basic,'材质成分').value=null;await f.wb.xlsx.writeFile(f.file);const missing=await prepareProduct(f.dir);assert.equal(missing.ok,false);assert(missing.errors.some(e=>e.message.includes('材质成分')));
  field(f.basic,'成分含量').value='30%（含）-50%（不含）';field(f.basic,'材质成分').value='不会从此字段推断套装含量';f.basic.getCell('B4').value='时尚套装';await f.wb.xlsx.writeFile(f.file);
  const set=await prepareProduct(f.dir);assert.equal(set.ok,true,JSON.stringify(set.errors));assert.equal(set.config.pdd.basic['材质成分'],undefined);assert.equal(set.config.pdd.basic['成分含量'],'30%（含）-50%（不含）');
});
test('内置模板的类目、必填提示和非适用输入校验一致，导出不含商品数据',async()=>{
  const {default:ExcelJS}=await import('exceljs');
  for(const type of ['时尚套装','针织衫']){
    const w=new ExcelJS.Workbook();await w.xlsx.readFile(new URL('../desktop/assets/pdd-templates/拼多多商品信息模板_'+type+'.xlsx',import.meta.url));const s=w.getWorksheet('基础信息');
    assert.equal(w.worksheets.length,3);assert.equal(s.getCell('B4').value,type);assert.equal(s.getCell('C20').result,type==='时尚套装'?'必填':'不适用');assert.equal(s.getCell('C21').result,type==='针织衫'?'必填':'不适用');
    for(const address of ['B11','B12','B13','B14','B15','B19','B20','B21'])assert.equal(s.getCell(address).value,null);
    assert.equal(s.getCell('B20').dataValidation.formulae[0],'$B$4="时尚套装"');assert.equal(s.getCell('B21').dataValidation.formulae[0],'$B$4="针织衫"');assert.equal(s.getCell('B21').dataValidation.errorStyle,'stop');
    assert(s.conditionalFormattings.some(c=>c.rules.some(r=>r.formulae.includes('$C21="不适用"'))));
    for(const sheet of w.worksheets)sheet.eachRow(row=>row.eachCell(cell=>assert(!cell.value?.error&&!cell.value?.result?.error)));
  }
});
