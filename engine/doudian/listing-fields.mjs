// Playwright DOM 适配器：真实页面复测需用户批准；任何定位/回读失败都抛错。
export async function fillSizeChart(page,config) {
  const chart=config.sizeChart;
  if(!Array.isArray(chart)||chart.length!==config.sizeSpecs.length) throw new Error('尺码表缺少身高/体重资料');
  const table=page.locator('table').filter({has:page.locator('[id="SIZE_TITLE_身高(cm)"]')});
  await table.waitFor({state:'visible',timeout:10000});

  for(const title of ['身高(cm)','体重(斤)']) {
    const checkbox=table.locator(`[id="SIZE_TITLE_${title}"] input[type="checkbox"]`);
    if(!await checkbox.isChecked()) await checkbox.locator("xpath=ancestor::label[1]").click({force:true,timeout:10000});
    await page.waitForFunction(title=>document.getElementById(`SIZE_TITLE_${title}`)?.querySelector('input[type="checkbox"]')?.checked,title,{timeout:5000});
  }
  for(const spec of chart){
    const row=table.locator('tbody tr[data-row-key]').filter({has:page.getByText(spec.size,{exact:true})});
    if(await row.count()!==1) throw new Error(`尺码行定位不唯一：${spec.size}`);
    for(const [index,values] of [[1,spec.height],[2,spec.weight]]){
      if(!Array.isArray(values)||values.length!==2||values.some(v=>!Number.isFinite(v))||values[0]>values[1]) throw new Error(`区间无效：${spec.size}`);
      const cell=row.locator('td').nth(index);
      const fields=[cell.getByPlaceholder('最小值',{exact:true}),cell.getByPlaceholder('最大值',{exact:true})];
      await fields[0].waitFor({state:'visible',timeout:10000});
      await fields[1].waitFor({state:'visible',timeout:10000});
      if(await cell.locator('input').count()!==2) throw new Error(`区间值未启用：${spec.size}/${index}`);
      for(let i=0;i<2;i++) {
        await fields[i].fill(String(values[i]),{force:true,timeout:10000});
        await fields[i].blur();
        if(Number(await fields[i].inputValue())!==values[i]) throw new Error(`尺码回读失败：${spec.size}`);
      }
    }
    // 仅写入身高和体重；其他测量字段保持空白，旧数据不沿用。
    const cells=row.locator('td');
    for(let i=3;i<await cells.count();i++) for(const input of await cells.nth(i).locator('input').all()) if(await input.inputValue()) await input.fill('',{force:true,timeout:10000});
  }
  const errors=await table.locator('[class*="explain-error"]').allTextContents();
  const heightError=page.getByText(/尺码信息中身高.*不能完全相同/);
  if(errors.length || await heightError.isVisible().catch(()=>false)) throw new Error(`平台尺码校验失败（保留素材库原值）：${errors.join('；') || await heightError.innerText()}`);
}

async function filterBatch(page,label,target) {
  // 顶部批量设置的多选控件。每次先清空，再精确选择单个款式/尺码。
  const batch=page.getByPlaceholder('价格',{exact:true}).locator('xpath=ancestor::*[.//div[contains(concat(" ", normalize-space(@class), " "), " ecom-g-select ")]][1]');
  const selector=batch.locator('.ecom-g-select').nth(label==='全部颜色分类'?0:1);
  if(!await selector.count()) throw new Error(`找不到批量筛选：${label}`);
  const current=await selector.locator('.ecom-g-select-selection-item-content').allTextContents();
  if(current.length===1 && current[0].trim()===target) return selector;
  const toggle=selector.locator('input[role=combobox]');
  if(await toggle.getAttribute('aria-expanded')!=='true') await selector.locator('.ecom-g-select-arrow').click({force:true,timeout:10000});
  const dropdown=page.locator('.ecom-g-select-dropdown:visible').last();
  await dropdown.waitFor({state:'visible',timeout:10000});
  const selected=dropdown.locator('.ecom-g-select-item-option-selected');
  for(let guard=0;await selected.count();guard++){
    if(guard>20) throw new Error(`无法清空筛选：${label}`);
    await selected.first().click();
  }
  const option=dropdown.locator('.ecom-g-select-item-option').filter({has:page.getByText(target,{exact:true})});
  if(await option.count()!==1) throw new Error(`批量选项不唯一：${target}`);
  await option.click();
  const onlyTargetSelected = await dropdown.locator('.ecom-g-select-item-option').count()===1 && await option.evaluate(e=>e.classList.contains('ecom-g-select-item-option-selected'));
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('价格',{exact:true}).click();
  const values=await selector.locator('.ecom-g-select-selection-item').allTextContents();
  const allMeansOnlyTarget=onlyTargetSelected && values.length===1 && values[0].trim()===label;
  if(!allMeansOnlyTarget && (values.length!==1 || values[0].trim()!==target)) throw new Error(`批量筛选回读失败：${target} / ${values.join(',')}`);
  return selector;
}

