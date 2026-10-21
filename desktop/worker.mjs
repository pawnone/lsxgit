// Isolated Node-compatible worker. Inputs come only from the main-process service.
import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import {SUPPORTED_CATEGORIES} from "../engine/doudian/category-rules.mjs";
// Load only the operation's dependencies; login checks do not parse Excel or load listing adapters.
process.on("disconnect", () => process.exit(1));
process.stdout.on("error", () => process.exit(1));
function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
console.log = (...a) => emit({ type: "log", text: util.format(...a) });
console.warn = console.log;
console.error = console.log;
async function json(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export function assertAdapterRange(c) {
  if (c.draftOnly !== true) throw Error("只允许保存草稿");
  if (
    !SUPPORTED_CATEGORIES.includes(c.product.categoryPath) ||
    c.product.mainImages.length !== 5 ||
    c.inventory.shippingMode !== "现货预售混合"
  )
    throw Error(
      "当前抖店适配范围：时尚套装、针织衫/毛衣/羊毛衫，5张主图、现货预售混合；请勿套用其他类目",
    );
  if (
    !c.product.materialTagImage ||
    !c.product.brand ||
    !c.service.freightTemplate ||
    !c.service.returnPolicy ||
    !c.inventory.stockCountMode
  )
    throw Error("缺少吊牌图、品牌或履约字段");
  for (const s of c.sizeSpecs) {
    const rows = c.sizeChart.filter((r) => r.size === s.name);
    if (
      rows.length !== 1 ||
      !["height", "weight"].every(
        (k) =>
          Array.isArray(rows[0][k]) &&
          rows[0][k].length === 2 &&
          rows[0][k].every((n) => Number.isFinite(n) && n > 0) &&
          rows[0][k][0] <= rows[0][k][1],
      )
    )
      throw Error(s.name + "：身高体重区间不完整");
  }
}
async function prepare(input, dir) {
  const output = path.join(dir, "resolved-product-config.json");
  const {prepareProduct} = await import("../engine/doudian/prepare-product.mjs");
  const {validateConfig} = await import("../engine/doudian/run-draft.mjs");
  const r = await prepareProduct({
    input,
    output,
    cdpUrl: "http://127.0.0.1:1",
  });
  if (!r.ok)
    return { ok: false, input, errors: r.errors, warnings: r.warnings };
  const v = await validateConfig(r.config);
  try {
    assertAdapterRange(r.config);
  } catch (e) {
    v.errors.push({ code: "ADAPTER_RANGE", message: e.message });
    v.ok = false;
  }
  return {
    ok: v.ok,
    input,
    config: r.config,
    validation: v,
    errors: v.errors,
    warnings: [...r.warnings, ...v.warnings],
  };
}
async function scan({ root, workDir }) {
  const {scanProducts} = await import("../engine/doudian/scan-products.mjs");
  await fs.mkdir(workDir, { recursive: true });
  const manifestFile = path.join(workDir, "scan.json");
  let manifest;
  try {
    manifest = await scanProducts(root, manifestFile, {
      platform: "doudian",
      cdpUrl: "http://127.0.0.1:1",
    });
  } catch {
    manifest = (await json(manifestFile + ".scan-report.json")) || {
      products: [],
      errors: [{ folder: root, error: "无法扫描素材库" }],
    };
  }
  const scanReport = await json(manifestFile + ".scan-report.json");
  const errors = scanReport?.errors || manifest.errors || [];
  const result = [];
  for (const p of manifest.products || []) {
    const input = path.resolve(path.dirname(manifestFile), p.materialRoot);
    try {
      const r = await prepare(input, path.join(workDir, p.id));
      result.push({ ...p, materialRoot: input, ...r });
    } catch (e) {
      result.push({
        ...p,
        materialRoot: input,
        ok: false,
        errors: [{ code: "READ_ERROR", message: e.message }],
      });
    }
  }
  return { root, products: result, errors };
}
async function execute(req) {
  const {chromium} = await import("playwright-core");
  const {prepareWorkspace,markWorkspace} = await import("../engine/doudian/workspace.mjs");
  const {validateConfig,executeDraft} = await import("../engine/doudian/run-draft.mjs");
  const { config, expectedHash, endpoint, expectedShop, outputDir } = req;
  if (
    !expectedShop ||
    config.expectedShop !== expectedShop ||
    config.draftOnly !== true
  )
    throw Error("执行配置的店铺或草稿模式不符");
  config.cdpUrl = endpoint;
  const v = await validateConfig(config);
  assertAdapterRange(config);
  if (!v.ok) throw Error(v.errors.map((e) => e.message).join("\n"));
  if (v.inputHash !== expectedHash)
    throw Error("商品资料或素材已变化，请重新预检确认");
  await fs.mkdir(outputDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    mode: "execute",
    validation: v,
  };
  let browser, workspace;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
    workspace = await prepareWorkspace(browser, {
      token: req.workspaceToken,
      expectedShop,
      attemptId: req.attemptId,
    });
    emit({
      type: "workspace",
      created: workspace.created,
      reused: !workspace.created,
    });
    const result = await executeDraft(config, v, {
      browser,
      page: workspace.page,
      requireBlankEntry: true,
      restartEntry: false,
      outputDir,
      onEvent: async (e) => {
        if (e.type === "step-start" && e.name === "保存草稿")
          await markWorkspace(workspace.page, req.workspaceToken, {
            phase: "saving",
          });
        emit(e);
      },
    });
    await markWorkspace(workspace.page, req.workspaceToken, {
      phase: "confirmed",
      finishedAt: new Date().toISOString(),
    });
    Object.assign(report, result, {
      workspace: { created: workspace.created, reused: !workspace.created },
      finishedAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(outputDir, "last-run.json"),
      JSON.stringify(report, null, 2),
    );
    return report;
  } catch (e) {
    if (workspace) {
      const receipt = await json(
        path.join(outputDir, `draft-save-${expectedHash}.json`),
      );
      const phase =
        receipt?.status === "confirmed"
          ? "confirmed"
          : receipt
            ? "needs-review"
            : /SAFETY_BLOCKED/.test(e.message)
              ? "safety-blocked"
              : /closed|disconnect|未知/.test(e.message)
                ? "needs-review"
                : "failed";
      try {
        await markWorkspace(workspace.page, req.workspaceToken, {
          phase,
          error: e.message,
        });
      } catch {}
    }
    Object.assign(report, e.execution, {
      ok: false,
      error: e.message,
      finishedAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(outputDir, "last-run.json"),
      JSON.stringify(report, null, 2),
    );
    throw e;
  } finally {
    if (browser) await browser.close();
  }
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (input.length > 16 * 1024 * 1024) throw Error("请求过大");
try {
  const { op, payload } = JSON.parse(input);
  let result;
  if (op === "scan") result = await scan(payload);
  else if (op === "observe")
    result = await (await import("../engine/doudian/shop-observation.mjs")).observeShop(payload.endpoint, payload.expectedShop);
  else if (op === "focus")
    result = await (await import("../engine/doudian/shop-observation.mjs")).focusShop(payload.endpoint, payload.expectedShop);
  else if (op === "verify")
    result = await (await import("../engine/doudian/shop-guard.mjs")).inspectShop(payload.endpoint, payload.expectedShop);
  else if (op === "validate") {
    const {validateConfig} = await import("../engine/doudian/run-draft.mjs");
    const v = await validateConfig(payload.config);
    assertAdapterRange(payload.config);
    result = v;
  } else if (op === "run") result = await execute(payload);
  else if (op === "runtime")
    result = {
      node: process.versions.node,
      electron: process.versions.electron,
      arch: process.arch,
    };
  else throw Error("未知执行器操作");
  emit({ type: "result", ok: true, result });
  process.exit(0);
} catch (e) {
  emit({ type: "result", ok: false, error: e.message });
  process.exit(1);
}
