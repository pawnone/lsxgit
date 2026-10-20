import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Store, readJson, writeJson } from "./storage.mjs";
const uuid = () => crypto.randomUUID(),
  hash = (s) =>
    crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
const failureType = (e) =>
  /SAFETY_BLOCKED/.test(e.message)
    ? "safety-blocked"
    : /未确认|unconfirmed|未知|未提供保存成功/.test(e.message)
      ? "needs-review"
      : "failed";
export class ListingService extends EventEmitter {
  constructor({ root, runner, browser, version = "0.3.0-alpha" } = {}) {
    super();
    Object.assign(this, { root, runner, browser, version });
    this.store = new Store(root);
    this.config = {
      schema: 1,
      materialsRoot: "",
      shops: [],
      selectedShopIds: [],
      selectedProductIds: [],
    };
    this.catalog = [];
    this.scanErrors = [];
    this.history = [];
    this.run = null;
    this.preflight = null;
    this.running = false;
    this.busyOp = false;
  }
  async init() {
    await this.store.recoverLock();
    this.config = await this.store.read("config.json", this.config);
    this.config.shops ??= [];
    this.config.selectedShopIds ??= [];
    this.config.selectedProductIds ??= [];
    for (const s of this.config.shops) {
      s.loggedIn = false;
      s.verified = false;
      s.actualName = null;
    }
    const dirs = await fs.readdir(path.join(this.root, "runs")).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    for (const id of dirs) {
      const r = await readJson(path.join(this.root, "runs", id, "run.json"));
      if (!r) continue;
      if (["running", "pausing", "paused"].includes(r.status)) {
        r.status = "needs-review";
        r.error =
          "上次APP在任务结束前退出。请先核实草稿和执行结果，禁止自动重放。";
        for (const t of r.tasks)
          if (t.status === "running") t.status = "needs-review";
        await writeJson(path.join(this.root, "runs", id, "run.json"), r);
      }
      this.history.push(r);
    }
    this.history.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    await this.saveConfig();
    return this.snapshot();
  }
  ensureIdle() {
    if (this.running || this.busyOp)
      throw Error("当前有任务或检查正在进行，请等待完成；未改变本批目标");
  }
  findShop(id) {
    const s = this.config.shops.find((s) => s.id === id);
    if (!s || s.platform !== "dou")
      throw Error("未找到抖店目标店铺，拼多多暂不开放执行");
    return s;
  }
  snapshot() {
    return {
      version: this.version,
      busyOp: this.busyOp,
      config: structuredClone(this.config),
      products: this.catalog.map((p) => ({
        id: p.id,
        title: p.config?.product.title || p.title || p.itemCode,
        code: p.config?.product.itemCode || p.itemCode,
        materialRoot: p.materialRoot,
        sku: p.config?.skuMatrix.length || 0,
        ok: p.ok,
        errors: p.errors || [],
        warnings: p.warnings || [],
        priceRange: p.config?.skuMatrix.map((s) => s.price) || [],
        image: p.config?.product.mainImages?.[0]
          ? path.resolve(p.materialRoot, p.config.product.mainImages[0])
          : null,
        white: !!p.config?.product.whiteBackgroundImage,
        attributes: p.config
          ? {
              pieces: p.config.product.pieceCount,
              age: p.config.product.applicableAge,
              style: p.config.product.style,
            }
          : null,
      })),
      scanErrors: this.scanErrors,
      preflight: this.preflight
        ? {
            token: this.preflight.token,
            createdAt: this.preflight.createdAt,
            tasks: this.preflight.tasks.map(({ config, ...t }) => t),
          }
        : null,
      run: this.run ? this.publicRun(this.run) : null,
      history: this.history.slice(0, 30).map((r) => this.publicRun(r)),
    };
  }
  publicRun(run) {
    const r = structuredClone(run);
    r.tasks = r.tasks.map(({ config, ...t }) => t);
    return r;
  }
  notify() {
    this.emit("state", this.snapshot());
  }
  saveConfig() {
    return this.store.write("config.json", this.config);
  }
  async addShop(name, platform = "dou") {
    this.ensureIdle();
    name = String(name || "").trim();
    if (platform !== "dou" && platform !== "pdd") throw Error("不支持的平台");
    if (!name || name.length > 100)
      throw Error("请填写100字以内的店铺完整名称");
    if (
      this.config.shops.some((s) => s.platform === platform && s.name === name)
    )
      throw Error("同平台已存在这家店铺");
    const s = {
      id: uuid(),
      platform,
      name,
      loggedIn: false,
      verified: false,
      actualName: null,
      securityBlocked: false,
    };
    this.config.shops.push(s);
    if (platform === "dou" && !this.config.selectedShopIds.length)
      this.config.selectedShopIds = [s.id];
    this.preflight = null;
    await this.saveConfig();
    this.notify();
    return s;
  }
  async select({ shopIds, productIds } = {}) {
    this.ensureIdle();
    if (shopIds) {
      if (
        !Array.isArray(shopIds) ||
        new Set(shopIds).size !== shopIds.length ||
        shopIds.some(
          (id) =>
            !this.config.shops.some((s) => s.id === id && s.platform === "dou"),
        )
      )
        throw Error("店铺选择无效");
      this.config.selectedShopIds = shopIds;
    }
    if (productIds) {
      if (
        !Array.isArray(productIds) ||
        new Set(productIds).size !== productIds.length ||
        productIds.some((id) => !this.catalog.some((p) => p.id === id))
      )
        throw Error("商品选择无效");
      this.config.selectedProductIds = productIds;
    }
    this.preflight = null;
    await this.saveConfig();
    this.notify();
  }
  async setRoot(root) {
    this.ensureIdle();
    const st = await fs.stat(root);
    if (!st.isDirectory()) throw Error("素材库不是文件夹");
    this.config.materialsRoot = path.resolve(root);
    this.preflight = null;
    this.catalog = [];
    this.scanErrors = [];
    await this.saveConfig();
    return this.scan();
  }
  async scan() {
    this.ensureIdle();
    if (!this.config.materialsRoot) throw Error("请先选择本机总素材库文件夹");
    this.busyOp = true;
    this.preflight = null;
    this.notify();
    try {
      const r = await this.runner.call("scan", {
        root: this.config.materialsRoot,
        workDir: path.join(this.root, "catalog"),
      });
      this.catalog = r.products;
      this.scanErrors = r.errors || [];
      const prior = this.config.selectedProductIds,
        valid = this.catalog.filter((p) => p.ok).map((p) => p.id);
      this.config.selectedProductIds = prior.length
        ? prior.filter((id) => valid.includes(id))
        : valid;
      await this.saveConfig();
      return this.snapshot();
    } finally {
      this.busyOp = false;
      this.notify();
    }
  }
  async openLogin(id) {
    this.ensureIdle();
    const s = this.findShop(id);
    this.preflight = null;
    this.busyOp = true;
    try {
      await this.browser.open(s);
      s.loggedIn = false;
      s.verified = false;
      s.actualName = null;
      await this.saveConfig();
      return {
        message:
          "浏览器已打开。请人工登录，再点击核对店铺；登录窗口不会自动关闭。",
      };
    } finally {
      this.busyOp = false;
      this.notify();
    }
  }
  async verify(id, { acknowledgeSafety = false } = {}) {
    this.ensureIdle();
    const s = this.findShop(id);
    if (s.securityBlocked && !acknowledgeSafety)
      throw Error(
        "该店铺上次遇到安全验证。请人工处理后点击“已处理，重新核对”，禁止自动恢复",
      );
    this.busyOp = true;
    this.preflight = null;
    try {
      const r = await this.browser.verify(s);
      s.loggedIn = true;
      s.verified = true;
      s.actualName = s.name;
      s.checkedAt = new Date().toISOString();
      s.securityBlocked = false;
      await this.saveConfig();
      return r.evidence;
    } catch (e) {
      s.verified = false;
      s.loggedIn = false;
      s.actualName = null;
      if (failureType(e) === "safety-blocked") s.securityBlocked = true;
      await this.saveConfig();
      throw e;
    } finally {
      this.busyOp = false;
      this.notify();
    }
  }
  async check() {
    this.ensureIdle();
    if (
      !this.config.selectedShopIds.length ||
      !this.config.selectedProductIds.length
    )
      throw Error("请至少选择一家店铺和一个商品");
    const targets = this.config.selectedShopIds.map((id) => this.findShop(id)),
      products = this.config.selectedProductIds.map((id) =>
        this.catalog.find((p) => p.id === id),
      );
    if (products.some((p) => !p?.ok))
      throw Error("所选商品存在缺失或校验错误，请先修正资料并重新扫描");
    for (const s of targets)
      if (
        s.securityBlocked ||
        !s.verified ||
        !s.loggedIn ||
        s.actualName !== s.name
      )
        throw Error(s.name + "：请先完成人工登录和店铺核对");
    this.busyOp = true;
    this.preflight = null;
    this.notify();
    try {
      const tasks = [];
      for (const s of targets) {
        await this.browser.verify(s);
        for (const p of products) {
          const config = structuredClone(p.config);
          config.expectedShop = s.name;
          config.draftOnly = true;
          const v = await this.runner.call("validate", { config });
          if (!v.ok) throw Error(v.errors.map((e) => e.message).join("\n"));
          const key = hash(s.id + "|" + p.id + "|" + v.inputHash),
            dir = path.join(this.root, "tasks", key),
            receipt = await readJson(
              path.join(dir, `draft-save-${v.inputHash}.json`),
            ),
            ledger = await readJson(path.join(dir, "intent.json"));
          if (
            (receipt &&
              (receipt.status !== "confirmed" ||
                receipt.inputHash !== v.inputHash ||
                !Array.isArray(receipt.evidence) ||
                !receipt.evidence.length)) ||
            (ledger &&
              (["running", "needs-review"].includes(ledger.status) ||
                (ledger.status === "confirmed" && !receipt)))
          )
            throw Error(
              `${s.name} / ${p.config.product.itemCode}：上次结果未确认，请核实草稿，不自动重试`,
            );
          tasks.push({
            id: key,
            shopId: s.id,
            shopName: s.name,
            productId: p.id,
            productTitle: p.config.product.title,
            code: p.config.product.itemCode,
            sku: config.skuMatrix.length,
            inputHash: v.inputHash,
            outputDir: dir,
            config,
            status: receipt?.status === "confirmed" ? "already-saved" : "ready",
            receiptFile: receipt
              ? path.join(dir, `draft-save-${v.inputHash}.json`)
              : null,
          });
        }
      }
      this.preflight = {
        token: uuid(),
        createdAt: new Date().toISOString(),
        selection: JSON.stringify([
          this.config.selectedShopIds,
          this.config.selectedProductIds,
        ]),
        tasks,
      };
      return this.snapshot();
    } catch (e) {
      if (failureType(e) === "safety-blocked") {
        for (const s of targets) {
          s.securityBlocked = true;
          s.verified = false;
        }
        await this.saveConfig();
      }
      throw e;
    } finally {
      this.busyOp = false;
      this.notify();
    }
  }
  async start(token) {
    this.ensureIdle();
    if (
      !this.preflight ||
      token !== this.preflight.token ||
      this.preflight.selection !==
        JSON.stringify([
          this.config.selectedShopIds,
          this.config.selectedProductIds,
        ])
    )
      throw Error("任务确认已失效，请重新检查本批资料");
    if (this.preflight.tasks.every((t) => t.status === "already-saved"))
      throw Error("本批全部已有确认草稿，未重复创建；请查看原回执");
    this.busyOp = true;
    try {
      await this.store.lock();
    } catch (e) {
      this.busyOp = false;
      throw e;
    }
    this.running = true;
    this.busyOp = false;
    const plan = this.preflight;
    this.preflight = null;
    this.run = {
      id:
        new Date().toISOString().replace(/[:.]/g, "-") +
        "-" +
        uuid().slice(0, 8),
      version: this.version,
      status: "running",
      draftOnly: true,
      startedAt: new Date().toISOString(),
      tasks: plan.tasks.map((t) => ({
        ...t,
        status: t.status === "already-saved" ? "already-saved" : "queued",
      })),
      index: 0,
      step: "准备任务",
      logs: [],
    };
    try {
      await this.persistRun();
    } catch (e) {
      this.running = false;
      await this.store.unlock();
      throw e;
    }
    this.notify();
    void this.drive();
    return this.snapshot();
  }
  async persistRun() {
    if (this.run)
      await this.store.write(
        path.join("runs", this.run.id, "run.json"),
        this.run,
      );
  }
  async drive() {
    try {
      for (; this.run.index < this.run.tasks.length; this.run.index++) {
        const r = this.run,
          t = r.tasks[r.index];
        if (t.status === "already-saved") continue;
        if (r.stopRequested) {
          r.status = "stopped";
          break;
        }
        if (r.pauseRequested) {
          r.status = "paused";
          await this.persistRun();
          this.notify();
          return;
        }
        const s = this.findShop(t.shopId);
        if (s.securityBlocked)
          throw Error("SAFETY_BLOCKED：该店铺仍处于安全停止状态");
        const verified = await this.browser.verify(s);
        const v = await this.runner.call("validate", { config: t.config });
        if (!v.ok || v.inputHash !== t.inputHash)
          throw Error("商品资料或素材已变化，请重新扫描和预检");
        t.status = "running";
        r.step = "核对店铺后开始填写";
        await writeJson(path.join(t.outputDir, "intent.json"), {
          status: "running",
          runId: r.id,
          shopId: s.id,
          productId: t.productId,
          inputHash: t.inputHash,
        });
        await this.persistRun();
        this.notify();
        try {
          const result = await this.runner.call(
            "run",
            {
              config: t.config,
              expectedHash: t.inputHash,
              endpoint: verified.endpoint,
              expectedShop: t.shopName,
              outputDir: t.outputDir,
            },
            {
              onEvent: (e) => {
                if (e.type === "step-start") r.step = e.name;
                if (e.type === "log") {
                  r.logs.push({
                    at: new Date().toISOString(),
                    task: t.id,
                    text: e.text,
                  });
                  r.logs = r.logs.slice(-1000);
                }
                if (e.type === "step-start" || e.type === "step-complete") {
                  void this.persistRun().catch((e) => {
                    r.stopRequested = true;
                    r.error = "记录写入失败：" + e.message;
                  });
                  this.notify();
                } else if (
                  !this.lastLogAt ||
                  Date.now() - this.lastLogAt > 1000
                ) {
                  this.lastLogAt = Date.now();
                  this.notify();
                }
              },
            },
          );
          if (!result.ok || result.saved?.status !== "confirmed")
            throw Error("脚本未提供保存成功证据，结果未知");
          t.status = "confirmed";
          t.receiptFile = result.saved.receiptFile;
          t.evidence = result.saved.evidence;
          await writeJson(path.join(t.outputDir, "intent.json"), {
            status: "confirmed",
            runId: r.id,
            inputHash: t.inputHash,
          });
        } catch (e) {
          const receipt = await readJson(
            path.join(t.outputDir, `draft-save-${t.inputHash}.json`),
          );
          t.status =
            receipt?.status === "confirmed"
              ? "confirmed"
              : receipt
                ? "needs-review"
                : failureType(e);
          if (receipt?.status === "confirmed") {
            t.receiptFile = path.join(
              t.outputDir,
              `draft-save-${t.inputHash}.json`,
            );
            t.evidence = receipt.evidence;
          } else if (
            !receipt &&
            /退出|closed|disconnect/i.test(e.message) &&
            !e.message.includes("SAFETY_BLOCKED")
          )
            t.status = "needs-review";
          t.error = e.message;
          await writeJson(path.join(t.outputDir, "intent.json"), {
            status: t.status,
            runId: r.id,
            inputHash: t.inputHash,
            error: e.message,
          });
          throw e;
        }
        await this.persistRun();
        this.notify();
      }
      if (this.run.status === "running" || this.run.status === "pausing")
        this.run.status = this.run.stopRequested ? "stopped" : "complete";
    } catch (e) {
      this.run.status = failureType(e);
      this.run.error = e.message;
      const t = this.run.tasks[this.run.index];
      if (t) {
        if (t.status === "queued") t.status = failureType(e);
        t.error = e.message;
        if (failureType(e) === "safety-blocked") {
          const s = this.findShop(t.shopId);
          s.securityBlocked = true;
          s.verified = false;
          await this.saveConfig();
        }
      }
    } finally {
      if (this.run.status !== "paused") {
        this.run.finishedAt = new Date().toISOString();
        for (const t of this.run.tasks)
          if (t.status === "queued") t.status = "not-run";
        await this.persistRun();
        this.history.unshift(structuredClone(this.run));
        this.running = false;
        await this.store.unlock();
      }
      this.notify();
    }
  }
  async pause() {
    if (!this.running || !["running", "pausing"].includes(this.run.status))
      throw Error("当前没有可暂停的任务");
    this.run.pauseRequested = true;
    this.run.status = "pausing";
    await this.persistRun();
    this.notify();
  }
  async resume() {
    if (this.run?.status !== "paused")
      throw Error("只有安全暂停的任务才可继续；安全停止不能直接恢复");
    this.run.pauseRequested = false;
    this.run.status = "running";
    await this.persistRun();
    this.notify();
    void this.drive();
  }
  async stopAfterCurrent() {
    if (!this.running) throw Error("当前没有运行任务");
    this.run.stopRequested = true;
    if (this.run.status === "paused") {
      this.run.status = "running";
      void this.drive();
    } else {
      await this.persistRun();
      this.notify();
    }
  }
  async flush() {
    await this.store.chain;
  }
}
