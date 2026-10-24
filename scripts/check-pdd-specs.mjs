// Native regression for the merchant's asynchronous name-blur row snapshot.
// All requests are intercepted locally; no real shop or draft is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {BrowserManager} from '../desktop/browser-manager.mjs';
import {PddDriver} from '../engine/pdd/dom-driver.mjs';
import {createSpecifications,specificationState} from '../engine/pdd/specs.mjs';

const browser=await chromium.launch({executablePath:await new BrowserManager({}).detectExecutable(),headless:true});
const checks=[];
try{
  const context=await browser.newContext();
  await context.route('**/*',async route=>{
    if(new URL(route.request().url()).pathname==='/glide/v2/mms/query/spec/by/name'){
      await new Promise(resolve=>setTimeout(resolve,200));
      return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
    }
    return route.fulfill({contentType:'text/html',body:'<html></html>'});
  });
  const page=await context.newPage();await page.goto('https://mms.pinduoduo.com/local-spec-test');
  const driver=new PddDriver({page,expectedShop:'本地备注测试店'});
  const press=driver.press.bind(driver);
  driver.press=async(...args)=>{await press(...args);await new Promise(resolve=>setTimeout(resolve,100));};
  const fixture=async()=>{
    await page.setContent('<div class="user-name-name"><span class="user-name-text">本地备注测试店</span></div><form><div id="newSpec"><div id="styles"></div><div id="sizes"></div></div></form>');
    await page.evaluate(()=>{
      window.specEvents=[];window.pendingNames=0;
      const append=()=>{
        const row=document.createElement('div');row.className='new-spec-single-color';
        row.innerHTML='<input placeholder="选择或输入主色"><input placeholder="备注（偏深/浅等）">';
        const [name,note]=row.querySelectorAll('input');
        name.oninput=()=>{if(name.value&&!row.nextElementSibling)append();};
        name.onblur=async()=>{
          if(!name.value)return;
          const snapshot={name:name.value,note:note.value};window.pendingNames++;
          window.specEvents.push({kind:'validate',...snapshot});
          await fetch('/glide/v2/mms/query/spec/by/name',{method:'POST',body:JSON.stringify(snapshot)});
          note.value=snapshot.note;window.pendingNames--;
          window.specEvents.push({kind:'commit',...snapshot});
        };
        note.oninput=()=>window.specEvents.push({kind:'note',name:name.value,note:note.value});
        document.querySelector('#styles').append(row);
      };
      append();
      document.querySelector('#sizes').innerHTML=['S','M','L','XL'].map(name=>'<div class="normal-check"><label data-testid="beast-core-checkbox"><input type="checkbox"><span class="check-wrapper">'+name+'</span></label><input placeholder="备注"></div>').join('');
    });
  };
  const skus=styles=>styles.flatMap(([style,styleNote])=>['S','M','L','XL'].map(size=>({style,styleNote,size,sizeNote:'（'+size+'码）'})));
  const complete=async input=>{
    await createSpecifications(driver,input);
    await page.waitForFunction(()=>window.pendingNames===0);
    return specificationState(driver);
  };
  await fixture();
  const single=skus([['上衣','（单件）']]);
  const actual=await complete(single);
  assert.equal(actual.colors.find(s=>s.name==='上衣')?.note,'（单件）');
  const events=await page.evaluate(()=>window.specEvents);
  assert.equal(events.find(e=>e.kind==='validate').note,'（单件）');
  assert.equal(events.filter(e=>e.kind==='note').length,1);
  checks.push('单上衣备注在名称异步校验前进入同一行快照，延迟返回后仍保留，只填写一次');
  await fixture();
  const set=skus([['上衣','（单件）'],['裤子','（单件）'],['上衣+裤子','（两件套）']]);
  const batch=await complete(set);
  assert.deepEqual(batch.colors.filter(s=>s.name).map(({name,note})=>[name,note]),[['上衣','（单件）'],['裤子','（单件）'],['上衣+裤子','（两件套）']]);
  assert.deepEqual(batch.sizes.filter(s=>s.checked).map(({name,note})=>[name,note]),['S','M','L','XL'].map(s=>[s,'（'+s+'码）']));
  checks.push('套装三款式和四尺码备注分别对应，异步返回不丢失或串行');
  await complete(set);assert.equal((await specificationState(driver)).colors.filter(s=>s.name).length,3);
  checks.push('已有相同款式只填本行备注，不新增重复款式');
  await fixture();const optional=await complete(skus([['上衣','']]));
  assert.equal(optional.colors.find(s=>s.name==='上衣')?.note,'');checks.push('原表备注留空仍允许，不把选填备注改为必填');
  await assert.rejects(createSpecifications(driver,skus([['裤子','（单件）']])),/其他款式/);
  checks.push('存在未知款式时仍阻断，不覆盖其他商品');
  await assert.rejects(createSpecifications(driver,[...single,{...single[0],styleNote:'冲突备注'}]),/备注存在冲突/);
  checks.push('同款式冲突备注仍在输入前阻断');
  assert.equal(context.pages().length,1);
  const result={checks:checks.length,names:checks,merchantMutation:false};
  const out=process.env.WQ_AUDIT_DIR||'output/pdd-049-audit';await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(out,'specs-native-test.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
