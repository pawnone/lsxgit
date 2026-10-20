// Local fixture only: does not visit merchant sites, solve challenges, or change a real listing.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { managedEndpoint } from "../engine/doudian/managed-browser.mjs";
import {
  installSafetyGuard,
  assertSafetyClear,
} from "../engine/doudian/safety-guard.mjs";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wq-safety-fixture-"));
const child = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    `--user-data-dir=${dir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--headless=new",
    "--no-first-run",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let b;
try {
  let endpoint;
  for (let i = 0; i < 100 && !endpoint; i++) {
    endpoint = await managedEndpoint(dir);
    if (!endpoint) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(endpoint);
  b = await chromium.connectOverCDP(endpoint);
  const p = await b.contexts()[0].newPage();
  await p.setContent("<main>本地安全停止测试</main>");
  await installSafetyGuard(p);
  await assertSafetyClear(p);
  const disconnected = new Promise((r) => b.once("disconnected", r));
  await p.setContent("<main>请完成安全验证</main>");
  await Promise.race([
    disconnected,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("安全检测未及时停止")), 3000),
    ),
  ]);
  await assert.rejects(assertSafetyClear(p), /SAFETY_BLOCKED/);
  assert.equal((await fetch(endpoint + "/json/version")).status, 200);
  console.log(
    "安全测试通过：可见验证提示触发自动化断开（≤3秒），安全停止被锁定；外部Chrome仍存活。仅本地模拟页面。",
  );
} finally {
  if (b?.isConnected()) await b.close();
  child.kill();
  await new Promise((r) => child.once("exit", r));
  await fs.rm(dir, { recursive: true, force: true });
}
