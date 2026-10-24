export const MAIN_FIRST = '首图编号';
export const normalizeImageRef = value => /^\d{1,2}$/.test(String(value ?? '').trim())
  ? String(value).trim().padStart(2,'0') : String(value ?? '').trim();

export function cycleImages(files, first, count) {
  const start=files.indexOf(first);
  if(start<0 || !files.length)throw Error('首图没有对应的主图原文件，请检查商品表的图片编号');
  return Array.from({length:count},(_,i)=>files[(start+i)%files.length]);
}

export function configuredImageOrder(basic, sources, map) {
  const firstRef=normalizeImageRef(basic[MAIN_FIRST]);
  if(!firstRef)return null; // Legacy workbooks keep their custom details.
  const first=map[firstRef];
  if(!first||!sources.includes(first))throw Error('基础信息 / '+MAIN_FIRST+'：主图编号“'+firstRef+'”没有对应图片');
  return {firstRef,first};
}
