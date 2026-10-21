import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {baseFields,readExcelProduct} from '../engine/doudian/excel-product.mjs';
import {SUIT_CATEGORY,KNIT_CATEGORY,KNIT_ATTRIBUTES,normalizeCategoryAttributes} from '../engine/doudian/category-rules.mjs';
import {desiredAttributes} from '../engine/doudian/product-attributes.mjs';
import {addKnitAttributes,blankTemplateFrom,mergeKnitIntoBase} from '../scripts/knit-template.mjs';
import {prepareProduct} from '../engine/doudian/prepare-product.mjs';
import {validateConfig} from '../engine/doudian/run-draft.mjs';
async function fixture(t,category=SUIT_CATEGORY){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wq-category-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const book=new ExcelJS.Workbook(),b=book.addWorksheet('基础信息');b.getCell('A2').value='适用平台';b.getCell('B2').value='抖店';
 const values={title:'脚本回归测试商品名称十五个字符',itemCode:'TEST-EXCEL',brand:'无品牌',categoryPath:category,material:'聚酯纤维',materialPercent:100,inStock:0,preSale:10,shippingMode:'现货预售混合',inStockDelivery:'48小时',preSaleDelivery:'10天',stockCountMode:'下单减库存',freightTemplate:'测试运费',returnPolicy:'7天无理由退货',operation:'保存草稿',pieceCount:'单件',applicableAge:category===KNIT_CATEGORY?'24-40周岁':'29周岁（含）-39周岁（不含）',style:'休闲风'};
 baseFields.forEach(([label,key],i)=>{b.getCell(i+4,1).value=label;b.getCell(i+4,2).value=values[key]});
 const s=book.addWorksheet('款式与尺码');s.getCell('A4').value='款式名称';s.getCell('C4').value='统一售价（元）';s.getCell('D4').value='对应主图编号';s.getRow(5).values=['测试款','单件',69.9,'01'];s.getCell('A18').value='尺码';s.getRow(19).values=['M',150,175,80,100];
 book.addWorksheet('个别尺码调整（选填）');book.addWorksheet('素材说明').getCell('A1').value='素材自动识别';
 const codes=book.addWorksheet('商家编码');codes.getRow(1).values=['款式名称','尺码','商家编码'];codes.getRow(2).values=['测试款','M','0001-M'];
 const file=path.join(dir,'商品信息.xlsx');return {book,file,dir,save:()=>book.xlsx.writeFile(file)};
}
test('legacy suit Excel stays compatible without category sheet or extra config properties',async t=>{
 const f=await fixture(t);await f.save();const p=await readExcelProduct(f.file);
 assert.equal(p.categoryPath,SUIT_CATEGORY);assert.equal(Object.hasOwn(p,'categoryAttributes'),false);assert.equal(p.skuMatrix[0].merchantCode,'0001-M');assert.equal(p.inventory.inStock,0);assert.equal(desiredAttributes({product:p}).length,3);
});
test('knit Excel reads by exact category with typed attributes, common fields and SKU values preserved',async t=>{
 const f=await fixture(t,KNIT_CATEGORY);addKnitAttributes(f.book,{'领型':'翻领','适用季节':'秋季、冬季','克重':350,'上市时间':'2026年秋季'});await f.save();
 const p=await readExcelProduct(f.file);assert.deepEqual(p.categoryAttributes,{'领型':'翻领','适用季节':['秋季','冬季'],'上市时间':'2026年秋季','克重':350});assert.equal(p.skuMatrix[0].merchantCode,'0001-M');
 assert.equal(desiredAttributes({product:p}).length,7);
});
test('knit requires matching sheet and rejects conflicting category, duplicate or missing field rows',async t=>{
 const f=await fixture(t,KNIT_CATEGORY);await f.save();await assert.rejects(readExcelProduct(f.file),/缺少属性字段/);
 const a=addKnitAttributes(f.book);a.getCell('B2').value=SUIT_CATEGORY;await f.save();await assert.rejects(readExcelProduct(f.file),/不一致/);
 a.getCell('B2').value=KNIT_CATEGORY;a.getCell('A6').value=a.getCell('A5').value;await f.save();await assert.rejects(readExcelProduct(f.file),/重复/);
 a.getCell('A6').value=KNIT_ATTRIBUTES[1].label;a.getCell('A5').value=null;await f.save();await assert.rejects(readExcelProduct(f.file),/缺少属性字段行/);
});
test('category normalization rejects unknown attributes, bad multi values, grams units and unsupported categories',()=>{
 for(const v of [{'拼写错误':'常规'},{'克重':'350g'},{'适用季节':'秋季、秋季'},{'适用季节':'一、二、三、四、五、六'},{'领型':'翻领、圆领'}])assert.throws(()=>normalizeCategoryAttributes(KNIT_CATEGORY,v));
 assert.throws(()=>normalizeCategoryAttributes('服装 > 女装 > 未适配',{}));assert.throws(()=>normalizeCategoryAttributes(SUIT_CATEGORY,{'领型':'翻领'}));
 assert.deepEqual(normalizeCategoryAttributes(KNIT_CATEGORY,{}),{});
});
test('formulas and invalid category sheets cannot bypass validation',async t=>{
 const f=await fixture(t,KNIT_CATEGORY),a=addKnitAttributes(f.book);a.getCell('B5').value={formula:'1+1',result:2};await f.save();await assert.rejects(readExcelProduct(f.file),/公式/);
});
test('prepared config preserves knit attributes in frozen hash and rejects missing category attributes',async t=>{
 const f=await fixture(t,KNIT_CATEGORY);addKnitAttributes(f.book,{'领型':'翻领'});await f.save();
 await fs.mkdir(path.join(f.dir,'主图'));await fs.mkdir(path.join(f.dir,'商品标签'));
 const image=await fs.readFile(new URL('../desktop/assets/tray.png',import.meta.url));
 for(let i=1;i<=5;i++)await fs.writeFile(path.join(f.dir,'主图',String(i).padStart(2,'0')+'.png'),image);
 await fs.writeFile(path.join(f.dir,'商品标签','tag.png'),image);
 const p=await prepareProduct({input:f.dir,output:path.join(f.dir,'resolved.json'),cdpUrl:'http://127.0.0.1:1'});assert.equal(p.ok,true,JSON.stringify(p.errors));
 const v=await validateConfig(p.config);assert.equal(v.ok,true,JSON.stringify(v.errors));assert.equal(p.config.product.categoryAttributes['领型'],'翻领');
 const other=structuredClone(p.config);other.product.categoryAttributes['领型']='圆领';assert.notEqual((await validateConfig(other)).inputHash,v.inputHash);
 delete other.product.categoryAttributes;assert.equal((await validateConfig(other)).ok,false);
});
test('blank templates remove source product identifiers while retaining workbook structure',async t=>{
 const f=await fixture(t);await f.save();
 for(const category of [SUIT_CATEGORY,KNIT_CATEGORY]){
  const out=path.join(f.dir,category===SUIT_CATEGORY?'suit-template.xlsx':'knit-template.xlsx');await blankTemplateFrom(f.file,category,out);
  const b=new ExcelJS.Workbook();await b.xlsx.readFile(out);assert.equal(b.getWorksheet('基础信息').getCell('B5').value,null);assert.equal(b.getWorksheet('基础信息').getCell('B7').value,category);
  assert.equal(!!b.getWorksheet('类目属性'),false);if(category===KNIT_CATEGORY)assert.equal(b.getWorksheet('基础信息').getCell('A22').value,KNIT_ATTRIBUTES[0].label);assert.equal(JSON.stringify(b.model).includes('0001-M'),false);
 }
});

