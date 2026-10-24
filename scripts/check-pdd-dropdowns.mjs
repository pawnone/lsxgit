// Regression for native clicks on clipped portal options and fixed footers.
// Every request is intercepted. No merchant data or browser session is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {BrowserManager} from '../desktop/browser-manager.mjs';
import {PddDriver} from '../engine/pdd/dom-driver.mjs';
import {selectField,selectMultiField,selectControl} from '../engine/pdd/attributes.mjs';
const browser=await chromium.launch({executablePath:await new BrowserManager({}).detectExecutable(),headless:true});
const checks=[];
try{
  const context=await browser.newContext();await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html></html>'}));
  const page=await context.newPage();await page.goto('https://mms.pinduoduo.com/local-dropdown-test');
  const driver=new PddDriver({page,expectedShop:'本地下拉测试店'});
  if(process.env.WQ_TRACE_SCROLL){
    const wheel=driver.wheel.bind(driver);
    driver.wheel=async(...args)=>{
      const before=await page.evaluate(()=>({scrollY,y:document.querySelector('[data-testid="beast-core-select-header"]')?.getBoundingClientRect().y}));
      await wheel(...args);
      console.error(JSON.stringify({wheel:args,before,after:await page.evaluate(()=>({scrollY,y:document.querySelector('[data-testid="beast-core-select-header"]')?.getBoundingClientRect().y}))}));
    };
  }
  const setup=async(mode='single')=>{
    await page.setContent('<style>body{margin:0}form{margin:0 0 0 240px;min-height:2400px}.row{padding-top:1100px;display:flex;gap:16px}label{width:100px}input{width:150px}ul{margin:0;padding:0;max-height:168px;overflow-y:auto;list-style:none}li{height:28px;line-height:28px;padding:0 4px;box-sizing:border-box}.goods-footer-main{position:fixed;bottom:0;left:240px;right:0;height:52px;background:#ddd;z-index:1000}.ST_dropdown_test{position:absolute;width:202px;background:white;border:1px solid #aaa;z-index:200}#top{position:fixed;top:0;height:80px;width:100%;background:#eee;z-index:1000}</style>'+
      '<div id="top"><span class="user-name-name"><span class="user-name-text">本地下拉测试店</span></span></div><form><div class="row" data-testid="beast-core-form-item" id="'+(mode==='freight'?'cost_template_id':'service.group_time_second')+'"><label class="Form_itemLabelContent_test">预售时间</label><div data-testid="beast-core-select-header">'+
      '<span class="'+(mode==='multi'?'ST_selectValueMultiple_test':'ST_selectValueSingle_test')+'"><input type="text" data-testid="beast-core-select-htmlInput" readonly value=""></span></div></div></form><div class="goods-footer-main">提交并上架 / 保存草稿</div>');
    await page.evaluate(mode=>{
      window.clicked=[];window.initialListScroll=246.5;
      const header=document.querySelector('[data-testid="beast-core-select-header"]');
      document.querySelector('label').onclick=()=>document.querySelector('.ST_dropdown_test')?.remove();
      header.onclick=()=>{
        if(document.querySelector('.ST_dropdown_test'))return;
        const r=header.getBoundingClientRect();window.openHeaderTop=r.top;
        const portal=document.createElement('div');portal.dataset.testid='beast-core-portal';portal.className='ST_dropdown_test';portal.style.left=r.left+'px';portal.style.top=(scrollY+r.bottom+4)+'px';
        const list=document.createElement('ul');
        for(let i=3;i<=30;i++){
          const option=document.createElement('li');option.role='option';option.innerText=(mode==='freight'?'模板':'')+i+(mode==='freight'?'':'天');
          option.onclick=()=>{
            window.clicked.push(option.innerText);
            if(mode==='multi'){
              option.setAttribute('data-checked','true');const tag=document.createElement('span');tag.dataset.testid='beast-core-tagGroup-tag';tag.innerText=option.innerText;header.querySelector('span').prepend(tag);
            }else{header.querySelector('input').value=option.innerText;portal.remove();}
          };list.append(option);
        }
        portal.append(list);document.body.append(portal);list.scrollTop=window.initialListScroll;
      };
      scrollTo(0,1100-(innerHeight-110));
    },mode);
  };
  for(const viewport of [{width:1500,height:860},{width:1024,height:768}]){
    await page.setViewportSize(viewport);
    for(const days of ['3天','10天','30天']){
      await setup();
      try{await selectField(driver,'预售时间',days);}catch(error){
        console.error(JSON.stringify({viewport,days,dom:await page.evaluate(()=>[...document.querySelectorAll('[data-testid="beast-core-select-header"],.ST_dropdown_test,ul,.goods-footer-main')].map(e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,cls:e.className,y:r.y,h:r.height,x:r.x,w:r.width,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflow:getComputedStyle(e).overflowY};}))}));throw error;
      }
      assert.equal(await page.locator('input').inputValue(),days);
      assert.deepEqual(await page.evaluate(()=>window.clicked),[days]);
      const gap=await page.evaluate(()=>document.querySelector('.goods-footer-main').getBoundingClientRect().top-window.openHeaderTop);
      assert(gap>200);checks.push(viewport.width+'×'+viewport.height+'，'+days+'在底栏上方打开并在列表内滚动，只点击一次');
    }
  }
  await setup('multi');await selectMultiField(driver,'预售时间',['3天','30天']);
  assert.deepEqual(await page.evaluate(()=>window.clicked),['3天','30天']);checks.push('多选两端选项使用同一列表滚动规则并回读');
  await setup('freight');await selectControl(driver,'#cost_template_id','模板30');
  assert.equal(await page.locator('input').inputValue(),'模板30');checks.push('长运费模板下拉也先留空间，再滚动选中精确名称');
  await setup();await driver.exposeFormControl('[data-testid="beast-core-select-header"]',{reserveBelow:220});await driver.click('[data-testid="beast-core-select-header"]');
  await page.evaluate(()=>{const list=document.querySelector('ul');list.scrollTop=0;const e=document.createElement('div');e.id='blocker';e.style='position:fixed;inset:0;background:rgba(0,0,0,.1);z-index:9000';document.body.append(e);});
  await assert.rejects(driver.exposeDropdownOption('[role="option"]'),/不是唯一匹配/);
  await assert.rejects(driver.exposeDropdownOption('[role="option"]:first-child'),/被其他元素遮挡/);
  assert.deepEqual(await page.evaluate(()=>window.clicked),[]);checks.push('未知遮罩盖住选项时停止，不强制点击或自动重试');
  await page.evaluate(()=>document.querySelector('#blocker').remove());
  await assert.rejects(driver.click('[role="option"]:first-child',{expectedText:'错误选项'}),/内容已变化/);checks.push('目标选项文字变化时拒绝点击');
  const result={checks:checks.length,names:checks,merchantMutation:false};
  await fs.writeFile('output/pdd-046-audit/dropdown-test.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
