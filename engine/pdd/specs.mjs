// Specification creation only. Pricing, state and image readback are separate
// stages; finishing this function does not permit saving a draft.
export async function specificationState(driver) {
  await driver.guard();
  return driver.read(() => {
    const cssPath = node => {
      if (!node) return null;
      const parts = [];
      for (let e = node; e && e !== document.documentElement; e = e.parentElement) {
        const siblings = [...e.parentElement.children].filter(p => p.tagName === e.tagName);
        parts.unshift(e.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")");
      }
      return "html > " + parts.join(" > ");
    };
    const colors = [...document.querySelectorAll('#newSpec .new-spec-single-color')].map(row => {
      const name = row.querySelector('input[placeholder="选择或输入主色"]');
      const note = row.querySelector('input[placeholder*="备注"]');
      return { name: name?.value, note: note?.value, nameSelector: cssPath(name), noteSelector: cssPath(note),
        fileSelector: row.querySelectorAll('input[type="file"]').length === 1 ? cssPath(row.querySelector('input[type="file"]')) : null };
    });
    const sizes = [...document.querySelectorAll('#newSpec .normal-check')].map(row => {
      const labels = [...row.querySelectorAll('label[data-testid="beast-core-checkbox"]')];
      if (labels.length !== 1) throw Error("尺码行复选框不唯一");
      const label = labels[0], input = label.querySelector('input[type="checkbox"]');
      const name = label.querySelector('.check-wrapper')?.innerText.trim();
      const note = row.querySelector('input[placeholder*="备注"]');
      return { name, checked: input?.checked, selector: cssPath(label), note: note?.value, noteSelector: cssPath(note) };
    }).filter(s => s.name);
    return { colors, sizes };
  });
}

export async function ensureSizeStandard(driver,names){
  const initial=await specificationState(driver);
  if(names.every(name=>initial.sizes.some(s=>s.name===name)))return;
  if(initial.sizes.some(s=>s.checked))throw Error('当前尺码制式已有选中规格，不能覆盖未知尺码');
  // The knit editor defaults to 通用 (150/72A, ...). Its 中国码 tab
  // explicitly contains S/M/L/XL; use that observed standard without mapping
  // or inventing a different size value.
  if(!names.every(name=>/^(?:XXS|XS|S|M|L|XL|[2-6]XL)$/.test(name)))throw Error('当前制式没有商品表尺码，尚未切换或填写');
  const selector=await driver.read(()=>{
    const nodes=[...document.querySelectorAll('#newSpec [class*="sizeStandardWrapper_sizeStandardWrapper"] label[data-testid="beast-core-radio"]')].filter(e=>e.innerText.trim()==='中国码');
    if(nodes.length!==1||nodes[0].querySelector('input')?.disabled)throw Error('平台没有唯一可用的中国码制式');
    const parts=[];for(let e=nodes[0];e&&e!==document.documentElement;e=e.parentElement){const siblings=[...e.parentElement.children].filter(s=>s.tagName===e.tagName);parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(e)+1)+')');}return'html > '+parts.join(' > ');
  });
  await driver.step('按表内字母尺码选择中国码',async()=>{
    await driver.exposeFormControl(selector);await driver.click(selector,{expectedText:'中国码',label:'选择包含表内字母尺码的中国码'});
    await driver.wait(wanted=>wanted.every(name=>[...document.querySelectorAll('#newSpec .normal-check .check-wrapper')].some(e=>e.innerText.trim()===name)),names,10000);
  });
}

