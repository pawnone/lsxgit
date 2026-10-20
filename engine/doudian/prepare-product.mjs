#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readExcelProduct } from './excel-product.mjs';
import { displaySpec, range, expandSkus } from "./listing-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(HERE, "output", "resolved-product-config.json");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);

function parseArgs(argv) {
  const options = { input: null, output: DEFAULT_OUTPUT, cdpUrl: "http://127.0.0.1:9222" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--input") options.input = path.resolve(argv[++index]);
    else if (item === "--output") options.output = path.resolve(argv[++index]);
    else if (item === "--cdp-url") options.cdpUrl = argv[++index];
    else if (item === "--help" || item === "-h") {
      console.log("用法: node prepare-product.mjs --input 商品素材库 [--output 标准配置.json]");
      process.exit(0);
    }
  }
  if (!options.input) throw new Error("缺少 --input 商品素材库路径");
  return options;
}

async function walkFiles(dir) {
  const files = [];
  async function visit(current) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(dir);
  return files.sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function relativeSegments(file, root) {
  return path.relative(root, file).split(path.sep).filter(Boolean);
}

function filesInFolder(files, root, folder, predicate) {
  return files.filter((file) => {
    const segments = relativeSegments(file, root);
    return segments.includes(folder) && (!predicate || predicate(file));
  });
}

function extension(file) { return path.extname(file).toLowerCase(); }

function addIssue(result, level, code, message) {
  result[level].push({ code, message });
}

function valueAfterColon(line) {
  const match = String(line).match(/^[\s>*-]*(?:[^：:]+)[：:]\s*(.+?)\s*$/);
  return match?.[1]?.trim() || "";
}

function cleanValue(value) {
  return String(value ?? "")
    .replace(/[`*_]/g, "")
    .replace(/（[^）]*平台无精确选项[^）]*）/g, "")
    .trim();
}

function parseBulletFields(markdown) {
  const fields = {};
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s*([^：:]+)[：:]\s*(.*?)\s*$/);
    if (!match) continue;
    fields[cleanValue(match[1])] = cleanValue(match[2]);
  }
  return fields;
}

function parseMoney(value) {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseInteger(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

function parseMarkdownTable(markdown, headerPart) {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("|") && line.endsWith("|"));
  const headerIndex = lines.findIndex((line) => line.includes(headerPart));
  if (headerIndex < 0 || !lines[headerIndex + 1]?.includes("---")) return [];
  const headers = lines[headerIndex].split("|").slice(1, -1).map((item) => cleanValue(item));
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    const cells = line.split("|").slice(1, -1).map((item) => cleanValue(item));
    if (cells.length !== headers.length) break;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
  }
  return rows;
}

function parseComposition(value) {
  const text = cleanValue(value);
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const material = text.replace(/\d+(?:\.\d+)?\s*%/g, "").trim() || text;
  return { composition: text, material, materialPercent: percent ? Number(percent[1]) : null };
}

function parseMarkdownProduct(markdown, materialRoot) {
  const fields = parseBulletFields(markdown);
  for (const [key,value] of Object.entries(fields)) {
    if (/【|待填写|待确认/.test(key + value)) throw new Error(`未填写字段：${key}`);
  }
  const whiteValue = fields['商品白底图'] || '';
  const whiteFlag = fields['是否提供商品白底图'];
  if (whiteFlag && !['有','无'].includes(whiteFlag)) throw new Error('是否提供商品白底图只能填有或无');
  if ((whiteFlag === '无' && whiteValue && whiteValue !== '无') || (whiteFlag === '有' && (!whiteValue || whiteValue === '无'))) throw new Error('商品白底图声明与路径不一致');
  const composition = parseComposition(fields["商品材质"] || fields["面料材质名称及含量"] || "");
  const colorRows = parseMarkdownTable(markdown, "颜色分类中新建的名称");
  const skuRows = parseMarkdownTable(markdown, "颜色分类（款式）");
  const colorNameBySaleName = new Map(colorRows.map((row) => [row["售卖款式"], row["颜色分类中新建的名称"]]));
  const sizeChart = parseMarkdownTable(markdown, "身高(cm)").map(row => ({size:row["尺码"],height:range(row["身高(cm)"]),weight:range(row["体重(斤)"])}));
  const colors = colorRows.map((row) => ({
    name: row["颜色分类中新建的名称"],
    remark: row["备注"],
    actualColor: row["实际颜色"]
  }));
  const priceByColor = new Map();
  const sizeRemarks = new Map();
  const skuMatrix = [];
  for (const row of skuRows) {
    const saleName = row["颜色分类（款式）"];
    const colorName = colorNameBySaleName.get(saleName) || saleName;
    const price = parseMoney(row["售价"]);
    const inStock = parseInteger(row["现货库存"]);
    const preSale = parseInteger(row["预售库存"]);
    const size = row["尺码"];
    if (price != null && !priceByColor.has(colorName)) priceByColor.set(colorName, price);
    if (size && row["建议体重"] && !sizeRemarks.has(size)) sizeRemarks.set(size, row["建议体重"]);
    skuMatrix.push({
      color: colorName,
      size,
      price,
      inStock,
      preSale,
      preSaleDelivery: row["预售周期"] || ""
    });
  }
  for (const color of colors) {
    const sale = colorRows.find(row => row["颜色分类中新建的名称"] === color.name)?.["售卖款式"];
    const prices = [...new Set(skuMatrix.filter(row => row.color === color.name && row.price != null).map(row=>row.price))];
    color.price = parseMoney(fields[`${sale}各尺码售价`]) ?? (prices.length === 1 ? prices[0] : null);
  }
  for (const row of sizeChart) if (!sizeRemarks.has(row.size)) sizeRemarks.set(row.size, `${row.weight[0]}–${row.weight[1]}斤`);
  const tagMatch = markdown.match(/水洗标\/吊牌图[^：:]*[：:]\s*`?([^`\s]+\.(?:jpg|jpeg|png|webp))`?/i);
  const tagPath = tagMatch?.[1] || "";
  const delivery = fields["现货发货时间"] || fields["现货发货"] || "";
  const inStockDelivery = delivery.includes("次日发") ? "次日发" : delivery;
  const preSaleDelivery = fields["预售周期"] || fields["预售发货时间"] || "";
  const mainImageList = markdown.match(/(?:^|\n)主图清单[：:][ \t]*\r?\n((?:- [^\r\n]+(?:\r?\n|$))+)/)?.[1];
  const info = {
    whiteBackgroundImage: whiteValue === '无' ? '' : whiteValue,
    whiteBackgroundFor: fields['白底图对应款式'] || '',
    whiteBackgroundDeclared: whiteFlag !== undefined,
    videoDeclaredNone: fields['是否提供商品视频'] === '无',
    video: /\.(mp4|mov|webm)$/i.test(fields['商品视频'] || '') ? fields['商品视频'] : '',
    title: fields["商品名称"] || "",
    ...(mainImageList
      ? { mainImages: mainImageList.trim().split(/\r?\n/).map((line) => cleanValue(line.replace(/^-\s+/, ""))) }
      : {}),
    itemCode: fields["货号"] || "",
    brand: fields["品牌"] || "",
    categoryPath: fields["抖店类目路径"] || fields["类目路径"] || fields.categoryPath || "",
    style: fields["风格"] || "",
    pieceCount: fields["组合件数"] || "",
    applicableAge: (fields["抖店适用年龄选项"] || fields["适用年龄"] || "").replace(/（平台.*$/, ""),
    ...composition,
    materialTagImage: tagPath && path.isAbsolute(tagPath) ? tagPath : tagPath ? path.resolve(materialRoot, tagPath) : "",
    colors,
    sizes: [...sizeRemarks].map(([name, remark]) => ({ name, remark })),
    skuMatrix,
    sizeChart,
    inventory: {
      shippingMode: fields["发货模式"] || "",
      inStockDelivery,
      preSaleDelivery,
      inStock: parseInteger(fields["现货库存"]),
      preSale: parseInteger(fields["预售库存"]),
      stockOperation: "set-final-value",
      stockCountMode: fields["订单库存计数"] || ""
    },
    service: {
      freightTemplate: fields["运费模板"] || "",
      afterSale: fields["售后服务"] || "",
      returnPolicy: fields["售后政策"] || ""
    }
  };
  return info;
}

async function findInfoFile(files, root) {
  const exactNames = new Set(["商品信息.json", "product-info.json", "listing.json", "product.json"]);
  const json = files.filter((file) => exactNames.has(path.basename(file)));
  const textFiles = files.filter((file) => {
    const name = file.toLowerCase();
    return /\.(md|markdown|txt)$/.test(name) && relativeSegments(file, root).includes("商品信息");
  });
  const excel=files.filter(file=>!path.basename(file).startsWith('~$') && extension(file)==='.xlsx' && (relativeSegments(file,root).includes('商品信息') || path.basename(file)==='商品信息.xlsx'));
  if (json.length + textFiles.length + excel.length > 1) return {error:'每个商品只能保留一份商品信息文件，不能混放旧 JSON 与新 Markdown 或 Excel'};
  if (excel.length === 1) return excel[0];
  if (json.length === 1) return json[0];
  if (textFiles.length === 1) return textFiles[0];
  if (textFiles.length > 1) return { error: `发现多个商品信息文本文件：${textFiles.map((file) => path.relative(root, file)).join(", ")}` };
  return null;
}

async function readProductInfo(file, root) {
  if (!file) return {};
  if (extension(file) === ".xlsx") return readExcelProduct(file);
  const text = await fs.readFile(file, "utf8");
  if (extension(file) === ".json") return JSON.parse(text.replace(/^\uFEFF/, ''));
  return parseMarkdownProduct(text, root);
}

function mergeCanonical(info, assets, options) {
  const product = info.product ?? info;
  const colors = (info.colorSpecs ?? product.colors ?? []).map(displaySpec);
  const sizes = info.sizeSpecs ?? product.sizes ?? [];
  const inventory = info.inventory ?? product.inventory ?? {};
  const service = info.service ?? product.service ?? {};
  return {
    platform: "dou店",
    draftOnly: true,
    cdpUrl: options.cdpUrl,
    materialRoot: options.input,
    product: {
      title: product.title || "",
      itemCode: product.itemCode || "",
      brand: product.brand || "",
      categoryPath: product.categoryPath || "",
      style: product.style || "",
      pieceCount: product.pieceCount || "",
      applicableAge: product.applicableAge || "",
      composition: product.composition || "",
      material: product.material || "",
      materialPercent: product.materialPercent ?? null,
      materialTagImage: product.materialTagImage || assets.materialTagImage || "",
      whiteBackgroundImage: product.whiteBackgroundImage || '',
      whiteBackgroundFor: product.whiteBackgroundFor || '', 
      mainImages: assets.mainImages,
      video: assets.video || "",
      mainImage34: product.mainImage34 || "smart-crop-from-1to1",
      detailImagesFromMain: product.detailImagesFromMain !== false
    },
    colorSpecs: colors.map((color) => ({ ...color, price: color.price ?? null })),
    sizeSpecs: sizes,
    skuMatrix: expandSkus(colors, sizes, info.skuMatrix ?? product.skuMatrix ?? [], inventory),
    sizeChart: info.sizeChart ?? product.sizeChart ?? [],
    inventory: {
      shippingMode: inventory.shippingMode || "",
      inStockDelivery: inventory.inStockDelivery || "",
      preSaleDelivery: inventory.preSaleDelivery || "",
      inStock: inventory.inStock ?? null,
      preSale: inventory.preSale ?? null,
      stockOperation: inventory.stockOperation || "set-final-value",
      stockCountMode: inventory.stockCountMode || ""
    },
    service,
    runtime: {
      maxMainImages: 5,
      expected34Count: 5,
      maxImageBytes: 5242880,
      maxVideoBytes: 209715200,
      allowedImageExtensions: [".jpg", ".jpeg", ".png"],
      allowedVideoExtensions: [".mp4", ".mov", ".webm"],
      detailImagesFillButtonText: "从主图填入",
      stepTimeoutMs: 15000,
      saveTimeoutMs: 30000
    }
  };
}

async function prepareProduct(options) {
  const files = await walkFiles(options.input);
  const result = { ok: true, errors: [], warnings: [], input: options.input, output: options.output };
  const mainImages = filesInFolder(files, options.input, "主图", (file) => IMAGE_EXTENSIONS.has(extension(file)));
  const videos = filesInFolder(files, options.input, "视频", (file) => VIDEO_EXTENSIONS.has(extension(file)));
  const tagImages = filesInFolder(files, options.input, "商品标签", (file) => IMAGE_EXTENSIONS.has(extension(file)));
  const infoFile = await findInfoFile(files, options.input);
  if (infoFile?.error) addIssue(result, "errors", "MULTIPLE_PRODUCT_INFO", infoFile.error);
  if (!infoFile) addIssue(result, "errors", "MISSING_PRODUCT_INFO", "未找到商品信息文件；请提供商品信息.json、product-info.json，或商品信息目录下唯一的 Markdown/TXT 文件");
  if (mainImages.length === 0) addIssue(result, "errors", "NO_MAIN_IMAGE", "主图目录没有可识别的 jpg/jpeg/png/webp 文件");
  if (videos.length > 1) addIssue(result, "errors", "MULTIPLE_VIDEOS", `视频目录发现 ${videos.length} 个视频；请只保留一个或在商品信息 JSON 中明确指定`);
  if (tagImages.length > 1) addIssue(result, "warnings", "MULTIPLE_TAG_IMAGES", `商品标签目录发现 ${tagImages.length} 张图片；将使用商品信息中明确指定的图片，否则不自动选择`);
  let info = {};
  if (infoFile && !infoFile.error) {
    try { info = await readProductInfo(infoFile, options.input); }
    catch (error) { addIssue(result, "errors", "INVALID_PRODUCT_INFO", `商品信息文件无法解析：${error.message}`); }
  }
  const requested=info.product??info;
  if(requested.targetPlatform && requested.targetPlatform!=='doudian')addIssue(result,'errors','UNSUPPORTED_PLATFORM','商品指定的平台尚未接入');
  if(requested.assetMode==='directory') {
    const direct = (folder,exts)=>files.filter(f=>path.dirname(f)===path.join(options.input,folder)&&exts.has(extension(f)));
    const ordered=direct('主图',IMAGE_EXTENSIONS).sort((a,b)=>path.basename(a).localeCompare(path.basename(b),'zh-CN',{numeric:true}));
    const slots=ordered.map(f=>path.basename(f,path.extname(f)));
    if(ordered.length!==5 || slots.some((v,i)=>v!==String(i+1).padStart(2,'0')))addIssue(result,'errors','MAIN_ORDER','主图目录必须恰好有01、02、03、04、05五张图片（JPG/PNG），不填写路径；多余图片请移出该目录');
    requested.mainImages=ordered.map(f=>path.relative(options.input,f));
    for(const [folder,key,exts,required]of [['商品标签','materialTagImage',IMAGE_EXTENSIONS,true],['视频','video',VIDEO_EXTENSIONS,false],['白底图','whiteBackgroundImage',IMAGE_EXTENSIONS,false]]) {
      const candidates=direct(folder,exts);
      const nested=files.filter(f=>relativeSegments(f,options.input)[0]===folder&&exts.has(extension(f))&&path.dirname(f)!==path.join(options.input,folder));
      if(nested.length)addIssue(result,'errors','NESTED_ASSET',`${folder}请直接放文件，不嵌套子目录`);
      if(candidates.length>1 || (required&&candidates.length!==1))addIssue(result,'errors','AMBIGUOUS_ASSET',`${folder}需要${required?'恰好':'最多'}1个文件，目前${candidates.length}个；请移出备用文件`);
      requested[key]=candidates.length===1?path.relative(options.input,candidates[0]):'';
    }
    requested.videoDeclaredNone=!requested.video;
    requested.whiteBackgroundDeclared=true;
  }
  const explicitImages = info.product?.mainImages || info.mainImages;
  const selectedImages = Array.isArray(explicitImages)
    ? explicitImages.map((file) => path.isAbsolute(file) ? file : path.resolve(options.input, file))
    : mainImages;
  if (Array.isArray(explicitImages)) {
    for (const file of selectedImages) if (!files.includes(file)) addIssue(result, "errors", "ASSET_NOT_FOUND", `商品信息指定的主图不存在：${file}`);
    if (selectedImages.length > 5) addIssue(result, "errors", "TOO_MANY_MAIN_IMAGES", `商品信息明确指定了 ${selectedImages.length} 张主图，最多允许 5 张`);
  } else if (mainImages.length > 5) {
    addIssue(result, "errors", "TOO_MANY_MAIN_IMAGES", `主图目录发现 ${mainImages.length} 张图片；请在商品信息文件中明确列出要上传的主图，不能自动截断`);
  }
  const selectedVideo = (info.product ?? info).videoDeclaredNone ? "" : info.product?.video || info.video || (videos.length === 1 ? path.relative(options.input, videos[0]) : "");
  const selectedTag = info.product?.materialTagImage || info.materialTagImage || (tagImages.length === 1 ? path.relative(options.input, tagImages[0]) : "");
  const assets = {
    mainImages: selectedImages.map((file) => path.isAbsolute(file) ? path.relative(options.input, file) : file),
    video: selectedVideo,
    materialTagImage: selectedTag
  };
  const config = mergeCanonical(info, assets, options);
  const declared = info.product ?? info;
  const whiteFiles = filesInFolder(files,options.input,'白底图',file=>IMAGE_EXTENSIONS.has(extension(file)));
  if (whiteFiles.length && (!Object.hasOwn(declared,'whiteBackgroundImage') || declared.whiteBackgroundDeclared === false)) addIssue(result,'errors','MISSING_WHITE_SELECTION','白底图目录有素材，须在商品信息明确选择路径或声明无');
  if (Array.isArray(declared.whiteBackgroundImage)) addIssue(result,'errors','MULTIPLE_WHITE_SELECTION','当前白底图入口只接受一个明确选择的图片路径');
  if (typeof config.product.whiteBackgroundImage !== 'string') config.product.whiteBackgroundImage = '';
  for (const key of ['materialTagImage','whiteBackgroundImage']) {
    const value=config.product[key];
    if (value && !path.isAbsolute(value)) config.product[key]=value.replaceAll('\\','/');
  }
  config.product.mainImages = assets.mainImages;
  if (!config.product.title) addIssue(result, "errors", "MISSING_FIELD", "商品信息缺少商品名称");
  if (!config.product.categoryPath) addIssue(result, "errors", "MISSING_CATEGORY", "商品信息缺少抖店精确类目路径；读取器不会根据标题猜类目");
  if (!config.product.material) addIssue(result, "errors", "MISSING_FIELD", "商品信息缺少材质");
  if (!config.colorSpecs.length) addIssue(result, "errors", "NO_COLOR_SPEC", "商品信息缺少颜色分类");
  if (!config.sizeSpecs.length) addIssue(result, "errors", "NO_SIZE_SPEC", "商品信息缺少尺码");
  if (config.colorSpecs.some((color) => !config.skuMatrix.filter(row=>row.color===color.name).every(row=>Number.isFinite(row.price)&&row.price>0))) addIssue(result, "errors", "INVALID_PRICE", "颜色分类中存在缺失或非正数价格");
  if (config.inventory.inStock == null || config.inventory.preSale == null) addIssue(result, "errors", "MISSING_INVENTORY", "商品信息缺少现货库存或预售库存");
  result.ok = result.errors.length === 0;
  result.config = config;
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(config, null, 2)}\n`);
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await prepareProduct(options);
  console.log(`素材读取：${result.ok ? "通过" : "阻断"}`);
  for (const item of result.errors) console.error(`✖ ${item.code}: ${item.message}`);
  for (const item of result.warnings) console.warn(`⚠ ${item.code}: ${item.message}`);
  console.log(`标准配置：${options.output}`);
  if (!result.ok) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { parseMarkdownProduct, prepareProduct, findInfoFile, readProductInfo };
