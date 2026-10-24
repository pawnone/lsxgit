// Browser-backed contract checks against local HTML only. All requests are
// intercepted; no merchant session, actual material, upload or save is used.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { BrowserManager } from "../desktop/browser-manager.mjs";
import { PddDriver } from "../engine/pdd/dom-driver.mjs";
import { inspectEntry } from "../engine/pdd/category-entry.mjs";
import { fieldState, selectField, selectControl } from "../engine/pdd/attributes.mjs";
import { assertSelected } from "../engine/pdd/core/form-review.mjs";
import { pricingState, fillPricing } from "../engine/pdd/pricing.mjs";

const executablePath = await new BrowserManager({ executable: process.env.WQ_TEST_CHROME }).detectExecutable();
const browser = await chromium.launch({ executablePath, headless: true });
const checks = [];
const checked = (name, fn) => { fn(); checks.push(name); };
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }) : route.abort());
  const page = await context.newPage();
  await page.goto("https://mms.pinduoduo.com/pdd-dom-test");
  const header = '<div class="user-name-name"><span class="user-name-text">合成测试店铺</span></div>';
  const driver = new PddDriver({ page, expectedShop: "合成测试店铺" });
  const form = content => header + '<form>' + content + '</form>';
  const title = '<input placeholder="商品标题组成：测试" value="">';
  const next = '<button id="bottomSubmitBtnId" type="button">下一步, 完善商品信息</button>';
  const file = '<input type="file" data-tracking-click-viewid="local_upload" multiple>';
  await page.setContent(form('<p>(0/10)</p>' + file + title + next +
    '<img src="https://commimg.pddpic.com/icon.png"><img src="https://commimg.pddpic.com/help.png">'));
  const blank = await inspectEntry(driver);
  checked("空白入口不将平台装饰图片计入主图", () => assert.deepEqual([blank.count, blank.uploaded.length, blank.files], [0, 0, 1]));
  const boxes = n => Array.from({ length: n }, (_, i) =>
    '<div class="MaterialModalButton_v2_imageBox__test" style="width:50px;height:50px;background-image:url(https://pfs.pinduoduo.com/' + i + '.jpeg)"></div>').join("");
  await page.setContent(form(boxes(10) + title + next + '<img src="https://commimg.pddpic.com/icon.png">'));
  const full = await inspectEntry(driver);
  checked("传满十张后计数器和上传输入消失，仍按主图槽位核对十张", () => assert.deepEqual([full.count, full.uploaded.length, full.files], [10, 10, 0]));
  await page.setContent(form('<p>(3/10)</p>' + boxes(3) + file + title + next));
  const partial = await inspectEntry(driver);
  checked("部分上传按计数器与服务端槽位核对", () => assert.deepEqual([partial.count, partial.uploaded.length], [3, 3]));
  await page.setContent(form(boxes(3) + file + title + next));
  const menuOpen = await inspectEntry(driver);
  checked("展开上传菜单导致计数文案隐藏时，仍识别三张主图", () => assert.deepEqual([menuOpen.count, menuOpen.uploaded.length], [3, 3]));

  const field = (name, content) => '<div data-testid="beast-core-form-item" id="basic.propertys.test.value">' +
    '<label class="Form_itemLabelContent_test">' + name + '</label><div data-testid="beast-core-select-header">' + content + '</div></div>';
  await page.setContent(form(field("材质", '<input type="hidden" value="123456">' +
    '<div class="ST_selectValueSingle_test"><input type="text" disabled readonly value="涤纶（聚酯纤维）"></div>')));
  const derived = await selectField(driver, "材质", "涤纶（聚酯纤维）");
  checked("平台锁定材质只核对可见显示值，忽略隐藏ID", () => assert.equal(derived.mode, "platform-derived-readback"));
  await assert.rejects(selectField(driver, "材质", "棉"), /不精确一致/);
  checks.push("平台锁定值与商品表不同则阻断");
  await page.setContent(form(field("重要流行元素", '<span class="ST_selectValueMultiple_test">' +
    '<span data-testid="beast-core-tagGroup-tag">纯色</span><input type="text" value="查询中的其他文字"></span>')));
  assertSelected(["纯色"], await fieldState(driver, "流行元素"));
  checks.push("多选回读只使用已选标签，搜索输入不能冒充已选值");

  await page.setContent(form('<div id="cost_template_id" style="margin-top:150px"><div data-testid="beast-core-select-header"><input data-testid="beast-core-select-htmlInput" type="text" readonly value="原模板"></div></div>'));
  await page.evaluate(() => {
    document.querySelector('[data-testid="beast-core-select-header"]').onclick = () => setTimeout(() => {
      const popup = document.createElement('div');
      popup.dataset.testid = 'beast-core-portal'; popup.className = 'ST_dropdown_test';
      const option = document.createElement('div'); option.role = 'option'; option.innerText = '完整测试模板';
      option.onclick = () => {
        document.querySelector('#cost_template_id input').value = option.innerText;
        setTimeout(() => popup.remove(), 100);
      };
      popup.append(option); document.body.append(popup);
    }, 100);
  });
  await selectControl(driver, '#cost_template_id', '完整测试模板');
  checks.push("运费模板等待下拉层出现及关闭，再核对完整名称");
  await page.setContent(form('<div id="cost_template_id"><div data-testid="beast-core-select-header"><span>完整测试模板</span><input data-testid="beast-core-select-htmlInput" type="text" value=""></div></div>'));
  await selectControl(driver,'#cost_template_id','完整测试模板');
  checks.push('模板名称显示在独立文本时，空白搜索框不会被误判为未选择');

  const skus = ["上衣", "上衣+裤子"].flatMap((style, si) => ["S", "M"].map((size, zi) => ({
    style, styleNote: si ? "（套装）" : "（单件）", size, sizeNote: zi ? "（100-120斤）" : "（80-100斤）",
    stock: zi, groupPriceCents: si ? 17990 : 9990, singlePriceCents: si ? 25990 : 15990,
    code: "EXACT-" + si + "-" + zi, state: "启用",
  })));
  const columns = ["颜色分类", "尺码", "库存", "拼单价(元)", "单买价(元)", "预览图", "规格编码", "状态"];
  const rows = skus.map((s, i) => '<tr data-testid="beast-core-table-body-tr">' +
    (i % 2 === 0 ? '<td rowspan="2"><span class="sku-row-title">' + s.style + ' ' + s.styleNote + '</span></td>' : '') +
    '<td><span class="sku-row-title">' + s.size + ' ' + s.sizeNote + '</span></td>' +
    '<td><input type="hidden" value="999999"><input type="text" value="' + s.stock + '"></td>' +
    '<td><input type="text" value="' + s.groupPriceCents / 100 + '"></td>' +
    '<td><input type="text" value="' + s.singlePriceCents / 100 + '"></td><td></td>' +
    '<td><input type="text" value="' + s.code + '"></td>' +
    '<td><div class="sku-status-word">已启用</div><div data-testid="beast-core-switch"></div></td></tr>').join('');
  await page.setContent(form('<div class="TB_innerMiddle_test"><table><thead><tr>' + columns.map(c => '<th>' + c + '</th>').join('') +
    '</tr></thead></table><table><tbody>' + rows + '</tbody></table></div>'));
  const prices = await pricingState(driver, skus);
  checked("独立表头、跨行款式及相似款名仍精确对应四个SKU", () => assert.deepEqual(
    prices.map(r => [r.style, r.size, r.stock, r.groupPriceCents, r.singlePriceCents, r.code]),
    skus.map(r => [r.style, r.size, r.stock, r.groupPriceCents, r.singlePriceCents, r.code])));
  const preserved = await fillPricing(driver, skus.map(s => ({ ...s, code: "", state: null })));
  checked("选填编码和启停省略时保留平台值，不清空或擅自切换", () => {
    assert.deepEqual(preserved.map(r => r.code), skus.map(r => r.code));
    assert(preserved.every(r => r.state === "启用"));
  });
  await page.locator('.sku-row-title').first().evaluate(e => { e.textContent = "上衣 错误备注"; });
  await assert.rejects(pricingState(driver, skus), /无法唯一匹配/);
  checks.push("款式备注不符不能靠子字符串关联价格或编码");

  await page.setContent(form('<div style="height:610px"></div><div id="nested"></div><div style="height:1100px"></div>') +
    '<div class="goods-footer-main" style="position:fixed;bottom:0;left:0;right:0;height:70px;background:white">底部操作栏</div>');
  await page.evaluate(() => {
    const nested = document.createElement("form");
    nested.innerHTML = '<input type="text" id="nested-target" value="">';
    document.querySelector("#nested").append(nested);
    window.scrollTo(0, 0);
  });
  await driver.exposeFormControl("#nested-target");
  const targetReachable = await page.evaluate(() => {
    const e = document.querySelector("#nested-target"), r = e.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e;
  });
  checked("嵌套表单及固定底栏通过原生滚动处理，不误点底部按钮", () => assert.equal(targetReachable, true));

  await page.setContent(form('<button id="publish" type="button">提交并上架</button><button id="save" type="button">保存草稿</button>'));
  await assert.rejects(driver.click("#publish"), /禁止正式发布/);
  await assert.rejects(driver.click("#save"), /保存门禁尚未通过/);
  checks.push("发布按钮被拒绝，未通过预检不能保存草稿");
  await page.setContent(form("<p>请完成安全验证</p>"));
  await assert.rejects(driver.guard(), /SAFETY_BLOCKED/);
  checks.push("已知安全提示立即停止");
  await page.setContent(form("<p>提示已移除</p>"));
  await assert.rejects(driver.guard(), /SAFETY_BLOCKED/);
  checks.push("安全提示消失也不能在原会话中自动恢复");
  await page.setContent('<div class="user-name-name"><span class="user-name-text">另一店铺</span></div><form></form>');
  await assert.rejects(new PddDriver({ page, expectedShop: "合成测试店铺" }).guard(), /店铺身份不符/);
  checks.push("店名不符立即停止");
  console.log(JSON.stringify({ checks: checks.length, names: checks, merchantMutation: false }));
} finally { await browser.close(); }
