import { installSafetyGuard, assertSafetyClear } from "./safety-guard.mjs";
import { assertPageShop } from "./shop-guard.mjs";
const KEY = "wenqing:workspace:v1";
const ORIGIN = "https://fxg.jinritemai.com";
const CREATE = ORIGIN + "/ffa/g/create?entrance=create";
export async function workspaceState(page) {
  try {
    return await page.evaluate(
      (k) => JSON.parse(sessionStorage.getItem(k) || "null"),
      KEY,
    );
  } catch {
    return null;
  }
}
export async function markWorkspace(page, token, changes) {
  if (new URL(page.url()).origin !== ORIGIN)
    throw Error("工作页离开抖店，已停止");
  return page.evaluate(
    ({ key, token, changes }) => {
      const old = JSON.parse(sessionStorage.getItem(key) || "null");
      if (old && old.token !== token) throw Error("工作页归属不符");
      const next = { ...old, ...changes, token };
      sessionStorage.setItem(key, JSON.stringify(next));
      return next;
    },
    { key: KEY, token, changes },
  );
}
export async function prepareWorkspace(
  browser,
  { token, expectedShop, attemptId, recreate = false },
) {
  if (!token || !expectedShop || !attemptId)
    throw Error("工作页缺少店铺或执行标识");
  const matches = [];
  for (const page of browser.contexts().flatMap((c) => c.pages())) {
    if (new URL(page.url()).origin !== ORIGIN) continue;
    const state = await workspaceState(page);
    if (state?.token === token && !state.retired) matches.push({ page, state });
  }
  if (matches.length > 1)
    throw Error(
      "同一店铺发现多个APP工作页副本；请人工核实，未随机选择或新开页面",
    );
  let page,
    state,
    created = false;
  if (matches.some(m=>m.state.attemptId===attemptId))throw Error('不能重复执行同一个任务，请重新创建草稿建立新任务');
  if (matches.length) {
    ({ page, state } = matches[0]);
    if (!recreate && ["running", "saving", "needs-review"].includes(state.phase))
      throw Error("工作页上次结果未知，请先核实草稿，禁止自动清空或重试");
  } else {
    const context = browser.contexts()[0];
    if (!context) throw Error("浏览器没有登录会话");
    page = await context.newPage();
    created = true;
  }
  await installSafetyGuard(page);
  await assertSafetyClear(page);
  // A full navigation to CREATE in this owned tab, never reload a saved draft.
  await page.goto(CREATE, { waitUntil: "domcontentloaded", timeout: 45000 });
  await assertPageShop(page, expectedShop);
  await assertSafetyClear(page);
  await markWorkspace(page, token, {
    phase: "running",
    attemptId,
    expectedShop,
    startedAt: new Date().toISOString(),
    previousAttemptId: state?.attemptId || null,
    previousState: recreate && state ? {phase:state.phase,attemptId:state.attemptId,startedAt:state.startedAt} : null,
  });
  return { page, created, previousAttemptId: state?.attemptId || null };
}
export async function assertBlankProductEntry(page) {
  await assertSafetyClear(page);
  const url = new URL(page.url());
  if (
    url.origin !== ORIGIN ||
    !/^\/ffa\/g\/create\/?$/.test(url.pathname) ||
    [...url.searchParams.keys()].some((k) =>
      /^(?:id|draft_?id|product_?id|goods_?id)$/i.test(k),
    )
  )
    throw Error("未进入独立新建商品流程，禁止覆盖现有草稿");
  const titles = page.locator(
    '[attr-field-id="商品标题"] input[type="text"], input[placeholder*="个字符"]',
  );
  for (const input of await titles.all())
    if ((await input.isVisible()) && (await input.inputValue()).trim())
      throw Error("新建工作页残留商品标题，已停止，未填写第二个商品");
  const codes = page.locator('[attr-field-id="货号"] input');
  for (const input of await codes.all())
    if ((await input.inputValue()).trim())
      throw Error("新建工作页残留货号，已停止");
  if (
    await page
      .locator('[attr-field-id="主图"] img,[class*="batchImageUpload"] img')
      .count()
  )
    throw Error("新建工作页残留主图，已停止");
  for (const input of await page
    .locator(
      '.attr-column-field_price input,.attr-column-field_outer_sku_id input,input[placeholder="请输入erp编码"]',
    )
    .all())
    if ((await input.inputValue()).trim())
      throw Error("新建工作页残留价格或商家编码，已停止");
}
