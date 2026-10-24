// Read-only acceptance of the installed bundle against the real material tree.
// Config is cloned to a private temp dir; no login, upload or save is dispatched.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'wenqing-pdd-installed-'));
const installed=process.env.WQ_TEST_APP;
if(!installed)throw Error('请通过WQ_TEST_APP指定实际安装的Mac可执行文件');
const original=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/文青尚品/config.json'),'utf8'));
const config={...original,shops:original.shops.filter(s=>s.platform==='pdd'),platform:'pdd',selectedProductIds:[]};
await fs.writeFile(path.join(data,'config.json'),JSON.stringify(config));
await fs.cp(path.join(os.homedir(),'Library/Application Support/文青尚品/ego-requests/control'),path.join(data,'ego-requests/control'),{recursive:true});
// Keep acceptance offline even if the real App currently holds an Ego grant.
for(const name of await fs.readdir(path.join(data,'ego-requests/control')))if(name.endsWith('.json'))await fs.writeFile(path.join(data,'ego-requests/control',name),JSON.stringify({phase:'awaiting-user',at:new Date().toISOString()}));
const env={...process.env,WQ_APP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await electron.launch({executablePath:installed,args:[],env,timeout:30000});
  const win=await app.firstWindow(),errors=[];win.on('pageerror',e=>errors.push(e.message));
  await win.getByText('拼多多 · Ego 执行器',{exact:true}).waitFor();
  let state;
  for(let n=0;n<180;n++){
    state=await win.evaluate(()=>window.wqapp.getState());
    if(!state.busyOp&&(state.products.length||state.scanErrors.length))break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(state.version,JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version);assert.equal(state.config.platform,'pdd');
  assert.equal(state.config.materialsRoot,original.materialRoots.pdd);
  assert.notEqual(state.config.materialRoots.dou,state.config.materialRoots.pdd);
  const product=state.products.find(p=>p.code==='WQ261');if(!product)throw Error(JSON.stringify({scanErrors:state.scanErrors,products:state.products,root:state.config.materialsRoot}));assert.equal(product.sku,12);
  assert.equal(product.errors.length,0);assert.equal(product.ok,true);
  assert.deepEqual([...new Set(product.priceRange)].sort((a,b)=>a-b),[99.9,179.9]);
  assert(await win.getByRole('button',{name:'连接 Ego',exact:true}).isVisible());
  assert.equal(await win.locator('[data-act="image-names"]').count(),0);
  assert(await win.getByRole('button',{name:'一键编号',exact:true}).isVisible());
  const workbook=path.join(product.materialRoot,'商品信息','WQ261pdd商品信息表.xlsx');
  const originalBook=await fs.readFile(workbook);
  await win.getByRole('button',{name:'选择首图',exact:true}).click();
  try{await win.waitForFunction(()=>[...document.querySelectorAll('.first-image-option img')].length===5&&[...document.querySelectorAll('.first-image-option img')].every(i=>i.complete&&i.naturalWidth>0),undefined,{timeout:10000});}
  catch(e){
    console.error(JSON.stringify(await win.evaluate(()=>({picker:document.querySelector('#image-picker')?.outerHTML,images:[...document.querySelectorAll('.first-image-option img')].map(i=>({src:i.src,complete:i.complete,width:i.naturalWidth})),error:document.querySelector('.error-box')?.innerText,scrollY})),null,2));
    await win.screenshot({path:path.join(root,'output/pdd-044-audit/real-preview-failure.png')});throw e;
  }
  assert.equal(await win.locator('#overlay-root .drawer').count(),0);
  assert.equal(await win.getByRole('button',{name:'确认首图',exact:true}).count(),1);
  await win.keyboard.press('Escape');await win.locator('#image-picker').waitFor({state:'detached'});
  assert.deepEqual(await fs.readFile(workbook),originalBook);
  await win.locator(`[data-act="product"][data-id="${product.id}"]`).click();
  await win.getByRole('button',{name:'打开商品素材文件夹',exact:true}).waitFor();
  assert((await win.locator('[role="dialog"]').innerText()).includes('30%（含）-50%（不含）'));
  assert.equal(errors.length,0);
  const output=path.join(root,'output/pdd-'+state.version.split('-')[0].replaceAll('.','')+'-install-check');await fs.mkdir(output,{recursive:true});
  await win.locator('[data-act="close"]').first().click();
  await win.locator('[role="dialog"]').waitFor({state:'detached'});
  await win.screenshot({path:path.join(output,'installed-pdd-workbench.png')});
  const result={checks:18,version:state.version,installed,materialRoot:state.config.materialsRoot,product:product.code,sku:product.sku,errors:product.errors,warnings:product.warnings,rendererErrors:errors,merchantMutation:false};
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(app)await app.close();await fs.rm(data,{recursive:true,force:true});}
