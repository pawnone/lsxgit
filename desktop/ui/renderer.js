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
let renderedPage = null;
const selectedShops = () =>
  S.config.shops.filter(
    (s) => s.platform === "dou" && S.config.selectedShopIds.includes(s.id),
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
  "already-saved": "已有草稿（跳过）",
  "needs-review": "结果待核实",
  failed: "失败",
  "safety-blocked": "安全停止",
  "not-run": "未执行",
  stopped: "已停止",
  complete: "本批完成",
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
}
async function call(method, ...args) {
  if (pending) return;
  pending = true;
  error = "";
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
  const items = S.config.shops.filter((s) => s.platform === p);
  return items.length
    ? `<div class="shop-list">${items.map((s) => `<div class="shop-option ${S.config.selectedShopIds.includes(s.id) ? "selected" : ""}" data-shop-row="${s.id}"><div class="shop-option-main">${selectable && p === "dou" ? `<input type="checkbox" aria-label="选择店铺：${esc(s.name)}" data-shop="${s.id}" ${S.config.selectedShopIds.includes(s.id) ? "checked" : ""} ${running() ? "disabled" : ""}>` : `<div class="shop-avatar small-avatar">${esc(s.name[0])}</div>`}<div class="shop-label"><strong>${esc(s.name)}</strong><small>${p === "dou" ? "抖店" : "拼多多"} · 专用本机登录资料</small></div></div><div class="shop-option-end"><span class="shop-status-pair">${badge(s.loggedIn ? "已登录" : "待登录", s.loggedIn ? "green" : "gray")}${badge(s.securityBlocked ? "安全停止" : s.verified ? "已核对" : "未核对", s.securityBlocked ? "amber" : s.verified ? "blue" : "gray")}</span>${p === "dou" ? `${btn("登录", "login", "shop-mini", `data-id="${s.id}" ${running() ? "disabled" : ""}`)}${btn(s.securityBlocked ? "已处理，重新核对" : "核对", "verify", "shop-mini", `data-id="${s.id}" ${running() ? "disabled" : ""}`)}` : badge("入口保留", "amber")}</div></div>`).join("")}</div>`
    : `<div class="empty-note">${ico("store")}还没有${p === "dou" ? "抖店" : "拼多多"}店铺<br><p style="margin:12px 0">先添加完整店铺名称，再打开浏览器登录</p>${btn("添加店铺", "add-shop", "primary", "", "plus")}</div>`;
}
function productTable() {
  return S.products.length
    ? `<div class="table-wrap"><table><thead><tr><th></th><th>商品信息</th><th>规格 / 售价</th><th>资料检查</th><th></th></tr></thead><tbody>${S.products.map((p) => `<tr><td><input type="checkbox" data-product="${p.id}" aria-label="选择商品：${esc(p.code)}" ${S.config.selectedProductIds.includes(p.id) ? "checked" : ""} ${!p.ok || running() ? "disabled" : ""}></td><td><div class="product-cell">${p.image ? `<img class="product-thumb" src="${esc(p.image)}" alt="主图">` : ""}<div><div class="product-name">${esc(p.title)}</div><div class="product-meta">${esc(p.code)}</div><span class="mini-tag">${p.white ? "有白底图" : "无白底图"}</span></div></div></td><td>${p.priceRange.length ? `<div class="price">¥ ${Math.min(...p.priceRange).toFixed(2)}${Math.max(...p.priceRange) !== Math.min(...p.priceRange) ? " – " + Math.max(...p.priceRange).toFixed(2) : ""}</div>` : "—"}<div class="cell-sub">${p.sku} 个规格</div></td><td>${badge(p.ok ? "本地校验通过" : "需要补充", p.ok ? "green" : "amber")}</td><td>${btn("查看", "product", "text", `data-id="${p.id}"`)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty-note">${ico("folder-open")}${S.busyOp ? "正在读取本机资料，请稍候" : "请选择总素材库文件夹"}<br><p style="margin-top:8px">每个商品一个子文件夹，读取现有商品信息 Excel 和素材</p></div>`;
}
function tasksTable(tasks) {
  return `<div class="table-wrap task-table"><table><thead><tr><th>#</th><th>目标店铺</th><th>商品 / 规格</th><th>结果</th></tr></thead><tbody>${tasks.map((t, i) => `<tr data-task="${t.id}"><td>${i + 1}</td><td>${esc(t.shopName)}</td><td>${esc(t.code)}<div class="cell-sub">${t.sku} 个规格</div></td><td>${badge(statuses[t.status] || t.status, t.status === "confirmed" ? "green" : ["needs-review", "safety-blocked", "failed"].includes(t.status) ? "amber" : t.status === "already-saved" ? "gray" : "blue")}</td></tr>`).join("")}</tbody></table></div>`;
}
function runPanel() {
  const r = S.run;
  if (!r) return "";
  return `<section class="panel"><div class="run-panel"><div class="run-title"><div><h2>${statuses[r.status] || r.status}</h2><p>${esc(r.id)} · ${esc(r.tasks[Math.min(r.index, r.tasks.length - 1)]?.shopName || "")}</p></div>${badge("仅保存草稿", "blue")}</div><div class="progress-track"><div class="progress-fill" style="width:${(r.tasks.filter((t) => ["confirmed", "already-saved"].includes(t.status)).length / r.tasks.length) * 100}%"></div></div><div class="run-phase"><span>${esc(r.step || r.error || "")}</span><span>新保存 ${r.tasks.filter((t) => t.status === "confirmed").length} / ${r.tasks.length}</span></div>${r.error ? `<div class="notice">${esc(r.error)}</div>` : ""}<div class="log-lines">${(
    r.logs || []
  )
    .slice(-5)
    .map((l) => `<div>${esc(l.text)}</div>`)
    .join(
      "",
    )}</div><div class="run-buttons">${["running", "pausing"].includes(r.status) ? btn("当前商品后暂停", "pause", "", "", "pause") : r.status === "paused" ? btn("继续本批", "resume", "primary", "", "play") : ""}${running() ? btn("当前商品后停止", "stop") : ""}${btn("打开原始报告", "report", "", `data-id="${r.id}"`)}</div></div>${tasksTable(r.tasks)}</section>`;
}
function workbench() {
  const targets = selectedShops(),
    ready =
      targets.length && targets.every((s) => s.verified && !s.securityBlocked),
    hasPlan = !!S.preflight;
  return `${heading("批量上架", "读取本机素材，逐店核对，逐商品保存草稿")}${
    platform === "pdd"
      ? `<div class="info-banner amber"><div><strong>拼多多入口保留，执行尚未开放</strong><p>此版本只接入抖店，不复用抖店字段或猜填拼多多价格。</p></div></div><section class="panel"><div class="panel-head"><div class="panel-title">拼多多店铺</div><div class="platform-switch"><button data-platform="dou">抖店</button><button class="active" data-platform="pdd">拼多多</button></div></div>${shopList(false, "pdd")}</section>`
      : `<div class="info-banner"><div><strong>抖店执行器 · 当前支持时尚套装</strong><p>适配范围：服装 > 女装 > 时尚套装、5张主图、现货预售混合。编码以你填写的 Excel 为准。</p></div></div><div class="columns"><div><section class="panel"><div class="panel-head"><div><div class="panel-title">01　选择平台与店铺 ${badge("可多选", "blue")}</div><p>每家店都要登录并单独核对；不默认全选</p></div><div class="platform-switch"><button class="active" data-platform="dou">抖店</button><button data-platform="pdd" ${running() ? "disabled" : ""}>拼多多</button></div></div>${shopList()}<div class="shop-tip">${ico("shield-check")}登录窗口一直保留；登录完成后点击核对</div></section><section class="panel"><div class="panel-head"><div><div class="panel-title">02　本批商品</div><p>选择准备好的商品，开始前会展示完整任务清单</p></div>${btn("重新扫描", "scan", "", "", "refresh-cw")}</div><div class="pathbar">${ico("folder-open")}<span class="path-text">${esc(S.config.materialsRoot || "尚未选择总素材库")}</span><button data-act="root" ${running() ? "disabled" : ""}>选择文件夹</button></div>${productTable()}${S.scanErrors.map((e) => `<div class="scan-error"><strong>${esc(e.folder)}</strong>${esc(e.error)}</div>`).join("")}</section>${runPanel()}</div><aside><section class="panel readiness"><div class="ready-head"><h2>运行前检查</h2><p>检查通过后，再确认全部目标</p></div><div class="check-list">${[
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
          )}</div><div class="run-summary"><div class="task-equation"><span>${selectedProducts().length} 件商品 × ${targets.length} 家店铺</span><strong>${countTasks()} <small>个草稿任务</small></strong></div><div class="summary-row"><span>顺序</span><strong>逐店、逐商品串行</strong></div><div class="summary-row"><span>异常</span><strong>立即停批，保留现场</strong></div></div><div class="save-mode">${ico("lock-keyhole")}<div><strong>仅保存草稿</strong><small>不提供正式发布操作</small></div></div><div class="run-action">${btn(hasPlan ? "核对任务并开始" : "检查本批素材", hasPlan ? "review" : "check", "primary full", running() ? "disabled" : "", "list-checks")}<p>已有确认草稿将跳过，不重复创建</p></div></section><div class="note-card">${ico("shield-check")}<div><strong>验证码立即停止</strong><p>APP不会绕过安全验证。出现“结果待核实”时，先检查草稿箱，不自动重试。</p></div></div></aside></div>`
  }`;
}
function shopsPage() {
  return `${heading("店铺管理", "专用浏览器自动管理连接，无需填写端口", "add-shop", "添加店铺")}<div class="sheet-grid">${["dou", "pdd"].map((p) => `<section class="panel"><div class="panel-head"><div class="panel-title">${p === "dou" ? "抖店" : "拼多多"} ${badge(p === "dou" ? "已接入执行器" : "暂不开放", p === "dou" ? "blue" : "amber")}</div></div>${shopList(false, p)}</section>`).join("")}</div>`;
}
function historyPage() {
  return `${heading("运行记录", "只有确认保存证据才标为成功；跳过和结果未知分别保留")}<section class="panel">${S.history.length ? `<div class="table-wrap"><table><thead><tr><th>批次</th><th>时间</th><th>结果</th><th>任务</th><th></th></tr></thead><tbody>${S.history.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(new Date(r.startedAt).toLocaleString())}</td><td>${badge(statuses[r.status] || r.status, r.status === "complete" ? "green" : "amber")}</td><td>${r.tasks.filter((t) => t.status === "confirmed").length} 新保存 / ${r.tasks.length}</td><td>${btn("详情", "history-detail", "text", `data-id="${r.id}"`)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-note">尚无本机真实任务记录</div>`}</section>`;
}
function settingsPage() {
  return `${heading("软件设置", "本机独立运行，无需 Workbuddy、Codex 或系统 Node.js")}<section class="panel"><div class="settings-list">${[
    ["运行版本", S.version],
    ["素材库", S.config.materialsRoot || "尚未选择"],
    ["支持范围", "抖店 / 时尚套装 / 现货预售混合 / 5张主图"],
    ["最终操作", "仅保存草稿"],
    ["浏览器", "Google Chrome；每店独立资料目录，自动管理端口"],
    ["关闭APP", "运行中可留在后台或完成当前商品后退出；不关闭店铺浏览器"],
    ["拼多多", "只保留入口，执行器尚未开放"],
  ]
    .map(
      (x) =>
        `<div class="setting-row"><strong>${x[0]}</strong><p>${esc(x[1])}</p></div>`,
    )
    .join("")}</div></section>`;
}
function render() {
  if (!S) return;
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
  const update = () => {
    document.querySelector("#main").innerHTML =
      `${error ? `<div class="error-box">${esc(error)}</div>` : ""}${{ workbench, shops: shopsPage, history: historyPage, settings: settingsPage }[page]()}`;
  };
  if (
    renderedPage !== null &&
    renderedPage !== page &&
    document.startViewTransition
  )
    document.startViewTransition(update);
  else update();
  renderedPage = page;
}
function head(title, sub = "") {
  return `<div class="overlay-head"><div><h2 id="dialog-title">${title}</h2><p>${sub}</p></div>${btn("关闭", "close", "ghost")}</div>`;
}
function overlay(html, type = "modal") {
  document.querySelector("#overlay-root").innerHTML =
    `<div class="overlay ${type === "modal" ? "modal-mode" : ""}"><section role="dialog" aria-modal="true" aria-labelledby="dialog-title" class="${type}">${html}</section></div>`;
}
function close() {
  const old = document.querySelector("#overlay-root .overlay");
  if (old) {
    old.classList.add("leaving");
    setTimeout(() => old.remove(), 160);
  }
  dialogTask = null;
}
function showReview() {
  const p = S.preflight;
  if (!p) return toast("请先检查本批素材");
  dialogTask = p.token;
  overlay(
    `${head("确认本批草稿任务", "以下为真实任务：请逐项核对店铺与商品")}<div class="review-metrics"><div><small>商品</small><strong>${selectedProducts().length}</strong></div><span>×</span><div><small>店铺</small><strong>${selectedShops().length}</strong></div><span>＝</span><div><small>草稿任务</small><strong>${p.tasks.length}</strong></div></div>${tasksTable(p.tasks)}<div class="notice blue">逐店串行执行。只保存草稿。已有确认草稿将跳过；结果未知会阻断，不自动重试。素材库另有 ${S.scanErrors.length} 个错误目录，未加入本批。</div><div class="buttons">${btn("返回修改", "close")}${btn("确认，开始保存草稿", "start", "primary", "", "play")}</div>`,
    "drawer",
  );
}
async function click(b) {
  const a = b.dataset.act,
    id = b.dataset.id;
  switch (a) {
    case "close":
      close();
      break;
    case "root":
      await call("chooseRoot");
      break;
    case "scan":
      await call("scan");
      break;
    case "add-shop":
      overlay(
        `${head("添加店铺", "填写后台展示的完整店铺名称")}<div class="field-label">平台</div><select id="shop-platform"><option value="dou">抖店</option><option value="pdd">拼多多（保留入口）</option></select><div class="field-label">完整店铺名称</div><input id="shop-name" class="text-input" placeholder="例如：星怡严选女装"><div class="buttons">${btn("取消", "close")}${btn("添加", "save-shop", "primary")}</div>`,
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
      const r = S.history.find((r) => r.id === id);
      overlay(
        `${head("本批执行结果", r.id)}${r.error ? `<div class="notice">${esc(r.error)}</div>` : ""}${tasksTable(r.tasks)}<div class="log-lines">${(
          r.logs || []
        )
          .slice(-60)
          .map((l) => esc(l.text))
          .join(
            "\n",
          )}</div><div class="buttons">${btn("原始报告", "report", "", `data-id="${id}"`)}${btn("导出报告", "export", "primary", `data-id="${id}"`)}</div>`,
        "drawer",
      );
      break;
    }
    case "product": {
      const p = S.products.find((p) => p.id === id);
      overlay(
        `${head("商品资料检查", esc(p.code))}<p>${esc(p.title)}</p><div class="kv-grid" style="margin-top:20px"><div><small>组合件数</small>${esc(p.attributes?.pieces)}</div><div><small>适用年龄</small>${esc(p.attributes?.age)}</div><div><small>风格</small>${esc(p.attributes?.style)}</div><div><small>规格数</small>${p.sku}</div></div><h3>错误与提示</h3>${[...p.errors, ...p.warnings].map((e) => `<div class="issue-row">${esc(e.message)}</div>`).join("") || '<p class="subtle">本地资料校验通过；执行前仍会再次核对素材与店铺。</p>'}`,
        "drawer",
      );
      break;
    }
    case "help":
      overlay(
        `${head("文青尚品使用流程")}<div class="issue-row"><strong>1. 添加店铺并人工登录</strong><p>APP打开每店专用Chrome，窗口不会自动关闭。</p></div><div class="issue-row"><strong>2. 点击核对，勾选目标店铺</strong><p>每家店都要核对；不能用端口或页面顺序代替店铺身份。</p></div><div class="issue-row"><strong>3. 选择总素材库及商品</strong><p>读取现有Excel和素材。缺项会指出商品目录、字段和修正提示。</p></div><div class="issue-row"><strong>4. 检查并确认任务，保存草稿</strong><p>全部目标列清楚再执行。验证码即停；已有草稿跳过，未知保存先核实。</p></div><div class="buttons">${btn("知道了", "close", "primary")}</div>`,
      );
      break;
  }
}
document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) {
    page = nav.dataset.nav;
    error = "";
    render();
    return;
  }
  const p = e.target.closest("[data-platform]");
  if (p && !running()) {
    platform = p.dataset.platform;
    render();
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
  if (e.key === "Escape" && !pending) close();
});
if (!api)
  document.querySelector("#main").innerHTML =
    '<div class="error-box">请从“文青尚品.app”启动本机应用，此页面没有模拟执行功能。</div>';
else {
  api.onState(receive);
  void call("getState")
    .then(receive)
    .catch(() => {});
}
