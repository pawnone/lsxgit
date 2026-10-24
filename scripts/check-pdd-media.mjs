import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { BrowserManager } from "../desktop/browser-manager.mjs";
import { PddDriver } from "../engine/pdd/dom-driver.mjs";
import { executionHash } from "../engine/pdd/frozen-input.mjs";
import { mediaPlan, mediaDescriptor, mediaState, uploadMediaPlan, assertPlanInput } from "../engine/pdd/media.mjs";

import { verifyMediaReceipts } from "../engine/pdd/full-media.mjs";

const executablePath = await new BrowserManager({ executable: process.env.WQ_TEST_CHROME }).detectExecutable();

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUAAAAABJRU5ErkJggg==", "base64");
const header = '<div class="user-name-name"><span class="user-name-text">离线测试店</span></div>';
const title = '<div data-testid="beast-core-form-item"><label class="Form_itemLabelContent_test">商品标题</label><input type="text" value="离线商品"></div>';
const details = '<div class="quick_decoration_v2_sortableWrapper_test"><p id="counter">已上传0/50张</p>' +
  '<input type="file" multiple data-tracking-click-viewid="detail_img_localfile_upload"><div id="previews"></div></div>';
const mutation = `<script>window.dispatched=[];document.querySelector('input[type=file]').addEventListener('change',e=>{
  for(const file of e.target.files){window.dispatched.push(file.name);const img=document.createElement('img');
  img.setAttribute('data-tracking-click-viewid','el_preview_business_details');img.src='https://img.pddpic.com/mms-goods-image/test/'+file.name;
  document.querySelector('#previews').append(img);}document.querySelector('#counter').textContent='已上传'+window.dispatched.length+'/50张';
});</script>`;