export async function createSpecifications(driver, skus) {
  if (!Array.isArray(skus) || !skus.length) throw Error("缺少规格输入");
  const styles = [...new Set(skus.map(s => s.style))].map(name => {
    const rows = skus.filter(s => s.style === name), notes = [...new Set(rows.map(s => s.styleNote || ""))];
    if (notes.length !== 1) throw Error("同款式备注存在冲突：" + name);
    return { name, note: notes[0] };
  });
  const sizes = [...new Set(skus.map(s => s.size))].map(name => {
    const rows = skus.filter(s => s.size === name), notes = [...new Set(rows.map(s => s.sizeNote || ""))];
    if (notes.length !== 1) throw Error("同尺码备注存在冲突：" + name);
    return { name, note: notes[0] };
  });
  const initial = await specificationState(driver);
  if (initial.colors.some(c => c.name && !styles.some(s => s.name === c.name)) ||
      initial.sizes.some(s => s.checked && !sizes.some(w => w.name === s.name)))
    throw Error("当前页面存在其他款式或尺码，不能覆盖未知页面");
  await ensureSizeStandard(driver,sizes.map(s=>s.name));
  for (const style of styles) await driver.step("创建款式：" + style.name, async () => {
    const state = await specificationState(driver);
    let matches = state.colors.filter(c => c.name === style.name);
    if (matches.length > 1) throw Error("款式名称重复：" + style.name);
    if (!matches.length) {
      const blanks = state.colors.filter(c => c.name === "");
      if (blanks.length !== 1 || !blanks[0].nameSelector) throw Error("缺少唯一空白款式行");
      matches = blanks;
    }
    if (matches.length !== 1 || !matches[0].noteSelector) throw Error("款式备注输入不唯一");
    // Name blur restores an asynchronously validated row snapshot. Enter the
    // note first so that the snapshot preserves it when validation completes.
    await driver.exposeFormControl(matches[0].noteSelector);
    await driver.fill(matches[0].noteSelector, style.note);
    if (matches[0].name !== style.name) {
      await driver.exposeFormControl(matches[0].nameSelector);
      await driver.fill(matches[0].nameSelector, style.name);
      await driver.wait(name => [...document.querySelectorAll('#newSpec .new-spec-single-color input[placeholder="选择或输入主色"]')]
        .filter(e => e.value === name).length === 1, style.name, 10000);
    }
    const got = (await specificationState(driver)).colors.filter(c => c.name === style.name);
    if (got.length !== 1 || got[0].note !== style.note) throw Error("款式或备注回读不一致");
  });
  for (const size of sizes) await driver.step("创建尺码：" + size.name, async () => {
    let matches = (await specificationState(driver)).sizes.filter(s => s.name === size.name);
    if (matches.length !== 1) throw Error("平台没有唯一的标准尺码：" + size.name);
    if (!matches[0].checked) {
      await driver.exposeFormControl(matches[0].selector);
      await driver.click(matches[0].selector, { label: "勾选商品表中的尺码" });
      await driver.wait(name => [...document.querySelectorAll('#newSpec .normal-check')].some(row =>
        row.querySelector('.check-wrapper')?.innerText.trim() === name && row.querySelector('input[type="checkbox"]')?.checked), size.name, 10000);
    }
    matches = (await specificationState(driver)).sizes.filter(s => s.name === size.name);
    if (!matches[0].noteSelector) throw Error("尺码备注输入未出现：" + size.name);
    await driver.exposeFormControl(matches[0].noteSelector);
    await driver.fill(matches[0].noteSelector, size.note);
    const got = (await specificationState(driver)).sizes.filter(s => s.name === size.name);
    if (got.length !== 1 || !got[0].checked || got[0].note !== size.note) throw Error("尺码及备注回读不一致");
  });
  const result = await specificationState(driver);
  const gotStyles = result.colors.filter(c => c.name).map(c => c.name).sort();
  const gotSizes = result.sizes.filter(s => s.checked).map(s => s.name).sort();
  if (JSON.stringify(gotStyles) !== JSON.stringify(styles.map(s => s.name).sort()) ||
      JSON.stringify(gotSizes) !== JSON.stringify(sizes.map(s => s.name).sort())) throw Error("最终款式尺码集合与商品表不同");
  return result;
}

export async function disablePlatformSizeChart(driver) {
  await driver.guard();
  const disabledSelector = 'button[data-tracking-click-viewid="enable_size_chart"]';
  const activeSelector = 'a[data-tracking-click-viewid="disable_size_chart"]';
  const state = await driver.read(({ activeSelector, disabledSelector }) => ({
    active: document.querySelectorAll(activeSelector).length,
    disabled: document.querySelectorAll(disabledSelector).length,
  }), { activeSelector, disabledSelector });
  if (state.active === 0 && state.disabled === 1) return { platformSizeChart: "停用" };
  if (state.active !== 1 || state.disabled) throw Error("平台尺码表状态不明确");
  await driver.exposeFormControl(activeSelector);
  await driver.click(activeSelector, { label: "按商品表停用平台尺码表" });
  const confirmation = await driver.read(() => {
    const buttons = [...document.querySelectorAll('button[data-testid="beast-core-button"]')]
      .filter(e => e.getClientRects().length && e.innerText.trim() === "确认停用");
    if (buttons.length !== 1) throw Error("停用尺码表确认按钮不唯一");
    const parts = [];
    for (let e = buttons[0]; e && e !== document.documentElement; e = e.parentElement) {
      const siblings = [...e.parentElement.children].filter(p => p.tagName === e.tagName);
      parts.unshift(e.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")");
    }
    return "html > " + parts.join(" > ");
  });
  await driver.click(confirmation, { label: "确认商品表指定停用尺码表" });
  await driver.wait(({ activeSelector, disabledSelector }) => document.querySelectorAll(activeSelector).length === 0 &&
    document.querySelectorAll(disabledSelector).length === 1, { activeSelector, disabledSelector }, 10000);
  return { platformSizeChart: "停用" };
}
