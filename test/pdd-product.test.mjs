import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { png } from "./pdd-fixtures.mjs";
import { prepareProduct, scanProducts, validateConfig, SUPPORTED_CATEGORY } from "../engine/pdd/product.mjs";
import {mediaPlan} from '../engine/pdd/media.mjs';
import {assertFrozenFiles} from '../engine/pdd/frozen-input.mjs';

async function fixture(t, parent) {
  const dir = parent || await fs.mkdtemp(path.join(os.tmpdir(), "wq-pdd-"));
  if (!parent) t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "商品信息"), { recursive: true });
  const wb = new ExcelJS.Workbook();
  const fields = {
    "适用平台": "拼多多", "商品业务标识": "SYNTHETIC-PDD", "商品标题": "合成测试商品",
    "商品货号": "TEST", "完整类目路径": SUPPORTED_CATEGORY, "平台尺码表": "停用",
    "详情尺码图": "保留", "最终操作": "保存草稿", "资料已核对": "是",
    "商品参考价（元）": 50, "满件折扣": "停用", "材质":"涤纶（聚酯纤维）", "成分含量":"100%",
  };
  const basic = wb.addWorksheet("基础信息");
  basic.addRow(["字段", "值"]);
  for (const pair of Object.entries(fields)) basic.addRow(pair);
  const services = wb.addWorksheet("服务与承诺");
  services.addRow(["字段", "值"]);
  for (const pair of Object.entries({ "商品类型":"普通商品", "是否二手":"非二手", "是否定制":"非定制", "发货模式": "普通发货", "预售起止日期/时段": "不适用",
    "承诺发货时间/时效": "48小时", "运费模板": "合成测试模板", "运费范围及收费规则": "合成测试规则",
    "其他服务设置": "无" })) services.addRow(pair);
  const specs = wb.addWorksheet("款式与尺码");
  specs.getRow(1).values = ["款式名称", "备注", "拼单价", "单买价", "库存", "主图编号", "编码前缀", "状态"];
  specs.getRow(2).values = ["测试款", "款式备注", 19.9, 29.9, 10, "01", "TEST", "启用"];
  specs.getRow(14).values = ["尺码", "备注"];
  specs.getRow(15).values = ["S", "尺码备注"];
  specs.getRow(16).values = ["M", "尺码备注2"];
  const adjustments = wb.addWorksheet("个别尺码调整（选填）");
  adjustments.getRow(1).values = ["款式", "尺码", "拼单价", "单买价", "库存", "编码", "图片", "状态"];
  adjustments.getRow(2).values = ["测试款", "M", 21.9, null, 0, "CUSTOM-M", null, "停用"];
  const file = path.join(dir, "商品信息", "TESTpdd商品信息表.xlsx");
  await wb.xlsx.writeFile(file);
  for (const folder of ["主图", "尺码图", "详情图"]) {
    await fs.mkdir(path.join(dir, folder), { recursive: true });
    await fs.writeFile(path.join(dir, folder, "01.png"), png());
  }
  return { dir, wb, file };
}

test("v0.1.2数据接入保留双价格、零库存、完整编码、备注和启停", async t => {
  const { dir } = await fixture(t);
  const p = await prepareProduct(dir);
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.equal(p.platform, "pdd");
  assert.equal(p.config.pdd.sourceVersion, "0.1.2");
  const [s, m] = p.config.skuMatrix;
  assert.deepEqual([s.groupPriceCents, s.singlePriceCents, s.stock, s.code], [1990, 2990, 10, "TEST S"]);
  assert.deepEqual([m.groupPriceCents, m.singlePriceCents, m.stock, m.code, m.state], [2190, 2990, 0, "CUSTOM-M", "停用"]);
  assert.equal(m.styleNote, "款式备注");
  assert.equal(m.sizeNote, "尺码备注2");
  assert.equal((await validateConfig(p.config)).inputHash, p.inputHash);
});

test("改价或变更素材后，冻结配置不能继续执行", async t => {
  const { dir, wb, file } = await fixture(t);
  const p = await prepareProduct(dir);
  wb.getWorksheet("款式与尺码").getCell("C2").value = 15.5;
  await wb.xlsx.writeFile(file);
  await assert.rejects(validateConfig(p.config), /已变化/);
  const q = await prepareProduct(dir);
  await fs.appendFile(path.join(dir, "主图", "01.png"), "changed");
  await assert.rejects(validateConfig(q.config), /已变化/);
});

