// Dedicated login launcher. This entry point never fills or saves a product.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { BrowserManager } from "../../desktop/browser-manager.mjs";
import { readJson, writeJson } from "../../desktop/storage.mjs";

const HOME = "https://mms.pinduoduo.com";
const isPdd = value => {
  try { return new URL(value).origin === HOME; }
  catch { return false; }
};

export async function openPddBrowser({ appData, runnerExecutable } = {}) {
  appData ||= process.env.WQ_APP_DATA_DIR || (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "文青尚品")
    : path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "文青尚品"));
  const sessionFile = path.join(appData, "pdd-development", "session.json");
  let session = await readJson(sessionFile);
  if (!session) {
    session = { schema: 1, platform: "pdd", loginProfileId: "pdd-" + crypto.randomUUID(), createdAt: new Date().toISOString() };
    await writeJson(sessionFile, session);
  }
  if (session.platform !== "pdd" || !/^pdd-[a-f0-9-]{36}$/.test(session.loginProfileId || ""))
    throw Error("拼多多登录记录无效；未重置已有登录资料");
  const manager = new BrowserManager({
    root: path.join(appData, "browser-profiles"), executable: runnerExecutable,
    runner: { call: async (op, payload) => {
      if (op !== "focus" || payload.platform !== "pdd") throw Error("此启动器只负责拼多多登录窗口");
      await focus(payload.endpoint);
    } },
  });
  const shop = { id: session.loginProfileId, loginProfileId: session.loginProfileId, platform: "pdd", name: session.expectedShop || "" };
  const opened = await manager.open(shop);
  const endpoint = await manager.endpoint(shop);
  if (!endpoint) throw Error("专用Chrome尚未就绪；已保留窗口和登录资料");
  const page = await focus(endpoint);
  const result = { ...opened, ...page, sessionFile, profile: manager.profile(shop), endpoint, loggedIn: false, identityVerified: false };
  const reportDir = path.join(appData, "pdd-development");
  await fs.mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "last-browser-open.json"), { ...result, checkedAt: new Date().toISOString(), note: "仅确认浏览器及页面已打开，登录与店铺身份仍待用户完成后核对" });
  return result;
}

async function focus(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw Error("专用浏览器没有可用窗口");
    let page = context.pages().find(p => isPdd(p.url()));
    if (!page) {
      page = await context.newPage();
      await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    await page.bringToFront();
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    if (!isPdd(page.url())) throw Error("登录页面跳转到非预期站点，请人工检查保留的窗口");
    return { url: page.url(), title: await page.title() };
  } finally {
    // This disconnects our CDP client; the externally launched Chrome stays open.
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--browser")
      throw Error("用法：node engine/pdd/launcher.mjs --browser；此入口只打开人工登录窗口");
    const r = await openPddBrowser();
    console.log(JSON.stringify({ opened: true, reused: r.reused, url: r.url, title: r.title,
      identityVerified: false, message: "专用Chrome已打开，请人工登录后提供完整店铺名称；浏览器不会自动关闭。" }, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
