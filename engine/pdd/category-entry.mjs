import { assertFrozenFiles, executionHash } from "./frozen-input.mjs";
import {assertMainUploadSlots} from './upload-slots.mjs';
import {armBatchImageOrder,verifyBatchImageOrder,releaseBatchImageOrder} from './batch-image-order.mjs';

const fileSelector = 'form input[type="file"][data-tracking-click-viewid="local_upload"][multiple]';
const titleSelector = 'form input[placeholder^="商品标题组成"]';
const nextSelector = "#bottomSubmitBtnId";

// The title appears before PDD has initialized the new-product upload context.
// Observe the page's own initialization request; do not send this API ourselves.
export async function waitForEntryReady(driver, { timeout = 45000, quietMs = 2000 } = {}) {
  const started = Date.now();
  let lastLog = 0;
  for (;;) {
    await driver.guard();
    const state = await driver.read(({fileSelector,titleSelector,nextSelector}) => {
      const initialization = performance.getEntriesByType('resource').filter(r => {
        try {const u = new URL(r.name);return u.origin === location.origin && u.pathname === '/glide/v2/mms/query/commit/detail';} catch {return false;}
      }).at(-1);
      return {loaded:document.readyState === 'complete',
        controls:document.querySelectorAll(fileSelector).length === 1 && document.querySelectorAll(titleSelector).length === 1 && document.querySelectorAll(nextSelector).length === 1,
        initialization:initialization ? {status:initialization.responseStatus,settledFor:performance.now()-initialization.responseEnd} : null};
    }, {fileSelector,titleSelector,nextSelector});
    if (state.initialization?.status >= 400) throw Error('平台新商品初始化失败（'+state.initialization.status+'），尚未上传图片');
    if (state.loaded && state.controls && state.initialization &&
        (!state.initialization.status || state.initialization.status === 200) && state.initialization.settledFor >= quietMs) return state;
    if (Date.now()-lastLog >= 10000) {
      await driver.onEvent({type:'log',text:'正在等待新商品页面初始化，尚未上传图片'});lastLog=Date.now();
    }
    if (Date.now()-started >= timeout) throw Error('新商品页面初始化未就绪，尚未上传图片；请检查原页面');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
}

export async function inspectEntry(driver) {
  await driver.guard();
  return driver.read(({ fileSelector, titleSelector, nextSelector }) => {
    const form = document.querySelector("form");
    const text = form?.innerText || "";
    const match = text.replace(/\s+/g, "").match(/\((\d+)\/10\)/);
    const slots = [...(form?.querySelectorAll('[class*="MaterialModalButton_v2_imageBox"]') || [])];
    const uploaded = slots
      .filter(e => e.getClientRects().length > 0)
      .map(e => e.style.backgroundImage)
      .filter(s => /https:\/\/(?:pfs\.pinduoduo\.com\/|img\.pddpic\.com\/(?:mms-goods-image|mms-material-img|goods\/images)\/)/.test(s));
    return { title: document.querySelector(titleSelector)?.value ?? null,
      files: document.querySelectorAll(fileSelector).length,
      next: document.querySelectorAll(nextSelector).length,
      // The upload button and its counter disappear when all ten slots are full.
      count: match ? Number(match[1]) : slots.length, slots: slots.length, uploaded, text,
      pending: /上传中|正在上传|处理中|\d+%/.test(text),
      error: /上传失败|图片格式不支持|上传出错|尺寸不符合|图片大小超出/.test(text) };
  }, { fileSelector, titleSelector, nextSelector });
}

// Inspection mode is only for staged development requested by the user. It
// cannot enable saving. The normal execution path always requires full input.
export async function fillEntry(driver, config, { inspectionOnly = false, validation,uploadFiles } = {}) {
  if (driver.saveEnabled) throw Error("入口填写时不应开放保存门禁");
  await assertFrozenFiles(config);
  if (!validation || validation.inputHash !== config.input.inputHash ||
      validation.executionHash !== executionHash(config) || !Array.isArray(validation.errors))
    throw Error("缺少与冻结输入对应的本地预检结果");
  if (!inspectionOnly) {
    if (validation.ok !== true || validation.errors.length) throw Error(validation.errors.map(e => e.message).join("\n"));
  } else {
    const invalid = validation.errors.filter(e => /主图|商品标题|完整类目路径|商品业务标识|适用平台/.test(e.field));
    if (invalid.length) throw Error(invalid.map(e => e.message).join("\n"));
  }
  if (driver.kind === 'ego') await driver.step('等待商品上传入口就绪',()=>waitForEntryReady(driver));
  const initial = await inspectEntry(driver);
  if (initial.files !== 1 || initial.next !== 1 || initial.title !== "" || initial.count !== 0)
    throw Error("入口不是已核对的空白表单，不能重复上传或覆盖未知页面");
  let imageOrder;
  await driver.step("批量上传商品主图", async () => {
    if(uploadFiles)await assertMainUploadSlots(config,uploadFiles);
    const order=await armBatchImageOrder(driver,fileSelector,uploadFiles||config.product.mainImages);
    await driver.setFiles(fileSelector, uploadFiles||config.product.mainImages);
    const state=await waitForMainImages(driver, config.product.mainImages.length);
    imageOrder=await verifyBatchImageOrder(driver,order,state.uploaded.map(raw=>raw.match(/^url\(["']?(.*?)["']?\)$/)?.[1]));
    await releaseBatchImageOrder(driver,order);
  });
  await fillUploadedEntryTitle(driver, config);
  return { ...await inspectEntry(driver), imageOrder, inspectionOnly, fullInputReady: validation.ok,
    remainingInputErrors: validation.errors, saveEnabled: false };
}

export async function waitForMainImages(driver, expected, { timeout = 120000, interval = 1000, stableMs = 1000 } = {}) {
  const started = Date.now();
  let lastProgress = "", lastLog = 0, stable = "", stableSince = 0;
  for (;;) {
    // Each observation also checks login, exact shop and security prompts.
    const state = await inspectEntry(driver);
    if (state.error) throw Error("平台显示主图上传失败，请检查原页面；未自动重传");
    if (state.slots > expected || state.count > expected) throw Error("主图数量超过本次计划，停止以免混入其他图片");
    const progress = state.uploaded.length + "/" + expected;
    if (progress !== lastProgress || Date.now() - lastLog >= 10000) {
      await driver.onEvent({ type: "log", text: "主图上传：已完成 " + progress + "，已等待 " + Math.round((Date.now() - started) / 1000) + " 秒" });
      lastProgress = progress; lastLog = Date.now();
    }
    const ready = state.count === expected && state.slots === expected && state.uploaded.length === expected && !state.pending;
    const signature = ready ? JSON.stringify(state.uploaded) : "";
    if (signature !== stable) { stable = signature; stableSince = Date.now(); }
    if (ready && Date.now() - stableSince >= stableMs) return state;
    if (Date.now() - started >= timeout) throw Error("主图上传未完成（服务端预览 " + progress + "，等待 " + Math.round(timeout / 1000) + " 秒）；已保留现场，未自动重传");
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// A separate stage lets development continue after an upload observation timeout
// without submitting the same files again. It never enables saving or replaces
// an existing different title; production callers still start with fillEntry.
export async function fillUploadedEntryTitle(driver, config) {
  if (driver.saveEnabled) throw Error("入口填写时不应开放保存门禁");
  await assertFrozenFiles(config);
  const state = await inspectEntry(driver);
  if (state.count !== config.product.mainImages.length || state.uploaded.length !== state.count)
    throw Error("主图数量或服务端预览未就绪，不能填写标题");
  if (state.title && state.title !== config.product.title) throw Error("已有其他商品标题，不能覆盖未知页面");
  if (!state.title) await driver.step("填写商品标题", () => driver.fill(titleSelector, config.product.title));
  return inspectEntry(driver);
}

export async function requestCategory(driver) {
  const current = await inspectEntry(driver);
  if (!current.title || !current.count || current.uploaded.length < current.count)
    throw Error("主图或标题未完成，不能进入类目选择");
  await driver.click(nextSelector, { label: "进入商品类目选择" });
  await driver.wait(() => document.querySelectorAll('[class*="cateItemCard_chooseCategory"]').length > 0 ||
    document.body.innerText.includes("手动选择类目"), undefined, 45000);
  return driver.read(() => ({ url: location.href,
    cards: [...document.querySelectorAll('[class*="cateItemCard_chooseCategory"]')].map((e, i) => ({ index: i, text: e.innerText })) }));
}

export async function selectRecommendedCategory(driver, categoryPath) {
  const normalize = s => String(s).trim().replace(/\s*>\s*/g, " > ");
  const wanted = normalize(categoryPath);
  const editingSelection=async()=>{
    await driver.guard();
    return driver.read(want=>({editing:/\/goods\/goods_add(?:\/|$)/.test(location.pathname),selected:[...document.querySelectorAll('form span,form div')].some(e=>e.getClientRects().length&&e.innerText.trim().replace(/\s*>\s*/g,' > ')===want)}),wanted);
  };
  const initial=await editingSelection();
  if(initial.editing){if(!initial.selected)throw Error('自动进入的编辑页实际类目与商品表不符');return wanted;}
  const readCards=()=>driver.read(() => [...document.querySelectorAll('form [class*="cateItemCard_chooseCategory"]')]
    .map(e => ({ text: e.innerText.trim(), params: e.getAttribute("data-tracking-params") })));
  let cards=await readCards();
  if(!cards.some(c=>normalize(c.text)===wanted)){
    const more=await driver.read(()=>{
      const matches=[...document.querySelectorAll('form button')].filter(e=>e.innerText.trim()==='查看更多推荐');if(matches.length!==1)return null;
      const parts=[];for(let e=matches[0];e&&e!==document.documentElement;e=e.parentElement){const same=[...e.parentElement.children].filter(s=>s.tagName===e.tagName);parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+(same.indexOf(e)+1)+')');}return'html > '+parts.join(' > ');
    });
    if(more){
      await driver.click(more,{label:'展开当前商品更多类目推荐'});
      await driver.wait(count=>document.querySelectorAll('form [class*="cateItemCard_chooseCategory"]').length>count,cards.length,10000);cards=await readCards();
    }
  }
  const matches = cards.filter(c => normalize(c.text) === wanted);
  if (matches.length !== 1 || !matches[0].params) throw Error("没有唯一的完整类目推荐，需单独适配手动类目选择");
  const attr = matches[0].params.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (/[\r\n\0]/.test(attr)) throw Error("类目控件属性无效");
  // cate_list analytics may change after recommendations settle. The selected
  // category ID is stable; exact visible text still guards the native click.
  const id=new URLSearchParams(matches[0].params).get('choosen_cate'),base='form [data-tracking-viewid="choose_cate"]';
  const selector=/^\d+$/.test(id||'')?base+'[data-tracking-params$="choosen_cate='+id+'"],'+base+'[data-tracking-params*="choosen_cate='+id+'&"]':base+'[data-tracking-params="'+attr+'"]';
  try{await driver.click(selector,{label:'选择完整商品类目',expectedText:matches[0].text});}
  catch(error){
    // Ego can report the old target gone after PDD already advanced. Do not
    // click again: accept only the actual editing URL and exact category.
    if(!/matched 0 elements/.test(error.message))throw error;
    const state=await editingSelection();if(!state.editing||!state.selected)throw error;
    return wanted;
  }
  await driver.wait(want => {
    if (/\/goods\/goods_add(?:\/|$)/.test(location.pathname)) return [...document.querySelectorAll('form span,form div')].some(e=>
      e.getClientRects().length && e.innerText.trim().replace(/\s*>\s*/g,' > ')===want);
    const checked = [...document.querySelectorAll('form [class*="cateItemCard_chooseCategory"][class*="cateItemCard_checked"]')];
    return checked.length === 1 && checked[0].innerText.trim().replace(/\s*>\s*/g, " > ") === want;
  }, wanted, 10000);
  return wanted;
}

export async function openSelectedCategory(driver, categoryPath) {
  const selected = await selectRecommendedCategory(driver, categoryPath);
  const stage = await driver.read(() => ({editing:/\/goods\/goods_add(?:\/|$)/.test(location.pathname)}));
  if (!stage.editing) {
    try { await driver.click(nextSelector, { label: "进入已选类目编辑页" }); }
    catch (error) {
      // Some PDD versions advance after choosing the recommendation. A missing
      // old Next button is acceptable only after the edit navigation occurred.
      const editing = await driver.read(()=>/\/goods\/goods_add(?:\/|$)/.test(location.pathname));
      if (!editing || !/matched 0 elements/.test(error.message)) throw error;
    }
  }
  await driver.wait(() => /\/goods\/goods_add(?:\/|$)/.test(location.pathname), undefined, 45000);
  await driver.wait(wanted => [...document.querySelectorAll('form span,form div')].some(e=>
    e.getClientRects().length && e.innerText.trim().replace(/\s*>\s*/g,' > ')===wanted), selected, 20000);
  return { selectedCategory: selected, url: await driver.page.url() };
}