export async function fillSkuPrices(page,config) {
  if(config.inventory.stockOperation!=='set-final-value') throw new Error('库存必须设置最终值');
  // 每次只选一个款式、一个尺码，因此明确的尺码差价不会被批量统一价覆盖。
  for(const sku of config.skuMatrix){
    const color=config.colorSpecs.find(s=>s.name===sku.color);
    const size=config.sizeSpecs.find(s=>s.name===sku.size);
    const colorLabel=color.name;
    const sizeLabel=size.name;
    // 恢复后再定位“全部”入口，避免把上一轮选中的筛选带到下一轮。
    const colorFilter=await filterBatch(page,'全部颜色分类',colorLabel);
    const sizeFilter=await filterBatch(page,'全部尺码大小',sizeLabel);
    for(const [placeholder,value] of [['价格',sku.price],['现货库存',sku.inStock],['预售库存',sku.preSale]]){
      const input=page.getByPlaceholder(placeholder,{exact:true});
      await input.fill(String(value),{timeout:10000});
      if(Number(await input.inputValue())!==Number(value)) throw new Error(`批量值回读失败：${sku.color}/${sku.size}/${placeholder}`);
    }
    if(sku.merchantCode){const code=page.getByPlaceholder('商家编码',{exact:true});await code.fill(sku.merchantCode,{timeout:10000});if(await code.inputValue()!==sku.merchantCode)throw new Error('商家编码批量输入回读失败');}
    await page.getByRole('button',{name:'批量设置',exact:true}).click({timeout:10000});
    console.log(`批量提交SKU：${sku.color}/${sku.size}，价格=${sku.price}，现货=${sku.inStock}，预售=${sku.preSale}（最终回读在保存前执行）`);

  }
}