test('参考价按商品表当前值读取，删除或留空时提示真实缺失，不推算或固定测试价',async t=>{
  const {dir,wb,file}=await fixture(t);const basic=wb.getWorksheet('基础信息');let cell;
  basic.eachRow(row=>{if(row.getCell(1).value==='商品参考价（元）')cell=row.getCell(2);});
  cell.value=87.6;await wb.xlsx.writeFile(file);const current=await prepareProduct(dir);
  assert.equal(current.ok,true,JSON.stringify(current.errors));assert.equal(current.config.pdd.basic['商品参考价（元）'],87.6);
  cell.value=null;await wb.xlsx.writeFile(file);const empty=await prepareProduct(dir);
  assert.equal(empty.ok,false);assert(empty.errors.some(e=>/参考价/.test(e.message)));
  basic.spliceRows(cell.row,1);await wb.xlsx.writeFile(file);const removed=await prepareProduct(dir);
  assert.equal(removed.ok,false);assert(removed.errors.some(e=>/参考价/.test(e.message)));
});

test("执行配置被修改不能绕开资料核对", async t => {
  const { dir } = await fixture(t);
  const p = await prepareProduct(dir);
  p.config.skuMatrix[0].stock = 9999;
  await assert.rejects(validateConfig(p.config), /已变化/);
  await assert.rejects(validateConfig({ ...p.config, platform: "dou" }), /仅允许保存草稿/);
  await assert.rejects(validateConfig({ ...p.config, draftOnly: false }), /仅允许保存草稿/);
});

test("冻结文件清单不能被修改后沿用原预检", async t => {
  const { dir } = await fixture(t);
  const p = await prepareProduct(dir);
  const checked = await validateConfig(p.config);
  assert.match(checked.executionHash, /^[a-f0-9]{64}$/);
  p.config.input.files = [];
  await assert.rejects(validateConfig(p.config), /已变化/);
});

test("成分依据中的单一百分比与填写区间冲突时阻断，不改原表", async t => {
  const { dir, wb, file } = await fixture(t);
  const sheet = wb.getWorksheet("基础信息");
  let range; sheet.eachRow(row=>{if(row.getCell(1).value==="成分含量")range=row;}); range.getCell(2).value="30%（含）-50%（不含）";
  sheet.addRow(["实际成分依据", "商品吊牌：聚酯纤维100%"]);
  await wb.xlsx.writeFile(file);
  const p = await prepareProduct(dir);
  assert(p.errors.some(e => e.field === "基础信息 / 成分含量" && /冲突/.test(e.message)));
  range.getCell(2).value = "100%";
  await wb.xlsx.writeFile(file);
  const q = await prepareProduct(dir);
  assert.equal(q.ok, true, JSON.stringify(q.errors));
  const untouched = new ExcelJS.Workbook(); await untouched.xlsx.readFile(file);
  assert.equal(untouched.getWorksheet("基础信息").getCell(range.number, 2).value, "100%");
});

test("包装标签图按实际页面要求检查比例，不能将不合格图片直接上传", async t => {
  const { dir } = await fixture(t);
  await fs.mkdir(path.join(dir, "商品标签"));
  await fs.writeFile(path.join(dir, "商品标签", "吊牌.png"), png(512, 900));
  const p = await prepareProduct(dir);
  assert.equal(p.ok,true);
  assert(p.warnings.some(e => /吊牌\.png/.test(e.field) && /包装标签图.*比例/.test(e.message)));
  assert.deepEqual(p.config.product.materialTagImages,[]);
});

test("时段预售使用明确天数，无需虚构起止日期；其他输入错误仍阻断", async t => {
  const { dir, wb, file } = await fixture(t);
  const service = wb.getWorksheet("服务与承诺");
  const rows = new Map(); service.eachRow(row => rows.set(row.getCell(1).value, row));
  rows.get("发货模式").getCell(2).value = "时段预售";
  rows.get("预售起止日期/时段").getCell(2).value = "【待补充】";
  rows.get("承诺发货时间/时效").getCell(2).value = "10天内发货";
  await wb.xlsx.writeFile(file);
  assert.equal((await prepareProduct(dir)).ok, true);
  rows.get("承诺发货时间/时效").getCell(2).value = "31天内发货";
  await wb.xlsx.writeFile(file);
  assert((await prepareProduct(dir)).errors.some(e => /3～30天/.test(e.message)));
  rows.get("承诺发货时间/时效").getCell(2).value = "10天内发货";
  rows.get("预售起止日期/时段").getCell(2).value = { formula: '"test"', result: "test" };
  await wb.xlsx.writeFile(file);
  assert((await prepareProduct(dir)).errors.some(e => /不接受公式/.test(e.message)));
});

