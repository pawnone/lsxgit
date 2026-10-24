import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { imageSizeFromFile } from "image-size/fromFile";
import {readWorkbook,workbookCandidates} from "./workbook-reader.mjs";
import {discoverMaterials} from "./material-discovery.mjs";
import { executionHash } from "./frozen-input.mjs";
import {configuredImageOrder,cycleImages} from './image-order.mjs';
import {SET_CATEGORY,KNIT_CATEGORY,SUPPORTED_CATEGORIES} from './categories.mjs';

export const SOURCE_VERSION = "0.1.2";
export const SUPPORTED_CATEGORY=SET_CATEGORY;
export {KNIT_CATEGORY,SUPPORTED_CATEGORIES};
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function digestFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
const imagePattern = /\.(?:png|jpe?g)$/i;

// Inspect the complete input tree before the upstream reader follows any paths.
// A linked material must never escape the product folder or silently disappear.
export async function inputFiles(root) {
  const found = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error("素材库内不接受符号链接：" + path.relative(root, file));
      if (!inside(root, await fs.realpath(file))) throw Error("素材路径超出商品目录");
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) found.push(file);
      else throw Error("素材库内存在非普通文件：" + path.relative(root, file));
    }
  }
  await visit(root);
  return found.sort((a, b) => order(path.relative(root, a), path.relative(root, b)));
}

