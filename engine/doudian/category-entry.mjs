import {assertSafetyClear} from './safety-guard.mjs';

const recommended = page => page.locator('[data-category-recommend-list="true"]').filter({visible:true});
const categoryDialog = page => page.getByRole('dialog').filter({hasText:'选择类目'}).filter({visible:true});
const manualEntry = page => page.getByText('手动选择类目',{exact:true}).filter({visible:true});

export async function readWizardCategory(page) {
  const root=page.locator('[class*="categorySelectorV2"]').filter({visible:true});
  if(await root.count()!==1)return [];
  return root.locator('[class*="itemSelected"]').evaluateAll(items=>items.map(item=>{
    const crumbs=[...item.querySelectorAll('[class*="selectedItem"]')];
    if(crumbs.length)return crumbs.map(el=>[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim()).filter(Boolean).reverse().join(' > ');
    return item.innerText.trim();
  }));
}

export async function verifyWizardCategory(page,category,{timeout=10000}={}) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    await assertSafetyClear(page);
    const selected=await readWizardCategory(page);
    if(selected.length===1&&selected[0]===category)return selected;
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error(`首步类目选中结果不符：期望“${category}”，实际“${(await readWizardCategory(page)).join('、')||'未选中'}”；未点击下一步`);
}

async function readRecommendedSelection(region) {
  return region.locator('[class*="itemSelected"]').allTextContents().then(a=>a.map(s=>s.trim()));
}

export async function selectWizardCategory(page, category, {timeout=30000}={}) {
  const deadline=Date.now()+timeout;
  // Title/image recognition is asynchronous. Wait for a supported, visible entry.
  while(Date.now()<deadline) {
    await assertSafetyClear(page);
    if(await categoryDialog(page).count() || await manualEntry(page).count())break;
    const region=recommended(page);
    if(await region.count()===1 && (await region.innerText()).trim().includes('>'))break;
    await new Promise(r=>setTimeout(r,250));
  }
  await assertSafetyClear(page);
  let dialog=categoryDialog(page);
  if(!await dialog.count() && await manualEntry(page).count()) {
    if(await manualEntry(page).count()!==1)throw Error('手动类目入口不唯一，已停止');
    await manualEntry(page).click({timeout:10000});
    await categoryDialog(page).waitFor({state:'visible',timeout:10000});
    dialog=categoryDialog(page);
  }
  if(await dialog.count()) {
    if(await dialog.count()!==1)throw Error('类目选择弹窗不唯一，已停止');
    for(const part of category.split('>').map(s=>s.trim())) {
      await assertSafetyClear(page);
      const option=dialog.getByText(part,{exact:true}).filter({visible:true});
      await option.waitFor({state:'visible',timeout:10000});
      if(await option.count()!==1)throw Error(`类目层级选项不唯一：${part}`);
      await option.click({timeout:10000});
    }
    await dialog.getByRole('button',{name:'确认',exact:true}).click({timeout:10000});
    await dialog.waitFor({state:'hidden',timeout:10000});
    const selected=await verifyWizardCategory(page,category);
    return {category,source:'manual',selected};
  }
  const region=recommended(page);
  if(await region.count()!==1)throw Error('未找到可用的类目选择入口，请保留页面检查；未点击下一步');
  let option=region.getByText(category,{exact:true});
  if(!await option.count()) {
    const more=page.getByRole('button',{name:'更多推荐',exact:true}).filter({visible:true});
    if(await more.count()===1) {
      await more.click({timeout:10000});
      await more.waitFor({state:'hidden',timeout:10000});
    }
  }
  await assertSafetyClear(page);
  if(await option.count()!==1) {
    const available=(await region.innerText()).trim().replace(/\s*\n\s*/g,'；');
    throw Error(`目标类目“${category}”未出现在平台可选类目中。当前可选：${available||'无'}。请检查商品信息.xlsx「基础信息」的商品标题和类目是否与实物一致；未点击下一步，未采用其他类目`);
  }
  let selected=await readRecommendedSelection(region);
  if(selected.length!==1 || selected[0]!==category) {
    await option.click({timeout:10000});
    await page.waitForFunction(category=>{
      const roots=[...document.querySelectorAll('[data-category-recommend-list="true"]')].filter(e=>e.getClientRects().length);
      if(roots.length!==1)return false;
      const values=[...roots[0].querySelectorAll('[class*="itemSelected"]')].map(e=>e.innerText.trim());
      return values.length===1&&values[0]===category;
    },category,{timeout:10000});
    selected=await readRecommendedSelection(region);
  }
  if(selected.length!==1||selected[0]!==category)throw Error(`类目选中结果不符：${selected.join('、')}`);
  await assertSafetyClear(page);
  return {category,source:'recommendation-exact',selected};
}
