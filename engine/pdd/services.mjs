import { selectField, waitForField } from "./attributes.mjs";

// Validated live category path: period presales use a duration, not calendar
// dates. Other presale types require their own adapter and must not fall back.
export async function configurePeriodPresale(driver, service) {
  const mode = service?.["发货模式"], match = /^(\d+)天内发货$/.exec(String(service?.["承诺发货时间/时效"] || ""));
  if (mode !== "时段预售" || !match || Number(match[1]) < 3 || Number(match[1]) > 30)
    throw Error("时段预售适配器需要商品表明确指定时段预售及3～30天内发货");
  await driver.guard();
  const radio = await driver.read(() => {
    const labels = [...document.querySelectorAll('[id="service.is_pre_sale"] label[data-testid="beast-core-radio"]')];
    const matches = labels.filter(e => e.innerText.trim() === "时段预售");
    if (matches.length !== 1) throw Error("时段预售控件不是唯一匹配");
    const e = matches[0], index = [...e.parentElement.children].filter(p => p.tagName === "LABEL").indexOf(e) + 1;
    return { checked: e.querySelector('input[type="radio"]')?.checked,
      selector: '[id="service.is_pre_sale"] label[data-testid="beast-core-radio"]:nth-of-type(' + index + ')' };
  });
  if (!radio.checked) {
    await driver.exposeFormControl(radio.selector);
    await driver.click(radio.selector, { label: "按商品表选择时段预售" });
  }
  await waitForField(driver, "预售时间");
  await selectField(driver, "预售时间", Number(match[1]) + "天");
  const current = await driver.read(() => [...document.querySelectorAll('[id="service.is_pre_sale"] label[data-testid="beast-core-radio"]')]
    .filter(e => e.querySelector('input[type="radio"]')?.checked).map(e => e.innerText.trim()));
  if (current.length !== 1 || current[0] !== mode) throw Error("预售模式回读不一致");
  return { mode, days: Number(match[1]) };
}
