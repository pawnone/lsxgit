// Upload stages for run-full v2.1. Developed locally before App synchronization.
// Native file inputs only; existing media requires a matching persisted receipt.
import path from "node:path";
import fs from 'node:fs/promises';
import { assertFrozenFiles, executionHash } from "./frozen-input.mjs";
import { pricingState } from "./pricing.mjs";
import {cycleImages} from './image-order.mjs';
import {assertUploadSlots,stageMediaUploadSlots} from './upload-slots.mjs';
import {armBatchImageOrder,verifyBatchImageSelection,verifyBatchImageOrder,releaseBatchImageOrder} from './batch-image-order.mjs';

const fields = {
  details: { root: '[class*="quick_decoration_v2_sortableWrapper"]', tracking: "detail_img_localfile_upload",
    previews: 'img[data-tracking-click-viewid="el_preview_business_details"]', limit: 50 },
  tags: { root: '[id="basic.pack_label_image"]', tracking: "upload_image_label",
    previews: '[class*="MaterialModalButton_v2_imageBox"]', limit: 10 },
  video: { root: '[id="basic.carousel_video"]', tracking: "merchandise_video_localfile_upload",
    previews: '.video-cards img.card-img', limit: 1 },
  white: { root: '[data-tracking-impr-viewid="upload_white_bg_img"]', tracking: "white_bg_img_localfile_upload",
    previews: '[class*="MaterialModalButton_v2_imageBox"]', limit: 1 },
  long: { tracking: "long_img_localfile_upload", previews: '[class*="MaterialModalButton_v2_imageBox"]', limit: 1 },
  explanationVideo: { root: '[id="basic.explanation_video"]', tracking: "intro_video_localfile_upload",
    previews: '.video-cards img.card-img', limit: 1 },
  detailVideo: { root: '[id="basic.detail_video"]', tracking: "detail_video_localfile_upload",
    previews: '.video-cards img.card-img', limit: 1 },
};
const fileInput = tracking => 'input[type="file"][data-tracking-click-viewid="' + tracking + '"]';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const mediaName = kind => ({details:'详情图',tags:'包装标签图',video:'商品视频',white:'白底图',long:'长图',explanationVideo:'讲解视频',detailVideo:'详情视频',style:'款式图'}[kind] || '素材');

export async function assertMediaTarget(driver, config, validation) {
  if (driver.saveEnabled || config.platform !== "pdd" || config.draftOnly !== true)
    throw Error("素材分段检查不能开放保存或发布");
  if (!validation || validation.inputHash !== config.input.inputHash || validation.executionHash !== executionHash(config))
    throw Error("素材执行配置与预检不一致");
  await assertFrozenFiles(config);
  await driver.guard();
  const target = await driver.read(() => {
    const row = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter(e =>
      e.querySelector('[class*="Form_itemLabelContent"]')?.innerText.trim().replace(/^[*\s]+/, "") === "商品标题");
    return { url: location.href, titles: row.flatMap(e => [...e.querySelectorAll('input[type="text"]')].map(i => i.value)) };
  });
  if (!/\/goods\/goods_add(?:\/|$)/.test(new URL(target.url).pathname) ||
      target.titles.length !== 1 || target.titles[0] !== config.product.title)
    throw Error("不是本次商品的唯一编辑页，不能上传到其他商品");
  return target;
}

