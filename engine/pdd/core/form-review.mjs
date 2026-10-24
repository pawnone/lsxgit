// 只处理调用者提供的数据快照；不导入Playwright，不查DOM，不发出键盘或鼠标动作。
export class ObservationError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const fail=(code,message)=>{throw new ObservationError(code,message);};
export function selectedValue({field,candidates,multiple=false}){
  if(typeof field!=='string'||!field||!Array.isArray(candidates))fail('INVALID_OBSERVATION','缺少字段及控件快照');
  const eligible=candidates.filter(c=>c&&c.field===field&&c.visible===true&&c.type!=='hidden'&&c.purpose==='selected'&&['display','input','tag'].includes(c.kind));
  const vals=eligible.map(c=>typeof c.value==='string'?c.value.trim():null);
  if(vals.some(v=>v===null))fail('INVALID_OBSERVATION','显示值必须是文本，不能用内部ID冒充显示文本');
  const unique=[...new Set(vals.filter(Boolean))];
  if(!unique.length)fail('NOT_READY','未提供明确的字段已选显示值');
  if(!multiple&&unique.length!==1)fail('AMBIGUOUS','同一字段存在冲突显示值，不能取第一个');
  return multiple?unique.sort():unique[0];
}
export function assertSelected(expected,snapshot){
  const got=selectedValue(snapshot);
  if(Array.isArray(expected)){
    const want=[...new Set(expected.map(x=>String(x).trim()))].sort();
    if(!Array.isArray(got)||JSON.stringify(want)!==JSON.stringify(got))fail('MISMATCH','多选集合不一致');
  }else if(typeof expected!=='string'||got!==expected.trim())fail('MISMATCH','显示值与期望不精确一致');
  return got;
}
// 离线分类策略，不调度重试、不生成键盘操作。没有充分证据就停止。
export function reviewAttempt({errorCode,attempt,maxAttempts=2,field,observedField,popupClosed}){
  if(!Number.isInteger(attempt)||attempt<1||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>3)fail('INVALID_POLICY','无效重试次数');
  if(['SAFETY_BLOCKED','AUTH_REQUIRED','ACCESS_DENIED'].includes(errorCode))return {decision:'stop',reason:errorCode};
  if(!field||field!==observedField)return {decision:'stop',reason:'FIELD_IDENTITY_UNCONFIRMED'};
  if(!['NOT_READY','STALE_OBSERVATION'].includes(errorCode))return {decision:'stop',reason:errorCode||'UNKNOWN'};
  if(attempt>=maxAttempts)return {decision:'stop',reason:'BUDGET_EXHAUSTED'};
  if(popupClosed!==true)return {decision:'stop',reason:'PREVIOUS_POPUP_STATE_UNKNOWN'};
  return {decision:'request-fresh-observation',reason:errorCode};
}
