import { assertSelected } from "./core/form-review.mjs";

const attributeSelector = value => '[id="' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]';

export async function fieldState(driver, field) {
  await driver.guard();
  const rows = await driver.read(name => {
    const visible = e => {
      if (!e?.getClientRects().length) return false;
      for (let p = e; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === "none" || s.visibility === "hidden") return false;
      }
      return true;
    };
    return [...document.querySelectorAll('form [class*="Form_itemLabelContent"]')]
      .filter(e => visible(e) && e.innerText.trim().replace(/^重要/, "") === name).map(label => {
        const row = label.closest('[data-testid="beast-core-form-item"]');
        if (!row) throw Error("字段缺少表单容器");
        const textInputs = [...row.querySelectorAll('input[type="text"]')].filter(visible);
        const multiple = !!row.querySelector('[class*="ST_selectValueMultiple"]');
        const candidates = (multiple ? [] : textInputs.filter(e => e.value.trim())).map(e => ({ field: name,
          visible: true, type: e.type, purpose: "selected", kind: "input", value: e.value.trim() }));
        for (const e of [...row.querySelectorAll('[class*="ST_selectValueSingle"]')].filter(visible)) {
          const value = e.innerText.trim();
          if (value) candidates.push({ field: name, visible: true, type: "text", purpose: "selected", kind: "display", value });
        }
        const tags = [...row.querySelectorAll('[data-testid="beast-core-tagGroup-tag"]')].filter(visible).map(e => e.innerText.trim());
        for (const value of tags) candidates.push({ field: name, visible: true, type: "text", purpose: "selected", kind: "tag", value });
        return { id: row.id, field: name, multiple, tags, headers: row.querySelectorAll('[data-testid="beast-core-select-header"]').length,
          inputs: textInputs.map(e => ({ value: e.value, readOnly: e.readOnly, disabled: e.disabled })), candidates };
      });
  }, field);
  if (rows.length !== 1 || !rows[0].id) throw Error("字段不存在或不唯一：" + field);
  return { ...rows[0], selector: attributeSelector(rows[0].id) };
}

