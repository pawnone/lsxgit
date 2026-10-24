// Entirely intercepted local fixture. No merchant requests, login or draft writes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { managedEndpoint } from "../engine/doudian/managed-browser.mjs";
import {
  prepareWorkspace,
  markWorkspace,
  assertBlankProductEntry,
  workspaceState,
} from "../engine/doudian/workspace.mjs";
import { observeShop } from "../engine/doudian/shop-observation.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "wq-workspace-fixture-"));
const child = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    `--user-data-dir=${root}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--headless=new",
    "--no-first-run",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let owner, client;
const checks = [];
const html = `<main><div class="shopTitle"><span class="userName">本地测试店</span></div><input placeholder="15-60个字符"><div attr-field-id="货号"><input></div><div attr-field-id="主图"></div><div class="attr-column-field_price"><input></div><input placeholder="请输入erp编码"></main>`;
try {
  let endpoint;
  for (let i = 0; i < 100 && !endpoint; i++) {
    endpoint = await managedEndpoint(root);
    if (!endpoint) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(endpoint);
  owner = await chromium.connectOverCDP(endpoint);
  const context = owner.contexts()[0];
  await context.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  const home = context.pages()[0];
  await home.goto("https://fxg.jinritemai.com/ffa/home");
  assert.equal((await observeShop(endpoint, "本地测试店")).status, "verified");
  assert.equal((await observeShop(endpoint, "其他店")).status, "mismatch");
  checks.push("只读识别实际店名与不匹配状态");
  client = await chromium.connectOverCDP(endpoint);
  const first = await prepareWorkspace(client, {
    token: "local-store",
    expectedShop: "本地测试店",
    attemptId: "one",
  });
  assert.equal(first.created, true);
  await assertBlankProductEntry(first.page);
  await first.page.getByPlaceholder("15-60个字符").fill("本地商品01");
  await first.page.locator(".attr-column-field_price input").fill("99.9");
  await first.page.getByPlaceholder("请输入erp编码").fill("TEST-S");
  await assert.rejects(assertBlankProductEntry(first.page), /残留商品标题/);
  await markWorkspace(first.page, "local-store", { phase: "confirmed" });
  const pageCount = context.pages().length;
  await client.close();
  client = await chromium.connectOverCDP(endpoint);
  const second = await prepareWorkspace(client, {
    token: "local-store",
    expectedShop: "本地测试店",
    attemptId: "two",
  });
  assert.equal(second.created, false);
  assert.equal(context.pages().length, pageCount);
  assert.equal(second.previousAttemptId, "one");
  await assertBlankProductEntry(second.page);
  assert.equal(
    await second.page.locator(".attr-column-field_price input").inputValue(),
    "",
  );
  assert.equal(
    await second.page.getByPlaceholder("请输入erp编码").inputValue(),
    "",
  );
  checks.push("跨执行器连接复用同一标签页，新建流程无前商品标题价格编码");
  await markWorkspace(second.page, "local-store", { phase: "needs-review" });
  await assert.rejects(
    prepareWorkspace(client, {
      token: "local-store",
      expectedShop: "本地测试店",
      attemptId: "three",
    }),
    /结果未知/,
  );
  assert.equal((await workspaceState(second.page)).attemptId, "two");
  checks.push("未知结果保留页面且拒绝清空重试");
  await markWorkspace(second.page, "local-store", { phase: "confirmed" });
  await second.page.goto(
    "https://fxg.jinritemai.com/ffa/g/create?id=existing-draft",
  );
  await assert.rejects(assertBlankProductEntry(second.page), /覆盖现有草稿/);
  checks.push("编辑已有草稿的URL被阻断");
  const duplicate = await context.newPage();
  await duplicate.goto("https://fxg.jinritemai.com/ffa/g/create");
  await markWorkspace(duplicate, "local-store", { phase: "confirmed" });
  await assert.rejects(
    prepareWorkspace(client, {
      token: "local-store",
      expectedShop: "本地测试店",
      attemptId: "four",
    }),
    /多个APP工作页/,
  );
  assert.equal(context.pages().length, pageCount + 1);
  checks.push("重复工作页阻断，不随机选页或继续新开");
  await assert.rejects(prepareWorkspace(client,{token:'local-store',expectedShop:'本地测试店',attemptId:'explicit-ambiguous',recreate:true}),/多个APP工作页/);
  checks.push('明确重建也不随机选择归属重复的工作页');
  await markWorkspace(duplicate,'local-store',{retired:true});
  await markWorkspace(second.page,'local-store',{phase:'needs-review'});
  const rebuilt=await prepareWorkspace(client,{token:'local-store',expectedShop:'本地测试店',attemptId:'explicit-rebuild',recreate:true});
  assert.equal(rebuilt.created,false);assert.equal(rebuilt.page,second.page);await assertBlankProductEntry(rebuilt.page);
  assert.equal((await workspaceState(rebuilt.page)).previousState.phase,'needs-review');
  assert.equal(context.pages().length,pageCount+1);
  checks.push('明确重建沿用本店工作页，保留旧状态摘要且页面不增长');
  for(let n=0;n<12;n++){
    await markWorkspace(rebuilt.page,'local-store',{phase:'confirmed'});
    const next=await prepareWorkspace(client,{token:'local-store',expectedShop:'本地测试店',attemptId:'repeat-'+n,recreate:true});
    assert.equal(next.page,rebuilt.page);assert.equal(next.created,false);
    assert.equal(context.pages().length,pageCount+1);await assertBlankProductEntry(next.page);
  }
  checks.push('连续12次重建复用原页，每次进入空白新建，页面数量不增长');
  await client.close();
  client = null;
  assert.equal((await fetch(endpoint + "/json/version")).status, 200);
  checks.push("断开执行器后外部Chrome仍存活");
  await fs.mkdir("output", { recursive: true });
  await fs.writeFile(
    "output/workspace-check.json",
    JSON.stringify(
      { at: new Date().toISOString(), checks, merchantMutation: false },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, merchantMutation: false }));
} finally {
  if (client?.isConnected()) await client.close();
  if (owner?.isConnected()) await owner.close();
  child.kill();
  await new Promise((r) => child.once("exit", r));
  await fs.rm(root, { recursive: true, force: true });
}
