import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { managedEndpoint } from "../engine/doudian/managed-browser.mjs";
export class BrowserManager {
  constructor({ root, runner, executable } = {}) {
    Object.assign(this, { root, runner, executable });
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
    const existing = await this.endpoint(shop);
    if (existing) {
      await this.runner.call(
        "focus",
        { endpoint: existing, expectedShop: shop.name },
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
        "https://fxg.jinritemai.com",
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
    const endpoint = await this.endpoint(shop);
    if (!endpoint)
      return { status: "browser-closed", loggedIn: false, actualName: null };
    const state = await this.runner.call(
      "observe",
      { endpoint, expectedShop: shop.name },
      { timeout: 30000 },
    );
    return { ...state, endpoint };
  }
  async verify(shop) {
    const endpoint = await this.endpoint(shop);
    if (!endpoint)
      throw Error("请先点击登录店铺，打开该店专用浏览器并完成人工登录");
    const evidence = await this.runner.call(
      "verify",
      { endpoint, expectedShop: shop.name },
      { timeout: 60000 },
    );
    return { endpoint, evidence };
  }
}