export async function prepareProduct(productDir) {
  const root = await fs.realpath(productDir);
  if (!(await fs.stat(root)).isDirectory()) throw Error("商品资料不是文件夹");
  const files = await inputFiles(root);
  const data = await readWorkbook(root,files);
  const warnings=[];
  const warn=(field,message)=>warnings.push({code:"PDD_OPTIONAL_SKIPPED",field,message:field+"："+message});
  // The live category uses "pay successfully, ship within N days" for period
  // presales. It has no calendar start/end fields in that mode. Keep the v0.1.2
  // source intact and relax only its irrelevant missing-date issue here.
  const periodPresale = data.service["发货模式"] === "时段预售";
  const errors = data.issues.filter(e => !(periodPresale && e.message === "预售起止日期/时段尚未填写完整"))
    .map(e => ({ code: "PDD_INPUT", field: e.cell, message: `${e.cell}：${e.message}` }));
  const error = (field, message) => errors.push({ code: "PDD_INPUT", field, message: `${field}：${message}` });
  if (periodPresale) {
    const days = /^(\d+)天内发货$/.exec(String(data.service["承诺发货时间/时效"] || ""));
    if (!days || Number(days[1]) < 3 || Number(days[1]) > 30)
      error("服务与承诺 / 承诺发货时间/时效", "当前时段预售须明确填写3～30天内发货，执行时还会核对平台实际选项");
  }
  if (!SUPPORTED_CATEGORIES.includes(data.basic["完整类目路径"]))
    error("基础信息 / 完整类目路径", "当前适配范围为“" + SUPPORTED_CATEGORIES.join('”或“') + "”");
  // Only detect a clear numeric contradiction. This does not infer composition
  // from filenames, certify the evidence, or overwrite either source field.
  const declared = String(data.basic["成分含量"] || "").replace(/\s+/g, "");
  const evidence = String(data.basic["实际成分依据"] || "");
  const percentages = [...evidence.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m => Number(m[1]));
  const range = /^(\d+(?:\.\d+)?)%[（(](含|不含)[）)]-(\d+(?:\.\d+)?)%[（(](含|不含)[）)]$/.exec(declared);
  const exact = /^(\d+(?:\.\d+)?)%$/.exec(declared);
  const above = /^(\d+(?:\.\d+)?)%及以上$/.exec(declared);
  const below = /^(\d+(?:\.\d+)?)%以下$/.exec(declared);
  if (percentages.length === 1 && (range || exact || above || below)) {
    const n = percentages[0];
    const agrees = exact ? n === Number(exact[1]) : above ? n >= Number(above[1]) : below ? n <= Number(below[1]) :
      (range[2] === "含" ? n >= Number(range[1]) : n > Number(range[1])) &&
      (range[4] === "含" ? n <= Number(range[3]) : n < Number(range[3]));
    if (!agrees) error("基础信息 / 成分含量", "成分含量与实际成分依据中的百分比冲突，请核实两处资料后再保存草稿");
  }
  if (!Number.isSafeInteger(data.totalStock)) error("款式与尺码 / 库存", "总库存超过可安全处理的整数范围");
  const discovered=discoverMaterials(root,files);
  const media=structuredClone(discovered);
  const allCandidates=[...new Set(Object.values(discovered).flat())];
  const imageInfo=[];
  for(const [role,list] of Object.entries(media)){
    const valid=[];
    for(const file of list){
      const relative=path.relative(root,file),st=await fs.stat(file),problems=[];
      if(role==='text'){
        if(!/\.txt$/i.test(file))problems.push('不是UTF-8详情文字文件');
      }else if(['video','explanationVideo','detailVideo'].includes(role)){
        if(!/\.(?:mp4|mov|m4v)$/i.test(file))problems.push('不支持的视频扩展名');
      }else if(!imagePattern.test(file))problems.push('不是支持的JPG/PNG图片');
      else{
        try{
          const info=await imageSizeFromFile(file),ext=path.extname(file).toLowerCase();
          if(!((info.type==='png'&&ext==='.png')||(info.type==='jpg'&&['.jpg','.jpeg'].includes(ext))))problems.push('图片真实格式与扩展名不一致');
          if(!info.width||!info.height)problems.push('无法读取有效图片尺寸');
          if(['main','tags'].includes(role)&&(info.width<=480||info.height<=480||!(info.width===info.height||Math.abs(info.width*4-info.height*3)<=4)))problems.push((role==='tags'?'包装标签图':'轮播图')+'宽高须均大于480px，比例为1:1或3:4');
          imageInfo.push({file:relative.split(path.sep).join('/'),width:info.width,height:info.height,type:info.type});
        }catch{problems.push('无法读取图片格式或尺寸，请检查文件是否损坏');}
      }
      if(!st.size)problems.push('文件为空');
      if(['main','tags'].includes(role)&&st.size>=3000000)problems.push('图片需小于3MB');
      if(problems.length){
        for(const problem of problems)if(role==='main')error(relative,problem);else warn(relative,problem+'，此选填素材已跳过');
      }else valid.push(file);
    }
    media[role]=valid;
    if(['size','white','long','video','explanationVideo','detailVideo','text'].includes(role)&&valid.length>1){
      warn(path.relative(root,path.dirname(valid[0])),'发现多份只能使用一份的选填素材，未自动取第一份，此项已跳过');media[role]=[];
    }
  }
  if(!media.main.length||media.main.length>10)error('主图','请提供1～10张合格主图，当前'+media.main.length+'张');
  if(media.tags.length>10){warn('包装标签图','超过平台10张上限，仅使用自然排序前10张');media.tags=media.tags.slice(0,10);}
  const maximumDetails=media.size.length?16:17;
  if(media.details.length>maximumDetails){warn('详情图','固定17张详情规则仅使用自然排序前'+maximumDetails+'张，其余原图保留');media.details=media.details.slice(0,maximumDetails);}
  const mainImageMap={};
  for(const [index,file] of media.main.entries())mainImageMap[String(index+1).padStart(2,'0')]=file;
  const stems=new Map();
  for(const file of media.main){const stem=path.basename(file,path.extname(file));if(stems.has(stem))error('主图','重复主图编号或名称：'+stem);stems.set(stem,file);mainImageMap[stem]=file;mainImageMap[path.basename(file)]=file;}
  let imageOrder=null;
  try{imageOrder=configuredImageOrder(data.basic,media.main,mainImageMap);}catch(e){error('图片设置',e.message);}
  if(!imageOrder&&!media.details.length&&media.main.length)imageOrder={firstRef:path.basename(media.main[0],path.extname(media.main[0])),first:media.main[0],implicit:true};
  const skippedPreviews=new Set();
  for(const sku of data.skus)if(sku.image&&!mainImageMap[sku.image]){
    const key=sku.style+' / '+sku.image;
    if(!skippedPreviews.has(key)){warn('规格预览图',sku.style+'引用的主图'+sku.image+'不存在，此选填预览图已跳过');skippedPreviews.add(key);}
    sku.image=null;
  }
  let detailText=null;
  if(media.text.length===1){
    try{detailText=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readFile(media.text[0])).trim();}
    catch{warn(path.relative(root,media.text[0]),'无法读取UTF-8详情文字，已跳过');media.text=[];}
    if(detailText){warn(path.relative(root,media.text[0]),'当前使用17张图片详情；尚不支持自动填写富文本，文字未上传');detailText=null;}
  }
  const hashes=[];
  for(const file of allCandidates.sort((a,b)=>order(path.relative(root,a),path.relative(root,b)))){
    const st=await fs.stat(file);hashes.push({file:path.relative(root,file).split(path.sep).join('/'),bytes:st.size,sha256:await digestFile(file)});
  }
  const workbook = path.join(root, data.infoPath);
  const workbookSha256 = digest(await fs.readFile(workbook));
  // Formatting changes do not create a different product; frozen bytes still
  // protect edits made after preflight, including a workbook saved mid-run.
  const sorted=values=>Object.fromEntries(Object.entries(values).sort(([a],[b])=>order(a,b)));
  const inputHash = digest(JSON.stringify({ platform: "pdd", sourceVersion: SOURCE_VERSION, adapterPolicy:"data-0.4.11",
    basic: sorted(data.basic), service: sorted(data.service), skus: data.skus, files: hashes }));
  const config = {
    platform: "pdd", draftOnly: true, materialRoot: root,
    product: {
      id: String(data.basic["商品业务标识"] || ""),
      title: String(data.basic["商品标题"] || ""),
      itemCode: String(data.basic["商品货号"] || data.basic["商品业务标识"] || ""),
      categoryPath: data.basic["完整类目路径"],
      mainImages: imageOrder?cycleImages(media.main,imageOrder.first,10):media.main,
      sourceMainImages:media.main, imageOrder,
      mainImageMap, detailImages: media.details, sizeImage: media.size[0] || null,
      whiteBackgroundImage: media.white[0] || null, video: media.video[0] || null, materialTagImages: media.tags,
      longImage: media.long[0] || null, explanationVideo: media.explanationVideo[0] || null,
      detailVideo: media.detailVideo[0] || null, detailText,
    },
    skuMatrix: data.skus,
    pdd: { sourceVersion: SOURCE_VERSION, basic: data.basic, service: data.service, totalStock: data.totalStock },
    input: { infoFile: data.infoFile, infoPath:data.infoPath, workbookSha256, inputHash, files: hashes, imageInfo },
  };
  return { id: digest("pdd|" + config.product.id).slice(0, 24), platform: "pdd", title: config.product.title,
    itemCode: config.product.itemCode, materialRoot: root, ok: errors.length === 0, errors,
    warnings, inputHash, config };
}