test("PDD media contracts with intercepted local pages only", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdd-media-"));
  const browser = await chromium.launch({executablePath,headless:true});
  try {
    await fs.mkdir(path.join(root, "商品信息"));
    await fs.writeFile(path.join(root, "商品信息", "fixture.xlsx"), "workbook");
    const images = ["size.png", "01.png", "02.png"].map(f => path.join(root, f));
    for (const f of images) await fs.writeFile(f, png);
    const config = { platform: "pdd", draftOnly: true, materialRoot: root,
      product: { title: "离线商品", sizeImage: images[0], detailImages: images.slice(1), materialTagImages: [], mainImages: images.slice(1) },
      skuMatrix: [], input: { inputHash: "a".repeat(64), infoFile: "fixture.xlsx", workbookSha256: sha("workbook"),
        files: images.map(f => ({ file: path.basename(f), sha256: sha(png), bytes: png.length })), imageInfo: [] } };
    const validation = { inputHash: config.input.inputHash, executionHash: executionHash(config), errors: [] };
    const fullPlan = mediaPlan(config)[0];
    const plan = { ...fullPlan, files: fullPlan.files.slice(0, 3) };
    const context = await browser.newContext();
    await context.route("**/*", route => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: "<html></html>" })
      : route.fulfill({ contentType: "image/png", body: png,headers:{'access-control-allow-origin':'*'} }));
    const page = await context.newPage();
    await page.goto("https://mms.pinduoduo.com/goods/goods_add/index?goods_id=offline");
    const driver = new PddDriver({ page, expectedShop: "离线测试店" });
    const reset = async (body = details, script = mutation) => page.setContent(header + "<form>" + title + body + "</form>" + script);
    await t.test("17 slots retain repeated files and size once; confirmed rerun adds nothing", async () => {
      await reset();
      let receipt;
      const result = await uploadMediaPlan(driver, { config, validation, plan: fullPlan, persist: async r => { receipt = r; } });
      const expected = Array.from({length:17},(_,i)=>String(i+1).padStart(2,'0')+'.png');
      assert.deepEqual(await page.evaluate(() => window.dispatched), expected);
      assert.equal(result.urls.length, 17);
      await verifyMediaReceipts(driver, [{key: "details", ...result}], {config, validation});
      assert.equal(result.identity.files.filter(f => f.file === "size.png").length, 1);
      await uploadMediaPlan(driver, { config, validation, plan: fullPlan, receipt, persist: async () => assert.fail("must not dispatch") });
      assert.equal(await page.evaluate(() => window.dispatched.length), 17);
    });
    await t.test("ordered size-first upload and idempotent confirmed receipt", async () => {
      await reset();
      let receipt;
      const result = await uploadMediaPlan(driver, { config, validation, plan, persist: async r => { receipt = r; } });
      assert.deepEqual(await page.evaluate(() => window.dispatched), ["01.png", "02.png", "03.png"]);
      assert.deepEqual(result.identity.files.map(f => f.file), ["size.png", "01.png", "02.png"]);
      assert.equal(result.urls.length, 3);
      await assert.rejects(verifyMediaReceipts(driver, [{ key: "details", ...result }], { config, validation }), /当前上传计划/);
      await uploadMediaPlan(driver, { config, validation, plan, receipt, persist: async () => assert.fail("must not dispatch") });
      assert.equal(await page.evaluate(() => window.dispatched.length), 3);
      await page.locator('#previews img').first().evaluate(e => e.remove());
      await assert.rejects(uploadMediaPlan(driver, { config, validation, plan, receipt, persist: async () => {} }), /不一致/);
    });
    await t.test("preexisting unrelated detail cannot satisfy or receive uploads", async () => {
      await reset(details.replace('id="previews"></div>', 'id="previews"><img data-tracking-click-viewid="el_preview_business_details" src="https://img.pddpic.com/old.png"></div>'));
      await assert.rejects(uploadMediaPlan(driver, { config, validation, plan, persist: async () => {} }), /未知素材/);
      assert.deepEqual(await page.evaluate(() => window.dispatched), []);
    });
    await t.test("platform-hosted loading image is not an upload success", async () => {
      const slow = mutation.replace("img.src='https://img.pddpic.com/mms-goods-image/test/'+file.name;",
        "img.src='https://promotion.pddpic.com/promo/mms-static/loading.png';setTimeout(()=>{img.src='https://img.pddpic.com/mms-goods-image/test/'+file.name},120);");
      await reset(details, slow);
      const result = await uploadMediaPlan(driver, { config, validation, plan,
        persist: async r => { if (r.status === 'confirmed') assert(r.urls.every(u => !u.includes('mms-static'))); } });
      assert.equal(result.urls.length, 3);
      assert.deepEqual(await page.evaluate(() => window.dispatched), ["01.png", "02.png", "03.png"]);
    });
    await t.test("pending upload prevents retry even when a thumbnail exists", async () => {
      await reset();
      let pending;
      const badPlan = { ...plan, files: images.slice(0, 1) };
      await assert.rejects(uploadMediaPlan(driver, { config, validation, plan: badPlan,
        persist: async r => { pending = r; if (r.status === "pending") throw Error("simulated process interruption"); } }), /interruption/);
      await assert.rejects(uploadMediaPlan(driver, { config, validation, plan: badPlan, receipt: pending, persist: async () => {} }), /未确认/);
      assert.deepEqual(await page.evaluate(() => window.dispatched), []);
    });
    await t.test("a valid intermediate preview URL must settle before confirmation", async () => {
      const transient = mutation.replace("img.src='https://img.pddpic.com/mms-goods-image/test/'+file.name;",
        "img.src='https://pfs.pinduoduo.com/intermediate.jpeg';setTimeout(()=>{img.src='https://pfs.pinduoduo.com/final.jpeg'},90);");
      await reset(details, transient);
      const result = await uploadMediaPlan(driver, { config, validation, plan: { ...plan, files: [images[0]] }, persist: async () => {} });
      assert.deepEqual(result.urls, ['https://pfs.pinduoduo.com/final.jpeg']);
      assert(result.stableWindowMs >= 1500);
    });
    await t.test("video ignores hidden helper video, blob and unrelated decoration", async () => {
      await reset('<div id="basic.carousel_video"><input type="file" data-tracking-click-viewid="merchandise_video_localfile_upload">' +
        '<video id="myVideo" src="blob:old"></video><img src="https://img.pddpic.com/icon.png">' +
        '<div class="video-cards"><img class="card-img" src="blob:pending"></div></div>', "");
      const d = await mediaDescriptor(driver, "video");
      assert.deepEqual((await mediaState(driver, d)).urls, [null]);
      await page.locator('.card-img').evaluate(e => { e.src = 'https://img.pddpic.com/mms-material-img/video-cover.jpeg'; });
      await page.waitForFunction(() => document.querySelector('.card-img').complete);
      assert.equal((await mediaState(driver, d)).urls[0], "https://img.pddpic.com/mms-material-img/video-cover.jpeg");
    });
    await t.test("wrong product title stops before file dispatch", async () => {
      await reset();
      await page.locator('input[type=text]').fill('另一商品');
      await assert.rejects(uploadMediaPlan(driver, { config, validation, plan, persist: async () => {} }), /其他商品/);
      assert.deepEqual(await page.evaluate(() => window.dispatched), []);
    });
    await t.test("white preview remains readable after its full upload input disappears", async () => {
      await reset('<div data-tracking-impr-viewid="upload_white_bg_img"><div class="MaterialModalButton_v2_imageBox_test" ' +
        'style="background-image:url(https://pfs.pinduoduo.com/white.jpeg)"></div><span>白底图</span></div>', '');
      const descriptor = await mediaDescriptor(driver, 'white');
      assert.equal(descriptor.file, null);
      assert.deepEqual((await mediaState(driver, descriptor)).urls, ['https://pfs.pinduoduo.com/white.jpeg']);
    });
    await t.test("out-of-ratio packaging is blocked before touching browser", () => {
      const tag = { kind: "tags", files: [images[0]] };
      assert.throws(() => assertPlanInput(tag, { ...config, input: { ...config.input,
        imageInfo: [{ file: "size.png", width: 1080, height: 1920 }] } }, validation), /包装标签图/);
      assert.doesNotThrow(() => assertPlanInput(tag, { ...config, input: { ...config.input,
        imageInfo: [{ file: "size.png", width: 1080, height: 1440 }] } }, validation));
    });
    await t.test("valid packaging uses its own input and rejects loading placeholder", async () => {
      const tagConfig = { ...config, input: { ...config.input, imageInfo: [{ file: "size.png", width: 1080, height: 1440 }] } };
      const tagValidation = { ...validation, executionHash: executionHash(tagConfig) };
      const tagPlan = { key: "tags", kind: "tags", files: [images[0]] };
      await reset('<div id="basic.pack_label_image"><p id="counter">已上传0/10张</p>' +
        '<input type="file" data-tracking-click-viewid="upload_image_label"><div id="previews"></div></div>',
        `<script>window.dispatched=[];document.querySelector('input[type=file]').addEventListener('change',e=>{
        window.dispatched.push(e.target.files[0].name);const slot=document.createElement('div');slot.className='MaterialModalButton_v2_imageBox_test';
        slot.style.backgroundImage='url(https://promotion.pddpic.com/promo/mms-static/loading.png)';document.querySelector('#previews').append(slot);
        document.querySelector('#counter').textContent='已上传1/10张';setTimeout(()=>{slot.style.backgroundImage='url(https://pfs.pinduoduo.com/real-label.jpeg)'},80);});</script>`);
      const result = await uploadMediaPlan(driver, { config: tagConfig, validation: tagValidation, plan: tagPlan, persist: async () => {} });
      assert.deepEqual(result.urls, ['https://pfs.pinduoduo.com/real-label.jpeg']);
      assert.deepEqual(await page.evaluate(() => window.dispatched), ['size.png']);
    });
    await t.test("styles sharing an image cannot reuse each other's receipt", async () => {
      const styleConfig = { ...config, product: { ...config.product, mainImages: [images[1]] },
        skuMatrix: [{ style: "上衣", styleNote: "单件", image: "01" }, { style: "上衣+裤子", styleNote: "套装", image: "01" }] };
      const styleValidation = { ...validation, executionHash: executionHash(styleConfig) };
      const styleRow = (name, note) => '<div class="new-spec-single-color"><input placeholder="选择或输入主色" value="'+name+'">' +
        '<input placeholder="备注（偏深/浅等）" value="'+note+'"><input type="file"></div>';
      await reset('<div id="newSpec">'+styleRow('上衣','单件')+styleRow('上衣+裤子','套装')+'</div>',
        `<script>window.dispatched=[];for(const input of document.querySelectorAll('input[type=file]'))input.addEventListener('change',e=>{
        window.dispatched.push(e.target.files[0].name);const slot=document.createElement('span');slot.className='MaterialModalButton_imgContainer_test';
        slot.style.backgroundImage='url(https://pfs.pinduoduo.com/spec-image.jpeg)';input.closest('.new-spec-single-color').append(slot);});</script>`);
      const plans = mediaPlan(styleConfig).filter(p => p.kind === 'style');
      const receipt = await uploadMediaPlan(driver, { config: styleConfig, validation: styleValidation, plan: plans[0], persist: async () => {} });
      await assert.rejects(uploadMediaPlan(driver, { config: styleConfig, validation: styleValidation, plan: plans[1], receipt, persist: async () => {} }), /不属于当前款式/);
      assert.equal(await page.evaluate(() => window.dispatched.length), 1);
      await uploadMediaPlan(driver, { config: styleConfig, validation: styleValidation, plan: plans[1], persist: async () => {} });
      assert.equal(await page.evaluate(() => window.dispatched.length), 2);
    });
    await t.test("frozen material changes stop before upload", async () => {
      await reset();
      await fs.writeFile(images[0], "changed");
      await assert.rejects(uploadMediaPlan(driver, { config, validation, plan, persist: async () => {} }), /已改变/);
      assert.deepEqual(await page.evaluate(() => window.dispatched), []);
    });
  } finally {
    await browser.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
