// Exercise the installed worker with a disposable copy of the real workbook
// and three main images only. No real material or merchant page is changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ProcessRunner} from '../desktop/process-runner.mjs';
const installed=process.env.WQ_TEST_APP,source=process.env.WQ_TEST_PDD_PRODUCT;
if(!installed||!source)throw Error('请指定WQ_TEST_APP和WQ_TEST_PDD_PRODUCT');
const bundle=path.resolve(installed,'../../Resources/app');
const {prepareProduct}=await import(pathToFileURL(path.join(bundle,'engine/pdd/product.mjs')));
const {mediaPlan}=await import(pathToFileURL(path.join(bundle,'engine/pdd/media.mjs')));
const {assertFrozenFiles}=await import(pathToFileURL(path.join(bundle,'engine/pdd/frozen-input.mjs')));
const original=await prepareProduct(source);
assert(original.ok,JSON.stringify(original.errors));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wenqing-pdd-minimal-'));
const names=[];
const check=(name,test)=>{assert(test,name);names.push(name);};
const sha=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
try{
  const productRoot=path.join(temp,'最简商品');await fs.mkdir(path.join(productRoot,'轮播图'),{recursive:true});
  const originalExcel=path.join(source,original.config.input.infoPath),before=await sha(originalExcel);
  await fs.copyFile(originalExcel,path.join(productRoot,'商品信息.xlsx'));
  for(const file of original.config.product.mainImages.slice(0,3))await fs.copyFile(file,path.join(productRoot,'轮播图',path.basename(file)));
  const runner=new ProcessRunner({execPath:installed,electron:true,worker:path.join(bundle,'desktop/worker.mjs')});
  const scan=await runner.call('scan',{platform:'pdd',root:temp,workDir:path.join(temp,'unused')},{timeout:30000});
  check('安装版识别根目录Excel与轮播图目录，不要求完整目录树',scan.products.length===1&&scan.errors.length===0);
  const p=scan.products[0],c=p.config;
  check('最简商品通过预检，保留真实12个SKU及双价格',p.ok&&p.errors.length===0&&c.skuMatrix.length===12&&JSON.stringify(c.skuMatrix)===JSON.stringify(original.config.skuMatrix));
  check('白底图、包装图、视频、尺码图和详情目录全部缺少仍可运行',!c.product.whiteBackgroundImage&&!c.product.video&&!c.product.sizeImage&&c.product.materialTagImages.length===0&&c.product.detailImages.length===0);
  const validation=await runner.call('validate',{config:c},{timeout:30000});
  check('安装版独立worker复核输入通过',validation.ok&&validation.errors.length===0&&validation.inputHash===p.inputHash);
  const plans=mediaPlan(c),details=plans.find(p=>p.key==='details');
  check('没有尺码图时由三张主图按顺序轮询补齐17张详情',details.files.length===17&&details.files.every((file,i)=>file===c.product.mainImages[i%3]));
  check('上传计划未要求不存在的选填素材',plans.every(p=>p.kind==='details'||p.kind==='style'));
  await assertFrozenFiles(c);check('根目录Excel和主图的冻结来源复核通过',true);
  check('扫描不创建空素材目录，也未改动原商品表',JSON.stringify((await fs.readdir(productRoot)).sort())===JSON.stringify(['商品信息.xlsx','轮播图'].sort())&&await sha(originalExcel)===before);
  console.log(JSON.stringify({version:JSON.parse(await fs.readFile(path.join(bundle,'package.json'),'utf8')).version,checks:names.length,names,merchantMutation:false,originalMaterialMutation:false}));
}finally{await fs.rm(temp,{recursive:true,force:true});}
