// 商品事实来自素材库；仅这三个展示名称按用户确认的图 2 归一化。
const DISPLAY = new Map([
  ['黑色上衣', ['上衣', '单件']], ['上衣', ['上衣', '单件']],
  ['杏色裤子', ['裤子', '单件']], ['裤子', ['裤子', '单件']],
  ['衣服加裤子', ['衣服+裤子', '两件套']], ['衣服+裤子', ['衣服+裤子', '两件套']]
]);
export function displaySpec(spec) {
  const mapped = DISPLAY.get(spec.name);
  return mapped ? {...spec, name:mapped[0], remark:mapped[1]} : {...spec};
}
export function range(value) {
  const match=String(value).match(/^(\d+(?:\.\d+)?)\s*[–—~-]\s*(\d+(?:\.\d+)?)(?:斤|cm)?$/i);
  if (!match || Number(match[1])>Number(match[2])) throw new Error(`无效区间：${value}`);
  return [Number(match[1]),Number(match[2])];
}
export function expandSkus(colors,sizes,rows=[],inventory={}) {
  const normalized=rows.map(r=>({...r,color:displaySpec({name:r.color}).name}));
  const keys=new Set();
  for(const row of normalized){
    const key=JSON.stringify([row.color,row.size]);
    if(keys.has(key)) throw new Error(`重复SKU：${key}`);
    keys.add(key);
    if(!colors.some(c=>c.name===row.color)||!sizes.some(s=>s.name===row.size)) throw new Error(`未知SKU：${key}`);
  }
  return colors.flatMap(color=>sizes.map(size=>{
    const explicit=normalized.find(r=>r.color===color.name&&r.size===size.name);
    const price=explicit?.price ?? color.price;
    if(price==null||!Number.isFinite(Number(price))||Number(price)<=0) throw new Error(`缺少有效价格：${color.name}/${size.name}`);
    const result={...(explicit?.merchantCode?{merchantCode:explicit.merchantCode}:{}),color:color.name,size:size.name,price:Number(price),inStock:explicit?.inStock??inventory.inStock,preSale:explicit?.preSale??inventory.preSale,preSaleDelivery:explicit?.preSaleDelivery||inventory.preSaleDelivery};
    for(const field of ['inStock','preSale']) if(result[field]==null||!Number.isInteger(Number(result[field]))||Number(result[field])<0) throw new Error(`库存无效：${color.name}/${size.name}/${field}`);
    return result;
  }));
}
