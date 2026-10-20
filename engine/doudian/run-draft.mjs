#!/usr/bin/env node
import {reconcileSpecs,verifySpecs} from './spec-reconcile.mjs';
import {assertBlankProductEntry} from './workspace.mjs';
import {resolveEntry} from './entry-state.mjs';
import {uploadMaterialEntry,waitMaterialEntryReady} from './material-entry.mjs';
import {installSafetyGuard,assertSafetyClear} from './safety-guard.mjs';
import {bindSpecImages,specImageBindings} from './spec-images.mjs';
import {fillProductAttributes} from './product-attributes.mjs';
import { assertPageShop } from './shop-guard.mjs';
import { uploadWhiteImage } from './platforms/doudian.mjs';
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

import { fillSizeChart, fillSkuPrices, verifySkuTable, fillMaterial } from "./listing-fields.mjs";

import { verifyBeforeSave, saveDraft } from "./save-draft.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, "output", "resolved-product-config.json");
let OUTPUT_DIR = path.join(HERE, "output");

function args(argv) {
  const out = { config: DEFAULT_CONFIG, execute: false, keepOpen: false, cdpUrl: null };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--execute") out.execute = true;
    else if (item === "--dry-run") out.execute = false;
    else if (item === "--keep-open") out.keepOpen = true;
    else if (item === "--stop-after-entry") out.stopAfterEntry = true;
    else if (item === "--stop-after-media") out.stopAfterMedia = true;
    else if (item === "--stop-after-attributes") out.stopAfterAttributes = true;
    else if (item === "--stop-after-pricing") out.stopAfterPricing = true;
    else if (item === "--stop-after-specs") out.stopAfterSpecs = true;
    else if (item === "--restart-entry") out.restartEntry = true;
    else if (item === "--output-dir") out.outputDir = path.resolve(argv[++i]);
    else if (item === "--config") out.config = path.resolve(argv[++i]);
    else if (item === "--cdp-url") out.cdpUrl = argv[++i];
    else if (item === "--help" || item === "-h") {
      console.log("用法: node run-draft.mjs [--dry-run|--execute] [--config 文件] [--cdp-url 地址] [--keep-open]");
      process.exit(0);
    }
  }
  return out;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function resolveAsset(config, relativeOrAbsolute) {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(config.materialRoot, relativeOrAbsolute);
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function listFiles(dir) {
  try { return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name); }
  catch { return []; }
}

async function walkFiles(dir) {
  const result = [];
  async function visit(current) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(full);
    }
  }
  await visit(dir);
  return result;
}

async function fileInfo(file) {
  try {
    const stat = await fs.stat(file);
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return { file, size: stat.size, hash: hash.digest("hex") };
  } catch {
    return null;
  }
}

function extension(file) {
  return path.extname(file).toLowerCase();
}

