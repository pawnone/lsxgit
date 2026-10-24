import { chromium } from "playwright-core";

export {classifyShop} from "./shop-state.mjs";
import {classifyShop} from "./shop-state.mjs";
export async function readShop(page) {
  const url = new URL(page.url());
  if (url.origin !== "https://mms.pinduoduo.com") return null;
  const state = await page.evaluate(() => {
    const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden";
    const text = document.body.innerText;
    const blocked = /为保障您账号的安全，请验证手机|请完成安全验证|访问受限|操作过于频繁|拖动滑块完成验证/.test(text) ||
      [...document.querySelectorAll("iframe")].some(e => visible(e) && /验证码|安全验证/.test(e.title));
    return { blocked, names: [...document.querySelectorAll('.user-name-name .user-name-text')]
      .filter(visible).map(e => e.innerText.trim()).filter(Boolean) };
  });
  if (state.blocked) throw Error("SAFETY_BLOCKED：拼多多要求人工安全验证，已停止");
  return { names: /\/login(?:\/|$)/.test(url.pathname) ? [] : state.names, url: url.origin + url.pathname };
}
async function connect(endpoint) {
  const u = new URL(endpoint);
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("浏览器地址必须为本机HTTP");
  return chromium.connectOverCDP(endpoint, { timeout: 15000 });
}
export async function observeShop(endpoint, expectedShop) {
  const browser = await connect(endpoint);
  try {
    const evidence = [];
    for (const page of browser.contexts().flatMap(c => c.pages())) {
      const state = await readShop(page);
      if (state) evidence.push(state);
    }
    return classifyShop(evidence, expectedShop);
  } finally { await browser.close(); }
}
export async function inspectShop(endpoint, expectedShop) {
  const state = await observeShop(endpoint, expectedShop);
  if (state.status !== "verified") throw Error("拼多多店铺尚未核对：" +
    (state.status === "ambiguous" ? "发现多个不同店铺身份" : state.actualName ? "当前为“" + state.actualName + "”，目标为“" + expectedShop + "”" : "请先人工登录"));
  return state;
}
export async function focusShop(endpoint, expectedShop) {
  const browser = await connect(endpoint);
  try {
    const pages = [];
    for (const page of browser.contexts().flatMap(c => c.pages())) {
      const state = await readShop(page);
      if (state) pages.push({ page, state });
    }
    if (!pages.length) throw Error("没有拼多多窗口，请人工检查专用浏览器");
    const matching = pages.filter(p => p.state.names.length === 1 && p.state.names[0] === expectedShop);
    await (matching[0] || pages[0]).page.bringToFront();
    return true;
  } finally { await browser.close(); }
}
