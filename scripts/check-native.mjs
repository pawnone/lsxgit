import { _electron as electron } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = await fs.mkdtemp(path.join(os.tmpdir(), "文青尚品-app-check-"));
const env = { ...process.env, WQ_APP_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
const assert = (v, name) => {
  if (!v) throw Error(name);
  checks.push(name);
};
if (process.env.WQ_TEST_MATERIALS)
  await fs.writeFile(
    path.join(data, "config.json"),
    JSON.stringify({
      schema: 1,
      materialsRoot: process.env.WQ_TEST_MATERIALS,
      shops: [],
      selectedShopIds: [],
      selectedProductIds: [],
    }),
  );
let app;
try {
  app = await electron.launch({
    executablePath: process.env.WQ_TEST_APP || require("electron"),
    args: process.env.WQ_TEST_APP ? [] : [root],
    env,
    timeout: 30000,
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForFunction(() => !!window.wqapp);
  await win.getByRole("heading", { name: "批量上架", exact: true }).waitFor();
  assert(
    await win.evaluate(
      () => typeof require === "undefined" && typeof process === "undefined",
    ),
    "渲染页没有Node或系统执行权限",
  );
  for (let n = 0; ; n++) {
    const state = await win.evaluate(() => window.wqapp.getState());
    if (!state.busyOp) break;
    if (n > 120) throw Error("启动扫描未能在60秒内结束");
    await new Promise((r) => setTimeout(r, 500));
  }
  const runtimePath = await app.evaluate(({ app }) => ({
    exe: process.execPath,
    app: app.getAppPath(),
  }));
  const { ProcessRunner } = await import("../desktop/process-runner.mjs");
  const runtime = await new ProcessRunner({
    execPath: runtimePath.exe,
    electron: true,
    worker: runtimePath.app + "/desktop/worker.mjs",
  }).call("runtime", {});
  assert(
    runtime.electron && runtime.node,
    "APP自带Node执行器可启动，无需系统Node",
  );
  await win.locator('[data-act="add-shop"]').first().click();
  await win.locator("#shop-name").fill("原生界面测试店");
  await win.locator('[data-act="save-shop"]').click();
  await win.getByText("原生界面测试店", { exact: true }).waitFor();
  const s = await win.evaluate(() => window.wqapp.getState());
  assert(
    s.config.shops.length === 1 && !s.config.shops[0].verified,
    "新店铺不会被虚构为已登录或已核对",
  );
  const result = await win.evaluate(async () => {
    try {
      await window.wqapp.check();
      return "UNEXPECTED";
    } catch (e) {
      return e.message;
    }
  });
  assert(/人工登录|至少选择/.test(result), "未登录目标无法执行");
  await win.locator('[data-platform="pdd"]').click();
  await win
    .getByText("拼多多入口保留，执行尚未开放", { exact: true })
    .waitFor();
  assert(
    (await win.locator('[data-act="start"]').count()) === 0,
    "拼多多仅保留入口，不提供执行",
  );
  await win.locator('[data-platform="dou"]').click();
  if (process.env.WQ_TEST_MATERIALS) {
    await win.waitForFunction(
      async () => {
        const s = await window.wqapp.getState();
        return !s.busyOp && s.products.length === 2;
      },
      {},
      { timeout: 60000 },
    );
    const data = await win.evaluate(() => window.wqapp.getState());
    assert(
      data.products.every((p) => p.ok),
      "本机两商品Excel与素材均通过真实离线校验",
    );
    assert(
      data.products
        .map((p) => p.sku)
        .sort((a, b) => a - b)
        .join(",") === "4,12",
      "真实识别商品01的4规格和商品02的12规格",
    );
    assert(
      data.products.every((p) => p.image.startsWith("wqasset://")),
      "主图通过受限本地媒体通道加载",
    );
    await win.waitForFunction(
      () =>
        [...document.querySelectorAll(".product-thumb")].length === 2 &&
        [...document.querySelectorAll(".product-thumb")].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
    );
    assert(true, "本地商品主图实际显示");
  }
  for (const bounds of [
    { width: 1024, height: 768 },
    { width: 1440, height: 1000 },
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b),
      bounds,
    );
    await new Promise((r) => setTimeout(r, 200));
    assert(
      await win.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `原生APP ${bounds.width}×${bounds.height}无整页横向溢出`,
    );
  }
  assert(errors.length === 0, "原生界面无JavaScript异常");
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  await win.screenshot({
    path: path.join(root, "output/native-app-check.png"),
  });
  await fs.writeFile(
    path.join(root, "output/native-check.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        packaged: !!process.env.WQ_TEST_APP,
        checks,
        runtime,
        merchantMutation: false,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks: checks.length, runtime, merchantMutation: false }),
  );
} finally {
  if (app) await app.close();
  await fs.rm(data, { recursive: true, force: true });
}
