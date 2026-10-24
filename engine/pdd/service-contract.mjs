import {fieldState,selectControl,selectControlState} from './attributes.mjs';
import {configurePeriodPresale} from './services.mjs';
import {missing} from './field-policy.mjs';

// Locate by the visible merchant field, never by a position or shop name.
export async function serviceControl(driver,field) {
  await driver.guard();
  return driver.read(name=>{
    const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    const clean=s=>s.replace(/[\s*：:]/g,'');
    const path=e=>{const parts=[];for(;e&&e!==document.documentElement;e=e.parentElement){const same=[...e.parentElement.children].filter(s=>s.tagName===e.tagName);parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+(same.indexOf(e)+1)+')');}return'html > '+parts.join(' > ');};
    let labels=[...document.querySelectorAll('form [class*="Form_itemLabelContent"]')].filter(e=>visible(e)&&clean(e.innerText)===clean(name));
    const checkboxField=['7天无理由退货','假一赔十'].includes(name);
    if(!labels.length&&checkboxField)labels=[...document.querySelectorAll('form label[data-testid="beast-core-checkbox"]')].filter(e=>visible(e)&&clean(e.innerText)===clean(name));
    if(labels.length!==1)throw Error('缺少唯一的服务字段：'+name);
    const row=checkboxField?labels[0]:labels[0].closest('[data-testid="beast-core-form-item"]');
    if(!row)throw Error('服务字段容器不存在：'+name);
    return{field:name,text:row.innerText,selector:path(row),
      inputs:[...row.querySelectorAll('input')].filter(e=>e.type!=='hidden').map(e=>({type:e.type,value:e.value,checked:e.checked,disabled:e.disabled,readOnly:e.readOnly,selector:path(e)})),
      choices:[...(row.tagName==='LABEL'?[row]:[]),...row.querySelectorAll('label')].filter(e=>visible(e)&&e.querySelector('input[type="radio"],input[type="checkbox"]')).map(e=>({text:e.innerText.trim().replace(/\s*推荐$/,''),checked:e.querySelector('input').checked,type:e.querySelector('input').type,selector:path(e)}))};
  },field);
}
async function choose(driver,field,value,{verifyOnly=false}={}) {
  const row=await serviceControl(driver,field);
  const matches=row.choices.filter(c=>c.text===value);
  if(matches.length!==1)throw Error('服务选项不唯一：'+field+' / '+value);
  const selected=row.choices.filter(c=>c.checked);
  if(matches[0].checked&&selected.length===1)return{field,value};
  if(verifyOnly)throw Error('服务回读不一致：'+field);
  await driver.exposeFormControl(matches[0].selector);await driver.click(matches[0].selector,{label:'按商品表设置服务选项'});
  return choose(driver,field,value,{verifyOnly:true});
}
async function toggle(driver,field,enabled,{verifyOnly=false}={}) {
  const row=await serviceControl(driver,field),choices=row.choices.filter(c=>c.type==='checkbox');
  if(choices.length!==1)throw Error('服务开关不是唯一复选框：'+field);
  if(choices[0].checked===enabled)return{field,enabled};
  if(row.inputs.some(i=>i.type==='checkbox'&&i.disabled))throw Error('平台已锁定此服务状态，与表格冲突：'+field);
  if(verifyOnly)throw Error('服务开关回读不一致：'+field);
  await driver.exposeFormControl(choices[0].selector);await driver.click(choices[0].selector,{label:'按商品表设置服务开关'});
  return toggle(driver,field,enabled,{verifyOnly:true});
}
async function input(driver,field,value,{verifyOnly=false}={}) {
  const row=await serviceControl(driver,field),inputs=row.inputs.filter(c=>['text','number'].includes(c.type));
  if(inputs.length!==1)throw Error('缺少唯一的服务输入：'+field);
  if(inputs[0].value===String(value))return{field,value:String(value)};
  if(verifyOnly||inputs[0].disabled||inputs[0].readOnly)throw Error('服务输入回读不一致：'+field);
  await driver.exposeFormControl(inputs[0].selector);await driver.fill(inputs[0].selector,String(value));
  return input(driver,field,value,{verifyOnly:true});
}
export function assertServiceRange(config) {
  const b=config.pdd.basic,s=config.pdd.service;
  for(const key of ['商品类型','是否二手','是否定制','发货模式','运费模板'])if(missing(s[key]))throw Error('缺少平台必填服务：'+key);
  if(!missing(s['7天无理由退货'])&&!['支持','不支持'].includes(s['7天无理由退货']))throw Error('7天无理由退货选项无法识别');
  if(!missing(s['假一赔十'])&&!['不开通','支持','不支持','开通'].includes(s['假一赔十']))throw Error('假一赔十选项无法识别');
  if(s['发货模式']!=='时段预售'||!/^\d+天内发货$/.test(s['承诺发货时间/时效']))throw Error('当前拼多多仅适配时段预售');
  if(!['普通商品'].includes(s['商品类型'])||!['非二手'].includes(s['是否二手'])||!['非定制'].includes(s['是否定制']))throw Error('当前仅适配普通、非二手、非定制商品');
  if(!missing(b['库存扣减方式'])&&b['库存扣减方式']!=='支付成功减库存')throw Error('当前仅适配支付成功减库存');
  if(!['启用','不启用','停用'].includes(b['满件折扣']))throw Error('请明确满件折扣是否启用');
}
export async function configureServices(driver,config,{verifyOnly=false}={}) {
  assertServiceRange(config);
  const b=config.pdd.basic,s=config.pdd.service,results=[];
  // Some merchant pages collapse the service editor on reopening.
  const expand=await driver.read(()=>[...document.querySelectorAll('#goods-service button,#goods-service a,#goods-service span,#goods-service div')].filter(e=>e.getClientRects().length&&e.children.length===0&&e.innerText.trim()==='展开修改').map(e=>e.tagName.toLowerCase()));
  if(expand.length===1){
    const selector=await driver.read(()=>{const a=[...document.querySelectorAll('#goods-service button,#goods-service a,#goods-service span,#goods-service div')].filter(e=>e.getClientRects().length&&e.children.length===0&&e.innerText.trim()==='展开修改');const parts=[];for(let e=a[0];e&&e!==document.documentElement;e=e.parentElement){const same=[...e.parentElement.children].filter(s=>s.tagName===e.tagName);parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+(same.indexOf(e)+1)+')');}return'html > '+parts.join(' > ');});
    await driver.exposeFormControl(selector);
    await driver.click(selector,{label:'展开商品服务设置'});
    await driver.wait(()=>[...document.querySelectorAll('form [class*="Form_itemLabelContent"]')].some(e=>e.innerText.trim()==='商品类型'),undefined,10000);
  }
  for(const field of ['商品类型','是否二手','是否定制'])results.push(await choose(driver,field,s[field],{verifyOnly}));
  if(!missing(s['7天无理由退货']))results.push(await toggle(driver,'7天无理由退货',s['7天无理由退货']==='支持',{verifyOnly}));
  if(!missing(s['假一赔十']))results.push(await toggle(driver,'假一赔十',['支持','开通'].includes(s['假一赔十']),{verifyOnly}));
  if(verifyOnly){
    const mode=await driver.read(()=>[...document.querySelectorAll('[id="service.is_pre_sale"] label')].filter(e=>e.querySelector('input[type="radio"]')?.checked).map(e=>e.innerText.trim()));
    const days=await fieldState(driver,'预售时间');
    if(mode.length!==1||mode[0]!==s['发货模式']||!days.inputs.some(i=>i.value===s['承诺发货时间/时效'].replace('内发货','')))throw Error('预售模式或天数回读不一致');
  }else results.push(await configurePeriodPresale(driver,s));
  results.push(await configureFreight(driver,s,{verifyOnly}));
  if(!missing(s['拼单人数'])){
    results.push(await readStaticSetting(driver,'拼单人数',String(s['拼单人数'])));
  }
  if(!missing(b['库存扣减方式']))results.push(await readStaticSetting(driver,'库存扣减方式',b['库存扣减方式']));
  // Product-level merchant code follows the Excel item number. Retain the
  // legacy code only for older sheets that have no item-number value.
  const goodsCode=!missing(b['商品货号'])?b['商品货号']:b['商品编码'];
  if(!missing(goodsCode)){
    const selector='[id="sku.out_goods_sn"] input[type="text"]';
    let values=await driver.read(css=>[...document.querySelectorAll(css)].map(e=>e.value),selector);
    if(values.length!==1)throw Error('商品编码输入不唯一');
    if(values[0]!==String(goodsCode)){
      if(verifyOnly)throw Error('商品编码回读不一致');
      await driver.exposeFormControl(selector);await driver.fill(selector,String(goodsCode));
      values=await driver.read(css=>[...document.querySelectorAll(css)].map(e=>e.value),selector);
      if(values.length!==1||values[0]!==String(goodsCode))throw Error('商品编码回读不一致');
    }
    results.push({field:'商品编码',value:String(goodsCode),source:!missing(b['商品货号'])?'商品货号':'商品编码'});
  }
  results.push(await input(driver,'商品参考价',b['商品参考价（元）'],{verifyOnly}));
  const discount=await serviceControl(driver,'满件折扣');
  const matched=discount.text.replace(/\s/g,'').match(/满(\d+)件(\d+(?:\.\d+)?)?折?/);
  const editable=discount.inputs.filter(i=>i.type==='text'||i.type==='number');
  if(b['满件折扣']==='启用'&&matched&&Number(matched[1])===Number(b['满件数量'])&&editable.length===1){
    await input(driver,'满件折扣',b['折扣（几折）'],{verifyOnly});
    results.push({field:'满件折扣',count:Number(matched[1]),discount:Number(b['折扣（几折）'])});
  }
  else if(b['满件折扣']==='启用'&&matched&&Number(matched[1])===Number(b['满件数量'])&&Number(matched[2])===Number(b['折扣（几折）']))results.push({field:'满件折扣',count:Number(matched[1]),discount:Number(matched[2])});
  else if(b['满件折扣']==='停用'&&/未设置|不设置|不参与|已停用/.test(discount.text))results.push({field:'满件折扣',enabled:false});
  else throw Error('平台当前满件折扣与表格不符，当前修改入口尚未核对；已停止，请反馈此步骤');
  const extras=await driver.read(()=>[...document.querySelectorAll('#goods-service label,[id^="service."] label')].filter(e=>e.querySelector('input[type="checkbox"]')?.checked&&e.getClientRects().length).map(e=>e.innerText.trim()));
  if(!missing(s['其他服务设置'])&&s['其他服务设置']==='不开通额外服务'&&extras.some(t=>!t.includes('7天无理由')))throw Error('检测到额外已开通服务，请人工核对：'+extras.join('、'));
  return results;
}

