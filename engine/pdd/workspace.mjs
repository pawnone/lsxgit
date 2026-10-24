import {PddDriver} from './dom-driver.mjs';
import {readShop} from './shop-observation.mjs';
const KEY='wenqing:pdd:workspace:v1';
const ORIGIN='https://mms.pinduoduo.com';
export async function workspaceState(page){return page.evaluate(k=>JSON.parse(sessionStorage.getItem(k)||'null'),KEY);}
export async function markWorkspace(page,token,changes){
  if(new URL(page.url()).origin!==ORIGIN)throw Error('工作页离开拼多多，已停止');
  return page.evaluate(({key,token,changes})=>{const old=JSON.parse(sessionStorage.getItem(key)||'null');if(old&&old.token!==token)throw Error('工作页归属不符');const next={...old,...changes,token};sessionStorage.setItem(key,JSON.stringify(next));return next;},{key:KEY,token,changes});
}
export async function prepareWorkspace(browser,{token,expectedShop,attemptId}){
  if(!token||!expectedShop||!attemptId)throw Error('缺少拼多多工作页身份');
  const matches=[],contexts=new Set();
  for(const context of browser.contexts())for(const page of context.pages()){
    if(new URL(page.url()).origin!==ORIGIN)continue;
    const shop=await readShop(page);
    if(shop.names.length&&shop.names.some(n=>n!==expectedShop))throw Error('拼多多专用窗口包含其他店铺，停止执行');
    if(shop.names.length===1&&shop.names[0]===expectedShop)contexts.add(context);
    const state=await workspaceState(page);if(state?.token===token)matches.push({page,state});
  }
  if(contexts.size!==1)throw Error('未找到唯一的已核对拼多多登录会话');
  if(matches.length>1)throw Error('发现多个拼多多工作页副本，需人工核实');
  const prior=matches[0];
  if(prior&&(!['confirmed'].includes(prior.state.phase)||prior.state.attemptId===attemptId))throw Error('原拼多多工作页结果待核实，禁止清空或重放');
  const page=prior?.page||await [...contexts][0].newPage();
  await page.goto(ORIGIN+'/goods/category',{waitUntil:'domcontentloaded',timeout:45000});
  const driver=new PddDriver({page,expectedShop});
  await page.locator('.user-name-name .user-name-text').waitFor({state:'visible',timeout:20000});
  await driver.guard();
  await markWorkspace(page,token,{phase:'running',attemptId,expectedShop,startedAt:new Date().toISOString(),previousAttemptId:prior?.state.attemptId||null});
  return {page,created:!prior};
}