function asPositiveNumber(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function addError(result, code, message) { result.errors.push({ code, message }); }
function addWarning(result, code, message) { result.warnings.push({ code, message }); }

async function validateConfig(config) {
  const result = { ok: true, errors: [], warnings: [], resolvedAssets: {}, inputHash: digest(config) };
  const product = config.product ?? {};
  const runtime = {
    maxMainImages: 5,
    expected34Count: 5,
    maxImageBytes: 5 * 1024 * 1024,
    maxVideoBytes: 200 * 1024 * 1024,
    allowedImageExtensions: [".jpg", ".jpeg", ".png"],
    allowedVideoExtensions: [".mp4", ".mov", ".webm"],
    ...config.runtime
  };
  const fileInfoCache = new Map();
  const getFileInfo = async (file) => {
    const absolute = path.resolve(file);
    if (!fileInfoCache.has(absolute)) fileInfoCache.set(absolute, fileInfo(absolute));
    return fileInfoCache.get(absolute);
  };
  for (const field of ["title", "itemCode", "composition", "material", "pieceCount", "applicableAge", "style"]) {
    if (!String(product[field] ?? "").trim()) addError(result, "MISSING_FIELD", `商品字段缺失：${field}`);
  }
  if (!String(product.categoryPath ?? "").trim()) {
    addError(result, "MISSING_CATEGORY", "缺少抖店类目路径；脚本不会猜类别，请先填写 categoryPath");
  }
  if (!config.draftOnly) addError(result, "PUBLISH_GUARD", "draftOnly 必须为 true，脚本禁止自动发布");
  try{specImageBindings(config);}catch(e){addError(result,'SPEC_IMAGE_MAPPING',e.message);}
  const images = Array.isArray(product.mainImages) ? product.mainImages : [];
  if (images.length === 0) addError(result, "NO_MAIN_IMAGE", "至少提供 1 张主图");
  if (images.length > runtime.maxMainImages) addError(result, "TOO_MANY_MAIN_IMAGES", `主图有 ${images.length} 张，平台最多允许 ${runtime.maxMainImages} 张；请显式筛选后再运行`);
  result.resolvedAssets.mainImages = [];
  for (const item of images) {
    const file = resolveAsset(config, item);
    result.resolvedAssets.mainImages.push(file);
    if (!(await exists(file))) addError(result, "ASSET_NOT_FOUND", `主图不存在：${file}`);
    else {
      const info = await getFileInfo(file);
      if (info && !runtime.allowedImageExtensions.includes(extension(file))) {
        addError(result, "INVALID_IMAGE_TYPE", `主图格式不支持：${path.basename(file)}；允许 ${runtime.allowedImageExtensions.join(", ")}`);
      }
      if (info && info.size > asPositiveNumber(runtime.maxImageBytes, 5 * 1024 * 1024)) {
        addError(result, "IMAGE_TOO_LARGE", `主图超过 ${Math.round(runtime.maxImageBytes / 1024 / 1024)}MB：${path.basename(file)}`);
      }
    }
  }
  if (product.video) {
    const file = resolveAsset(config, product.video);
    result.resolvedAssets.video = file;
    if (!(await exists(file))) addError(result, "ASSET_NOT_FOUND", `商品视频不存在：${file}`);
    else {
      const info = await getFileInfo(file);
      if (info && !runtime.allowedVideoExtensions.includes(extension(file))) {
        addError(result, "INVALID_VIDEO_TYPE", `商品视频格式不支持：${path.basename(file)}；允许 ${runtime.allowedVideoExtensions.join(", ")}`);
      }
      if (info && info.size > asPositiveNumber(runtime.maxVideoBytes, 200 * 1024 * 1024)) {
        addWarning(result, "VIDEO_TOO_LARGE", `商品视频超过配置上限 ${Math.round(runtime.maxVideoBytes / 1024 / 1024)}MB：${path.basename(file)}；请在页面上传前确认平台限制`);
      }
    }
  } else addWarning(result, "NO_VIDEO", "未提供商品视频，脚本会跳过视频上传");
  if (product.materialTagImage) {
    const file = resolveAsset(config, product.materialTagImage);
    result.resolvedAssets.materialTagImage = file;
    if (!(await exists(file))) addError(result, "ASSET_NOT_FOUND", `水洗标/吊牌图不存在：${file}`);
    else {
      const info = await getFileInfo(file);
      if (![...runtime.allowedImageExtensions, ".webp"].includes(extension(file))) {
        addError(result, "INVALID_TAG_IMAGE_TYPE", `吊牌图格式不支持：${path.basename(file)}`);
      }
      if (info && info.size > asPositiveNumber(runtime.maxImageBytes, 5 * 1024 * 1024)) {
        addError(result, "TAG_IMAGE_TOO_LARGE", `吊牌图超过 ${Math.round(runtime.maxImageBytes / 1024 / 1024)}MB：${path.basename(file)}`);
      }
    }
  }
  if (product.whiteBackgroundImage) {
    const file=resolveAsset(config,product.whiteBackgroundImage);
    result.resolvedAssets.whiteBackgroundImage=file;
    const info=await getFileInfo(file);
    if (!info) addError(result,'ASSET_NOT_FOUND',`商品白底图不存在：${file}`);
    else if (!['.jpg','.jpeg','.png'].includes(extension(file)) || info.size>runtime.maxImageBytes) addError(result,'INVALID_WHITE_IMAGE','白底图必须是大小不超过配置上限的 JPG/PNG 文件');
  }
  const colors = Array.isArray(config.colorSpecs) ? config.colorSpecs : [];
  const sizes = Array.isArray(config.sizeSpecs) ? config.sizeSpecs : [];
  if (colors.length === 0) addError(result, "NO_COLOR_SPEC", "至少提供 1 个颜色分类");
  if (sizes.length === 0) addError(result, "NO_SIZE_SPEC", "至少提供 1 个尺码分类");
  const colorNames = new Set();
  for (const color of colors) {
    if (!color.name || !color.remark || !(config.skuMatrix ?? []).filter(row=>row.color===color.name).length || !(config.skuMatrix ?? []).filter(row=>row.color===color.name).every(row=>Number.isFinite(Number(row.price)) && Number(row.price)>0)) addError(result, "INVALID_COLOR_SPEC", `颜色规格不完整：${JSON.stringify(color)}`);
    if (colorNames.has(color.name)) addError(result, "DUPLICATE_COLOR", `颜色规格重复：${color.name}`);
    colorNames.add(color.name);
  }
  const sizeNames = new Set();
  for (const size of sizes) {
    if (!size.name || !size.remark) addError(result, "INVALID_SIZE_SPEC", `尺码规格不完整：${JSON.stringify(size)}`);
    if (sizeNames.has(size.name)) addError(result, "DUPLICATE_SIZE", `尺码规格重复：${size.name}`);
    sizeNames.add(size.name);
  }
  const configuredAssets = [
    ...result.resolvedAssets.mainImages,
    result.resolvedAssets.video,
    result.resolvedAssets.materialTagImage,
    result.resolvedAssets.whiteBackgroundImage
  ].filter(Boolean).map((file) => path.resolve(file));
  const assetInfos = (await Promise.all(configuredAssets.map(getFileInfo))).filter(Boolean);
  const byHash = new Map();
  for (const info of assetInfos) {
    const previous = byHash.get(info.hash);
    if (previous) addWarning(result, "DUPLICATE_ASSET", `素材内容重复：${path.basename(previous)} 与 ${path.basename(info.file)}；不会自动去重`);
    else byHash.set(info.hash, info.file);
  }
  if (new Set(result.resolvedAssets.mainImages.map((file) => path.resolve(file))).size !== result.resolvedAssets.mainImages.length) {
    addError(result, "DUPLICATE_MAIN_IMAGE", "主图配置包含重复文件路径");
  }
  if (product.title && String(product.title).length > 60) addWarning(result, "TITLE_LONG", "商品标题超过 60 个字符；请按抖店页面实际限制复核");
  const expectedSkuCount = colors.length * sizes.length;
  result.expectedSkuCount = expectedSkuCount;
  if (expectedSkuCount > 0 && config.skuMatrix && Array.isArray(config.skuMatrix) && config.skuMatrix.length !== expectedSkuCount) {
    addError(result, "SKU_MATRIX_MISMATCH", `SKU 明细有 ${config.skuMatrix.length} 行，但颜色×尺码应为 ${expectedSkuCount} 行`);
  }
  const inventory = config.inventory ?? {};
  for (const field of ["shippingMode", "inStockDelivery", "preSaleDelivery"]) {
    if (!String(inventory[field] ?? "").trim()) addError(result, "MISSING_INVENTORY_FIELD", `库存/发货字段缺失：${field}`);
  }
  for (const field of ["inStock", "preSale"]) {
    if (!Number.isInteger(Number(inventory[field])) || Number(inventory[field]) < 0) addError(result, "INVALID_INVENTORY", `${field} 必须是非负整数`);
  }
  if (inventory.stockOperation !== "set-final-value") addWarning(result, "DELTA_STOCK_CONTROL", "库存必须按最终值写入；页面若显示“增/减”，脚本需要先清空再设置，不能把 10000 当增量叠加");
  const allMaterialFiles = await walkFiles(config.materialRoot);
  const configuredSet = new Set(configuredAssets);
  const candidateAssetExtensions = new Set([
    ...runtime.allowedImageExtensions,
    ".webp",
    ...runtime.allowedVideoExtensions
  ]);
  const extras = allMaterialFiles.filter((file) => candidateAssetExtensions.has(extension(file)) && !configuredSet.has(path.resolve(file)));
  if (extras.length) {
    const preview = extras.slice(0, 12).map((file) => path.relative(config.materialRoot, file));
    const suffix = extras.length > preview.length ? ` 等 ${extras.length} 个文件` : "";
    addWarning(result, "UNUSED_ASSETS", `素材库有 ${extras.length} 个未引用文件：${preview.join(", ")}${suffix}；不会自动上传`);
  }
  const materialVideos = allMaterialFiles.filter((file) => runtime.allowedVideoExtensions.includes(extension(file)));
  if (materialVideos.length > 1) addWarning(result, "MULTIPLE_VIDEOS", `素材库发现 ${materialVideos.length} 个视频；配置只会上传明确指定的一个视频`);
  // 替换同名素材也必须改变本次输入版本。
  const fingerprintConfig=structuredClone(config);
  delete fingerprintConfig.materialRoot; delete fingerprintConfig.cdpUrl;
  for (const key of ['mainImages','video','materialTagImage','whiteBackgroundImage']) {
    const relative=value=>value ? path.relative(config.materialRoot,resolveAsset(config,value)).split(path.sep).join('/') : value;
    const value=fingerprintConfig.product[key];
    if(value) fingerprintConfig.product[key]=Array.isArray(value)?value.map(relative):relative(value);
  }
  result.inputHash = digest({config:fingerprintConfig,assets:assetInfos.map(({file,hash,size})=>({file:path.relative(config.materialRoot,file).split(path.sep).join('/'),hash,size}))});
  result.ok = result.errors.length === 0;
  return result;
}

function printValidation(validation) {
  console.log(`检索结果：${validation.ok ? "通过" : "阻断"}`);
  for (const item of validation.errors) console.error(`✖ ${item.code}: ${item.message}`);
  for (const item of validation.warnings) console.warn(`⚠ ${item.code}: ${item.message}`);
  console.log(`输入版本：${validation.inputHash}`);
}

async function writeReport(report) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, "last-run.json");
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(OUTPUT_DIR, `run-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

async function loadPlaywright() {
  try { return await import("playwright-core"); }
  catch (error) { throw new Error(`缺少项目依赖 playwright-core，请运行 npm ci。${error.message}`); }
}

async function choosePage(browser) {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  if (!pages.length) throw new Error("CDP 已连接，但没有可操作页面；请先打开抖店后台页面");
  // 多个抖店 tab 常同时存在：优先选择已经进入旧版商品表单的页面，
  // 避免误选新版资料上传页、列表页或草稿页。
  const douPages = pages.filter((page) => /jinritemai|douyin|抖店/i.test(page.url()));
  for (const page of douPages) {
    try {
      if (/\/ffa\/g\/create/i.test(page.url()) && await page.locator('input[placeholder*="15-60个字符"]').count()) return page;
    } catch {}
  }
  return douPages.find((page) => /\/ffa\/g\/create/i.test(page.url())) || douPages[0] || pages[0];
}

async function clickText(page, text, timeout = 15000) {
  const candidates = [
    page.getByText(text, { exact: true }).first(),
    page.getByRole("button", { name: text, exact: true }).first(),
    page.locator(`button:has-text("${text}")`).first()
  ];
  for (const locator of candidates) {
    try { await locator.waitFor({ state: "visible", timeout: Math.min(timeout, 4000) }); await locator.click({timeout}); return true; } catch {}
  }
  throw new Error(`找不到可点击元素：${text}`);
}

async function fillNearLabel(page, label, value, required = true) {
  const businessInput = page.locator(`[attr-field-id="${label}"] input:not([type="file"])`).first();
  if (await businessInput.count() && !await businessInput.getAttribute('readonly') && await businessInput.getAttribute('type') !== 'search') {
    await businessInput.fill(String(value)); return true;
  }
  // 新版抖店基础信息字段使用业务 placeholder，标签文本与输入框不在同一父节点。
  const directSelectors = {
    商品名称: 'input[placeholder*="15-60个字符"]',
    导购短标题: 'input[placeholder*="简明准确的标题"]',
  };
  const direct = directSelectors[label];
  if (direct) {
    const input = page.locator(direct).first();
    if (await input.count()) { await input.fill(String(value)); return true; }
  }
  const labels = page.getByText(label, { exact: true });
  const count = await labels.count();
  for (let i = 0; i < count; i += 1) {
    const labelNode = labels.nth(i);
    const parent = labelNode.locator("xpath=.. ");
    const input = parent.locator("input,textarea").first();
    if (await input.count()) {
      try { await input.fill(String(value)); return true; } catch {}
    }
  }
  if (required) throw new Error(`找不到字段输入框：${label}`);
  return false;
}

async function uploadByIndex(page, index, files, timeout = 15000) {
  const inputs = page.locator('input[type="file"]');
  await inputs.nth(index).waitFor({ state: "attached", timeout });
  await inputs.nth(index).setInputFiles(files);
}

async function uploadMainImages(page, files, timeout = 15000) {
  await page.waitForFunction(() => [...document.querySelectorAll('[class*="form-item"]')].some(e=>e.innerText.includes('发布≥3张优质图片') && e.querySelectorAll('input[type="file"]').length===5), null, {timeout:30000});
  // 新版抖店主图区域是 5 个单文件 input，不能一次传数组。
  const inputs = page.locator('input[type="file"][accept="image/*"]');
  const count = await inputs.count();
  const candidates = [];
  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    const section = await input.evaluate(el => el.closest('[class*="form-item"]')?.innerText || '');
    if (section.includes('发布≥3张优质图片')) candidates.push(input);
  }
  if (candidates.length !== files.length) throw new Error(`主图槽位数不匹配：找到 ${candidates.length} 个，配置需要 ${files.length} 个`);
  const region = page.locator('[class*="form-item"]').filter({hasText:'发布≥3张优质图片'}).last();
  const existing = await region.locator('img').count();
  if (existing >= files.length) return;
  // 辅助图入口支持批量；重新定位当前空槽，避免上传完成后 DOM 索引改变。
  await region.locator('input[type="file"][multiple]').first().setInputFiles(files.slice(existing), { timeout });
  await page.waitForFunction(({count}) => [...document.querySelectorAll('[class*="form-item"]')].some(e=>e.innerText.includes('发布≥3张优质图片') && e.querySelectorAll('img').length===count), {count:files.length}, {timeout:180000});
}

async function uploadVideo(page, file, timeout = 15000) {
  const success = page.locator('[attr-field-id="主图视频"] [class*="item-success"]');
  if (await success.count()) return true;
  const input = page.locator('input[type="file"][accept*=".mp4"], input[type="file"][accept*="video"]').first();
  if (await input.count()) { await input.setInputFiles(file, { timeout }); await success.waitFor({state:'attached',timeout:120000}); return true; }
  throw new Error('找不到视频上传入口；停止执行，不能跳过素材库指定的视频');
}

async function completeLegacyWizard(page, config, validation) {
  const legacyVisible = await page.getByText('主图上传', {exact:true}).count() > 0;
  const titleInput = page.locator('input[placeholder*="2-60个字符"], input[placeholder*="15-60个字符"]').filter({visible:true}).first();
  if (!legacyVisible || !await titleInput.count()) return false;
  const dialog = page.getByRole('dialog').filter({hasText:'选择类目'});
  if (!await dialog.isVisible()) {
    const hasImage = await page.locator('img').evaluateAll(es=>es.some(e=>e.complete && e.naturalWidth>=600));
    if (!hasImage) {
      await page.locator('input[type="file"]').first().setInputFiles(validation.resolvedAssets.mainImages[0]);
      await page.waitForFunction(() => [...document.querySelectorAll('img')].some(e=>e.complete && e.naturalWidth>=600), null, {timeout:60000});
    }
    if (await titleInput.inputValue() !== config.product.title) await titleInput.fill(config.product.title);
    await titleInput.press('Tab'); // Commit title before category recommendation/next-step validation.
    // 推荐类目异步生成；仍未就绪时才打开手动选择。
    await page.waitForFunction(() => { const b=[...document.querySelectorAll('button')].find(e=>e.innerText==='下一步'); return b && !b.disabled; }, null, {timeout:15000}).catch(()=>{});
    if (await page.getByRole('button',{name:'下一步',exact:true}).isDisabled() || !await page.getByText(config.product.categoryPath,{exact:true}).count()) {
      await page.getByText('手动选择类目',{exact:true}).click({timeout:10000});
    }
  }
  if (await dialog.isVisible()) {
    for (const part of config.product.categoryPath.split('>').map(x=>x.trim())) {
      await dialog.getByText(part,{exact:true}).click({timeout:10000});
    }
    await dialog.getByRole('button',{name:'确认',exact:true}).click({timeout:10000});
    await dialog.waitFor({state:'hidden',timeout:10000});
  }
  await page.getByText(config.product.categoryPath,{exact:true}).waitFor({state:'visible',timeout:30000});
  await assertSafetyClear(page);
  console.log('旧版首步：标题已失焦提交，类目=' + config.product.categoryPath);
  await page.getByRole('button',{name:'下一步',exact:true}).click({timeout:10000});
  try {
    await page.locator('[attr-field-id="商品类目"]').waitFor({state:'visible',timeout:30000});
  } catch (error) {
    await assertSafetyClear(page);
    const state=await page.locator('body').innerText();
    throw new Error('旧版下一步未进入编辑页：' + state.slice(-2500) + '\n' + error.message);
  }
  return true;
}

async function closeOverlays(page) {
  if (!page) return;
  const drawerClose = page.getByRole('button', {name:'Close',exact:true});
  if (await drawerClose.isVisible().catch(()=>false)) await drawerClose.click();
  for (const text of ["关闭", "知道了"]) {
    try { await page.getByText(text, { exact: true }).last().click({ timeout: 1000 }); } catch {}
  }
}

async function executeDraft(config, validation, options) {
  OUTPUT_DIR = options.outputDir || OUTPUT_DIR;
  const playwright = await loadPlaywright();
  const cdpUrl = options.cdpUrl || config.cdpUrl || "http://127.0.0.1:9222";
  const browser = options.browser || await playwright.chromium.connectOverCDP(cdpUrl);
  let page = options.page || await choosePage(browser);
  const events = [];
  const environment={browser:browser.version(),page:await page.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio,visualScale:visualViewport?.scale,userAgent:navigator.userAgent})),viewport:page.viewportSize()};
  events.push({name:'运行环境',ok:true,environment});
  const step = async (name, fn) => {
    const started = Date.now();
    events.push({ name, startedAt: new Date().toISOString() });
    console.log(`开始步骤：${name}`);
    await options.onEvent?.({type:"step-start",name,startedAt:new Date().toISOString()});
    try { await assertPageShop(page,config.expectedShop); const value = await fn(); await assertSafetyClear(page); events.at(-1).ok = true; events.at(-1).durationMs = Date.now() - started; console.log(`步骤通过：${name}`); await options.onEvent?.({type:"step-complete",name,durationMs:Date.now()-started}); return value; }
    catch (error) { try{await assertSafetyClear(page);}catch(safety){if(safety.message.startsWith('SAFETY_BLOCKED'))error=safety;} events.at(-1).ok = false; events.at(-1).durationMs = Date.now() - started; events.at(-1).error = error.message; throw error; }
  };
  try {
    await step("进入新建单商品页面", async () => {
      if (options.restartEntry) page = await page.context().newPage();
      await installSafetyGuard(page);
      if (!/\/ffa\/g\/create(?:\?|$)/.test(page.url())) {
        await page.goto('https://fxg.jinritemai.com/ffa/g/create?entrance=create', { waitUntil: 'domcontentloaded' });
      }
      const entry=await resolveEntry(page);
      if(options.requireBlankEntry)await assertBlankProductEntry(page);
      events.at(-1).entry=entry;
      const legacyWizard = async () => await page.getByText('主图上传', { exact: true }).isVisible();
      if(await page.getByText('确认信息，继续生成',{exact:true}).isVisible().catch(()=>false)) {
        console.log('识别到商品材料入口，上传素材库主图和详情图');
        const files=config.product.mainImages.map(f=>path.resolve(config.materialRoot,f));
        await uploadMaterialEntry(page,files);
        const title=page.locator('input[placeholder*="个字符"]').first();
        await title.fill(config.product.title);
        await title.press('Tab'); // Commit the title through normal focus/change behavior.
        if(await title.inputValue()!==config.product.title)throw new Error('材料入口标题回读不符');
        const next=await waitMaterialEntryReady(page,config.product.categoryPath);
        await assertSafetyClear(page);
        await next.click({timeout:15000});
        await page.locator('[attr-field-id="商品类目"]').waitFor({state:'visible',timeout:90000});
      }
      if (!await page.locator('input[placeholder*="15-60个字符"]').count() && !await legacyWizard()) throw new Error("点击返回旧版后未加载旧版入口或商品编辑表单");
      await completeLegacyWizard(page, config, validation);
    });
    if (options.stopAfterEntry) return { ok: true, entryOnly: true, pageUrl: page.url(), events };
    if (!await page.locator('input[placeholder*="15-60个字符"]').count()) throw new Error('LEGACY_WIZARD_PENDING：旧版首步未完成');
    await step("填写基础信息", async () => {
      await page.locator('[attr-field-id="商品类目"]').getByText(config.product.categoryPath,{exact:true}).waitFor({state:'visible',timeout:30000});
      await fillNearLabel(page, "商品名称", config.product.title);
      await fillNearLabel(page, "货号", config.product.itemCode);
      const brand = page.locator('[attr-field-id="品牌"]');
      if (!await brand.getByText(config.product.brand,{exact:true}).count()) {
        await brand.locator('input').fill(config.product.brand);
        await page.getByText(config.product.brand,{exact:true}).last().click({timeout:10000});
      }
    });
    await step("上传图文素材", async () => {
      await closeOverlays(page);
      const images = validation.resolvedAssets.mainImages;
      await uploadMainImages(page, images);
      if (validation.resolvedAssets.video) await uploadVideo(page, validation.resolvedAssets.video);
      if (config.product.mainImage34 === "smart-crop-from-1to1") {
        const cropRegion = page.locator('[attr-field-id="主图3:4"]');
        if (await cropRegion.locator('img').count() !== (config.runtime?.expected34Count ?? 5)) await clickText(page, "从1:1主图智能裁剪", 10000);
        const expected = config.runtime?.expected34Count ?? 5;
        await page.waitForFunction((count) => [...document.querySelectorAll('[class*="form-item"]')].some(e=>e.innerText.includes('从1:1主图智能裁剪') && e.querySelectorAll('img').length===count), expected, { timeout: 60000 });
      }
      if (config.product.detailImagesFromMain === true && !await page.getByText(`商详图片（${images.length}/50）`,{exact:true}).count()) {
        const buttonText = config.runtime?.detailImagesFillButtonText || "从主图填入";
        await clickText(page, buttonText, config.runtime?.stepTimeoutMs ?? 15000);
        await page.getByText(`商详图片（${images.length}/50）`,{exact:true}).waitFor({state:'visible',timeout:30000});
      }
    });
    await step("上传并回读商品白底图",async()=>uploadWhiteImage(page,config,validation));
    if (options.stopAfterMedia) return {ok:true,mediaOnly:true,pageUrl:page.url(),events};
    await step("填写材质和吊牌", async () => {
      if (validation.resolvedAssets.materialTagImage) {
        const tagRegion = page.locator('[attr-field-id="水洗标/吊牌图"]');
        const tagInput = tagRegion.locator('input[type="file"]').first();
        if (!await tagInput.count()) throw new Error('找不到水洗标/吊牌图上传入口');
        if (!await tagRegion.locator('img').count()) await tagInput.setInputFiles(validation.resolvedAssets.materialTagImage);
        await tagRegion.locator('img').waitFor({state:'attached',timeout:30000});
      }
      await fillMaterial(page,config);
      await fillProductAttributes(page,config);
    });
    if (options.stopAfterAttributes) return {ok:true,attributesOnly:true,pageUrl:page.url(),events};
    const specEvidence=await step("按配置同步全部规格",async()=>reconcileSpecs(page,config));
    events.at(-1).readback=specEvidence;
    await step("绑定并回读款式规格图",async()=>bindSpecImages(page,config));
    if (options.stopAfterSpecs) return {ok:true,specsOnly:true,pageUrl:page.url(),events};
    await step("填写身高体重尺码表", async () => fillSizeChart(page,config));
    await step("设置价格库存和发货", async () => {
      await closeOverlays(page);
      await clickText(page, config.inventory.shippingMode, 8000);
      const shippingRadio=page.locator('[attr-field-id="现货发货时间"] label').filter({hasText:config.inventory.inStockDelivery}).locator('input[type="radio"]');
      await shippingRadio.check({timeout:10000});
      if(!await shippingRadio.isChecked()) throw new Error('现货发货时间回读失败');
      const delivery=page.getByText(config.inventory.preSaleDelivery.replace(/天$/, "天内"),{exact:true}).first().locator('xpath=ancestor::label[1]');
      const deliveryInput=delivery.locator('input');
      if(await deliveryInput.count()) await deliveryInput.check();
      else await clickText(page, config.inventory.preSaleDelivery.replace(/天$/, "天内"), 8000);
      await fillSkuPrices(page,config);
      if (config.inventory.stockOperation !== "set-final-value") throw new Error("库存操作策略不安全：必须使用 set-final-value");
    });
    const skuReadback=await step("回读全部SKU价格库存",async()=>verifySkuTable(page,config));
    if(options.stopAfterPricing) return {ok:true,pricingOnly:true,skuReadback,pageUrl:page.url(),events};
    await step("保存前校验",async()=>{await verifySpecs(page,config);await verifyBeforeSave(page,config,skuReadback);});
    const saved=await step("保存草稿",async()=>saveDraft(page,config,OUTPUT_DIR,validation.inputHash));
    return {ok:true,pageUrl:page.url(),skuReadback,saved,events};
  } catch (error) {
    error.execution = { pageUrl: page.url(), events };
    throw error;
  } finally {
    if (!options.keepOpen && typeof browser.disconnect === "function") browser.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const options = args(process.argv.slice(2));
OUTPUT_DIR = options.outputDir || OUTPUT_DIR;
const config = await readJson(options.config);
const validation = await validateConfig(config);
printValidation(validation);
const report = { startedAt: new Date().toISOString(), mode: options.execute ? "execute" : "dry-run", config: options.config, validation };
if (!validation.ok) {
  report.ok = false;
  report.finishedAt = new Date().toISOString();
  const output = await writeReport(report);
  console.error(`已阻断，报告：${output}`);
  process.exitCode = 2;
} else if (!options.execute) {
  report.ok = true;
  report.message = "dry-run 通过；未连接浏览器、未上传素材、未保存草稿";
  report.finishedAt = new Date().toISOString();
  const output = await writeReport(report);
  console.log(`dry-run 通过，报告：${output}`);
} else {
  try {
    const execution = await executeDraft(config, validation, options);
    Object.assign(report, execution, { finishedAt: new Date().toISOString() });
    const output = await writeReport(report);
    console.log(execution.entryOnly || execution.mediaOnly || execution.attributesOnly || execution.specsOnly || execution.pricingOnly ? `检查点结束，未保存草稿。报告：${output}` : `草稿保存流程完成，未执行发布。报告：${output}`);
  } catch (error) {
    Object.assign(report, error.execution, { ok: false, error: error.message, finishedAt: new Date().toISOString() });
    const output = await writeReport(report);
    console.error(`执行中止：${error.message}\n报告：${output}`);
    process.exitCode = 1;
  }
}
// CDP 客户端保持 WebSocket 活跃；报告写完后退出客户端，不关闭用户浏览器。
if (options.execute) process.exit(process.exitCode || 0);

}
export {validateConfig, executeDraft};