test("移动到另一台电脑的相同文件不生成新商品版本", async t => {
  const { dir } = await fixture(t);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "wq-pdd-copy-"));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  await fs.cp(dir, target, { recursive: true });
  const a = await prepareProduct(dir), b = await prepareProduct(target);
  assert.equal(a.id, b.id);
  assert.equal(a.inputHash, b.inputHash);
});

test("多份选填素材提示跳过；多份商品表仍阻断以免读错商品", async t => {
  const { dir, file } = await fixture(t);
  await fs.mkdir(path.join(dir, "白底图"));
  await fs.writeFile(path.join(dir, "白底图", "1.png"), png());
  await fs.writeFile(path.join(dir, "白底图", "2.png"), png());
  const p = await prepareProduct(dir);
  assert.equal(p.ok, true);
  assert(p.warnings.some(e => e.field === "白底图"));
  await fs.copyFile(file, path.join(dir, "商品信息", "商品信息.xlsx"));
  await assert.rejects(prepareProduct(dir), /唯一一份/);
});

test("单品和总素材库都可扫描，重复标识阻断所有关联目录", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wq-pdd-catalog-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const first = await fixture(t, path.join(parent, "商品一"));
  assert.equal((await scanProducts(first.dir)).products.length, 1);
  await fs.cp(first.dir, path.join(parent, "商品二"), { recursive: true });
  const r = await scanProducts(parent);
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].ok, false);
  assert(r.errors.some(e => /业务标识重复/.test(e.error)));
});

test("符号链接不能越过素材目录读取文件", async t => {
  const { dir } = await fixture(t);
  const secret = await fs.mkdtemp(path.join(os.tmpdir(), "wq-pdd-outside-"));
  t.after(() => fs.rm(secret, { recursive: true, force: true }));
  await fs.writeFile(path.join(secret, "secret.png"), "not-material");
  await fs.symlink(path.join(secret, "secret.png"), path.join(dir, "主图", "02.png"));
  await assert.rejects(prepareProduct(dir), /不接受符号链接/);
});

test("真实格式、像素、比例和页面允许的格式均在上传前检查", async t => {
  const { dir } = await fixture(t);
  const file = path.join(dir, "主图", "01.png");
  await fs.writeFile(file, png(480, 480));
  assert((await prepareProduct(dir)).errors.some(e => /大于480/.test(e.message)));
  await fs.writeFile(file, png(600, 500));
  assert((await prepareProduct(dir)).errors.some(e => /比例/.test(e.message)));
  await fs.writeFile(file, "corrupt");
  assert((await prepareProduct(dir)).errors.some(e => /损坏/.test(e.message)));
  await fs.writeFile(file, png());
  await fs.rename(file, path.join(dir, "主图", "01.jpg"));
  assert((await prepareProduct(dir)).errors.some(e => /真实格式/.test(e.message)));
});

test("可选详情文字进入冻结输入，变更后不能沿用旧任务", async t => {
  const { dir } = await fixture(t);
  await fs.mkdir(path.join(dir, "详情文字（选填）"));
  const text = path.join(dir, "详情文字（选填）", "详情文字.txt");
  await fs.writeFile(text, "合成测试详情");
  const r = await prepareProduct(dir);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.config.product.detailText,null);
  assert(r.warnings.some(w=>/文字未上传/.test(w.message)));
  await fs.writeFile(text, "更新后的合成测试详情");
  await assert.rejects(validateConfig(r.config), /已变化/);
});

test('只有商品表和主图也能运行：全部选填目录、选填工作表、SKU编码及预览图均可缺少',async t=>{
  const {dir,wb,file}=await fixture(t);
  for(const folder of ['尺码图','详情图'])await fs.rm(path.join(dir,folder),{recursive:true});
  wb.removeWorksheet('个别尺码调整（选填）');
  wb.getWorksheet('款式与尺码').getCell('F2').value=null;
  wb.getWorksheet('款式与尺码').getCell('G2').value=null;
  wb.getWorksheet('款式与尺码').getCell('H2').value=null;
  for(const [key,value] of [['品牌',''],['风格','【待确认】'],['服装版型',null],['商品编码','不填写']])wb.getWorksheet('基础信息').addRow([key,value]);
  for(const key of ['假一赔十','拼单人数','运费范围及收费规则','其他服务设置'])wb.getWorksheet('服务与承诺').eachRow(row=>{if(row.getCell(1).value===key)row.getCell(2).value=null;});
  await wb.xlsx.writeFile(file);
  const p=await prepareProduct(dir);assert.equal(p.ok,true,JSON.stringify(p.errors));
  assert.equal(p.config.product.sizeImage,null);assert.equal(p.config.product.whiteBackgroundImage,null);assert.deepEqual(p.config.product.materialTagImages,[]);
  assert(p.config.skuMatrix.every(s=>s.code===''&&s.image===null&&s.state===null));
  const plans=mediaPlan(p.config);assert.deepEqual(plans.map(p=>p.key),['details']);assert.equal(plans[0].files.length,17);
  await assertFrozenFiles(p.config);assert.equal((await validateConfig(p.config)).ok,true);
});

