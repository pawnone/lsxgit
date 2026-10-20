import {assertSafetyClear} from './safety-guard.mjs';
export async function uploadMaterialEntry(page,files,{timeout=180000}={}){
 const regions=[['商品主图',page.locator('[class*="batchImageUpload"]'), 'input[type="file"][accept="image/*"]'],['商品详情',page.locator('[class*="materialUploadList"]').filter({has:page.locator('input[type="file"][accept=".png,.jpg,.jpeg"]')}),'input[type="file"][accept=".png,.jpg,.jpeg"]']];
 for(const [name,region,inputSelector] of regions){
  await assertSafetyClear(page);
  if(await region.count()!==1)throw new Error(`商品材料入口：${name}上传区域不唯一或不存在，已停止，请适配页面结构`);
  const input=region.locator(inputSelector).first();await input.waitFor({state:'attached',timeout:10000});
  if(await region.locator('img').count())throw new Error(`商品材料入口：${name}已有图片，请先核实，禁止盲目重复上传`);
  console.log(`商品材料入口：提交${name} ${files.length}张`);
  await input.setInputFiles(files,{timeout:30000});
  const start=Date.now();let snapshot;
  while(Date.now()-start<timeout){
   await assertSafetyClear(page);
   snapshot=await region.evaluate(el=>({images:[...el.querySelectorAll('img')].map(i=>({ready:i.complete&&i.naturalWidth>0,remote:/^https?:/.test(i.currentSrc||i.src)})),error:/上传失败|上传出错|格式不支持|文件过大/.test(el.innerText),busy:!!el.querySelector('[class*="uploading"],[class*="item-loading"]')}));
   if(snapshot.error)throw new Error(`商品材料入口：${name}页面提示上传失败，请检查文件格式、大小或网络；不自动重试`);
   const ready=snapshot.images.filter(i=>i.ready&&i.remote).length;
   if(ready===files.length&&!snapshot.busy){console.log(`商品材料入口：${name}已回读${ready}/${files.length}张服务端图片`);break;}
   if(snapshot.images.length>files.length)throw new Error(`${name}图片数量超出配置，已停止`);
   await new Promise(r=>setTimeout(r,500));
  }
  if(!snapshot||snapshot.images.filter(i=>i.ready&&i.remote).length!==files.length||snapshot.busy)throw new Error(`商品材料入口：${name}上传等待超时；已回读${snapshot?.images.filter(i=>i.ready&&i.remote).length||0}/${files.length}张服务端图片。保留页面，不自动重复上传`);
 }
}
export async function waitMaterialEntryReady(page,category,{timeout=300000,poll=500}={}){
 const button=page.getByRole('button',{name:'确认信息，继续生成',exact:true});const start=Date.now();let nextLog=0,state={};
 while(Date.now()-start<timeout){
  await assertSafetyClear(page);
  state={category:await page.getByText(category,{exact:true}).isVisible(),visible:await button.isVisible(),enabled:await button.isEnabled()};
  if(state.category&&state.visible&&state.enabled){console.log('商品材料入口：类目与生成按钮已就绪');return button;}
  if(Date.now()-start>=nextLog){console.log(`等待商品材料识别：类目=${state.category}，按钮可用=${state.enabled}`);nextLog+=20000;}
  await new Promise(r=>setTimeout(r,poll));
 }
 throw new Error(`商品材料识别等待超时：目标类目=${category}，状态=${JSON.stringify(state)}；请保留页面人工核实，未点击生成`);
}
