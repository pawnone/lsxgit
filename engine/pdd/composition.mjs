const aliases={'涤纶':'涤纶（聚酯纤维）','聚酯纤维':'涤纶（聚酯纤维）'};
export function materialComponents(basic){
  let raw=String(basic['材质成分']||'').normalize('NFKC').trim();
  const amount=String(basic['成分含量']||'').normalize('NFKC').trim();
  if(!raw&&/^\d+(?:\.\d+)?\s*%$/.test(amount)&&basic['材质'])raw=basic['材质']+' '+amount;
  if(!raw)throw Error('针织衫缺少材质成分及具体百分比；成分区间不能代替具体含量');
  const values=raw.split(/[、,，;；\n]+/).map(s=>s.trim()).filter(Boolean).map(s=>{
    const match=/^(.+?)[：:\s]*(\d+(?:\.\d+)?)\s*%$/.exec(s);
    if(!match)throw Error('材质成分需填写“材质名称 百分比%”，不能使用区间：'+s);
    const rawName=match[1].trim();if(/[%\d]/.test(rawName))throw Error('材质成分名称中含有区间或重复百分比：'+s);
    const canonical=rawName.replace(/\(/g,'（').replace(/\)/g,'）'),name=aliases[canonical]||canonical,percent=Number(match[2]);
    if(percent<=0||percent>100)throw Error('材质成分百分比应大于0且不超过100：'+s);
    return{name,percent};
  });
  if(!values.length||values.length>7)throw Error('针织衫材质成分需要1～7项');
  if(new Set(values.map(v=>v.name)).size!==values.length)throw Error('材质成分存在重复材质');
  if(values.reduce((sum,v)=>sum+v.percent,0)>100.000001)throw Error('材质成分合计不能超过100%');
  return values;
}
const ordered=items=>[...items].sort((a,b)=>a.name.localeCompare(b.name));
export async function compositionState(driver){
  await driver.guard();
  return driver.read(()=>{
    const labels=[...document.querySelectorAll('form [class*="Form_itemLabelContent"]')].filter(e=>e.innerText.trim()==='材质成分');
    if(labels.length!==1)throw Error('材质成分字段不是唯一匹配');
    const root=labels[0].closest('[data-testid="beast-core-form-item"]');if(!root?.id)throw Error('材质成分缺少表单标识');
    const path=e=>{const parts=[];for(;e&&e!==document.documentElement;e=e.parentElement){const siblings=[...e.parentElement.children].filter(s=>s.tagName===e.tagName);parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(e)+1)+')');}return'html > '+parts.join(' > ');};
    return{root:'[id="'+root.id+'"]',items:[...root.querySelectorAll('[class*="IngredientList_selectedItem"]')].map(row=>{
      const names=row.querySelectorAll('input[data-testid="beast-core-select-htmlInput"]'),amounts=row.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"]');
      if(names.length!==1||amounts.length!==1)throw Error('材质成分行结构变化');
      return{name:names[0].value,percent:amounts[0].value===''?null:Number(amounts[0].value),input:path(amounts[0])};
    })};
  });
}
export async function configureComposition(driver,expected,{verifyOnly=false}={}){
  let state=await compositionState(driver);
  if(state.items.some(item=>!expected.some(v=>v.name===item.name)))throw Error('页面已有其他材质成分，不能覆盖未知数据');
  if(new Set(state.items.map(i=>i.name)).size!==state.items.length)throw Error('页面材质成分重复');
  const absent=expected.filter(item=>!state.items.some(v=>v.name===item.name));
  if(absent.length){
    if(verifyOnly)throw Error('保存后的材质成分缺项');
    const button=state.root+' [class*="IngredientList_addBtnWrapper"] button';
    await driver.exposeFormControl(button,{reserveBelow:300});await driver.click(button,{label:'添加商品表明确列出的材质成分'});
    const panel='[class*="IngredientList_searchPanel"]';
    await driver.wait(()=>document.querySelectorAll('[class*="IngredientList_searchPanel"]').length===1,undefined,10000);
    for(const item of absent){
      await driver.fill(panel+' input[placeholder="请输入搜索内容"]',item.name,{blur:false});
      await driver.wait(name=>[...document.querySelectorAll('[class*="IngredientList_searchPanel"] label[data-testid="beast-core-checkbox"]')].some(e=>e.innerText.trim()===name),item.name,10000);
      const option=await driver.read(name=>{
        const nodes=[...document.querySelectorAll('[class*="IngredientList_searchPanel"] label[data-testid="beast-core-checkbox"]')].filter(e=>e.innerText.trim()===name);
        if(nodes.length!==1)throw Error('材质选项不存在或不唯一：'+name);
        const e=nodes[0],literal=name.includes("'")?'concat('+name.split("'").map(part=>"'"+part+"'").join(',"\'",')+')':"'"+name+"'";
        // Search filtering moves rows after discovery; bind the native click
        // to the exact material text inside this panel, never its old index.
        return{selector:'xpath=//*[contains(@class,"IngredientList_searchPanel")]//label[@data-testid="beast-core-checkbox" and .//text()[normalize-space(.)='+literal+']]',checked:e.querySelector('input').checked,disabled:e.querySelector('input').disabled};
      },item.name);
      if(option.disabled)throw Error('平台禁用了该材质：'+item.name);
      if(!option.checked)await driver.click(option.selector,{label:'勾选精确匹配的商品材质',expectedText:item.name});
    }
    const confirm=panel+' button[class*="BTN_primary_"]';
    const text=await driver.read(css=>{const buttons=document.querySelectorAll(css);if(buttons.length!==1)throw Error('材质确认按钮不唯一');return buttons[0].innerText.replace(/\s/g,'');},confirm);
    if(!text.startsWith('确定('+absent.length+'/'))throw Error('勾选材质数量与商品表不符');
    await driver.click(confirm,{label:'确认本次勾选的材质集合'});
    await driver.wait(()=>document.querySelectorAll('[class*="IngredientList_searchPanel"]').length===0,undefined,10000);
    state=await compositionState(driver);
  }
  if(state.items.length!==expected.length)throw Error('材质成分数量回读不一致');
  for(const item of expected){
    const actual=state.items.find(v=>v.name===item.name);if(!actual)throw Error('缺少材质：'+item.name);
    if(actual.percent!==item.percent){
      if(verifyOnly)throw Error('材质百分比回读不一致：'+item.name);
      await driver.exposeFormControl(actual.input);await driver.fill(actual.input,String(item.percent),{blur:false});
      // The native number control formats 100 as 100.0 on blur. Read its
      // numeric value after committing instead of rejecting valid formatting.
      await driver.press(actual.input,'Tab');
    }
  }
  const readback=await compositionState(driver),actual=readback.items.map(({name,percent})=>({name,percent}));
  if(JSON.stringify(ordered(actual))!==JSON.stringify(ordered(expected)))throw Error('材质成分及百分比回读不一致');
  return{field:'材质成分',components:actual};
}
