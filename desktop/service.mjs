import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Store, readJson, writeJson } from "./storage.mjs";
import {planMainImageNames,applyMainImageNames} from "./main-image-names.mjs";
import {planPddImageSettings,applyPddImageSettings} from './pdd-image-settings.mjs';
import {detailImagePlan} from '../engine/pdd/media.mjs';
import { taskRecords } from "./task-records.mjs";
const uuid = () => crypto.randomUUID(),
  hash = (s) =>
    crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
const failureType = (e) =>
  /SAFETY_BLOCKED/.test(e.message)
    ? "safety-blocked"
    : ['EGO_USER_CONTROL','EGO_SPACE_INACTIVE','EGO_CONNECTION_LOST','EGO_EVENT_FAILED'].includes(e.code)||/未确认|unconfirmed|未知|未提供保存成功/.test(e.message)
      ? "needs-review"
      : "failed";
export class ListingService extends EventEmitter {
  constructor({ root, runner, browser, version = "0.3.2-alpha" } = {}) {
    super();
    Object.assign(this, { root, runner, browser, version });
    this.store = new Store(root);
    this.config = {
      schema: 1,
      platform: "dou",
      materialRoots: {},
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
    this.drivePromise = null;
  }
  async init() {
    await this.store.recoverLock();
    this.config = await this.store.read("config.json", this.config);
    this.config.platform ??= "dou";
    this.config.materialRoots ??= { dou: this.config.materialsRoot || "" };
    this.config.shops ??= [];
    this.config.selectedShopIds ??= [];
    this.config.selectedProductIds ??= [];
    for (const s of this.config.shops) {
      s.loggedIn = false;
      s.verified = false;
      s.actualName = null;
      s.loginStatus = s.securityBlocked ? "safety-blocked" : "checking";
      s.workspaceToken ??= uuid();
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
    if (!s || !["dou", "pdd"].includes(s.platform))
      throw Error("未找到目标平台店铺");
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
        priceRange: p.config?.skuMatrix.map((s) => p.config.platform === "pdd" ? s.groupPriceCents / 100 : s.price) || [],
        image: p.config?.product.mainImages?.[0]
          ? path.resolve(p.materialRoot, p.config.product.mainImages[0])
          : null,
        white: !!p.config?.product.whiteBackgroundImage,
        category: p.config?.product.categoryPath || p.categoryPath || "",
        mediaPlan: this.mediaSummary(p),
        attributes: p.config
          ? p.config.platform==='pdd' ? {
              age:p.config.pdd.basic['适用年龄'],style:p.config.pdd.basic['风格'],
              categoryAttributes:{...p.config.pdd.basic,...p.config.pdd.service},
            } : {
              pieces: p.config.product.pieceCount,
              age: p.config.product.applicableAge,
              style: p.config.product.style,
              category: p.config.product.categoryPath,
              categoryAttributes: p.config.product.categoryAttributes,
            }
          : null,
      })),
      scanErrors: this.scanErrors,
      preflight: this.preflight
        ? {
            token: this.preflight.token,
            mode: this.preflight.mode,
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
  mediaSummary(p){
    if(p.config?.platform!=='pdd')return null;
    const product=p.config.product,sources=product.sourceMainImages||product.mainImages||[];
    const label=f=>path.basename(f,path.extname(f));
    try{return {reuse:!!product.imageOrder,sourceCount:sources.length,
      main:product.mainImages.map(label),details:detailImagePlan(product).map(f=>f===product.sizeImage?'尺码图':label(f))};}catch{return null;}
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
      loginStatus: "browser-closed",
      workspaceToken: uuid(),
    };
    this.config.shops.push(s);
    if (platform === this.config.platform && !this.config.selectedShopIds.length)
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
            !this.config.shops.some((s) => s.id === id && s.platform === this.config.platform),
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
  async setPlatform(platform) {
    this.ensureIdle();
    if (!["dou", "pdd"].includes(platform)) throw Error("不支持的平台");
    if (this.config.platform === platform) return this.snapshot();
    this.config.materialRoots[this.config.platform] = this.config.materialsRoot;
    this.config.platform = platform;
    this.config.materialsRoot = this.config.materialRoots[platform] || "";
    this.config.selectedShopIds = [];
    this.config.selectedProductIds = [];
    this.catalog = []; this.scanErrors = []; this.preflight = null; this.imageRenamePlan = null;
    await this.saveConfig(); this.notify();
    return this.config.materialsRoot ? this.scan() : this.snapshot();
  }
  async setRoot(root) {
    this.ensureIdle();
    const st = await fs.stat(root);
    if (!st.isDirectory()) throw Error("素材库不是文件夹");
    this.config.materialsRoot = path.resolve(root);
    this.config.materialRoots[this.config.platform] = this.config.materialsRoot;
    this.preflight = null;
    this.catalog = [];
    this.scanErrors = [];
    await this.saveConfig();
    return this.scan();
  }
  async mainImageNames(id, token) {
    this.ensureIdle();
    if(this.config.platform==='pdd')throw Error('拼多多主图请使用01～10编号；当前一键编号适用于抖店5张主图');
    const product=this.catalog.find(p=>p.id===id);
    if(!product)throw Error("未找到当前商品，请重新扫描");
    this.busyOp=true; this.notify();
    try {
      if(!token){
        const plan=await planMainImageNames(this.config.materialsRoot,product.materialRoot);
        const key=uuid();
        this.imageRenamePlan={id,key,signature:plan.signature};
        return {token:key,mapping:plan.mapping.map(({from,to})=>({from,to})),changed:plan.changed};
      }
      const plan=this.imageRenamePlan;
      if(!plan || plan.id!==id || plan.key!==token)throw Error("编号预览已失效，请重新查看");
      this.imageRenamePlan=null;this.preflight=null;
      return await applyMainImageNames(this.config.materialsRoot,product.materialRoot,plan.signature);
    } finally {this.busyOp=false;this.notify();}
  }
  async imageSettings(id,token,selection){
    this.ensureIdle();
    if(this.config.platform!=='pdd')throw Error('当前首图选择适用于拼多多；抖店继续使用一键编号');
    const product=this.catalog.find(p=>p.id===id);
    if(!product)throw Error('未找到当前商品，请重新扫描');
    this.busyOp=true;this.notify();
    try{
      if(!token){
        const plan=await planPddImageSettings(this.config.materialsRoot,product.materialRoot);
        const key=uuid();this.imageSettingsPlan={id,key,signature:plan.signature,root:this.config.materialsRoot};
        return {id,token:key,changed:plan.changed,selected:plan.selected,uniqueCount:plan.uniqueCount,recovered:plan.recovered,
          hasSize:!!product.config?.product.sizeImage,
          pictures:plan.mapping.map(m=>({id:m.id,from:m.from,image:m.file,hash:m.sha256}))};
      }
      const current=this.imageSettingsPlan;this.imageSettingsPlan=null;
      if(!current||current.id!==id||current.key!==token||current.root!==this.config.materialsRoot)throw Error('首图选择已失效，请重新打开');
      this.preflight=null;
      return await applyPddImageSettings(this.config.materialsRoot,product.materialRoot,current.signature,selection,{rename:false});
    }finally{this.busyOp=false;this.notify();}
  }
  async numberPddImages(id){
    this.ensureIdle();
    if(this.config.platform!=='pdd')throw Error('当前平台请使用原主图编号入口');
    const product=this.catalog.find(p=>p.id===id);
    if(!product)throw Error('未找到当前商品，请重新扫描');
    this.busyOp=true;this.preflight=null;this.imageSettingsPlan=null;this.notify();
    try{
      const plan=await planPddImageSettings(this.config.materialsRoot,product.materialRoot);
      return await applyPddImageSettings(this.config.materialsRoot,product.materialRoot,plan.signature,plan.selected,{rename:true,setFirst:false});
    }finally{this.busyOp=false;this.notify();}
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
        workDir: path.join(this.root, "catalog", this.config.platform),
        platform: this.config.platform,
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
  applyObservation(shop, state) {
    shop.loggedIn = state.loggedIn === true;
    shop.actualName = state.actualName || null;
    shop.checkedAt = state.checkedAt || new Date().toISOString();
    shop.loginError = state.error || null;
    shop.verified = state.status === "verified" && !shop.securityBlocked;
    shop.loginStatus = shop.securityBlocked ? "safety-blocked" : state.status;
  }
  async observeOne(shop) {
    try {
      const state = await this.browser.observe(shop);
      this.applyObservation(shop, state);
      return state;
    } catch (e) {
      if (failureType(e) === "safety-blocked") shop.securityBlocked = true;
      this.applyObservation(shop, {
        status: shop.securityBlocked ? "safety-blocked" : /由你控制/.test(e.message) ? "awaiting-user" : "connection-error",
        loggedIn: false,
        error: e.message,
      });
      return null;
    }
  }
  async refreshShops() {
    this.ensureIdle();
    this.busyOp = true;
    this.preflight = null;
    this.notify();
    try {
      for (const shop of this.config.shops.filter(
        (s) => ["dou", "pdd"].includes(s.platform),
      )) {
        await this.observeOne(shop);
        await this.saveConfig();
        this.notify();
      }
      return this.snapshot();
    } finally {
      this.busyOp = false;
      this.notify();
    }
  }
  async openLogin(id, { fresh = false } = {}) {
    this.ensureIdle();
    const shop = this.findShop(id);
    if(fresh&&shop.platform==='pdd')throw Error('请在本店 Ego 工作空间手动退出并登录目标店铺，再点击核对');
    this.preflight = null;
    this.busyOp = true;
    this.notify();
    try {
      if (shop.securityBlocked)
        throw Error(
          "SAFETY_BLOCKED：请先人工处理安全验证，不能用新登录环境绕过",
        );
      // Existing profile is checked before an explicitly requested independent sign-in.
      if (fresh) {
        await this.observeOne(shop);
        if (shop.securityBlocked)
          throw Error("SAFETY_BLOCKED：检测到安全验证，已停止");
        shop.loginProfiles ??= [];
        shop.loginProfiles.push({
          id: shop.loginProfileId || shop.id,
          retiredAt: new Date().toISOString(),
        });
        shop.loginProfileId = uuid();
        await this.saveConfig();
      }
      await this.browser.open(shop);
      if(shop.platform==='pdd')return {message:'本店 Ego 工作空间已打开。请人工登录，返回文青尚品点击“核对”后再测试。'};
      await this.observeOne(shop);
      await this.saveConfig();
      return {
        message: shop.verified
          ? "已复用该店窗口，店铺核对通过"
          : shop.loginStatus === "mismatch"
            ? `此专用窗口当前是「${shop.actualName}」，目标是「${shop.name}」。可使用“重新登录”建立独立登录；不会自动切店。`
            : "专用窗口已打开，请人工完成登录，再核对店铺；窗口不会自动关闭。",
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
      s.loginStatus = "verified";
      s.loginError = null;
      await this.saveConfig();
      return r.evidence;
    } catch (e) {
      s.verified = false;
      s.loggedIn = false;
      s.actualName = null;
      if (failureType(e) === "safety-blocked") s.securityBlocked = true;
      if (this.browser.observe) await this.observeOne(s);
      else
        s.loginStatus = s.securityBlocked ? "safety-blocked" : "login-required";
      s.verified = false;
      s.loginError = e.message;
      await this.saveConfig();
      throw e;
    } finally {
      this.busyOp = false;
      this.notify();
    }
  }
  async check({ mode = "normal" } = {}) {
    if (!["normal", "recreate"].includes(mode)) throw Error("任务模式无效");
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
    if (targets.some(s => s.platform !== this.config.platform)) throw Error("本批店铺必须属于同一平台");
    if (products.some(p => p?.config?.platform && p.config.platform !== this.config.platform && !(this.config.platform === "dou" && p.config.platform === "doudian"))) throw Error("商品素材与本批平台不一致");
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
          for (const r of this.history)
            for (const t of r.tasks || [])
              if (
                t.shopId === s.id &&
                t.productId === p.id &&
                mode !== "recreate" && ["running", "needs-review"].includes(t.status)
              )
                throw Error(
                  `${s.name} / ${p.config.product.itemCode}：上次结果未确认，请核实草稿，不自动重试`,
                );
          const baseKey = hash(s.id + "|" + p.id + "|" + v.inputHash),
            baseDir = path.join(this.root, "tasks", baseKey);
          const records = mode === 'recreate' ? [] : await taskRecords(baseDir, v.inputHash);
          if (mode !== "recreate" && records.some((r) => r.uncertain))
            throw Error(
              `${s.name} / ${p.config.product.itemCode}：上次结果未确认，请核实草稿，不自动重试`,
            );
          const previous = records.find((r) => r.confirmed),
            skip = mode === "normal" && !!previous,
            attemptId = skip ? null : uuid();
          tasks.push({
            id: skip ? baseKey : baseKey + "." + attemptId,
            baseKey,
            attemptId,
            shopId: s.id,
            shopName: s.name,
            productId: p.id,
            productTitle: p.config.product.title,
            code: p.config.product.itemCode,
            sku: config.skuMatrix.length,
            inputHash: v.inputHash,
            outputDir: skip
              ? previous.dir
              : path.join(baseDir, "attempts", attemptId),
            config,
            status: skip
              ? "already-saved"
              : mode === "recreate"
                ? "recreate-ready"
                : "ready",
            previousSavedAt: previous?.savedAt || null,
            receiptFile: skip ? previous.receiptFile : null,
          });
        }
      }
      this.preflight = {
        token: uuid(),
        mode,
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
      throw Error(
        "本批全部已有确认草稿；可点击“重新创建草稿”并确认新的一批，原回执会保留",
      );
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
      mode: plan.mode,
      startedAt: new Date().toISOString(),
      tasks: plan.tasks.map((t) => ({
        ...t,
        status: t.status === "already-saved" ? "already-saved" : "queued",
      })),
      index: 0,
      step: "准备任务",
      logs: [{at:new Date().toISOString(),text:plan.mode==='recreate'?'已建立全新的重建任务，旧任务与回执保留':'任务已建立，准备核对店铺'}],
    };
    try {
      for (const t of this.run.tasks)
        if (t.status !== "already-saved") {
          await fs.mkdir(path.dirname(t.outputDir), { recursive: true });
          await fs.mkdir(t.outputDir);
          await writeJson(path.join(t.outputDir, "intent.json"), {
            status: "reserved",
            runId: this.run.id,
            shopId: t.shopId,
            productId: t.productId,
            inputHash: t.inputHash,
            attemptId: t.attemptId,
            mode: this.run.mode,
          });
        }
      await this.persistRun();
    } catch (e) {
      this.running = false;
      await this.store.unlock();
      throw e;
    }
    this.notify();
    this.drivePromise = this.drive();
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
    // Background cleanup can reject after the normal execution catch has run.
    try{await this.driveBatch();}catch(error){
      this.running=false;this.busyOp=false;
      if(this.run){
        this.run.status='needs-review';this.run.finishedAt=new Date().toISOString();
        this.run.error=(this.run.error?this.run.error+'；':'')+'本地运行收尾失败：'+error.message;
        this.run.errorCode='RUN_FINALIZE_FAILED';
        for(const task of this.run.tasks)if(task.status==='running')task.status='needs-review';else if(task.status==='queued')task.status='not-run';
        this.run.logs.push({at:new Date().toISOString(),text:this.run.error});
      }
      try{await this.store.unlock();}catch(e){console.error('任务锁清理失败：'+e.message);}
      try{await this.persistRun();}catch(e){console.error('运行记录保存失败：'+e.message);}
      try{this.emit('diagnostic',{type:'run-finalize-failed',runId:this.run?.id,error:error.stack||error.message});this.notify();}catch(e){console.error('运行状态通知失败：'+e.message);}
    }
  }
  async driveBatch() {
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
        r.step = '核对店铺';
        r.logs.push({at:new Date().toISOString(),task:t.id,text:'正在核对店铺：'+s.name});
        await this.persistRun();this.notify();
        const verified = await this.browser.verify(s);
        const v = await this.runner.call("validate", { config: t.config });
        if (!v.ok || v.inputHash !== t.inputHash)
          throw Error("商品资料或素材已变化，请重新扫描和预检");
        t.status = "running";
        r.logs.push({at:new Date().toISOString(),task:t.id,text:(r.mode==='recreate'?'开始独立重建任务：':'开始任务：')+t.shopName+' / '+t.code});
        r.step = "核对店铺后开始填写";
        await writeJson(path.join(t.outputDir, "intent.json"), {
          status: "running",
          runId: r.id,
          shopId: s.id,
          productId: t.productId,
          inputHash: t.inputHash,
          attemptId: t.attemptId,
          mode: r.mode,
        });
        await this.persistRun();
        this.notify();
        try {
          const execute = (payload,options) => s.platform==='pdd'
            ? this.browser.runPdd(s,payload,options)
            : this.runner.call('run',payload,options);
          const result = await execute(
            {
              config: t.config,
              expectedHash: t.inputHash,
              endpoint: verified.endpoint,
              expectedShop: t.shopName,
              outputDir: t.outputDir,
              workspaceToken: s.workspaceToken,
              attemptId: t.attemptId,
              batchId:r.id,
              validation:v,
              recreate:r.mode==='recreate',
            },
            {
              onEvent: (e) => {
                if (e.type === "workspace") {
                  t.workspace = { created: e.created, reused: e.reused };
                  r.logs.push({
                    at: new Date().toISOString(),
                    task: t.id,
                    text: e.reused
                      ? "复用本店固定工作页"
                      : "创建本店固定工作页",
                  });
                }
                if (e.type === "step-start") {
                  r.step = e.name;
                  r.logs.push({at:e.at||new Date().toISOString(),task:t.id,text:'开始：'+e.name});
                }
                if (e.type === "step-complete") {
                  t.timings ||= [];
                  t.timings.push({step:e.name,durationMs:e.durationMs});
                  r.logs.push({at:e.at||new Date().toISOString(),task:t.id,text:'完成：'+e.name+(Number.isFinite(e.durationMs)?'（'+(e.durationMs/1000).toFixed(1)+'秒）':'')});
                }
                if (e.type === "log") {
                  r.logs.push({
                    at: e.at || new Date().toISOString(),
                    task: t.id,
                    text: e.text,
                  });
                }
                r.logs = r.logs.slice(-1000);
                if (e.type === "step-start" || e.type === "step-complete") {
                  void this.persistRun().catch((e) => {
                    r.stopRequested = true;
                    r.error = "记录写入失败：" + e.message;
                  });
                  this.notify();
                } else {
                  void this.persistRun().catch(error=>{r.stopRequested=true;r.error='记录写入失败：'+error.message;});
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
            shopId: t.shopId,
            productId: t.productId,
            attemptId: t.attemptId,
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
          if(e.code)t.errorCode=e.code;
          if(e.diagnostic)t.diagnostic=e.diagnostic;
          const failure=s.platform==='pdd'&&!receipt&&t.status==='failed'
            ? await readJson(path.join(t.outputDir,'product-failure.json')) : null;
          const continueBatch=failure?.safeToContinue===true&&failure.inputHash===t.inputHash&&failure.attemptId===t.attemptId&&failure.batchId===r.id;
          r.logs.push({at:new Date().toISOString(),task:t.id,text:(continueBatch?'本商品未保存，已记录失败并继续下一件：':'停止：')+e.message});
          r.logs = r.logs.slice(-1000);
          await writeJson(path.join(t.outputDir, "intent.json"), {
            status: t.status,
            shopId: t.shopId,
            productId: t.productId,
            attemptId: t.attemptId,
            runId: r.id,
            inputHash: t.inputHash,
            error: e.message,
          });
          if(!continueBatch)throw e;
        }
        await this.persistRun();
        this.notify();
      }
      if (this.run.status === "running" || this.run.status === "pausing")
        this.run.status = this.run.stopRequested ? "stopped" : this.run.tasks.some(t=>t.status==='failed')?'complete-with-errors':"complete";
    } catch (e) {
      this.run.status = failureType(e);
      this.run.error = e.message;
      if(e.code)this.run.errorCode=e.code;
      const t = this.run.tasks[this.run.index];
      if(this.run.logs.at(-1)?.text!=='停止：'+e.message)this.run.logs.push({at:new Date().toISOString(),task:t?.id,text:'停止：'+e.message});
      this.run.logs=this.run.logs.slice(-1000);
      if (t) {
        if (t.status === "queued") t.status = failureType(e);
        t.error = e.message;
        if(e.code)t.errorCode=e.code;
        if(e.diagnostic)t.diagnostic=e.diagnostic;
        if(['EGO_USER_CONTROL','EGO_SPACE_INACTIVE','EGO_CONNECTION_LOST','EGO_PERMISSION_DENIED'].includes(e.code)){
          const shop=this.findShop(t.shopId);shop.verified=false;shop.loggedIn=false;
          shop.loginStatus=e.code==='EGO_USER_CONTROL'?'awaiting-user':'connection-error';shop.loginError=e.message;
          await this.saveConfig();
        }
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
    // "paused" is visible while its drive is still persisting and notifying.
    // Let that drive finish before changing shared state or starting another.
    await this.drivePromise;
    if (this.run?.status !== "paused")
      throw Error("任务状态已改变，请重新检查当前任务");
    this.run.pauseRequested = false;
    this.run.status = "running";
    await this.persistRun();
    this.notify();
    this.drivePromise = this.drive();
  }
  async stopAfterCurrent() {
    if (!this.running) throw Error("当前没有运行任务");
    if (this.run.status === "paused") await this.drivePromise;
    this.run.stopRequested = true;
    if (this.run.status === "paused") {
      this.run.status = "running";
      this.drivePromise = this.drive();
    } else {
      await this.persistRun();
      this.notify();
    }
  }
  async flush() {
    await this.store.chain;
  }
}
