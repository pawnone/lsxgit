import fs from 'node:fs/promises';
import path from 'node:path';
// Reserve once before clicking. A crash, timeout or missing acknowledgement
// leaves the original intent pending; no automatic retry may duplicate a draft.
export async function saveTransaction({outputDir,inputHash,expectedShop,productId,beforeSave,dispatch,onEvent=async()=>{}}) {
  if(!/^[a-f0-9]{64}$/.test(inputHash||'')||!expectedShop||!productId)throw Error('缺少草稿保存身份');
  const receiptFile=path.join(outputDir,`draft-save-${inputHash}.json`);
  await fs.mkdir(outputDir,{recursive:true});
  const existing=await fs.readFile(receiptFile,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(existing)throw Error('已有保存记录，请核实原草稿；禁止自动重复保存');
  const verification=await beforeSave();
  if(verification?.ok!==true||verification.stage!=='before-save'||!Array.isArray(verification.evidence)||!verification.evidence.length)
    throw Error('保存前未获得完整核对结果，尚未点击保存');
  const pending={status:'pending',inputHash,expectedShop,productId,startedAt:new Date().toISOString()};
  const handle=await fs.open(receiptFile,'wx');
  try{await handle.writeFile(JSON.stringify(pending,null,2));await handle.sync();}finally{await handle.close();}
  await onEvent({type:'step-start',name:'保存草稿'});
  try{
    const dispatched=await dispatch();
    const notice=dispatched?.acknowledgement;
    if(!['draft-save-modal','draft-specific-message'].includes(notice?.kind)||!notice.text?.trim())
      throw Error('未获得本次草稿保存成功提示');
    const confirmed={...pending,status:'confirmed',finishedAt:new Date().toISOString(),evidence:verification.evidence,verification,saveAcknowledgement:dispatched};
    const temporary=receiptFile+'.confirmed.tmp';
    await fs.writeFile(temporary,JSON.stringify(confirmed,null,2),{flag:'wx'});
    await fs.rename(temporary,receiptFile);
    await onEvent({type:'step-complete',name:'保存草稿',durationMs:Date.now()-Date.parse(pending.startedAt)});
    return {...confirmed,receiptFile};
  }catch(e){
    await fs.writeFile(receiptFile+'.failure.json',JSON.stringify({...pending,error:e.message,at:new Date().toISOString()},null,2));
    throw Error('保存结果未确认，禁止自动重试：'+e.message,{cause:e});
  }
}
