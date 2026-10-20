import {installSafetyGuard,assertSafetyClear} from './safety-guard.mjs';
import {chromium} from 'playwright-core';
export function checkShopNames(names,expected){
 if(typeof expected!=='string'||!expected.trim())throw new Error('请先设置目标店铺名称；未设置时禁止执行');
 const found=[...new Set(names.map(s=>s.trim()).filter(Boolean))];
 if(found.length!==1||found[0]!==expected.trim())throw new Error(`店铺不匹配：期望「${expected}」，实际「${found.join('、')||'未识别/未登录'}」。已停止，不会自动切店。`);
 return found[0];
}
export async function assertPageShop(page,expected){
 await installSafetyGuard(page);await assertSafetyClear(page);
 if(new URL(page.url()).hostname!=='fxg.jinritemai.com')throw new Error('当前页面不是抖店商家后台');
 const header=page.locator('[class*="shopTitle"] [class*="userName"]');
 try{await header.first().waitFor({state:'visible',timeout:10000});}catch{await assertSafetyClear(page);throw new Error('无法读取店铺名称：请先在专用浏览器完成登录并进入抖店后台，再选菜单7核对；若已登录仍失败，保留页面并报告，禁止跳过校验');}
 const actual=checkShopNames(await header.allTextContents(),expected);
 return {expected,actual,url:page.url().split('?')[0],checkedAt:new Date().toISOString()};
}
export async function inspectShop(endpoint,expected){
 const url=new URL(endpoint);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('浏览器地址必须为本机 HTTP');
 checkShopNames([expected||''],expected);
 let browser;try{browser=await chromium.connectOverCDP(endpoint,{timeout:30000});}catch(e){throw new Error(`无法连接专用浏览器「${endpoint}」：请先选菜单1打开浏览器，再登录目标店铺；已有浏览器则检查菜单6的端口。原错误：${e.message}`);}
 try{
  const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url().startsWith('https://fxg.jinritemai.com/ffa/'));
  if(!pages.length)throw new Error('此浏览器没有已登录的抖店后台，请先登录目标店铺');
  const evidence=[];for(const p of pages)evidence.push(await assertPageShop(p,expected));
  console.log(`店铺核对通过：${expected}（${endpoint}）`);return evidence;
 }finally{await browser.close();} // CDP连接仅断开客户端，不关闭外部Chrome。
}