test('根目录Excel、常见目录别名和非编号主图可以自动识别，SKU编号按顺序对应',async t=>{
  const {dir,file}=await fixture(t);
  const rootBook=path.join(dir,'商品信息.xlsx');await fs.rename(file,rootBook);await fs.rmdir(path.join(dir,'商品信息'));
  await fs.rename(path.join(dir,'主图'),path.join(dir,'轮播图'));
  await fs.rename(path.join(dir,'轮播图','01.png'),path.join(dir,'轮播图','女装正面.png'));
  await fs.rename(path.join(dir,'尺码图'),path.join(dir,'尺码表'));
  const p=await prepareProduct(dir);assert.equal(p.ok,true,JSON.stringify(p.errors));
  assert.equal(p.config.input.infoPath,'商品信息.xlsx');
  assert.equal(p.config.product.mainImageMap['01'],await fs.realpath(path.join(dir,'轮播图','女装正面.png')));
  assert.equal(mediaPlan(p.config).find(p=>p.kind==='style').files[0],p.config.product.mainImages[0]);
  assert.equal((await scanProducts(dir)).products.length,1);await assertFrozenFiles(p.config);
  await fs.appendFile(rootBook,'changed');await assert.rejects(assertFrozenFiles(p.config),/已改变/);
});

test('不合格选填图只警告跳过，主图不合格及真实必填缺失仍阻断',async t=>{
  const {dir,wb,file}=await fixture(t);
  for(const folder of ['白底图','包装标签图']){await fs.mkdir(path.join(dir,folder));await fs.writeFile(path.join(dir,folder,'bad.png'),'broken');}
  const p=await prepareProduct(dir);assert.equal(p.ok,true);assert.equal(p.warnings.length,2);
  assert(!mediaPlan(p.config).some(p=>['white','tags'].includes(p.kind)));
  wb.getWorksheet('基础信息').eachRow(row=>{if(row.getCell(1).value==='成分含量')row.getCell(2).value=null;});await wb.xlsx.writeFile(file);
  const q=await prepareProduct(dir);assert.equal(q.ok,false);assert(q.errors.some(e=>/成分含量/.test(e.message)));
  await fs.writeFile(path.join(dir,'主图','01.png'),'broken');assert((await prepareProduct(dir)).errors.some(e=>e.field.includes('主图/01')));
});

test('空选填目录不影响扫描，补充选填素材后旧预检必须失效',async t=>{
  const {dir}=await fixture(t);
  for(const folder of ['白底图','商品标签','视频','讲解视频','商详视频','长图'])await fs.mkdir(path.join(dir,folder));
  const p=await prepareProduct(dir);assert.equal(p.ok,true);
  await fs.writeFile(path.join(dir,'白底图','white.png'),png());
  await assert.rejects(validateConfig(p.config),/已变化/);
  const q=await prepareProduct(dir);assert(q.ok);assert(mediaPlan(q.config).some(p=>p.key==='white'));
});

test('没有详情目录和尺码图时，三张不同名称主图按自然顺序补齐17张',async t=>{
  const {dir}=await fixture(t);
  await fs.rm(path.join(dir,'尺码图'),{recursive:true});await fs.rm(path.join(dir,'详情图'),{recursive:true});
  await fs.rename(path.join(dir,'主图','01.png'),path.join(dir,'主图','主图2.png'));
  for(const name of ['主图10.png','主图1.png'])await fs.writeFile(path.join(dir,'主图',name),png());
  const p=await prepareProduct(dir);assert(p.ok,JSON.stringify(p.errors));
  assert.deepEqual(p.config.product.sourceMainImages.map(f=>path.basename(f)),['主图1.png','主图2.png','主图10.png']);
  assert.equal(p.config.product.mainImages.length,10);
  assert.equal(mediaPlan(p.config)[0].files.length,17);
  assert.deepEqual(mediaPlan(p.config)[0].files.slice(0,4).map(f=>path.basename(f)),['主图1.png','主图2.png','主图10.png','主图1.png']);
});
