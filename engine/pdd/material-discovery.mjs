import path from 'node:path';
export const ROLES={main:['主图','轮播图','商品主图','商品轮播图','main','main-images'],size:['尺码图','尺码表','size-chart'],details:['详情图','详情','商品详情图','details','detail-images'],white:['白底图','white-background'],long:['长图','long-images'],video:['视频','商品视频','video'],explanationVideo:['讲解视频','商品讲解视频'],detailVideo:['商详视频','详情视频'],text:['详情文字（选填）','详情文字'],tags:['商品标签','包装标签图','包装图','标签图','吊牌图','packaging-labels']};
const normalized=name=>name.normalize('NFKC').replace(/\s|[（(](?:选填|必填)[）)]/g,'').toLowerCase();
const compare=(a,b)=>a.localeCompare(b,'zh-CN',{numeric:true})||(a<b?-1:a>b?1:0);
export function discoverMaterials(root,files){
  const result=Object.fromEntries(Object.keys(ROLES).map(k=>[k,[]]));
  for(const file of files){
    const relative=path.relative(root,file),parts=relative.split(path.sep),base=path.basename(file);
    const ancestors=parts.slice(0,-1).map(normalized);
    if(ancestors.some(p=>/^(?:备份|backup)(?:$|[-_\s])/.test(p)))continue;
    let matches=[];
    for(const parent of [...ancestors].reverse()){matches=Object.entries(ROLES).filter(([,names])=>names.some(n=>parent===normalized(n)));if(matches.length)break;}
    if(matches.length>1)throw Error('素材目录同时属于多个用途，请分清主图、详情等目录：'+relative);
    if(matches.length===1){result[matches[0][0]].push(file);continue;}
    if(parts.length!==1||/\.xlsx$/i.test(base))continue;
    if(/^白底/i.test(base))result.white.push(file);
    else if(/^(?:包装|标签|吊牌)/.test(base))result.tags.push(file);
    else if(/^尺码/.test(base))result.size.push(file);
    else if(/^长图/.test(base))result.long.push(file);
    else if(/^讲解.*\.(?:mp4|mov|m4v)$/i.test(base))result.explanationVideo.push(file);
    else if(/^(?:商详|详情).*\.(?:mp4|mov|m4v)$/i.test(base))result.detailVideo.push(file);
    else if(/\.(?:mp4|mov|m4v)$/i.test(base))result.video.push(file);
    else if(/^详情.*\.(?:jpg|jpeg|png|webp)$/i.test(base))result.details.push(file);
    else if(/\.(?:jpg|jpeg|png|webp)$/i.test(base))result.main.push(file);
    else if(/^详情.*\.txt$/i.test(base))result.text.push(file);
  }
  for(const values of Object.values(result))values.sort(compare);
  return result;
}
