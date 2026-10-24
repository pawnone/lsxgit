// 纯内存验证模型：不读取浏览器，不产生点击、上传或保存动作。
export const stages=['identity','category','attributes','media','specs','pricing','services','finalReview'];
export const attributeDependencies={material:['fabric'],composition:['fabric','material']};
const exact=s=>typeof s==='string'&&s.trim().length>0&&s===s.trim();
export class IdentitySession {
  constructor(expected){
    if(!expected||!exact(expected.platform)||!exact(expected.shopId)||!exact(expected.shopName)) throw Error('必须明确平台、稳定店铺ID和完整店铺名称');
    this.expected=Object.freeze({...expected});this.blocked=false;
  }
  check(observations){
    if(this.blocked)throw Error('会话已失效，需建立新会话并重新验证');
    if(!Array.isArray(observations)||!observations.length){this.blocked=true;throw Error('缺少身份观察记录');}
    const mismatch=observations.some(o=>!o||o.loggedIn!==true||['platform','shopId','shopName'].some(k=>o[k]!==this.expected[k]));
    if(mismatch){this.blocked=true;throw Error('身份不符、冲突或登录失效，停止本地验证流程');}
    return {...this.expected};
  }
}
export class StageLedger {
  constructor({session,productId,inputVersion}){
    if(!(session instanceof IdentitySession)||!exact(productId)||!exact(inputVersion))throw Error('缺少身份会话、商品或数据版本');
    this.session=session;this.productId=productId;this.inputVersion=inputVersion;this.records=[];this.failed=false;this.attributes=new Set();
  }
  record(stage,{observations,ok,evidence}={}){
    if(this.failed)throw Error('流程已有失败，不能继续');
    try{
      this.session.check(observations);
      if(stages[this.records.length]!==stage)throw Error(`阶段乱序：当前应为${stages[this.records.length]||'已结束'}`);
      if(ok!==true||typeof evidence!=='string'||!evidence.trim())throw Error('缺少明确通过证据');
      this.records.push({stage,evidence,productId:this.productId,inputVersion:this.inputVersion});
    }catch(e){this.failed=true;throw e;}
  }
  attribute(name){
    if(this.failed||this.session.blocked)throw Error('流程已失效');
    if(this.records.at(-1)?.stage!=='category')throw Error('仅允许在类目完成后、属性阶段结束前核对动态字段');
    for(const parent of attributeDependencies[name]||[])if(!this.attributes.has(parent))throw Error(`属性依赖未完成：${parent}`);
    this.attributes.add(name);
  }
  invalidate(reason){this.failed=true;this.reason=reason;}
  summary(){return {scope:'offline-model-only',failed:this.failed||this.session.blocked,completed:this.records.map(r=>r.stage),productId:this.productId,inputVersion:this.inputVersion,browserVerified:false};}
}
export function assertConsistentReadback(expected,observed){
  const key=s=>JSON.stringify([s.style,s.size]);
  if(expected.length!==observed.length)throw Error('SKU数量不一致');
  const seen=new Set();
  for(const row of observed){const k=key(row);if(seen.has(k))throw Error('重复SKU');seen.add(k);const e=expected.find(s=>key(s)===k);if(!e)throw Error('出现未知SKU');
    for(const field of ['groupPriceCents','singlePriceCents','stock','code','image','state','styleNote','sizeNote'])if(row[field]!==e[field])throw Error(`SKU字段不一致：${field}`);
  }
  return true;
}
