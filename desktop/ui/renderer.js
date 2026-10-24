/* Native renderer: all operations use a narrow preload API; no Node or shell access. */
const api = window.wqapp;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const ico = (n) => `<img src="assets/icons/${n}.svg" alt="">`;
const btn = (label, act, kind = "", extra = "", icon) =>
  `<button class="button ${kind}" data-act="${act}" ${extra}>${icon ? ico(icon) : ""}${label}</button>`;
const badge = (text, color = "gray") =>
  `<span class="badge ${color}">${text}</span>`;
let S = null,
  page = "workbench",
  platform = "dou",
  pending = false,
  error = "",
  toastTimer,
  dialogTask = null;
let renderedPage = null, logDialogRunId = null, imageDialog = null, overlayFocus = null, bodyOverflow = '';
const selectedShops = () =>
  S.config.shops.filter(
    (s) => s.platform === platform && S.config.selectedShopIds.includes(s.id),
  );
const selectedProducts = () =>
  S.products.filter((p) => S.config.selectedProductIds.includes(p.id));
const running = () =>
  S.run && ["running", "pausing", "paused"].includes(S.run.status);
const countTasks = () => selectedShops().length * selectedProducts().length;
const statuses = {
  queued: "等待",
  ready: "待执行",
  running: "正在执行",
  confirmed: "已保存草稿",
  "already-saved": "本机曾保存（跳过）",
  "recreate-ready": "本次重新创建",
  "needs-review": "结果待核实",
  failed: "失败",
  "safety-blocked": "安全停止",
  "not-run": "未执行",
  stopped: "已停止",
  complete: "本批完成",
  'complete-with-errors': '本批结束 · 有失败商品',
  paused: "已安全暂停",
  pausing: "当前商品结束后暂停",
};
function toast(s) {
  clearTimeout(toastTimer);
  const t = document.querySelector("#toast");
  t.textContent = s;
  t.classList.add("show");
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}
function receive(s) {
  S = s;
  render();
  if (logDialogRunId) {
    const run = S.run?.id === logDialogRunId ? S.run : S.history.find(r => r.id === logDialogRunId);
    const box = document.querySelector('#full-run-log');
    if (run && box) {
      const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40, top = box.scrollTop;
      box.innerHTML = logRows(run, true);
      box.scrollTop = bottom ? box.scrollHeight : top;
    }
  }
}
async function call(method, ...args) {
  if (pending) return;
  pending = true;
  error = "";
  clearTimeout(toastTimer);
  document.querySelector('#toast').classList.remove('show');
  document.querySelector("#busy-cover").hidden = false;
  try {
    const r = await api[method](...args);
    if (r?.config) S = r;
    return r;
  } catch (e) {
    error = e.message;
    toast(e.message);
    throw e;
  } finally {
    pending = false;
    document.querySelector("#busy-cover").hidden = true;
    if (S) render();
  }
}
function heading(title, sub, action = "help", label = "使用说明") {
  return `<div class="page-heading"><div><div class="eyebrow">WENQING SHANGPIN / LOCAL WORKSPACE</div><h1>${title}</h1><p class="subtitle">${sub}</p></div>${btn(label, action, "", "", action === "add-shop" ? "plus" : "circle-help")}</div>`;
}
function shopList(selectable = true, p = platform) {
  const items = S.config.shops.filter(s => s.platform === p);
  return items.length ? `<div class="shop-list">${items.map(s => `<div class="shop-option ${S.config.selectedShopIds.includes(s.id) ? 'selected' : ''}"><div class="shop-option-main">${selectable ? `<input type="checkbox" aria-label="选择店铺：${esc(s.name)}" data-shop="${s.id}" ${S.config.selectedShopIds.includes(s.id) ? 'checked' : ''} ${running() ? 'disabled' : ''}>` : '<div class="shop-avatar small-avatar">'+esc(s.name[0])+'</div>'}<div class="shop-label"><strong>${esc(s.name)}</strong><small>${p === 'pdd' ? '拼多多 · Ego 工作空间' : '抖店 · 专用 Chrome'}</small>${s.actualName && s.actualName !== s.name ? `<small class="shop-mismatch">当前窗口：${esc(s.actualName)}</small>` : ''}${s.loginError ? `<small class="shop-mismatch">${esc(s.loginError)}</small>` : ''}</div></div><div class="shop-option-end"><span class="shop-status-pair">${badge(s.loginStatus === 'checking' ? '检测中' : s.loggedIn ? '已登录' : s.loginStatus === 'awaiting-user' ? '等待你操作' : '需连接',s.loggedIn ? 'green' : 'gray')}${badge(s.securityBlocked ? '安全停止' : s.verified ? '已核对' : '未核对',s.verified ? 'blue' : 'gray')}</span>${btn(p === 'pdd' ? '连接 Ego' : s.loggedIn ? '打开' : '登录','login','shop-mini',`data-id="${s.id}" ${running() ? 'disabled' : ''}`)}${btn(s.securityBlocked ? '已处理，重新核对' : '核对','verify','shop-mini',`data-id="${s.id}" ${running() ? 'disabled' : ''}`)}${p === 'dou' && ['mismatch','login-required','connection-error'].includes(s.loginStatus) && !s.securityBlocked ? btn('重新登录','new-login','shop-mini',`data-id="${s.id}" ${running() ? 'disabled' : ''}`) : ''}</div></div>`).join('')}</div>` : `<div class="empty-note">${ico('store')}还没有${p === 'pdd' ? '拼多多' : '抖店'}店铺<p>添加完整店铺名称，再打开浏览器人工登录</p>${btn('添加店铺','add-shop','primary','','plus')}</div>`;
}
function productTable() {
  return S.products.length
    ? `<div class="table-wrap"><table><thead><tr><th></th><th>商品信息</th><th>规格 / 售价</th><th>资料检查</th><th></th></tr></thead><tbody>${S.products.map((p) => `<tr><td><input type="checkbox" data-product="${p.id}" aria-label="选择商品：${esc(p.code)}" ${S.config.selectedProductIds.includes(p.id) ? "checked" : ""} ${!p.ok || running() ? "disabled" : ""}></td><td><div class="product-cell">${p.image ? `<img class="product-thumb" src="${esc(p.image)}" alt="主图">` : ""}<div><div class="product-name">${esc(p.title)}</div><div class="product-meta">${esc(p.code)}</div><div class="cell-sub">${esc(p.category || "")}</div><span class="mini-tag">${p.white ? "有白底图" : "无白底图"}</span></div></div></td><td>${p.priceRange.length ? `<div class="price">¥ ${Math.min(...p.priceRange).toFixed(2)}${Math.max(...p.priceRange) !== Math.min(...p.priceRange) ? " – " + Math.max(...p.priceRange).toFixed(2) : ""}</div>` : "—"}<div class="cell-sub">${p.sku} 个规格</div></td><td>${badge(p.ok ? p.warnings?.length ? "可运行 · " + p.warnings.length + " 项提示" : "本地校验通过" : "需要补充", p.ok ? "green" : "amber")}</td><td>${btn("查看", "product", "text", `data-id="${p.id}"`)}${platform === "dou" ? btn("主图一键编号", "image-names", "text", `data-id="${p.id}" ${running() || S.busyOp ? "disabled" : ""}`) : `${btn("一键编号", "pdd-number", "text", `data-id="${p.id}" ${running() || S.busyOp ? "disabled" : ""}`)}${btn(`${p.image ? `<img class="first-image-mini" src="${esc(p.image)}" alt="">` : ""}首图 ▾`, "image-settings", "text first-image-trigger", `data-id="${p.id}" aria-label="选择首图" aria-haspopup="dialog" ${running() || S.busyOp ? "disabled" : ""}`)}`}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty-note">${ico("folder-open")}${S.busyOp ? "正在读取本机资料，请稍候" : "请选择总素材库文件夹"}<br><p style="margin-top:8px">每个商品一个子文件夹，读取现有商品信息 Excel 和素材</p></div>`;
}
function tasksTable(tasks) {
  return `<div class="table-wrap task-table"><table><thead><tr><th>#</th><th>目标店铺</th><th>商品 / 规格</th><th>结果</th></tr></thead><tbody>${tasks.map((t, i) => `<tr data-task="${t.id}"><td>${i + 1}</td><td>${esc(t.shopName)}</td><td>${esc(t.code)}<div class="cell-sub">${t.sku} 个规格</div></td><td>${badge(statuses[t.status] || t.status, t.status === "confirmed" ? "green" : ["needs-review", "safety-blocked", "failed"].includes(t.status) ? "amber" : t.status === "already-saved" ? "gray" : "blue")}${t.error?`<div class="cell-sub">${esc(t.error)}</div>`:""}</td></tr>`).join("")}</tbody></table></div>`;
}
function logRows(run, full = false) {
  const rows = (run.logs || []).slice(full ? -1000 : -200);
  return rows.map(l => `<div class="live-log-row"><time>${esc(new Date(l.at || run.startedAt).toLocaleTimeString('zh-CN', {hour12:false}))}</time><span>${esc(l.text)}</span></div>`).join('') || `<div class="subtle">${esc(run.error || '等待脚本输出…')}</div>`;
}
function runPanel() {
  const r = S.run;
  if (!r) return "";
  return `<section class="panel"><div class="run-panel"><div class="run-title"><div><h2>${statuses[r.status] || r.status}</h2><p>${esc(r.id)} · ${esc(r.tasks[Math.min(r.index, r.tasks.length - 1)]?.shopName || "")}</p></div>${badge("仅保存草稿", "blue")}</div><div class="progress-track"><div class="progress-fill" style="width:${(r.tasks.filter((t) => ["confirmed", "already-saved"].includes(t.status)).length / r.tasks.length) * 100}%"></div></div><div class="run-phase"><span>${esc(r.step || r.error || "")}</span><span>新保存 ${r.tasks.filter((t) => t.status === "confirmed").length} / ${r.tasks.length} · 失败 ${r.tasks.filter(t=>t.status==='failed').length} · 未运行 ${r.tasks.filter(t=>t.status==='not-run').length}</span></div>${r.error ? `<div class="notice">${esc(r.error)}</div>` : ""}<div class="live-log-head"><strong>实时运行日志</strong><span>${(r.logs || []).length} 条</span></div><div class="log-lines live-logs" data-live-logs="${esc(r.id)}" aria-label="实时运行日志" tabindex="0">${logRows(r)}</div><div class="run-buttons">${btn("查看完整日志", "history-detail", "", `data-id="${r.id}"`)}${["running", "pausing"].includes(r.status) ? btn("当前商品后暂停", "pause", "", "", "pause") : r.status === "paused" ? btn("继续本批", "resume", "primary", "", "play") : ""}${running() ? btn("当前商品后停止", "stop") : ""}${btn("打开原始报告", "report", "", `data-id="${r.id}"`)}</div></div>${tasksTable(r.tasks)}</section>`;
}
function workbench() {
  const targets = selectedShops(),
    ready =
      targets.length && targets.every((s) => s.verified && !s.securityBlocked),
    hasPlan = !!S.preflight;
  const intro = platform === 'pdd' ? '<strong>拼多多 · Ego 执行器</strong><p>按商品类型匹配时尚套装或针织衫；可在商品旁选择首图，使用原图循环为10张轮播、17张详情。白底图、包装标签图、视频、尺码图均可缺省；尺码图有则首位且仅一次。</p>' : '<strong>抖店执行器 · 支持时尚套装与针织衫</strong><p>5张主图、现货预售混合，编码以 Excel 为准。</p>';
  return `${heading("批量上架", "读取本机素材，逐店核对，逐商品保存草稿")}<div class="info-banner"><div>${intro}</div></div><div class="columns"><div><section class="panel"><div class="panel-head"><div><div class="panel-title">01　选择平台与店铺 ${badge("可多选", "blue")}</div><p>每家店都要登录并单独核对；不默认全选</p></div><div class="platform-switch"><button class="${platform === "dou" ? "active" : ""}" data-platform="dou" ${running() ? "disabled" : ""}>抖店</button><button class="${platform === "pdd" ? "active" : ""}" data-platform="pdd" ${running() ? "disabled" : ""}>拼多多</button></div></div>${shopList()}<div class="shop-tip">${ico("shield-check")}${platform === "pdd" ? "先连接 Ego，登录后点击核对" : "独立窗口保持登录；APP重开会自动检测"}${btn("刷新状态", "refresh-shops", "text", running() ? "disabled" : "")}</div></section><section class="panel"><div class="panel-head"><div><div class="panel-title">02　本批商品</div><p>选择准备好的商品，开始前会展示完整任务清单</p></div>${btn("重新扫描", "scan", "", "", "refresh-cw")}</div><div class="pathbar">${ico("folder-open")}<span class="path-text">${esc(S.config.materialsRoot || "尚未选择总素材库")}</span><button data-act="root" ${running() ? "disabled" : ""}>选择文件夹</button></div>${platform==='pdd'?`<div class="buttons">${btn("套装空白模板","pdd-template","text",`data-id="时尚套装" ${running()?"disabled":""}`)}${btn("针织衫空白模板","pdd-template","text",`data-id="针织衫" ${running()?"disabled":""}`)}</div>`:""}${productTable()}${S.scanErrors.map((e) => `<div class="scan-error"><strong>${esc(e.folder)}</strong>${esc(e.error)}</div>`).join("")}</section>${runPanel()}</div><aside><section class="panel readiness"><div class="ready-head"><h2>运行前检查</h2><p>检查通过后，再确认全部目标</p></div><div class="check-list">${[
          [
            "店铺已核对",
            targets.length
              ? `${targets.filter((s) => s.verified && !s.securityBlocked).length} / ${targets.length} 家已就绪`
              : "请先添加并选择店铺",
            ready,
          ],
          [
            "资料与素材",
            `${selectedProducts().length} 件商品已选`,
            selectedProducts().length > 0 &&
              selectedProducts().every((p) => p.ok),
          ],
          [
            "本批最终预检",
            hasPlan ? "已重新核对店铺与素材内容" : "开始前再次检查资料是否变化",
            hasPlan,
          ],
        ]
          .map(
            (x) =>
              `<div class="check-item"><span class="check-circle ${x[2] ? "good" : ""}">${x[2] ? "✓" : "·"}</span><div><strong>${x[0]}</strong><small>${esc(x[1])}</small></div></div>`,
          )
          .join(
            "",
          )}</div><div class="run-summary"><div class="task-equation"><span>${selectedProducts().length} 件商品 × ${targets.length} 家店铺</span><strong>${countTasks()} <small>个草稿任务</small></strong></div><div class="summary-row"><span>顺序</span><strong>逐店、逐商品串行</strong></div><div class="summary-row"><span>异常</span><strong>${platform==='pdd'?"普通失败跳过，关键异常停批":"立即停批，保留现场"}</strong></div></div><div class="save-mode">${ico("lock-keyhole")}<div><strong>仅保存草稿</strong><small>不提供正式发布操作</small></div></div><div class="run-action">${btn(hasPlan ? "核对任务并开始" : "检查本批素材", hasPlan ? "review" : "check", "primary full", running() ? "disabled" : "", "list-checks")}<p>本机曾保存的商品默认跳过</p>${btn("重新创建草稿", "recreate", "full", running() ? "disabled" : "")}</div></section><div class="note-card">${ico("shield-check")}<div><strong>验证码立即停止</strong><p>APP不会绕过安全验证。出现“结果待核实”时，先检查草稿箱，不自动重试。</p></div></div></aside></div>`;
}
function shopsPage() {
  return `${heading("店铺管理", "专用浏览器自动管理连接，无需填写端口", "add-shop", "添加店铺")}<div class="sheet-grid">${["dou", "pdd"].map((p) => `<section class="panel"><div class="panel-head"><div class="panel-title">${p === "dou" ? "抖店" : "拼多多"} ${badge(p === "dou" ? "Chrome" : "Ego", p === "dou" ? "blue" : "amber")}</div></div>${shopList(false, p)}</section>`).join("")}</div>`;
}
function historyPage() {
  return `${heading("运行记录", "只有确认保存证据才标为成功；跳过和结果未知分别保留")}<section class="panel">${S.history.length ? `<div class="table-wrap"><table><thead><tr><th>批次</th><th>时间</th><th>结果</th><th>任务</th><th></th></tr></thead><tbody>${S.history.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(new Date(r.startedAt).toLocaleString())}</td><td>${badge(statuses[r.status] || r.status, r.status === "complete" ? "green" : "amber")}</td><td>${r.tasks.filter((t) => t.status === "confirmed").length} 新保存 / ${r.tasks.length} · ${r.tasks.filter(t=>t.status==='failed').length} 失败 · ${r.tasks.filter(t=>t.status==='not-run').length} 未运行</td><td>${btn("详情", "history-detail", "text", `data-id="${r.id}"`)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-note">尚无本机真实任务记录</div>`}</section>`;
}
function settingsPage() {
  return `${heading("软件设置", "本机独立运行，无需 Workbuddy、Codex 或系统 Node.js")}<section class="panel"><div class="settings-list">${[
    ["运行版本", S.version],
    ["素材库", S.config.materialsRoot || "尚未选择"],
    ["支持范围", "抖店 / 时尚套装、针织衫 / 现货预售混合 / 5张主图"],
    ["最终操作", "仅保存草稿"],
    ["浏览器", "抖店：Google Chrome；拼多多：ego lite（首次设置后连接）"],
    ["关闭APP", "运行中可留在后台或完成当前商品后退出；不关闭店铺浏览器"],
    ["拼多多", "Ego / 时尚套装、毛衣/针织衫 / 主图10张、详情17张 / 时段预售；仅保存草稿"],
  ]
    .map(
      (x) =>
        `<div class="setting-row"><strong>${x[0]}</strong><p>${esc(x[1])}</p></div>`,
    )
    .join("")}</div></section>`;
}
function render() {
  if (!S) return;
  platform = S.config.platform || "dou";
  document.querySelector("#version").textContent = "本机版本 " + S.version;
  document.querySelector("#breadcrumb").textContent = {
    workbench: "批量上架",
    shops: "店铺管理",
    history: "运行记录",
    settings: "软件设置",
  }[page];
  document
    .querySelectorAll("[data-nav]")
    .forEach((b) => b.classList.toggle("active", b.dataset.nav === page));
  document.querySelector("#main").classList.add("update-only");
  const oldLog = document.querySelector('[data-live-logs]');
  const scroll = oldLog ? {id:oldLog.dataset.liveLogs, top:oldLog.scrollTop, bottom:oldLog.scrollHeight-oldLog.scrollTop-oldLog.clientHeight<40} : null;
  const update = () => {
    document.querySelector("#main").innerHTML =
      `${error ? `<div class="error-box">${esc(error)}</div>` : ""}${{ workbench, shops: shopsPage, history: historyPage, settings: settingsPage }[page]()}`;
    const box = document.querySelector('[data-live-logs]');
    if (box) box.scrollTop = !scroll || box.dataset.liveLogs !== scroll.id || scroll.bottom ? box.scrollHeight : scroll.top;
  };
  if (
    renderedPage !== null &&
    renderedPage !== page &&
    document.startViewTransition
  )
    document.startViewTransition(update);
  else update();
  renderedPage = page;
  if(imageDialog)positionImagePicker();
}
function head(title, sub = "") {
  return `<div class="overlay-head"><div><h2 id="dialog-title">${title}</h2><p>${sub}</p></div>${btn("关闭", "close", "ghost")}</div>`;
}
function overlay(html, type = "modal") {
  logDialogRunId = null;
  if(!document.querySelector('#overlay-root .overlay')){
    overlayFocus??=document.activeElement;
    bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
  }
  document.querySelector("#overlay-root").innerHTML =
    `<div class="overlay ${type === "modal" ? "modal-mode" : ""}"><section role="dialog" aria-modal="true" aria-labelledby="dialog-title" class="${type}">${html}</section></div>`;
  document.querySelector('#overlay-root [data-act="close"]')?.focus({preventScroll:true});
}
function close() {
  const old = document.querySelector("#overlay-root .overlay");
  if (old) {
    old.classList.add("leaving");
    setTimeout(() => {
      old.remove();
      if(!document.querySelector('#overlay-root .overlay')){
        document.body.style.overflow=bodyOverflow;
        const target=overlayFocus?.isConnected?overlayFocus:overlayFocus?.dataset.act?document.querySelector(`[data-act="${overlayFocus.dataset.act}"]${overlayFocus.dataset.id?'[data-id="'+CSS.escape(overlayFocus.dataset.id)+'"]':''}`):null;
        target?.focus({preventScroll:true});overlayFocus=null;
      }
    }, 160);
  }
  dialogTask = null;
  logDialogRunId = null;
  imageDialog=null;
}
function closeImagePicker(){
  const picker=document.querySelector('#image-picker');
  if(!picker)return;
  const id=imageDialog?.id;imageDialog=null;
  picker.classList.add('leaving');setTimeout(()=>picker.remove(),140);
  document.querySelector(`[data-act="image-settings"][data-id="${CSS.escape(id||'')}"]`)?.focus({preventScroll:true});
}
function showImageSettings(plan){
  document.querySelector('#image-picker')?.remove();
  const selectedPhoto=plan.pictures.find(p=>p.id===plan.selected);
  const hashes=new Set();
  plan.pictures=plan.pictures.filter(p=>{if(hashes.has(p.hash))return false;hashes.add(p.hash);return true;});
  plan.selected=plan.pictures.find(p=>p.hash===selectedPhoto?.hash)?.id||plan.pictures[0].id;
  imageDialog=plan;
  if(plan.recovered)toast('已恢复上次中断的图片设置');
  document.body.insertAdjacentHTML('beforeend',`<div id="image-picker" role="dialog" aria-label="选择首图" class="image-picker"><div class="first-image-options">${plan.pictures.map(p=>`<button type="button" data-act="pick-first-image" data-id="${p.id}" class="first-image-option ${p.id===plan.selected?'selected':''}" aria-label="选择图片 ${p.id}" aria-pressed="${p.id===plan.selected}"><img src="${esc(p.image)}" alt="图片 ${p.id}"></button>`).join('')}</div><div class="first-image-footer"><small>${plan.hasSize?'详情：尺码表 + 同一张首图':'未提供尺码图，详情从首图开始'}</small>${btn('确认首图','save-image-settings','primary')}</div><div id="image-picker-error" role="status"></div></div>`);
  positionImagePicker();
  document.querySelector('#image-picker .selected')?.focus({preventScroll:true});
}
function positionImagePicker(){
  if(!imageDialog)return;
  const picker=document.querySelector('#image-picker'),anchor=document.querySelector(`[data-act="image-settings"][data-id="${CSS.escape(imageDialog.id)}"]`);
  if(!picker||!anchor)return;
  const rect=anchor.getBoundingClientRect(),width=picker.getBoundingClientRect().width;
  picker.style.left=Math.max(12,Math.min(rect.right-width,innerWidth-width-12))+'px';
  const height=picker.getBoundingClientRect().height;
  picker.style.top=(rect.bottom+height+12<innerHeight?rect.bottom+6:Math.max(42,rect.top-height-6))+'px';
}
function mediaSummaryHtml(p){
  const m=p.mediaPlan;
  return m?`<h3>本次图片计划</h3><div class="image-plan-summary"><p>${m.sourceCount} 张原图 · 轮播 ${m.main.length} 张 · 详情 ${m.details.length} 张${m.reuse?' · 主图复用':' · 兼容原模板'}</p><p>轮播：${m.main.map(esc).join(' · ')}</p><p>详情：${m.details.map(esc).join(' · ')}</p></div>`:'';
}
function showReview() {
  const p = S.preflight;
  if (!p) return toast("请先检查本批素材");
  dialogTask = p.token;
  const create = p.tasks.filter((t) => t.status !== "already-saved").length,
    skip = p.tasks.length - create;
  overlay(
    `${head(p.mode === "recreate" ? "确认重新创建草稿" : "确认本批草稿任务", "逐项核对店铺与商品；仅保存草稿")}<div class="review-metrics"><div><small>商品</small><strong>${selectedProducts().length}</strong></div><span>×</span><div><small>店铺</small><strong>${selectedShops().length}</strong></div><span>＝</span><div><small>任务</small><strong>${p.tasks.length}</strong></div></div><div class="notice blue">本次将新建 ${create} 个，跳过 ${skip} 个。${p.mode === "recreate" ? "重建优先：已有草稿或旧任务待核实均不拦截。本次使用独立新任务，在同一工作页进入空白新建；原历史与回执保留，后台原草稿可能仍在。" : "“本机曾保存”来自本地历史，并未查询后台草稿是否仍存在。"}</div>${tasksTable(p.tasks)}<div class="notice blue">逐店串行，每店复用固定工作页。${p.mode === "recreate" ? "旧任务不拦截本次重建；验证码仍立即停止。" : "保存未知会阻断；验证码立即停止。"}素材库另有 ${S.scanErrors.length} 个错误目录未加入本批。</div><div class="buttons">${btn("返回修改", "close")}${!create ? btn("重新创建草稿", "recreate", "primary") : btn(p.mode === "recreate" ? "确认，重新创建草稿" : "确认，开始保存草稿", "start", "primary", "", "play")}</div>`,
    "drawer",
  );
}

async function click(b) {
  const a = b.dataset.act,
    id = b.dataset.id;
  if(!document.querySelector('#overlay-root .overlay'))overlayFocus=b;
  switch (a) {
    case 'pdd-template':
      if(await call('exportPddTemplate',id))toast('空白模板已保存；填好后放入商品文件夹');
      break;
    case 'pdd-number':{
      document.querySelector('#image-picker')?.remove();imageDialog=null;
      const result=await call('numberPddImages',id);await call('scan');
      toast(result.changed?'主图已编号，原图备份已保留':'主图已是标准编号');break;
    }
    case 'image-settings':{
      if(imageDialog?.id===id){closeImagePicker();break;}
      showImageSettings(await call('imageSettings',id));break;
    }
    case 'pick-first-image':{
      if(!imageDialog)return;
      imageDialog.selected=id;
      for(const option of document.querySelectorAll('.first-image-option')){
        const selected=option.dataset.id===id;option.classList.toggle('selected',selected);option.setAttribute('aria-pressed',String(selected));
      }
      break;
    }
    case 'save-image-settings':{
      if(!imageDialog)return;
      const plan=imageDialog;
      try{
        const result=await call('imageSettings',plan.id,plan.token,plan.selected);
        closeImagePicker();await call('scan');toast(result.changed?'首图已确认':'首图设置未变化');
      }catch(e){
        document.querySelector('#image-picker-error').textContent=e.message;
        // Refresh a failed write's signature, retaining the exact chosen file.
        try{
          const photo=plan.pictures.find(p=>p.id===plan.selected),fresh=await call('imageSettings',plan.id);
          const match=fresh.pictures.find(p=>p.from===photo?.from&&p.hash===photo?.hash);
          if(match){showImageSettings({...fresh,selected:match.id});document.querySelector('#image-picker-error').textContent=e.message;}
          else{closeImagePicker();toast('主图已变化，请重新选择首图');}
        }catch{closeImagePicker();toast(e.message);}
      }
      break;
    }
    case "close":
      close();
      break;
    case "root":
      await call("chooseRoot");
      break;
    case "scan":
      await call("scan");
      break;
    case "image-names": {
      const plan=await call("mainImageNames",id);
      dialogTask={id,token:plan.token};
      overlay(`${head("主图一键编号", "按当前文件名的自然顺序编号，保留图片格式")}<div class="notice blue">请核对首图与排列顺序。当前模板要求5张主图，检测到 ${plan.mapping.length} 张。原图会自动备份，不修改Excel、白底图或其他素材。</div><div class="table-wrap"><table><thead><tr><th>当前文件名</th><th>编号后</th></tr></thead><tbody>${plan.mapping.map(m=>`<tr><td>${esc(m.from)}</td><td>${esc(m.to)}</td></tr>`).join("")}</tbody></table></div><div class="buttons">${btn("返回", "close")}${plan.changed?btn("确认编号并重新扫描", "apply-image-names", "primary"):'<span class="mini-tag">已是标准编号</span>'}</div>`);
      break;
    }
    case "apply-image-names": {
      const result=await call("mainImageNames",dialogTask.id,dialogTask.token);
      close();
      await call("scan");
      toast(result.changed?`已编号 ${result.count} 张主图，原图备份已保留`:"主图已是标准编号");
      break;
    }
    case "add-shop":
      overlay(
        `${head("添加店铺", "填写后台展示的完整店铺名称")}<div class="field-label">平台</div><select id="shop-platform"><option value="dou" ${platform === "dou" ? "selected" : ""}>抖店</option><option value="pdd" ${platform === "pdd" ? "selected" : ""}>拼多多</option></select><div class="field-label">完整店铺名称</div><input id="shop-name" class="text-input" placeholder="例如：星怡严选女装"><div class="buttons">${btn("取消", "close")}${btn("添加", "save-shop", "primary")}</div>`,
      );
      break;
    case "save-shop":
      await call(
        "addShop",
        document.querySelector("#shop-name").value,
        document.querySelector("#shop-platform").value,
      );
      close();
      break;
    case "refresh-shops":
      await call("refreshShops");
      toast("已检查本软件登记的店铺窗口");
      break;
    case "new-login":
      overlay(
        `${head("重新登录此店", "其他店铺会话保持独立")}<p>将为「${esc(S.config.shops.find((s) => s.id === id).name)}」建立新的独立登录环境。原窗口和资料保留，不会切换其他店铺；请在新窗口人工登录目标店铺后核对。</p><div class="buttons">${btn("取消", "close")}${btn("打开独立登录窗口", "confirm-new-login", "primary", `data-id="${id}"`)}</div>`,
      );
      break;
    case "confirm-new-login": {
      const r = await call("newLogin", id);
      close();
      toast(r?.message);
      break;
    }
    case "recreate":
      await call("check", "recreate");
      showReview();
      break;
    case "login": {
      const r = await call("openLogin", id);
      toast(r?.message || "请人工登录后点击核对");
      break;
    }
    case "verify": {
      const s = S.config.shops.find((s) => s.id === id);
      if (s.securityBlocked) {
        overlay(
          `${head("人工处理后重新核对", "不会自动绕过验证码")}<p>请先在保留的浏览器中完成人工验证，并检查是否已有保存结果。核对仍会重新检查可见安全限制。</p><div class="buttons">${btn("取消", "close")}${btn("我已处理，重新核对", "ack-verify", "primary", `data-id="${id}"`)}</div>`,
        );
      } else {
        await call("verifyShop", id);
        toast("店铺核对通过");
      }
      break;
    }
    case "ack-verify":
      await call("verifyShop", id, true);
      close();
      break;
    case "check":
      await call("check");
      toast("本批预检通过，请核对任务清单");
      break;
    case "review":
      showReview();
      break;
    case "start": {
      const token = dialogTask;
      await call("start", token);
      close();
      break;
    }
    case "pause":
      await call("pause");
      break;
    case "resume":
      await call("resume");
      break;
    case "stop":
      await call("stopAfterCurrent");
      break;
    case "report":
      await call("openReport", id);
      break;
    case "export":
      await call("exportReport", id);
      toast("报告已导出");
      break;
    case "history-detail": {
      const r = S.run?.id === id ? S.run : S.history.find(r => r.id === id);
      if (!r) return toast('没有找到该批次日志');
      overlay(
        `${head("本批执行结果", r.id)}${r.error ? `<div class="notice">${esc(r.error)}</div>` : ""}${tasksTable(r.tasks)}<h3>完整运行日志</h3><div id="full-run-log" class="log-lines live-logs" aria-label="完整运行日志" tabindex="0">${logRows(r, true)}</div><div class="buttons">${btn("原始报告", "report", "", `data-id="${id}"`)}${btn("导出报告", "export", "primary", `data-id="${id}"`)}</div>`,
        "drawer",
      );
      logDialogRunId = r.id;
      const box = document.querySelector('#full-run-log');
      if (box) box.scrollTop = box.scrollHeight;
      break;
    }
    case "open-material":
      await call("openMaterial", id);
      break;
    case "product": {
      const p = S.products.find((p) => p.id === id);
      overlay(
        `${head("商品资料检查", esc(p.code))}${btn("打开商品素材文件夹", "open-material", "", `data-id="${p.id}"`)}<p>${esc(p.title)}</p><p class="cell-sub">${esc(p.category || "")}</p><div class="kv-grid" style="margin-top:20px">${[["组合件数",p.attributes?.pieces],["适用年龄",p.attributes?.age],["风格",p.attributes?.style],["规格数",p.sku]].filter(([,v])=>v!==undefined&&v!==null&&v!=="").map(([k,v])=>`<div><small>${k}</small>${esc(v)}</div>`).join("")}</div>${p.attributes?.categoryAttributes ? `<h3>${platform === "pdd" ? "商品表基础信息与服务" : "基础信息选填项"}</h3><div class="settings-list">${Object.entries(p.attributes.categoryAttributes).map(([label,value])=>`<div class="setting-row"><strong>${esc(label)}</strong><p>${esc(Array.isArray(value)?value.join('、'):value)}</p></div>`).join('') || '<p class="subtle">选填属性未提供，执行时仍检查平台必填项</p>'}</div>` : ''}${mediaSummaryHtml(p)}<h3>错误与提示</h3>${[...p.errors, ...p.warnings].map((e) => `<div class="issue-row">${esc(e.message)}</div>`).join("") || '<p class="subtle">本地资料校验通过；执行前仍会再次核对素材与店铺。</p>'}`,
        "drawer",
      );
      break;
    }
    case "help":
      overlay(
        `${head("文青尚品使用流程")}<div class="issue-row"><strong>1. 添加店铺并人工登录</strong><p>抖店使用专用 Chrome，拼多多使用本店 Ego 工作空间。点击“连接 Ego”后在浏览器内登录，再返回 App 点击“核对”。首次登录若进入同账号下另一店，须在该独立窗口选择目标店铺；APP会显示实际店名并阻断不匹配目标。</p></div><div class="issue-row"><strong>2. 点击核对，勾选目标店铺</strong><p>APP重开自动检查已登记窗口，也可点击刷新状态；店名精确一致才显示已核对。打开窗口或登录同一个账号不等于选对店铺。</p></div><div class="issue-row"><strong>3. 选择总素材库及商品</strong><p>读取现有Excel和素材。缺项会指出商品目录、字段和修正提示。</p></div><div class="issue-row"><strong>4. 检查并确认任务，保存草稿</strong><p>全部目标列清楚再执行，每店复用固定工作页。默认按本机保存历史跳过；需要再测请点“重新创建草稿”。后台删除草稿不会自动删除本机记录；未知保存仍须先核实。</p></div><div class="buttons">${btn("知道了", "close", "primary")}</div>`,
      );
      break;
  }
}
document.addEventListener("click", (e) => {
  if(imageDialog&&!e.target.closest('#image-picker')&&!e.target.closest('[data-act="image-settings"]'))closeImagePicker();
  if(e.target.matches('.overlay')){e.preventDefault();e.stopPropagation();close();return;}
  const nav = e.target.closest("[data-nav]");
  if (nav) {
    page = nav.dataset.nav;
    error = "";
    render();
    return;
  }
  const p = e.target.closest("[data-platform]");
  if (p && !running()) {
    void call("setPlatform", p.dataset.platform).catch(() => {});
    return;
  }
  const b = e.target.closest("[data-act]");
  if (b && !pending) void click(b).catch(() => {});
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-shop]")) {
    const ids = [...S.config.selectedShopIds],
      id = e.target.dataset.shop;
    void call("select", {
      shopIds: e.target.checked ? [...ids, id] : ids.filter((x) => x !== id),
    }).catch(() => {});
  }
  if (e.target.matches("[data-product]")) {
    const ids = [...S.config.selectedProductIds],
      id = e.target.dataset.product;
    void call("select", {
      productIds: e.target.checked ? [...ids, id] : ids.filter((x) => x !== id),
    }).catch(() => {});
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !pending){
    if(imageDialog)closeImagePicker();else close();
  }
  if(e.key==='Tab'&&(document.querySelector('#overlay-root .overlay')||imageDialog)){
    const container=document.querySelector('#image-picker')||document.querySelector('#overlay-root section');
    const controls=[...container.querySelectorAll('button,input,select,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
  }
});
window.addEventListener('resize',positionImagePicker);
document.addEventListener('scroll',positionImagePicker,true);
if (!api)
  document.querySelector("#main").innerHTML =
    '<div class="error-box">请从“文青尚品.app”启动本机应用，此页面没有模拟执行功能。</div>';
else {
  api.onState(receive);
  void call("getState")
    .then(receive)
    .catch(() => {});
}
