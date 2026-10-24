import { _electron as electron } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ExcelJS from 'exceljs';
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
  const fakeEgo=path.join(data,'fake-ego.mjs');
  await fs.writeFile(fakeEgo,'#!/usr/bin/env node\nconsole.error("synthetic browser disconnected");process.exit(23);',{mode:0o700});
  const isolated=await app.evaluate(async(_electron,{bridge,executable,root})=>{
    const {pathToFileURL}=process.getBuiltinModule('node:url'),io=process.getBuiltinModule('node:fs/promises'),path=process.getBuiltinModule('node:path');
    await io.mkdir(root,{recursive:true});const loader=path.join(root,'fixture-loader.cjs');
    await io.writeFile(loader,'module.exports = import('+JSON.stringify(pathToFileURL(bridge).href)+');');
    const {EgoRunner}=await process.getBuiltinModule('node:module').createRequire(bridge)(loader);
    try{await new EgoRunner({root,executable}).call('observe',{});return null;}
    catch(error){return{code:error.code,exitCode:error.diagnostic?.exitCode};}
  },{bridge:runtimePath.app+'/desktop/ego-runner.mjs',executable:fakeEgo,root:path.join(data,'ego-isolation')});
  assert(isolated?.code==='EGO_CONNECTION_LOST'&&isolated.exitCode===23,'Ego子进程异常退出被App主进程接住，保留退出码');
  assert(!!(await win.evaluate(()=>window.wqapp.getState())).config,'Ego异常退出后App界面和IPC仍可使用');
  await app.evaluate(({app})=>app.emit('child-process-gone',{}, {type:'Utility',reason:'crashed',exitCode:23,name:'synthetic-diagnostics-only'}));
  const diagnostic=JSON.parse((await fs.readFile(path.join(data,'runtime-errors.jsonl'),'utf8')).trim().split('\n').at(-1));
  assert(diagnostic.type==='child-process-gone'&&diagnostic.details.exitCode===23,'原生进程异常独立记入本地诊断文件');
  assert(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling() === false), "APP关闭后台渲染限速");
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide());
  const hiddenState = await win.evaluate(() => window.wqapp.getState());
  assert(!!hiddenState.config, "隐藏后主进程与IPC仍可用");
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].show());
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
  await win.getByText("拼多多 · Ego 执行器", { exact: true }).waitFor();
  const pddState = await win.evaluate(() => window.wqapp.getState());
  assert(pddState.config.platform === 'pdd' && pddState.config.selectedShopIds.length === 0, '拼多多使用独立的平台选择和素材配置');
  assert(await win.getByRole('button', {name:'检查本批素材',exact:true}).isVisible(), '拼多多已接入真实任务预检入口');
  const templatePath=path.join(data,'导出模板.xlsx');
  await app.evaluate(({dialog},file)=>{globalThis.originalTemplateSaveDialog=dialog.showSaveDialog;dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},templatePath);
  for(const name of ['套装空白模板','针织衫空白模板']){
    await fs.rm(templatePath,{force:true});await win.getByRole('button',{name,exact:true}).click();
    await win.waitForFunction(()=>!document.querySelector('[data-act="pdd-template"][disabled]'));
    for(let n=0;n<40;n++){if(await fs.stat(templatePath).catch(()=>null))break;await new Promise(r=>setTimeout(r,50));}
    const template=new ExcelJS.Workbook();await template.xlsx.readFile(templatePath);const basic=template.getWorksheet('基础信息');
    assert(basic.getCell('B4').value===(name.startsWith('套装')?'时尚套装':'针织衫')&&!basic.getCell('B12').value&&template.worksheets.length===3,'App导出'+name+'且不包含真实商品值');
  }
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=globalThis.originalTemplateSaveDialog;delete globalThis.originalTemplateSaveDialog;});
  assert((await win.locator('[data-act="image-names"]').count()) === 0,'拼多多不误用抖店5张主图编号');
  await win.locator('[data-platform="dou"]').click();
  // UI-only fixture: never starts a task or writes to a merchant page.
  const realState = await win.evaluate(() => window.wqapp.getState());
  await win.evaluate((s) => {
    const shop = s.config.shops[0];
    shop.loginStatus = "mismatch";
    shop.loggedIn = true;
    shop.verified = false;
    shop.actualName = "另一个店铺";
    receive(s);
  }, structuredClone(realState));
  assert(
    await win.getByText("当前窗口：另一个店铺", { exact: true }).isVisible(),
    "店名不匹配明确显示实际窗口店名",
  );
  await win.locator('[data-act="new-login"]').first().click();
  assert(
    await win
      .getByRole("button", { name: "打开独立登录窗口", exact: true })
      .isVisible(),
    "重新登录须明确确认独立新窗口，未自动退出其他店",
  );
  await win.locator('[data-act="close"]').first().click();
  await win.waitForTimeout(200);
  await win.evaluate((s) => {
    s.preflight = {
      token: "ui-only",
      mode: "normal",
      tasks: [
        {
          id: "ui-only",
          shopName: "界面测试店",
          code: "UI-TEST",
          sku: 4,
          status: "already-saved",
        },
      ],
    };
    receive(s);
    showReview();
  }, structuredClone(realState));
  assert(
    await win.getByText(/本次将新建 0 个，跳过 1 个/).isVisible(),
    "确认页区分本机历史跳过和本次新建数量",
  );
  assert(
    (await win.locator('[data-act="start"]').count()) === 0,
    "全部跳过时不提供无效开始按钮",
  );
  await win.locator('[data-act="close"]').first().click();
  await win.waitForTimeout(200);
  await win.evaluate((s) => receive(s), realState);
  if (process.env.WQ_TEST_MATERIALS) {
    const expectedSkus=(process.env.WQ_TEST_EXPECTED_SKUS || "4,12").split(",").map(Number).sort((a,b)=>a-b);
    for (let n = 0; ; n++) {
      const current = await win.evaluate(() => window.wqapp.getState());
      if (!current.busyOp && current.products.length === expectedSkus.length) break;
      if (n > 120) throw Error("Material scan timeout");
      await new Promise((r) => setTimeout(r, 500));
    }
    const data = await win.evaluate(() => window.wqapp.getState());
    assert(
      data.products.every((p) => p.ok),
      "本机商品Excel与素材均通过真实离线校验",
    );
    assert(
      data.products
        .map((p) => p.sku)
        .sort((a, b) => a - b)
        .join(",") === expectedSkus.join(","),
      "真实识别指定商品的规格数量",
    );
    assert(
      data.products.every((p) => p.image.startsWith("wqasset://")),
      "主图通过受限本地媒体通道加载",
    );
    await win.waitForFunction(
      (expected) =>
        [...document.querySelectorAll(".product-thumb")].length === expected &&
        [...document.querySelectorAll(".product-thumb")].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      expectedSkus.length,
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
  const audit=process.env.WQ_AUDIT_DIR||path.join(root,'output');
  await fs.mkdir(audit, { recursive: true });
  await win.screenshot({
    path: path.join(audit, "native-app-check.png"),
  });
  await fs.writeFile(
    path.join(audit, "native-check.json"),
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