export async function mediaDescriptor(driver, kind, style) {
  const field = fields[kind];
  if (!field && kind !== "style") throw Error("未知素材区域");
  await driver.guard();
  return driver.read(({ kind, field, style }) => {
    const cssPath = node => {
      const parts = [];
      for (let e = node; e && e !== document.documentElement; e = e.parentElement) {
        const siblings = [...e.parentElement.children].filter(p => p.tagName === e.tagName);
        parts.unshift(e.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")");
      }
      return "html > " + parts.join(" > ");
    };
    let roots;
    if (kind === "style") roots = [...document.querySelectorAll('#newSpec .new-spec-single-color')].filter(e =>
      e.querySelector('input[placeholder="选择或输入主色"]')?.value === style.name &&
      e.querySelector('input[placeholder*="备注"]')?.value === style.note);
    else if (field.root) roots = [...document.querySelectorAll(field.root)];
    else roots = [...document.querySelectorAll('input[type="file"][data-tracking-click-viewid="' + field.tracking + '"]')]
      .map(e => e.closest('[class*="MaterialModalButton_v2_materialContainer"]')).filter(Boolean);
    if (roots.length !== 1) throw Error("没有唯一的素材区域：" + kind);
    const root = roots[0];
    const inputs = [...root.querySelectorAll('input[type="file"]')].filter(e => kind === "style" ||
      e.getAttribute("data-tracking-click-viewid") === field.tracking);
    return { kind, target: kind === "style" ? { style: style.name, note: style.note } : kind,
      root: field?.root || cssPath(root), file: inputs.length === 1 ?
        (kind==='details'?field.root+' input[type="file"][data-tracking-click-viewid="'+field.tracking+'"]':cssPath(inputs[0])) : null,
      previews: kind === "style" ? '[class*="MaterialModalButton_imgContainer"]' : field.previews,
      limit: kind === "style" ? 1 : field.limit };
  }, { kind, field: field || null, style: style || null });
}

// This function is serializable to either browser implementation. Selectors are
// scoped to the observed upload area, never all images or videos on the page.
export function readMediaDom(d) {
  const roots = document.querySelectorAll(d.root);
  if (roots.length !== 1) throw Error("素材区域结构已变化");
  const root = roots[0], text = root.innerText || "";
  const serverUrl = raw => {
    try {
      const u = new URL(raw);
      // Platform loading placeholders are also hosted on pddpic.com. They are
      // not uploaded product media and can briefly replace a finished preview.
      const storage = u.hostname === "pfs.pinduoduo.com" || u.hostname === "img.pddpic.com" &&
        /^\/(?:mms-goods-image|mms-material-img|goods\/images)\//.test(u.pathname);
      return u.protocol === "https:" && storage
        ? u.origin + u.pathname : null;
    } catch { return null; }
  };
  const slots = [...root.querySelectorAll(d.previews)].map(e => {
    const raw = e.tagName === "IMG" ? e.getAttribute("src") :
      (e.style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1] || e.querySelector("img")?.getAttribute("src"));
    return { url: serverUrl(raw), loaded: e.tagName !== "IMG" || e.complete && e.naturalWidth > 0 };
  });
  const count = text.replace(/\s+/g, "").match(/已上传(\d+)\/(?:10|50)张/);
  const errorPattern=/上传失败|上传出错|格式不支持|超过.*限制|尺寸.*(?:错误|不符|不支持)|宽高.*(?:错误|不符)|图片.*(?:过大|过小)/;
  const errorText=[...new Set([...text.split('\n').filter(line=>errorPattern.test(line)),
    ...[...root.querySelectorAll('.video-card-error')].map(e=>e.innerText.trim()).filter(Boolean)])].join('；').slice(0,500);
  return { urls: slots.map(s => s.url), slots: slots.length, loaded: slots.every(s => s.loaded),
    count: count ? Number(count[1]) : null,
    pending: /上传中|正在上传|处理中|转码中|\d+%/.test(text),
    error: !!errorText,errorText };
}

export async function mediaState(driver, descriptor) {
  await driver.guard();
  return driver.read(readMediaDom, descriptor);
}

function assertReady(state, expected) {
  if (state.error || state.pending || !state.loaded || state.slots !== expected ||
      state.urls.some(u => !u) || state.count !== null && state.count !== expected)
    throw Error("素材数量、服务端预览或完成状态不一致");
}