async function popupCount(driver) {
  return driver.read(() => [...document.querySelectorAll('[data-testid="beast-core-portal"][class*="ST_dropdown_"]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).display !== "none").length);
}

async function exactOption(driver, value) {
  return driver.read(wanted => {
    const visible = e => {
      if (!e?.getClientRects().length) return false;
      for (let p = e; p; p = p.parentElement) if (getComputedStyle(p).display === "none") return false;
      return true;
    };
    const popups = [...document.querySelectorAll('[data-testid="beast-core-portal"][class*="ST_dropdown_"]')].filter(visible);
    if (popups.length !== 1) throw Error("当前字段下拉层不是唯一匹配");
    const matches = [...popups[0].querySelectorAll('[role="option"]')]
      .filter(e => visible(e) && e.innerText.trim() === wanted && e.getAttribute("data-disabled") !== "true");
    if (matches.length > 1) throw Error("下拉选项存在重名，不能取第一个");
    if (!matches.length) return null;
    const parts = [];
    for (let e = matches[0]; e && e !== document.documentElement; e = e.parentElement) {
      const siblings = [...e.parentElement.children].filter(p => p.tagName === e.tagName);
      parts.unshift(e.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")");
    }
    return { selector: "html > " + parts.join(" > "), text: wanted, checked: matches[0].getAttribute("data-checked") === "true" };
  }, value);
}

export async function selectField(driver, field, value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value === "不填写")
    throw Error("缺少明确的字段选项：" + field);
  return driver.step("填写属性：" + field, async () => {
    const state = await fieldState(driver, field);
    if (state.multiple || state.headers !== 1 || state.inputs.length !== 1) throw Error("字段不是已适配的单选控件：" + field);
    if (await popupCount(driver)) throw Error("上一下拉层仍未关闭，不能填写另一个字段");
    if (state.inputs[0].disabled) {
      assertSelected(value, state);
      return { field, value, mode: "platform-derived-readback" };
    }
    const header = state.selector + ' [data-testid="beast-core-select-header"]';
    await driver.exposeFormControl(header,{reserveBelow:220});
    await driver.click(header, { label: "选择商品属性选项" });
    await driver.wait(() => [...document.querySelectorAll('[data-testid="beast-core-portal"][class*="ST_dropdown_"]')]
      .filter(e => e.getClientRects().length && getComputedStyle(e).display !== "none").length === 1, undefined, 10000);
    let option = await exactOption(driver, value);
    if (!option && !state.inputs[0].readOnly && !state.inputs[0].disabled) {
      // Search only inside the identified field; never type into the active page.
      await driver.fill(state.selector + ' input[data-testid="beast-core-select-htmlInput"]', value, { blur: false });
      await driver.wait(wanted => [...document.querySelectorAll('[role="option"]')].some(e =>
        e.getClientRects().length && e.innerText.trim() === wanted && e.getAttribute("data-disabled") !== "true"), value, 10000);
      option = await exactOption(driver, value);
    }
    if (!option) throw Error("平台没有该精确选项：" + field + " = " + value);
    await driver.exposeDropdownOption(option.selector);
    await driver.click(option.selector, { label: "确认当前字段精确选项",expectedText:value });
    await driver.wait(() => [...document.querySelectorAll('[data-testid="beast-core-portal"][class*="ST_dropdown_"]')]
      .filter(e => e.getClientRects().length && getComputedStyle(e).display !== "none").length === 0, undefined, 10000);
    const readback = await fieldState(driver, field);
    assertSelected(value, readback);
    return { field, value };
  });
}

export async function selectMultiField(driver, field, values, { max = 3 } = {}) {
  if (!Array.isArray(values) || !values.length || values.length > max || new Set(values).size !== values.length ||
      values.some(v => typeof v !== "string" || !v.trim() || v !== v.trim() || v === "不填写"))
    throw Error("缺少有效的多选集合：" + field);
  return driver.step("填写多选属性：" + field, async () => {
    const state = await fieldState(driver, field);
    if (!state.multiple || state.headers !== 1 || state.inputs.length !== 1) throw Error("字段不是已适配的多选控件：" + field);
    if (state.tags.some(t => !values.includes(t))) throw Error("字段已有其他已选值，不能覆盖未知页面：" + field);
    if (await popupCount(driver)) throw Error("上一下拉层仍未关闭");
    if (values.every(v => state.tags.includes(v))) { assertSelected(values, state); return { field, values }; }
    const header = state.selector + ' [data-testid="beast-core-select-header"]';
    await driver.exposeFormControl(header,{reserveBelow:220});
    await driver.click(header, { label: "选择商品多选属性" });
    await driver.wait(() => [...document.querySelectorAll('[data-testid="beast-core-portal"][class*="ST_dropdown_"]')]
      .filter(e => e.getClientRects().length && getComputedStyle(e).display !== "none").length === 1, undefined, 10000);
    for (const value of values.filter(v => !state.tags.includes(v))) {
      let option = await exactOption(driver, value);
      if (!option) {
        await driver.fill(state.selector + ' input[data-testid="beast-core-select-htmlInput"]', value, { blur: false });
        await driver.wait(want => [...document.querySelectorAll('[role="option"]')].some(e =>
          e.getClientRects().length && e.innerText.trim() === want && e.getAttribute("data-disabled") !== "true"), value, 10000);
        option = await exactOption(driver, value);
      }
      if (!option) throw Error("缺少精确多选项：" + value);
      if (!option.checked) {await driver.exposeDropdownOption(option.selector);await driver.click(option.selector, { label: "勾选当前属性精确选项",expectedText:value });}
    }
    await driver.click(state.selector + ' label[class*="Form_itemLabelContent"]', { label: "完成当前多选属性填写" });
    await driver.wait(() => [...document.querySelectorAll('[data-testid="beast-core-portal"][class*="ST_dropdown_"]')]
      .filter(e => e.getClientRects().length && getComputedStyle(e).display !== "none").length === 0, undefined, 10000);
    assertSelected(values, await fieldState(driver, field));
    return { field, values };
  });
}

export async function fillTextField(driver, field, value) {
  return driver.step("填写属性：" + field, async () => {
    const state = await fieldState(driver, field);
    if (state.headers || state.inputs.length !== 1) throw Error("字段不是唯一文本输入：" + field);
    const input = state.selector + ' input[type="text"]';
    await driver.exposeFormControl(input);
    await driver.fill(input, value);
    const readback = await fieldState(driver, field);
    assertSelected(String(value), readback);
    return { field, value: String(value) };
  });
}

export async function waitForField(driver, field) {
  await driver.wait(name => [...document.querySelectorAll('form [class*="Form_itemLabelContent"]')]
    .filter(e => e.getClientRects().length && e.innerText.trim().replace(/^重要/, "") === name).length === 1, field, 15000);
  return fieldState(driver, field);
}

// The freight selector lives outside its radio field's form-item. Share the
// existing exact-option adapter, scoped to the observed freight container.
export async function selectControlState(driver,root){
  return driver.read(css=>{const rows=document.querySelectorAll(css);if(rows.length!==1)throw Error('选择区域不唯一');const headers=rows[0].querySelectorAll('[data-testid="beast-core-select-header"]'),inputs=rows[0].querySelectorAll('input[data-testid="beast-core-select-htmlInput"]');
    const candidates=[inputs[0]?.value?.trim(),headers[0]?.innerText.trim()].filter(v=>v&&!/^请选择/.test(v));
    const values=[...new Set(candidates)];if(values.length>1)throw Error('模板显示值与输入值冲突');
    return{headers:headers.length,inputs:inputs.length,value:values[0]||'',readOnly:inputs[0]?.readOnly};},root);
}
export async function selectControl(driver,root,value){
  const state=await selectControlState(driver,root);
  if(state.headers!==1||state.inputs!==1)throw Error('缺少唯一的模板下拉选择框');
  if(state.value===value)return;
  if(await popupCount(driver))throw Error('上一下拉层尚未关闭');
  const header=root+' [data-testid="beast-core-select-header"]';
  await driver.exposeFormControl(header,{reserveBelow:220});await driver.click(header,{label:'选择商品表中的运费模板'});
  await driver.wait(() => [...document.querySelectorAll('[data-testid="beast-core-portal"][class*="ST_dropdown_"]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).display !== "none").length === 1, undefined, 10000);
  let option=await exactOption(driver,value);
  if(!option&&!state.readOnly){
    await driver.fill(root+' input[data-testid="beast-core-select-htmlInput"]',value,{blur:false});
    await driver.wait(wanted=>[...document.querySelectorAll('[role="option"]')].some(e=>e.getClientRects().length&&e.innerText.trim()===wanted),value,10000);option=await exactOption(driver,value);
  }
  if(!option)throw Error('后台没有此精确运费模板：'+value);
  await driver.exposeDropdownOption(option.selector);await driver.click(option.selector,{label:'确认完整运费模板名称',expectedText:value});
  await driver.wait(() => [...document.querySelectorAll('[data-testid="beast-core-portal"][class*="ST_dropdown_"]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).display !== "none").length === 0, undefined, 10000);
  const got=await selectControlState(driver,root);
  if(got.headers!==1||got.inputs!==1||got.value!==value)throw Error('运费模板回读不一致');
}
