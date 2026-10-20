export function desiredAttributes(config){
 const p=config.product;const result=[['组合件数',[p.pieceCount]],['适用年龄',[p.applicableAge]],['风格',String(p.style||'').split('、').map(s=>s.trim()).filter(Boolean)]];
 for(const [field,values]of result)if(!values.length||values.some(v=>typeof v!=='string'||!v.trim()))throw new Error(`商品信息缺少${field}，禁止沿用页面默认值`);
 return result;
}
async function selected(field){
 const content=field.locator('.ecom-g-select-selection-item-content');
 return (await content.count()?await content.allTextContents():await field.locator('.ecom-g-select-selection-item').allTextContents()).map(v=>v.trim());
}
const same=(a,b)=>a.length===b.length&&[...a].sort().every((v,i)=>v===[...b].sort()[i]);
export async function verifyProductAttributes(page,config){
 for(const [label,values]of desiredAttributes(config)){const actual=await selected(page.locator(`[attr-field-id="${label}"]`));if(!same(actual,values))throw new Error(`保存前${label}不符：${actual.join('、')}，应为${values.join('、')}`);}
}
export async function fillProductAttributes(page,config){
 for(const [label,values]of desiredAttributes(config)){
  const field=page.locator(`[attr-field-id="${label}"]`);await field.waitFor({state:'visible',timeout:10000});
  if(same(await selected(field),values))continue;
  if(label==='风格'){
   const remove=field.locator('.ecom-g-select-selection-item-remove');
   for(let n=0;await remove.count();n++){if(n>20)throw new Error('无法清空旧风格');await remove.first().click({timeout:10000});}
   const combo=field.getByRole('combobox');
   for(const value of values){
    if(await combo.getAttribute('aria-expanded')!=='true')await field.locator('.ecom-g-select-selector').click({timeout:10000});
    await combo.fill(value,{timeout:10000});
    const popup=page.locator('.ecom-g-select-dropdown:visible').last();
    await popup.getByText(value,{exact:true}).click({timeout:10000});
   }
  }else{
   const combo=field.getByRole('combobox');await field.locator('.ecom-g-select-selector').click({timeout:10000});await combo.fill(values[0],{timeout:10000});
   const option=page.locator('.ecom-g-select-dropdown:visible .ecom-g-select-item-option').filter({has:page.getByText(values[0],{exact:true})});
   await option.click({timeout:10000});
  }
  await page.keyboard.press('Escape');await field.getByText(label,{exact:true}).click();
  if(!same(await selected(field),values))throw new Error(`${label}填写回读失败，已停止`);
 }
 await verifyProductAttributes(page,config);
}
