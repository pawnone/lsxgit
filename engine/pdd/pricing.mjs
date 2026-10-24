const normalize = s => String(s || "").trim().replace(/\s+/g, " ");
const title = (name, note) => normalize(name + (note ? " " + note : ""));
const money = text => /^\d+(?:\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;

export async function pricingState(driver, skus) {
  await driver.guard();
  const raw = await driver.read(() => {
    const headers = [...document.querySelectorAll("form thead")].filter(e =>
      [...e.querySelectorAll("th")].some(h => h.innerText.replace(/[\s*]/g, "") === "拼单价(元)"));
    if (headers.length !== 1) throw Error("价格表头不是唯一匹配");
    const header = headers[0], root = header.closest('[class*="TB_innerMiddle"]');
    if (!root) throw Error("价格表缺少已适配的表体容器");
    const names = [...header.querySelectorAll("th")].map(e => e.innerText.replace(/[\s*]/g, ""));
    const required = ["颜色分类", "尺码", "库存", "拼单价(元)", "单买价(元)", "预览图", "规格编码", "状态"];
    if (JSON.stringify(names) !== JSON.stringify(required)) throw Error("价格表列结构与已适配版本不同");
    const cssPath = node => {
      const parts = [];
      for (let e = node; e && e !== document.documentElement; e = e.parentElement) {
        const siblings = [...e.parentElement.children].filter(p => p.tagName === e.tagName);
        parts.unshift(e.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")");
      }
      return "html > " + parts.join(" > ");
    };
    const carry = new Map();
    return [...root.querySelectorAll('tbody > tr[data-testid="beast-core-table-body-tr"]')].map(row => {
      const cells = Array(required.length).fill(null);
      for (const [i, record] of carry) {
        cells[i] = record.cell;
        if (--record.left === 0) carry.delete(i);
      }
      let column = 0;
      for (const cell of row.cells) {
        while (cells[column]) column++;
        if (column >= required.length || cell.colSpan !== 1) throw Error("价格表合并单元格结构无法核对");
        cells[column] = cell;
        if (cell.rowSpan > 1) carry.set(column, { cell, left: cell.rowSpan - 1 });
        column++;
      }
      if (cells.some(c => !c)) throw Error("价格表有无法关联的跨行单元格");
      const values = {};
      for (const [index, key] of [[2, "stock"], [3, "groupPrice"], [4, "singlePrice"], [6, "code"]]) {
        const inputs = cells[index].querySelectorAll('input[type="text"]');
        if (inputs.length !== 1) throw Error("SKU字段缺少唯一文本输入：" + key);
        values[key] = { value: inputs[0].value, selector: cssPath(inputs[0]), disabled: inputs[0].disabled };
      }
      const switches = cells[7].querySelectorAll('[data-testid="beast-core-switch"]');
      if (switches.length !== 1) throw Error("SKU状态开关不是唯一匹配");
      return { styleTitle: cells[0].querySelector(".sku-row-title")?.innerText,
        sizeTitle: cells[1].querySelector(".sku-row-title")?.innerText, values,
        stateText: cells[7].querySelector(".sku-status-word")?.innerText.trim(), switchSelector: cssPath(switches[0]) };
    });
  });
  if (raw.length !== skus.length) throw Error("价格表行数与商品表不同，尚未完整加载或出现额外规格");
  const seen = new Set();
  return raw.map(row => {
    const matches = skus.filter(s => title(s.style, s.styleNote) === normalize(row.styleTitle) &&
      title(s.size, s.sizeNote) === normalize(row.sizeTitle));
    if (matches.length !== 1) throw Error("SKU完整款式、尺码或备注无法唯一匹配：" + row.styleTitle + " / " + row.sizeTitle);
    const source = matches[0], key = JSON.stringify([source.style, source.size]);
    if (seen.has(key)) throw Error("价格表出现重复SKU");
    seen.add(key);
    return { ...row, style: source.style, size: source.size,
      stock: /^\d+$/.test(row.values.stock.value) ? Number(row.values.stock.value) : null,
      groupPriceCents: money(row.values.groupPrice.value), singlePriceCents: money(row.values.singlePrice.value),
      code: row.values.code.value, state: row.stateText === "已启用" ? "启用" : row.stateText === "已停用" ? "停用" : null };
  });
}

export async function fillPricing(driver, skus) {
  await pricingState(driver, skus); // Verify the entire row identity map before writing any amounts.
  for (const source of skus) await driver.step("填写库存价格编码：" + source.style + " / " + source.size, async () => {
    const row = (await pricingState(driver, skus)).filter(r => r.style === source.style && r.size === source.size);
    if (row.length !== 1) throw Error("SKU行身份发生变化");
    const current = row[0];
    for (const [key, value] of [["stock", String(source.stock)], ["groupPrice", String(source.groupPriceCents / 100)],
      ["singlePrice", String(source.singlePriceCents / 100)], ["code", source.code]]) {
      if(key==='code'&&!source.code)continue;
      if (current.values[key].value === value) continue;
      if (current.values[key].disabled) throw Error("SKU字段不可编辑，需核对当前状态：" + key);
      await driver.exposeFormControl(current.values[key].selector);
      await driver.fill(current.values[key].selector, value);
    }
    let got = (await pricingState(driver, skus)).find(r => r.style === source.style && r.size === source.size);
    if (source.state && got.state !== source.state) {
      if (!got.state) throw Error("SKU状态无法识别");
      await driver.exposeFormControl(got.switchSelector);
      await driver.click(got.switchSelector, { label: "按商品表设置规格状态" });
      got = (await pricingState(driver, skus)).find(r => r.style === source.style && r.size === source.size);
    }
    for (const field of ["stock", "groupPriceCents", "singlePriceCents", "code", "state"])
      if((field!=='code'||source.code)&&(field!=='state'||source.state))
      if (got[field] !== source[field]) throw Error("SKU字段回读不一致：" + field);
  });
  const result = await pricingState(driver, skus);
  for (const source of skus) {
    const actual = result.find(r => r.style === source.style && r.size === source.size);
    for (const field of ["stock", "groupPriceCents", "singlePriceCents", "code", "state"])
      if((field!=='code'||source.code)&&(field!=='state'||source.state))
      if (actual[field] !== source[field]) throw Error("最终SKU字段回读不一致：" + field);
  }
  return result;
}
