import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const engine=path.resolve(process.env.WQ_SCRIPT_ENGINE||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../engine/doudian'));
const {selectWizardCategory}=await import(pathToFileURL(path.join(engine,'category-entry.mjs')));
const {installSafetyGuard}=await import(pathToFileURL(path.join(engine,'safety-guard.mjs')));
const knit='服装 > 女装 > 针织衫/毛衣/羊毛衫',suit='服装 > 女装 > 时尚套装';
const browser=await chromium.launch({channel:'chrome',headless:true});
const checks=[];
try {
  const page=await browser.newPage();await installSafetyGuard(page);
  const fixture=(target,duplicate=false)=>`<div class="styles_categorySelectorV2__abc"><div data-category-recommend-list="true"><div class="styles_itemSelected__abc"><span>${suit}</span></div></div></div><button id="more">更多推荐</button><button id="next" onclick="window.advanced=true">下一步</button><script>
    document.querySelector('#more').onclick=()=>{document.querySelector('#more').remove();const r=document.querySelector('[data-category-recommend-list]');for(const label of ${JSON.stringify(target?[knit,...duplicate?[knit]:[]]:['服装 > 女装 > 半身裙'])}){const d=document.createElement('div');const s=document.createElement('span');s.textContent=label;d.append(s);d.onclick=()=>{for(const e of r.children)e.className='';d.className='styles_itemSelected__abc';};r.append(d);}};
  </script>`;
  await page.setContent(fixture(true));
  const evidence=await selectWizardCategory(page,knit);assert.equal(evidence.source,'recommendation-exact');assert.deepEqual(evidence.selected,[knit]);assert.equal(await page.evaluate(()=>!!window.advanced),false);checks.push('更多推荐展开后选择目标，核对选中项，保持下一步未点击');
  await page.setContent(fixture(false));await assert.rejects(selectWizardCategory(page,knit),/未出现在平台可选类目中/);assert.equal(await page.evaluate(()=>!!window.advanced),false);checks.push('复现旧标题推荐套装：明确报错且不推进错误类目');
  await page.setContent(fixture(true,true));await assert.rejects(selectWizardCategory(page,knit),/未出现在平台可选类目中/);checks.push('重复目标类目阻断，不随机选择');
  await page.setContent(`<div class="styles_categorySelectorV2__abc"><div data-category-recommend-list="true"><div class="styles_itemSelected__abc"><span>${knit}</span></div></div></div>`);assert.deepEqual((await selectWizardCategory(page,knit)).selected,[knit]);checks.push('平台已准确选中目标时直接核对通过');
  await page.setContent(`<button id="manual">手动选择类目</button><div role="dialog" style="display:none"><h2>选择类目</h2><div>服装</div><div>女装</div><div>针织衫/毛衣/羊毛衫</div><button id="confirm">确认</button></div><script>document.querySelector('#manual').onclick=()=>{document.querySelector('[role=dialog]').style.display='block';};document.querySelector('#confirm').onclick=()=>{document.querySelector('[role=dialog]').style.display='none';const s=document.createElement('span');s.className='styles_itemSelected__abc';s.innerHTML='<span class="style_selectedItem__a"><span><span class="style_selectedItem__a"><span><span class="style_selectedItem__a">服装</span></span>女装</span></span>针织衫/毛衣/羊毛衫</span>';const root=document.createElement('div');root.className='styles_categorySelectorV2__abc';root.append(s);document.body.append(root);};</script>`);assert.equal((await selectWizardCategory(page,knit)).source,'manual');checks.push('旧版手动选择弹窗兼容');
  console.log(JSON.stringify({checks,merchantMutation:false}));
} finally {await browser.close();}
