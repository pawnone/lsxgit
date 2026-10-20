import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ListingService } from "../desktop/service.mjs";
import { writeJson, readJson, Store } from "../desktop/storage.mjs";
import { ProcessRunner } from "../desktop/process-runner.mjs";

async function setup(t, { fail, wait } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wq-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executions = [];
  const products = [1, 2].map((n) => ({
    id: "p" + n,
    ok: true,
    materialRoot: root,
    config: {
      product: { title: "测试" + n, itemCode: "test" + n },
      skuMatrix: [{ price: 99 }],
      testHash: "hash" + n,
    },
  }));
  const runner = {
    async call(op, p) {
      if (op === "scan") return { products, errors: [] };
      if (op === "validate") return { ok: true, inputHash: p.config.testHash };
      if (op === "run") {
        executions.push(p);
        if (wait) await wait(p);
        if (fail) throw Error(fail);
        const receiptFile = path.join(
          p.outputDir,
          "draft-save-" + p.expectedHash + ".json",
        );
        await writeJson(receiptFile, {
          status: "confirmed",
          inputHash: p.expectedHash,
          evidence: ["保存成功"],
        });
        return {
          ok: true,
          saved: { status: "confirmed", receiptFile, evidence: ["保存成功"] },
        };
      }
      throw Error(op);
    },
  };
  const browser = {
    async verify(s) {
      return { endpoint: "http://127.0.0.1:1", evidence: [{ actual: s.name }] };
    },
    async open() {},
  };
  const s = new ListingService({ root, runner, browser });
  await s.init();
  await s.addShop("测试店A");
  await s.addShop("测试店B");
  await s.setRoot(root);
  await s.select({ shopIds: s.config.shops.map((s) => s.id) });
  for (const shop of s.config.shops) await s.verify(shop.id);
  return { s, root, runner, browser, executions };
}
async function finished(s) {
  for (let n = 0; n < 300 && s.running; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.running, false);
}

test("native queue freezes two shops × two products, exact draft-only targets and four receipts", async (t) => {
  const { s, executions } = await setup(t);
  await s.check();
  assert.equal(s.preflight.tasks.length, 4);
  const token = s.preflight.token;
  await s.start(token);
  await assert.rejects(s.select({ shopIds: [] }), /当前有任务/);
  await finished(s);
  assert.equal(s.run.status, "complete");
  assert.equal(executions.length, 4);
  assert.equal(s.run.tasks.filter((t) => t.status === "confirmed").length, 4);
  assert.ok(
    executions.every(
      (p) =>
        p.config.draftOnly === true && p.expectedShop === p.config.expectedShop,
    ),
  );
  assert.equal(s.snapshot().run.tasks[0].config, undefined);
  await s.check();
  assert.ok(s.preflight.tasks.every((t) => t.status === "already-saved"));
  await assert.rejects(s.start(s.preflight.token), /已有确认草稿/);
  assert.equal(executions.length, 4);
});
test("unverified or mismatched shop blocks before any execution", async (t) => {
  const { s, browser, executions } = await setup(t);
  s.config.shops[0].verified = false;
  await assert.rejects(s.check(), /人工登录和店铺核对/);
  s.config.shops[0].verified = true;
  browser.verify = async () => {
    throw Error("店铺不匹配");
  };
  await assert.rejects(s.check(), /店铺不匹配/);
  assert.equal(executions.length, 0);
});
test("material content changes invalidate frozen task before execution", async (t) => {
  const { s, runner, executions } = await setup(t);
  await s.check();
  const orig = runner.call;
  runner.call = async (op, p) =>
    op === "validate" ? { ok: true, inputHash: "changed" } : orig(op, p);
  await s.start(s.preflight.token);
  await finished(s);
  assert.match(s.run.error, /资料或素材已变化/);
  assert.equal(executions.length, 0);
});
test("unknown save receipt blocks automatic replay", async (t) => {
  const { s } = await setup(t);
  await s.check();
  const task = s.preflight.tasks[0];
  await writeJson(
    path.join(task.outputDir, "draft-save-" + task.inputHash + ".json"),
    { status: "unconfirmed" },
  );
  await assert.rejects(s.check(), /上次结果未确认/);
});
test("security block stops batch, latches store and cannot resume", async (t) => {
  const { s, executions } = await setup(t, { fail: "SAFETY_BLOCKED：验证码" });
  await s.check();
  await s.start(s.preflight.token);
  await finished(s);
  assert.equal(s.run.status, "safety-blocked");
  assert.equal(executions.length, 1);
  assert.equal(s.config.shops[0].securityBlocked, true);
  await assert.rejects(s.resume(), /安全停止不能/);
  await assert.rejects(s.verify(s.config.shops[0].id), /人工处理/);
});
test("pause occurs after current product and resume preserves frozen targets", async (t) => {
  let release, entered;
  const enteredP = new Promise((r) => (entered = r));
  const { s, executions } = await setup(t, {
    wait: async () => {
      if (!release) {
        entered();
        await new Promise((r) => (release = r));
      }
    },
  });
  await s.check();
  await s.start(s.preflight.token);
  await enteredP;
  await s.pause();
  release();
  for (let n = 0; n < 100 && s.run.status !== "paused"; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.run.status, "paused");
  assert.equal(executions.length, 1);
  await s.resume();
  await finished(s);
  assert.equal(executions.length, 4);
});
test("interrupted run requires review; dead process lock recovers but ledger never resets", async (t) => {
  const { s, root } = await setup(t);
  await s.check();
  const task = s.preflight.tasks[0];
  await writeJson(path.join(task.outputDir, "intent.json"), {
    status: "running",
  });
  await writeJson(path.join(root, "app-run.lock"), { pid: 2147483647 });
  const next = new ListingService({
    root,
    runner: s.runner,
    browser: s.browser,
  });
  await next.init();
  assert.ok(
    (await fs.readdir(root)).some((n) =>
      n.startsWith("app-run.lock.recovered"),
    ),
  );
  await next.scan();
  for (const shop of next.config.shops) await next.verify(shop.id);
  await assert.rejects(next.check(), /上次结果未确认/);
});
test("live process lock and corrupt records refuse reset", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wq-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, "app-run.lock"), { pid: process.pid });
  await assert.rejects(new Store(root).recoverLock(), /仍在运行/);
  await fs.writeFile(path.join(root, "broken.json"), "{");
  await assert.rejects(readJson(path.join(root, "broken.json")), /未重置/);
});
test("standalone worker runs without Workbuddy or model API", async () => {
  const r = await new ProcessRunner().call("runtime", {});
  assert.ok(r.node);
  assert.equal(r.arch, process.arch);
});

test("missing receipt cannot turn confirmed ledger into a new save", async (t) => {
  const { s } = await setup(t);
  await s.check();
  const task = s.preflight.tasks[0];
  await writeJson(path.join(task.outputDir, "intent.json"), {
    status: "confirmed",
  });
  await assert.rejects(s.check(), /上次结果未确认/);
});