test('merged base sheet preserves semantic product data, removes legacy sheet and marks required/optional rows',async t=>{
 const f=await fixture(t,KNIT_CATEGORY);addKnitAttributes(f.book,{'领型':'翻领','适用季节':'秋季、冬季','克重':350});await f.save();
 const before=await readExcelProduct(f.file);mergeKnitIntoBase(f.book);await f.save();
 assert.equal(f.book.getWorksheet('类目属性'),undefined);assert.deepEqual(await readExcelProduct(f.file),before);
 const b=f.book.getWorksheet('基础信息');assert.equal(b.getCell('C3').value,'填写要求');assert.equal(b.getCell('C4').value,'必填');assert.equal(b.getCell('C22').value,'选填');assert.equal(b.rowCount,49);
 mergeKnitIntoBase(f.book);await f.save();assert.deepEqual(await readExcelProduct(f.file),before);
});
test('merged reader rejects duplicates across sheets and repeated optional labels',async t=>{
 const f=await fixture(t,KNIT_CATEGORY);mergeKnitIntoBase(f.book);addKnitAttributes(f.book);await f.save();await assert.rejects(readExcelProduct(f.file),/同时存在/);
 f.book.removeWorksheet(f.book.getWorksheet('类目属性').id);f.book.getWorksheet('基础信息').getCell('A23').value=KNIT_ATTRIBUTES[0].label;await f.save();await assert.rejects(readExcelProduct(f.file),/重复/);
});
test('requirement display cannot bypass required checks; empty optional values remain allowed',async t=>{
 const f=await fixture(t,KNIT_CATEGORY);mergeKnitIntoBase(f.book);await f.save();assert.deepEqual((await readExcelProduct(f.file)).categoryAttributes,{});
 const b=f.book.getWorksheet('基础信息');b.getCell('C4').value='选填';b.getCell('B4').value=null;await f.save();await assert.rejects(readExcelProduct(f.file),/商品名称/);
});