// Before dispatch is persisted by the caller. On a timeout or crash the intent
// remains pending, so reruns inspect evidence instead of uploading again.
export async function beginUploadOne(driver, { config, validation, descriptor, files, uploadFiles=files, receipt, previous, persist, timeout = 120000 }) {
  const target = await assertMediaTarget(driver, config, validation);
  if (!files.length || files.length > descriptor.limit || !persist) throw Error("素材数量或记录接口无效");
  const relative = files.map(file => path.relative(config.materialRoot, file).split(path.sep).join("/"));
  const records = relative.map(file => {
    const matches = config.input.files.filter(r => r.file === file);
    if (matches.length !== 1) throw Error("上传文件不在冻结输入中");
    return { file, sha256: matches[0].sha256 };
  });
  const identity = { inputHash: config.input.inputHash, executionHash: executionHash(config), url: target.url,
    kind: descriptor.kind, target: descriptor.target, files: records };
  const before = await mediaState(driver, descriptor);
  if (receipt) {
    if (!same(receipt.identity, identity)) throw Error("素材回执属于其他页面或输入");
    if (receipt.status !== "confirmed") throw Error("先前素材上传结果未确认，禁止自动重传");
    assertReady(before, files.length);
    if (!same(before.urls, receipt.urls)) throw Error("页面素材与原上传回执不同");
    return {wait:async()=>receipt,probe:async()=>{}};
  }
  let offset = 0;
  if (previous) {
    offset = previous.identity?.files?.length;
    const preceding = { ...identity, files: records.slice(0, offset) };
    if (previous.status !== "confirmed" || !offset || offset >= files.length || !same(previous.identity, preceding))
      throw Error("缺少同页、同输入的前序上传确认记录");
    assertReady(before, offset);
    if (!same(before.urls, previous.urls)) throw Error("前序素材或顺序已被改变");
  } else if (before.slots || before.count || before.pending || before.error)
    throw Error("页面已有未知素材或上传状态，不能覆盖或追加");
  if (!descriptor.file) throw Error("缺少唯一的本地上传输入");
  const pending = { identity, descriptor, status: "pending", startedAt: new Date().toISOString(),
    before, previous: previous || null };
  await assertUploadSlots(config,files,uploadFiles);
  await persist(pending);
  const images=files.every(f=>/\.(?:png|jpe?g)$/i.test(f));
  const order=images?await armBatchImageOrder(driver,descriptor.file,uploadFiles.slice(offset)):null;
  if(order){pending.uploadFiles=order.files;await persist(pending);}
  await driver.setFiles(descriptor.file, uploadFiles.slice(offset));
  if(order){
    try{pending.selection=await verifyBatchImageSelection(driver,order);await persist(pending);}
    catch(error){await persist({...pending,selection:error.selection||null,selectionError:error.message});throw Error(mediaName(descriptor.kind)+'未能确认本次文件选择事件或文件可读性；结果未确认，不自动重传。'+error.message);}
    await driver.onEvent({type:'log',text:mediaName(descriptor.kind)+'本次文件已读取：'+pending.selection.files.map((f,i)=>f.name+' '+pending.selection.images[i].width+'×'+pending.selection.images[i].height+' '+f.bytes+'字节').join('；')});
  }
  if(images)await driver.onEvent({type:'log',text:mediaName(descriptor.kind)+'已一次选入'+(files.length-offset)+'张，等待平台处理'});
  const deadline = Date.now() + timeout;
  let after, stableUrls = null, stableSince = 0, lastLog = Date.now(),lastProbe=0,failureSince=0;
  const uploadObservations=[];
  const track=state=>{
    try{assertReady(state,files.length);}catch{stableUrls=null;stableSince=0;return;}
    const signature=JSON.stringify(state.urls);
    if(signature!==stableUrls){stableUrls=signature;stableSince=Date.now();}
  };
  const failUpload=async state=>{
    await persist({...pending,failure:{at:new Date().toISOString(),state}});
    throw Error(mediaName(descriptor.kind)+'上传失败：'+(state.errorText||'平台返回上传错误')+'；保留现场，不自动重传');
  };
  const observeUploadError=async state=>{
    if(!state.error){failureSince=0;return;}
    // PDD briefly labels all newly reserved detail slots 上传失败 before the
    // same native batch supplies its server previews. Observe that batch only;
    // no file selection, retry or later form action is dispatched here.
    if(!images||/格式不支持|超过.*限制|尺寸.*(?:错误|不符|不支持)|宽高.*(?:错误|不符)|图片.*(?:过大|过小)/.test(state.errorText||''))await failUpload(state);
    if(!failureSince){
      failureSince=Date.now();uploadObservations.push({at:new Date().toISOString(),state});
      await persist({...pending,uploadObservations});
      await driver.onEvent({type:'log',text:mediaName(descriptor.kind)+'暂显示“'+(state.errorText||'上传错误')+'”，核对本次上传是否完成，最多观察10秒，不会重传'});
    }
    if(Date.now()-failureSince>=10000)await failUpload(state);
  };
  const probe=async()=>{
    if(Date.now()-lastProbe<750)return;lastProbe=Date.now();
    const state=await driver.read(readMediaDom,descriptor);
    await observeUploadError(state);
    if(state.slots>files.length)throw Error('上传区域出现超出本次计划的素材');
    track(state);
    if(Date.now()>=deadline&&!stableUrls)throw Error('素材上传超时，结果未确认；禁止自动重传');
  };
  return {probe,wait:async()=>{
  do {
    after = await mediaState(driver, descriptor);
    await observeUploadError(after);
    if (Date.now() - lastLog >= 10000) {
      await persist({...pending,observation:{at:new Date().toISOString(),state:after}});
      await driver.onEvent({type:'log',text:mediaName(descriptor.kind)+(pending.selection?'已收到本次'+pending.selection.count+'张文件；':'')+'平台已显示 '+after.urls.filter(Boolean).length+'/'+files.length+(after.slots||after.pending?'，等待平台处理':'，尚未观察到平台上传进度，不会重复选择文件')});
      lastLog = Date.now();
    }
    let ready = false;
    try { assertReady(after, files.length); ready = true; } catch { /* Wait for this submission, never submit again. */ }
    if (ready) {
      const signature = JSON.stringify(after.urls);
      if (signature !== stableUrls) { stableUrls = signature; stableSince = Date.now(); }
      // The image widget may first display a valid temporary server preview,
      // then commit its final URL on the next render. Require stable readback.
      if (Date.now() - stableSince >= 1500) {
        if (previous && !same(after.urls.slice(0, offset), previous.urls))
          throw Error("追加上传改变了已确认的图片顺序");
        break;
      }
    } else { stableUrls = null; stableSince = 0; }
    if (Date.now() >= deadline) throw Error("素材上传超时，结果未确认；禁止自动重传");
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (true);
  const confirmed = { ...pending, status: "confirmed", confirmedAt: new Date().toISOString(), urls: after.urls,
    stableWindowMs: Date.now() - stableSince,uploadObservations:[...(previous?.uploadObservations||[]),...uploadObservations] };
  if(order){
    try{confirmed.imageOrder=[...(previous?.imageOrder||[]),...(await verifyBatchImageOrder(driver,order,after.urls.slice(offset))).map(r=>({...r,slot:r.slot+offset}))];await releaseBatchImageOrder(driver,order);}
    catch(error){await persist({...pending,urls:after.urls,orderError:error.message,imageOrder:error.imageOrder||[]});throw error;}
  }
  await persist(confirmed);
  await driver.onEvent({ type: "media-confirmed", kind: descriptor.kind, count: files.length });
  return confirmed;
  }};
}

export async function uploadOne(driver,options){return (await beginUploadOne(driver,options)).wait();}

export async function beginMediaPlan(driver, { config, validation, plan, receipt, persist, timeout, cacheDir }) {
  assertPlanInput(plan, config, validation);
  let current = receipt;
  if (current && current.status !== "confirmed") throw Error("先前上传结果未确认，需先检查现场，禁止重传");
  const target = plan.kind === "style" ? { style: plan.style.name, note: plan.style.note } : plan.kind;
  if (current && !same(current.identity.target, target)) throw Error("素材回执不属于当前款式或素材区域");
  let descriptor = await mediaDescriptor(driver, plan.kind, plan.style);
  if (descriptor.kind !== plan.kind || !same(descriptor.target, target)) throw Error("素材控件目标与上传计划不同");
  const count = current?.identity.files.length || 0;
  if (count > plan.files.length) throw Error("已有上传记录超出当前素材计划");
  if (count) {
    await uploadOne(driver, { config, validation, descriptor, files: plan.files.slice(0, count), receipt: current, persist, timeout });
    if (count === plan.files.length) return {wait:async()=>current,probe:async()=>{}};
  }
  // One native multi-select per batch. Slot filenames preserve size/first order
  // and keep intentionally repeated images from being collapsed by FileList.
  let uploadFiles=plan.files,temporary;
  await assertMediaTarget(driver,config,validation);
  if(plan.files.length>1&&plan.files.every(f=>/\.(?:png|jpe?g)$/i.test(f))){
    const staged=await stageMediaUploadSlots(config,plan.files,cacheDir);uploadFiles=staged.files;temporary=staged.temporary;
    await driver.onEvent({type:'log',text:mediaName(plan.kind)+'上传临时文件已准备：'+path.dirname(uploadFiles[0])+'，最长路径'+Math.max(...uploadFiles.map(f=>f.length))+'字符；原图内容与尺寸不变'});
  }
  // Bound detail batches for browser compatibility; never replay an uncertain batch.
  const batchSize=plan.kind==='details'?5:plan.files.length;
  let end=Math.min(count+batchSize,plan.files.length);
  const start=()=>beginUploadOne(driver,{config,validation,descriptor,files:plan.files.slice(0,end),uploadFiles:uploadFiles.slice(0,end),previous:current,persist,timeout});
  let started=await start();
  return {probe:()=>started.probe(),wait:async()=>{
    let result;
    while(true){
      result=await started.wait();
      await driver.onEvent({type:'log',text:mediaName(plan.kind)+'平台已确认 '+end+'/'+plan.files.length+'；本批数量、内容及顺序通过'});
      if(end===plan.files.length)break;
      current=result;end=Math.min(end+batchSize,plan.files.length);
      descriptor=await mediaDescriptor(driver,plan.kind,plan.style);started=await start();
    }
    if(temporary)await fs.rm(temporary,{recursive:true,force:true});
    await driver.onEvent({type:'log',text:mediaName(plan.kind)+'批量上传完成：'+plan.files.length+'/'+plan.files.length});return result;
  }};
}
export async function uploadMediaPlan(driver,options){return (await beginMediaPlan(driver,options)).wait();}

// Build upload slots without changing source files or deduplicating intentional repeats.
export function detailImagePlan(product) {
  const size = product.sizeImage;
  if(product.imageOrder){
    const sources=product.sourceMainImages.filter(f=>!size||path.resolve(f)!==path.resolve(size));
    return [...(size?[size]:[]),...cycleImages(sources,product.imageOrder.first,size?16:17)];
  }
  const sameSize = file => size && path.resolve(file) === path.resolve(size);
  const details = (product.detailImages || []).filter(file => !sameSize(file));
  const max=size?16:17;
  if (details.length > max) throw Error("详情图超过"+max+"张，请先选择要保留的图片，不能自动丢弃");
  const files = [...(size?[size]:[]), ...details];
  const main = (product.mainImages || []).filter(file => !sameSize(file));
  if (files.length < 17 && !main.length) throw Error("详情不足17张，主图目录没有可用于补齐的图片");
  for (let index = 0; files.length < 17; index++) files.push(main[index % main.length]);
  return files;
}

export function mediaPlan(config) {
  const p = config.product, plans = [];
  if (p.detailText) throw Error("详情文字需要单独的富文本适配，不能静默丢弃");
  plans.push({ key: "details", kind: "details", files: detailImagePlan(p), ordered: true });
  if (p.whiteBackgroundImage) plans.push({ key: "white", kind: "white", files: [p.whiteBackgroundImage] });
  if (p.materialTagImages?.length) plans.push({ key: "tags", kind: "tags", files: p.materialTagImages });
  if (p.video) plans.push({ key: "video", kind: "video", files: [p.video] });
  for (const [key, file] of [["long", p.longImage], ["explanationVideo", p.explanationVideo], ["detailVideo", p.detailVideo]])
    if (file) plans.push({ key, kind: key, files: [file] });
  const styles = [...new Set(config.skuMatrix.map(s => s.style))];
  for (const name of styles) {
    const rows = config.skuMatrix.filter(s => s.style === name);
    const notes = [...new Set(rows.map(s => s.styleNote || ""))], images = [...new Set(rows.map(s => s.image).filter(Boolean))];
    if(!images.length)continue; // SKU preview images are optional too.
    if (notes.length !== 1 || images.length !== 1) throw Error("同款式预览图或备注不一致");
    const mapped=p.mainImageMap?.[images[0]];
    const files = mapped?[mapped]:p.mainImages.filter(f => path.basename(f, path.extname(f)) === String(images[0]).padStart(2, "0"));
    if (files.length !== 1) throw Error("款式主图编号没有唯一文件");
    plans.push({ key: "style:" + name, kind: "style", style: { name, note: notes[0] }, files });
  }
  return plans;
}

export function assertPlanInput(plan, config, validation) {
  const rel = plan.files.map(f => path.relative(config.materialRoot, f).split(path.sep).join("/"));
  const errors = validation.errors.filter(e => rel.includes(e.field) ||
    plan.kind === "details" && /详情|尺码图/.test(e.field) || plan.kind === "tags" && e.field === "商品标签");
  if (errors.length) throw Error(errors.map(e => e.message).join("\n"));
  // Even staged inspection does not bypass the actual packaging image limits.
  if (plan.kind === "tags") for (const file of rel) {
    const info = config.input.imageInfo.find(i => i.file === file);
    const record = config.input.files.find(i => i.file === file);
    if (!info || !record || record.bytes >= 3000000 || info.width <= 480 || info.height <= 480 ||
        !(info.width === info.height || Math.abs(info.width * 4 - info.height * 3) <= 4))
      throw Error("包装标签图不符合页面要求：" + file);
  }
}

export async function verifySkuPreviewImages(driver, config, receipts) {
  const expected = new Map(receipts.filter(r => r.key.startsWith("style:")).map(r => [r.key.slice(6), r.urls?.[0]]));
  if(!expected.size)return [];
  const rows = (await pricingState(driver, config.skuMatrix)).filter(r=>expected.has(r.style));
  const actual = await driver.read(records => records.map(r => {
    const inputs = document.querySelectorAll(r.selector);
    if (inputs.length !== 1) throw Error("SKU预览行关联已变化");
    const cells = inputs[0].closest("tr").querySelectorAll('.sku-preview-cell [class*="MaterialModalButton_imgContainer"]');
    if (cells.length !== 1) throw Error("SKU没有唯一预览图");
    const raw = cells[0].style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    const u = new URL(raw);
    return { style: r.style, size: r.size, url: u.origin + u.pathname };
  }), rows.map(r => ({ style: r.style, size: r.size, selector: r.values.stock.selector })));
  for (const row of actual) if (!expected.has(row.style) || expected.get(row.style) !== row.url)
    throw Error("SKU预览图与本次款式图片回执不同：" + row.style + " / " + row.size);
  return actual;
}