export async function verifySkuTable(page,config) {
  const holder=page.locator('.ecom-g-table-tbody-virtual-holder');
  await holder.waitFor({state:'visible',timeout:10000});
  await holder.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
  const found=new Map();let bottomPasses=0,reachedEnd=false;
  for(let pass=0;pass<200;pass++){
    await page.waitForTimeout(200);
    const rows=await holder.evaluate(e=>{
      const groupCells=[...e.querySelectorAll('tr.ecom-g-table-row-extra .attr-column-field_spec_0')].filter(c=>c.innerText.trim());
      return [...e.querySelectorAll('tr[data-row-key]:not(.ecom-g-table-row-extra)')].map(row=>{
        const y=row.getBoundingClientRect().top+1;
        const group=groupCells.find(cell=>{const r=cell.getBoundingClientRect();return y>=r.top&&y<r.bottom;});
        const val=cls=>row.querySelector(`.${cls} input`)?.value;
        return {key:row.getAttribute('data-row-key'),color:group?.innerText.trim(),size:row.querySelector('.attr-column-field_spec_1')?.innerText.trim(),merchantCode:row.querySelector('input[placeholder="请输入erp编码"]')?.value,price:val('attr-column-field_price'),inStock:val('attr-column-field_stock_info'),preSale:val('attr-column-field_step_stock_info')};
      });
    });
    for(const row of rows) if(row.color) found.set(row.key,row);
    // Read to the actual end: reaching the expected count alone can hide extra SKUs.
    const scroll=await holder.evaluate(e=>({top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight}));
    if(scroll.top+scroll.height>=scroll.total-2){
      if(++bottomPasses>=2){reachedEnd=true;break;}
    }else bottomPasses=0;
    await holder.evaluate(e=>{e.scrollTop=Math.min(e.scrollTop+Math.max(1,Math.floor(e.clientHeight*0.7)),e.scrollHeight);e.dispatchEvent(new Event('scroll'));});
  }
  if(!reachedEnd)throw new Error('SKU表格未读到末尾，禁止保存；检查窗口布局或虚拟列表结构');
  const values=[...found.values()];
  if(values.length!==config.skuMatrix.length) throw new Error(`SKU回读数量错误：${values.length}/${config.skuMatrix.length}`);
  for(const expected of config.skuMatrix){
    const c=config.colorSpecs.find(c=>c.name===expected.color),s=config.sizeSpecs.find(s=>s.name===expected.size);
    const matches=values.filter(row=>row.color===`${c.name}（${c.remark}）`&&row.size===`${s.name}（${s.remark}）`);
    if(matches.length!==1) throw new Error(`SKU身份回读错误：${expected.color}/${expected.size}`);
    if(expected.merchantCode&&matches[0].merchantCode!==expected.merchantCode)throw new Error(`商家编码不符：${expected.color}/${expected.size}，实际=${matches[0].merchantCode}，应为${expected.merchantCode}`);
    for(const key of ['price','inStock','preSale']) if(matches[0][key]===''||Number(matches[0][key])!==Number(expected[key])) throw new Error(`SKU值不符：${expected.color}/${expected.size}/${key}=${matches[0][key]}，应为${expected[key]}`);
  }
  return values;
}

export async function fillMaterial(page,config) {
  const material=String(config.product.material ?? '').trim();
  const percent=Number(config.product.materialPercent);
  if(!material || percent!==100) throw new Error('当前单材质流程要求明确的材质名称和100%含量');
  const field=page.locator('[attr-field-id="面料材质"]').last();
  const existing=await field.locator('.aurora-select-selection-item-content').allTextContents();
  if(existing.length===1 && existing[0].trim()===`${material} ${percent}%`) return;
  const combo=field.getByRole('combobox');
  if(await combo.getAttribute('aria-expanded')!=='true') await combo.click({timeout:10000});
  const popup=page.locator('.aurora-dorami-composition-select-select-popup:visible');
  await popup.waitFor({state:'visible',timeout:10000});
  const rows=popup.locator('.aurora-dorami-composition-select-selected-row');
  const names=await rows.locator('.aurora-dorami-composition-select-selected-label').allTextContents();
  if(names.length!==1 || names[0].trim()!==material){
    // 吊牌OCR可能识别成“涤”；必须按素材库的精确选项重新选择。
    await popup.getByRole('button',{name:'清空',exact:true}).click();
    await popup.getByPlaceholder('搜索材质',{exact:true}).fill(material);
    // title 是平台可见选项的完整名称，避免搜索高亮 span 影响文本定位。
    const exact=popup.locator('.aurora-select-item-option').and(popup.getByTitle(material,{exact:true}));
    await exact.waitFor({state:'visible',timeout:15000});
    await exact.click();
  }
  const selected=rows.filter({has:page.locator('.aurora-dorami-composition-select-selected-label').getByText(material,{exact:true})});
  if(await rows.count()!==1 || await selected.count()!==1) throw new Error(`材质选项回读失败：应仅选${material}`);
  const input=selected.getByRole('spinbutton');
  await input.fill(String(percent));
  await input.blur();
  if(Number(await input.inputValue())!==percent) throw new Error('材质含量回读失败');
  await field.getByText('面料材质',{exact:true}).click();
  const expected=`${material} ${percent}%`;
  await field.locator('.aurora-select-selection-item-content').getByText(expected,{exact:true}).waitFor({state:'visible',timeout:10000});
  const tags=await field.locator('.aurora-select-selection-item-content').allTextContents();
  if(tags.length!==1 || tags[0].trim()!==expected) throw new Error(`材质最终显示错误：${tags.join('、')}`);
}