export async function validateConfig(config) {
  if (config?.platform !== "pdd" || config.draftOnly !== true) throw Error("拼多多执行仅允许保存草稿");
  const current = await prepareProduct(config.materialRoot);
  if (JSON.stringify(current.config.product) !== JSON.stringify(config.product) ||
      JSON.stringify(current.config.skuMatrix) !== JSON.stringify(config.skuMatrix) ||
      JSON.stringify(current.config.pdd) !== JSON.stringify(config.pdd) ||
      JSON.stringify(current.config.input) !== JSON.stringify(config.input))
    throw Error("商品资料、素材或执行配置已变化，请重新扫描并预检");
  return { ok: current.ok, errors: current.errors, warnings: current.warnings,
    inputHash: current.inputHash, executionHash: executionHash(config) };
}

export async function scanProducts(root) {
  root = await fs.realpath(root);
  const products = [], errors = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const ownFiles=await inputFiles(root);
  const single=workbookCandidates(ownFiles,root).length>0;
  const folders=single?[root]:entries.filter(e=>!e.name.startsWith('.')&&e.isDirectory()).map(e=>path.join(root,e.name)).sort(order);
  for(const folder of folders){
    try{
      const candidates=workbookCandidates(single?ownFiles:await inputFiles(folder),folder);
      if(!candidates.length)continue;
      const product=await prepareProduct(folder);
      if(products.some(p=>p.config.product.id===product.config.product.id))throw Error('商品业务标识重复：'+product.config.product.id);
      products.push(product);
    }catch(e){errors.push({folder,error:e.message});}
  }
  for (const entry of entries.filter(e => e.isSymbolicLink()))
    errors.push({ folder: path.join(root, entry.name), error: "素材库内不接受符号链接" });
  if (!products.length && !errors.length) errors.push({ folder: root, error: "没有找到商品信息Excel；可放商品根目录、商品信息或商品资料目录" });
  // Duplicate identifiers invalidate every instance, including the first folder.
  for (const p of products) if (errors.some(e => e.error === "商品业务标识重复：" + p.config.product.id)) {
    p.ok = false;
    p.errors.push({ code: "PDD_DUPLICATE_ID", field: "商品业务标识", message: "多个商品目录使用了相同的商品业务标识，请修正后重新扫描" });
  }
  return { root, products, errors };
}