async function readStaticSetting(driver,field,value){
  const found=await driver.read(({field,value})=>[...document.querySelectorAll('form *')].filter(e=>e.children.length===0&&e.innerText?.trim()===field).some(e=>{for(let p=e.parentElement,n=0;p&&n<4;p=p.parentElement,n++){const text=p.innerText.replace(/\s/g,'');if(text.length<200&&text.includes(field+value))return true;}return false;}),{field,value});
  if(!found)throw Error('平台只读字段与表格不符：'+field);return{field,value,readOnly:true};
}
async function configureFreight(driver,service,{verifyOnly}){
  const name=service['运费模板'];
  let row=await serviceControl(driver,'运费模板');
  const current=row.choices.find(c=>c.checked)?.text;
  if(current!==name){
    if(current!=='其他模板'){
      if(verifyOnly)throw Error('运费模板与表格不符');
      await choose(driver,'运费模板','其他模板');
      await driver.wait(()=>document.querySelectorAll('#cost_template_id [data-testid="beast-core-select-header"]').length===1,undefined,10000);
    }
    const selected=await selectControlState(driver,'#cost_template_id');
    if(selected.headers!==1||selected.inputs!==1||selected.value!==name){if(verifyOnly)throw Error('运费模板回读不一致');await selectControl(driver,'#cost_template_id',name);}
  }
  const text=await driver.read(()=>{
    const root=document.querySelector('#cost_template_id');if(!root)throw Error('运费区域不存在');
    return root.innerText+'\n'+[...root.querySelectorAll('[title]')].map(e=>e.title).join('\n');
  });
  const rule=service['运费范围及收费规则'];
  if(!missing(rule)){
    const normalize=s=>s.replace(/[，,、\s]/g,'');
    if(normalize(rule)==='大陆包邮港澳台不发'){
      const free=text.split('包邮配送区域')[1]?.split(/买家付运费区域|不配送区域/)[0]||'';
      const paid=text.split('买家付运费区域')[1]?.split('不配送区域')[0]||'';
      const excluded=text.split('不配送区域')[1]||'';
      if(!(/新疆/.test(free)&&/西藏/.test(free)&&!/付费规则|元/.test(paid)&&['香港','澳门','台湾'].every(p=>excluded.includes(p))))throw Error('运费详情尚不能确认为大陆包邮、港澳台不发，请检查所选模板');
    }else if(!normalize(text).includes(normalize(rule)))throw Error('页面无法精确核对表内运费范围及收费规则');
  }
  return{field:'运费模板',value:name,rule:text,explicitRule:!missing(rule)};
}
