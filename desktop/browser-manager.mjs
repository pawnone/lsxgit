import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { managedEndpoint } from "../engine/doudian/managed-browser.mjs";
import {EgoRunner} from './ego-runner.mjs';
const homePages = {
  dou: "https://fxg.jinritemai.com",
  pdd: "https://mms.pinduoduo.com",
};
export class BrowserManager {
  constructor({ root, runner, executable } = {}) {
    Object.assign(this, { root, runner, executable });
    this.ego = new EgoRunner({root:path.join(root ? path.dirname(root) : os.tmpdir(),'ego-requests')});
  }
  egoPayload(shop) {
    return {expectedShop:shop.name,workspaceName:'文青尚品 · 拼多多 · '+shop.name+' · '+shop.workspaceToken.slice(0,8),
      workspaceFile:path.join(path.dirname(this.root),'ego-workspaces',shop.workspaceToken+'.json')};
  }
  async runPdd(shop,payload,options) {
    if(shop.platform!=='pdd')throw Error('Ego 仅用于拼多多');
    return this.ego.call('run',{...payload,...this.egoPayload(shop)},options);
  }
  profile(shop) {
    return path.join(this.root, shop.loginProfileId || shop.id);
  }
  async endpoint(shop) {
    return managedEndpoint(this.profile(shop));
  }
  async detectExecutable() {
    const candidates = [
      this.executable,
      ...(process.platform === "win32" ? [
        ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
          .filter(Boolean).map(base => path.join(base, "Google", "Chrome", "Application", "chrome.exe")),
      ] : []),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(
        os.homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    ].filter(Boolean);
    for (const p of candidates)
      try {
        await fs.access(p);
        return p;
      } catch {}
    throw Error(
      "未找到Google Chrome。请先安装Chrome，再点击登录店铺；无需安装Node或填写端口。",
    );
  }
  async open(shop) {
    const platform = shop.platform || "dou";
    if (!Object.hasOwn(homePages, platform)) throw Error("不支持的浏览器登录平台");
    if(platform==='pdd') return this.ego.call('open',this.egoPayload(shop),{timeout:60000});
    const existing = await this.endpoint(shop);
    if (existing) {
      await this.runner.call(
        "focus",
        { endpoint: existing, expectedShop: shop.name, platform },
        { timeout: 20000 },
      );
      return { ready: true, reused: true };
    }
    const executable = await this.detectExecutable(),
      profile = this.profile(shop);
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    const child = spawn(
      executable,
      [
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        homePages[platform],
      ],
      { detached: true, stdio: "ignore", shell: false },
    );
    let failed;
    child.once("error", (e) => (failed = e));
    child.unref();
    for (let i = 0; i < 60; i++) {
      if (failed) throw failed;
      if (await this.endpoint(shop)) return { ready: true, reused: false };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error(
      "专用浏览器尚未就绪。已保留窗口，请检查Chrome提示；不要清理登录目录或连续重启。",
    );
  }
  async observe(shop) {
    if(shop.platform==='pdd')return this.ego.call('observe',this.egoPayload(shop),{timeout:30000});
    const endpoint = await this.endpoint(shop);
    if (!endpoint)
      return { status: "browser-closed", loggedIn: false, actualName: null };
    const state = await this.runner.call(
      "observe",
      { endpoint, expectedShop: shop.name, platform: shop.platform || "dou" },
      { timeout: 30000 },
    );
    return { ...state, endpoint };
  }
  async verify(shop) {
    if(shop.platform==='pdd') {
      const evidence=await this.ego.call('verify',this.egoPayload(shop),{timeout:60000});
      return{endpoint:'ego:'+shop.workspaceToken,evidence};
    }
    const endpoint = await this.endpoint(shop);
    if (!endpoint)
      throw Error("请先点击登录店铺，打开该店专用浏览器并完成人工登录");
    const evidence = await this.runner.call(
      "verify",
      { endpoint, expectedShop: shop.name, platform: shop.platform || "dou" },
      { timeout: 60000 },
    );
    return { endpoint, evidence };
  }
}
