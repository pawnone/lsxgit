// PDD recompresses temporary upload images into permanent goods images on save.
// Compare rendered image content in the same slot; counts alone are insufficient.
export async function compareImageContentDom({beforeUrl,afterUrl}) {
  const load=url=>new Promise((resolve,reject)=>{
    const image=new Image();image.crossOrigin='anonymous';
    const timer=setTimeout(()=>{image.src='';reject(Error('保存后图片内容读取超时'));},8000);
    image.onerror=()=>{clearTimeout(timer);reject(Error('保存后图片无法读取，不能仅凭数量确认'));};
    image.onload=()=>{
      try{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,128,128);ctx.drawImage(image,0,0,128,128);
        const pixels=ctx.getImageData(0,0,128,128).data;
        clearTimeout(timer);resolve({width:image.naturalWidth,height:image.naturalHeight,pixels});
      }catch(error){clearTimeout(timer);reject(error);}
    };
    image.src=url;
  });
  const [a,b]=await Promise.all([load(beforeUrl),load(afterUrl)]);
  let absolute=0,squares=0;
  for(let i=0;i<a.pixels.length;i++)if(i%4!==3){const d=Math.abs(a.pixels[i]-b.pixels[i]);absolute+=d;squares+=d*d;}
  const meanError=absolute/(128*128*3),rmsError=Math.sqrt(squares/(128*128*3));
  const aspectError=Math.abs(a.width/a.height-b.width/b.height);
  return{same:aspectError<0.001&&meanError<=1.25&&rmsError<=3.5,
    beforeSize:[a.width,a.height],afterSize:[b.width,b.height],meanError,rmsError,aspectError};
}

export async function verifyMediaPersistence(driver,before,after){
  if(before.length!==after.length)throw Error('保存后素材数量与原回执不同');
  const evidence=[];
  for(let index=0;index<before.length;index++){
    if(before[index]===after[index])continue;
    const from=new URL(before[index]),to=new URL(after[index]);
    if(from.protocol!=='https:'||to.protocol!=='https:'||
      !(from.hostname==='pfs.pinduoduo.com'||from.hostname==='img.pddpic.com'&&/^\/mms-material-img\//.test(from.pathname))||
      !(to.hostname==='img.pddpic.com'&&/^\/mms-goods-image\//.test(to.pathname)))throw Error('素材地址发生非预期变化，不能确认保存');
    await driver.guard();
    const comparison=await driver.read(compareImageContentDom,{beforeUrl:before[index],afterUrl:after[index]});
    if(!comparison.same)throw Error('保存后第'+(index+1)+'张图片内容或顺序与原素材不符');
    evidence.push({slot:index+1,before:before[index],after:after[index],...comparison});
  }
  return evidence;
}
