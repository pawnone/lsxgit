import {assertSafetyClear} from './safety-guard.mjs';
export async function entryState(page){
 if(await page.getByText('返回旧版',{exact:true}).first().isVisible())return 'new-entry';
 if(await page.getByText('确认信息，继续生成',{exact:true}).isVisible())return 'material';
 if(await page.getByText('主图上传',{exact:true}).isVisible())return 'legacy-wizard';
 if(await page.locator('[attr-field-id="商品类目"]').isVisible()&&await page.locator('[attr-field-id="商品规格"]').count())return 'editor';
 return 'loading-or-unknown';
}
export async function resolveEntry(page,{timeout=20000}={}){
 const evidence={startedAt:new Date().toISOString(),transitions:[]};const end=Date.now()+timeout;let clicked=false;
 while(Date.now()<end){
  await assertSafetyClear(page);const state=await entryState(page);
  if(state==='new-entry'){
   if(clicked)throw new Error('返回旧版后仍停留新入口，禁止重复点击');
   evidence.transitions.push({from:state,action:'返回旧版',at:new Date().toISOString()});
   await page.getByText('返回旧版',{exact:true}).first().click({timeout:10000});clicked=true;
   await page.getByText('返回旧版',{exact:true}).first().waitFor({state:'hidden',timeout:10000});
  }else if(state!=='loading-or-unknown'){
   evidence.state=state;evidence.clickedLegacy=clicked;evidence.finishedAt=new Date().toISOString();console.log(`入口核对：${JSON.stringify(evidence)}`);return evidence;
  }
  await new Promise(r=>setTimeout(r,250));
 }
 throw new Error(`无法识别商品入口：${JSON.stringify(evidence)}`);
}
