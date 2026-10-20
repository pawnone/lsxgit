// Standard Playwright APIs only. Never solve, dismiss, or bypass a challenge.
const blockedText=/^(?:请完成安全验证|请完成以下验证|请完成验证|请拖动滑块完成验证|拖动滑块完成拼图|访问被拒绝|访问受限|操作过于频繁|操作频繁，请稍后再试|检测到异常访问|账号存在风险|当前操作存在风险|Access Denied)$/i;
const states=new WeakMap();
export async function installSafetyGuard(page){
 if(states.has(page))return;
 const state={reason:null};states.set(page,state);
 const stop=async()=>{state.reason='检测到验证码或访问安全限制';clearInterval(state.timer);const browser=page.context().browser();if(browser)await browser.close();}; // CDP: disconnect automation, retain external browser.

 const markers=[page.getByText(blockedText).first(),page.locator('iframe[src*="captcha"],iframe[title*="验证码"],iframe[title*="安全验证"]').first()];
 state.markers=markers;
 for(const marker of markers)await page.addLocatorHandler(marker,stop,{noWaitAfter:true});
 state.timer=setInterval(async()=>{if(state.reason||state.scanning)return;state.scanning=true;try{for(const marker of markers)if(await marker.isVisible()){await stop();break;}}catch{}finally{state.scanning=false;}},750);
 state.timer.unref?.();
 page.once('close',()=>clearInterval(state.timer));
 page.context().browser()?.once('disconnected',()=>clearInterval(state.timer));
}
export async function assertSafetyClear(page){
 const state=states.get(page);if(!state)throw new Error('安全检查未初始化');
 if(state.reason)throw new Error('SAFETY_BLOCKED：'+state.reason+'。本次运行已锁定停止，请人工处理；禁止自动恢复。');
 for(const marker of state.markers)if(await marker.isVisible()){
  state.reason='检测到验证码或访问安全限制';
  throw new Error('SAFETY_BLOCKED：'+state.reason+'。请人工核实并指示，禁止自动绕过或重试。');
 }
}
