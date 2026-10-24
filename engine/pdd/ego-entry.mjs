import fs from 'node:fs/promises';
import {classifyShop} from './shop-state.mjs';

export function egoFailure(error) {
  const diagnostic=String(error?.message||error),evaluation=diagnostic.match(/JavaScript evaluation failed[^\n]*?Error:\s*([^\n]+)/);
  let code='EGO_OPERATION_FAILED',message=evaluation?evaluation[1].trim():diagnostic;
  if(/Control of this task space is with the user|Ego 工作空间由你控制/i.test(diagnostic)){
    code='EGO_USER_CONTROL';message='Ego 已报告控制权交给用户。请点击“核对”交给 App；当前操作已停止，现场与记录保留。';
  }else if(/task ?space.*\b(?:inactive|unassigned)\b|task.*\b(?:finished|ended)\b/i.test(diagnostic)){
    code='EGO_SPACE_INACTIVE';message='Ego 工作空间已失效或任务已结束，不能据此判断有人操作。请点击“连接 Ego”重新连接原空间，再核对店铺；不会自动重跑。';
  }else if(/permission denied|access denied|not permitted|权限.*拒绝/i.test(diagnostic)){
    code='EGO_PERMISSION_DENIED';message='Ego 操作权限被拒绝，已停止；请检查浏览器授权，现场与记录保留。';
  }else if(/ECONN\w*|EPIPE|WebSocket.*(?:closed|disconnect)|(?:browser|page|target|connection|session).*(?:closed|disconnect)|Ego.*(?:连接超时|连接已中断)/i.test(diagnostic)){
    code='EGO_CONNECTION_LOST';message='Ego 连接中断，当前操作已停止，现场与记录保留。请重新连接并核对店铺；不会自动重传或保存。';
  }
  return{code,message,diagnostic};
}
export const egoMessage=message=>egoFailure(message).message;
export async function connectSpace(payload,allowClaim) {
  if(!payload.workspaceName?.startsWith('文青尚品 · 拼多多 · '))throw Error('缺少 App 工作空间标识');
  const spaces=await globalThis.listTaskSpaces();
  const matches=spaces.filter(s=>s.name===payload.workspaceName);
  if(matches.length>1)throw Error('有多个同名 Ego 工作空间，请人工检查');
  if(!matches.length){
    if(!allowClaim)throw Error('请先点击“连接 Ego”打开本店工作空间');
    return globalThis.taskSpace(payload.workspaceName);
  }
  const item=matches[0];
  if(item.ownership==='user'){
    if(!allowClaim)throw Error('Ego 工作空间由你控制，请点击“核对”交给 App');
    return globalThis.claimTaskSpace(item.id);
  }
  // Metadata ownership is distinct from active control after handOff(). Only
  // an explicit Connect/Verify request may take control at the start of a round.
  if(allowClaim)return globalThis.takeOverTaskSpace(item.id);
  return globalThis.taskSpace(item.id);
}
async function shopEvidence(task) {
  const evidence=[];
  for(const item of await task.tabs()){
    if(!item.url?.startsWith('https://mms.pinduoduo.com/'))continue;
    const page=item.label?task.page(item.label):await task.adopt(item.page);
    const state=await page.evaluate(()=>{
      const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const blocked=/为保障您账号的安全，请验证手机|请完成安全验证|访问受限|操作过于频繁|拖动滑块完成验证/.test(document.body.innerText)||[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/验证码|安全验证/.test(e.title));
      return{blocked,names:[...document.querySelectorAll('.user-name-name .user-name-text')].filter(visible).map(e=>e.innerText.trim()).filter(Boolean),url:location.origin+location.pathname};
    });
    if(state.blocked)throw Error('SAFETY_BLOCKED：拼多多要求人工安全验证，已停止');
    if(/\/login(?:\/|$)/.test(new URL(state.url).pathname))state.names=[];
    evidence.push({...state,label:page.label});
  }
  return evidence;
}
export async function runEgoRequest(inputFile,resultFile) {
  let task;
  let seq=0;
  const emit=async event=>{
    const record={...event,seq:++seq,at:new Date().toISOString()};
    // Ego's CLI may buffer console output until a round ends. The local
    // append-only journal lets the App show progress while that round runs.
    await fs.appendFile(resultFile+'.events.jsonl',JSON.stringify(record)+'\n',{mode:0o600});
    console.log('WQ_EVENT '+JSON.stringify(record));
  };
  try{
    const {op,payload}=JSON.parse(await fs.readFile(inputFile,'utf8'));
    if(op==='run')await emit({type:'log',text:'正在连接本店 Ego 工作空间'});
    task=await connectSpace(payload,['open','verify'].includes(op)||op==='run'&&payload.recreate===true);
    let evidence=await shopEvidence(task),state=classifyShop(evidence,payload.expectedShop);
    if(op==='open'){
      if(!evidence.length){
        const tabs=await task.tabs();
        const blank=tabs.filter(t=>t.label&&t.url==='about:blank');
        const page=blank.length===1?task.page(blank[0].label):await task.newPage();
        await page.goto('https://mms.pinduoduo.com');
      }
      await task.handOff();
      await fs.writeFile(resultFile,JSON.stringify({ok:true,result:{spaceId:task.spaceId,opened:true}}));return;
    }
    if(op==='observe'){
      await fs.writeFile(resultFile,JSON.stringify({ok:true,result:state}));return;
    }
    if(state.status!=='verified')throw Error(state.status==='ambiguous'?'工作空间内有多个不同店铺，已停止':state.actualName?'店铺不符：当前为“'+state.actualName+'”，目标为“'+payload.expectedShop+'”':'请先在本店 Ego 工作空间完成人工登录，再点击核对');
    if(op==='verify'){
      await fs.writeFile(resultFile,JSON.stringify({ok:true,result:state}));return;
    }
    if(op!=='run')throw Error('未知 Ego 操作');
    const {executePddDraft}=await import('./run-draft.mjs');
    const result=await executePddDraft({task,payload,onEvent:emit});
    await task.handOff();
    await fs.writeFile(resultFile,JSON.stringify({ok:true,result}));
  }catch(e){
    // Never re-claim or finish after a control/permission failure.
    const failure=egoFailure(e);
    await emit({type:'log',code:failure.code,text:'操作停止：'+failure.message});
    await fs.writeFile(resultFile,JSON.stringify({ok:false,error:failure.message,code:failure.code,diagnostic:failure.diagnostic}));
  }
}
