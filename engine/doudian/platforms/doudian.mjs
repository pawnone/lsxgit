// Locator verified read-only against the current Dou店 legacy product form.
export const platform = 'doudian';
export const whiteImageSelector = '[attr-field-id="白底图"]';
export async function verifyWhiteImage(page, config) {
  const expected = config.product.whiteBackgroundImage ? 1 : 0;
  const region = page.locator(whiteImageSelector);
  if (!expected) {
    if (await region.locator('img').count()) throw new Error('资料未提供白底图，但页面已有白底图；停止，避免沿用旧商品素材');
    return {status:'skipped',count:0};
  }
  await region.waitFor({state:'visible',timeout:10000});
  await page.waitForFunction(selector => {
    const root = document.querySelector(selector);
    const imgs = root ? [...root.querySelectorAll('img')] : [];
    return imgs.length === 1 && imgs.every(img=>img.complete && img.naturalWidth>0 && /^(https?:|data:)/.test(img.currentSrc || img.src)) && !root.querySelector('[class*="uploading"], [class*="item-error"], [class*="item-loading"]');
  }, whiteImageSelector, {timeout:90000});
  return {status:'verified',count:1};
}
export async function uploadWhiteImage(page, config, validation) {
  const file = validation.resolvedAssets.whiteBackgroundImage;
  if (!file) return verifyWhiteImage(page,config);
  const region = page.locator(whiteImageSelector);
  await region.waitFor({state:'visible',timeout:10000});
  if (await region.locator('img').count()) throw new Error('白底图入口已有图片，无法证明属于本次商品；请从新建入口运行');
  const input = region.locator('input[type="file"]');
  if (await input.count() !== 1) throw new Error('白底图上传入口数量异常；页面可能已改版');
  await input.setInputFiles(file,{timeout:15000});
  return verifyWhiteImage(page,config);
}
