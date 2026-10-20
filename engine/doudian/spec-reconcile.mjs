import {assertSafetyClear} from './safety-guard.mjs';
export function exactNames(actual,desired){return actual.length===desired.length&&actual.every((x,i)=>x===desired[i]);}
const region=(page,label)=>page.locator(`[id="skuValue-${label}"]`);
export async function readSpecs(page,label){return region(page,label).locator('.ecom-g-cascader-picker-label').allTextContents().then(a=>a.map(x=>x.trim()).filter(Boolean));}
async function waitNames(page,label,expected){
 await page.waitForFunction(({label,expected})=>{const r=document.getElementById(`skuValue-${label}`);const a=r?[...r.querySelectorAll('.ecom-g-cascader-picker-label')].map(e=>e.textContent.trim()).filter(Boolean):[];return JSON.stringify(a)===JSON.stringify(expected);},{label,expected},{timeout:10000});
}
export async function verifySpecs(page,config){
 const evidence={};
 for(const [label,specs]of [['颜色分类',config.colorSpecs],['尺码大小',config.sizeSpecs]]){
  const actual=await readSpecs(page,label),expected=specs.map(s=>s.name);
  if(!exactNames(actual,expected))throw new Error(`规格集合不符：${label}，实际=${JSON.stringify(actual)}，配置=${JSON.stringify(expected)}`);
  const remarks=region(page,label).getByPlaceholder('备注',{exact:true});
  if(await remarks.count()!==specs.length)throw new Error(`${label}备注数量不符`);
  for(let i=0;i<specs.length;i++)if(await remarks.nth(i).inputValue()!==specs[i].remark)throw new Error(`${label}/${specs[i].name}备注不符`);
  evidence[label]=actual;
 }
 return evidence;
}
export async function selectSizeOption(page,name){
 const item=page.locator('[class*="groupItem"]:visible').filter({has:page.getByText(name,{exact:true})});
 if(await item.count()!==1)throw new Error(`尺码选项不唯一或不存在：${name}`);
 const checkbox=item.locator('input[type="checkbox"]');
 if(await checkbox.count()!==1)throw new Error(`尺码选项缺少可回读状态：${name}`);
 if(!await checkbox.isChecked())await item.click({timeout:10000});
 await page.waitForFunction(name=>[...document.querySelectorAll('[class*="groupItem"]')].some(e=>e.getClientRects().length&&e.innerText.trim()===name&&e.querySelector('input[type="checkbox"]')?.checked),name,{timeout:5000});
}
export async function reconcileSpecs(page,config){
 const manual=page.getByText('切换手动填写',{exact:true});if(await manual.isVisible())await manual.click();
 const evidence={};
 for(const [label,specs]of [['颜色分类',config.colorSpecs],['尺码大小',config.sizeSpecs]]){
  await assertSafetyClear(page);
  const r=region(page,label);await r.waitFor({state:'visible',timeout:15000});
  const desired=specs.map(s=>s.name),before=await readSpecs(page,label);evidence[label]={before,desired};
  if(!exactNames(before,desired)){
   // Reset a mismatching collection, rather than appending to unknown AI-prefilled values.
   await page.keyboard.press('Escape');
   for(let remaining=before.length;remaining>0;remaining--){
    await assertSafetyClear(page);
    const remove=r.locator('[data-kora="删除规格值"]');
    if(await remove.count()!==remaining)throw new Error(`${label}删除入口数量与现有规格不符，停止适配`);
    await remove.last().click({timeout:10000});
    await waitNames(page,label,before.slice(0,remaining-1));
   }
   if(label==='颜色分类'){
    for(let i=0;i<specs.length;i++){
     await assertSafetyClear(page);
     const picker=r.locator('.ecom-g-cascader-picker-multiple');
     const menu=page.locator('[class*="cascaderPopup"]:visible');
     if(!await menu.isVisible())await picker.click({timeout:10000});
     await menu.waitFor({state:'visible',timeout:10000});
     await menu.getByText('创建类型',{exact:true}).click({timeout:10000});
     const input=page.getByPlaceholder('请输入规格值',{exact:true});await input.fill(specs[i].name);await input.press('Enter');
     // The popup counts this pending selection, not the already committed rows.
     const popup=page.locator('[class*="cascaderPopup"]:visible');
     // Creation may commit immediately or leave a pending checkbox selection.
     // Wait for either real state; never assume that Enter requires confirmation.
     await page.waitForFunction(({expected,name})=>{
      const rows=[...document.querySelectorAll('[id="skuValue-颜色分类"] .ecom-g-cascader-picker-label')].map(e=>e.textContent.trim()).filter(Boolean);
      if(JSON.stringify(rows)===JSON.stringify(expected))return true;
      return [...document.querySelectorAll('[class*="cascaderPopup"]')].filter(e=>e.getClientRects().length).some(e=>{
       const chosen=[...e.querySelectorAll('li')].filter(li=>li.querySelector('input[type="checkbox"]:checked')).map(li=>li.textContent.trim());
       return chosen.length===1&&chosen[0]===name;
      });
     },{expected:desired.slice(0,i+1),name:specs[i].name},{timeout:10000});
     if(!exactNames(await readSpecs(page,label),desired.slice(0,i+1))){
      const chosen=await popup.locator('li').filter({has:page.locator('input[type="checkbox"]:checked')}).allTextContents();
      if(chosen.length!==1||chosen[0].trim()!==specs[i].name)throw new Error(`待提交规格与配置不符：${JSON.stringify(chosen)}`);
      await popup.getByRole('button',{name:/^确定\s*[（(]1[）)]$/}).click({timeout:10000});
     }
     await waitNames(page,label,desired.slice(0,i+1));
    }
   }else{
    await r.getByText('请选择尺码大小',{exact:true}).click({timeout:10000});
    await page.getByText('中国码',{exact:true}).click({timeout:10000});
    for(const spec of specs)await selectSizeOption(page,spec.name);
    await page.getByRole('button',{name:new RegExp(`^确定\\s*[（(]${specs.length}[）)]$`)}).click({timeout:10000});
    await waitNames(page,label,desired);
   }
  }
  const remarks=r.getByPlaceholder('备注',{exact:true});
  if(await remarks.count()!==specs.length)throw new Error(`${label}备注入口数量不符`);
  for(let i=0;i<specs.length;i++)await remarks.nth(i).fill(specs[i].remark);
 }
 evidence.after=await verifySpecs(page,config);return evidence;
}
