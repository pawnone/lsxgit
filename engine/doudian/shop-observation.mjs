import { chromium } from "playwright-core";
import { installSafetyGuard, assertSafetyClear } from "./safety-guard.mjs";

// Observing a login state is distinct from asserting the intended shop.
export async function observeShop(endpoint, expectedShop) {
  const u = new URL(endpoint);
  if (
    u.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(u.hostname)
  )
    throw Error("浏览器地址必须为本机HTTP");
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const evidence = [];
    for (const page of pages) {
      await installSafetyGuard(page);
      await assertSafetyClear(page);
      if (
        new URL(page.url()).hostname !== "fxg.jinritemai.com" ||
        !new URL(page.url()).pathname.startsWith("/ffa/")
      )
        continue;
      const header = page.locator('[class*="shopTitle"] [class*="userName"]');
      if (!(await header.count()))
        await header
          .first()
          .waitFor({ state: "visible", timeout: 2000 })
          .catch(() => {});
      await assertSafetyClear(page);
      const names = [];
      for (const h of await header.all())
        if (await h.isVisible()) {
          const text = (await h.innerText()).trim();
          if (text) names.push(text);
        }
      for (const actual of names)
        evidence.push({
          actual,
          url: new URL(page.url()).origin + new URL(page.url()).pathname,
          checkedAt: new Date().toISOString(),
        });
    }
    const actualNames = [...new Set(evidence.map((e) => e.actual))];
    const actualName = actualNames.length === 1 ? actualNames[0] : null;
    return {
      status:
        actualNames.length > 1
          ? "ambiguous"
          : !actualName
            ? "login-required"
            : actualName === expectedShop
              ? "verified"
              : "mismatch",
      loggedIn: actualNames.length > 0,
      actualName,
      actualNames,
      evidence,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}
export async function focusShop(endpoint, expectedShop) {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    let chosen;
    for (const page of pages) {
      if (new URL(page.url()).hostname !== "fxg.jinritemai.com") continue;
      const names = await page
        .locator('[class*="shopTitle"] [class*="userName"]')
        .allTextContents();
      if (names.some((n) => n.trim() === expectedShop)) {
        chosen = page;
        break;
      }
    }
    chosen ??=
      pages.find((p) => new URL(p.url()).hostname === "fxg.jinritemai.com") ||
      pages[0];
    if (!chosen) throw Error("浏览器没有可打开的页面，请人工检查该店铺窗口");
    await chosen.bringToFront();
    return true;
  } finally {
    await browser.close();
  }
}
