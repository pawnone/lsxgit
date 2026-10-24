import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {imageSize} from 'image-size';

// Observe the native FileList, without changing the merchant widget's state.
// Keep small decoded signatures in the page, never send full images over IPC.
export async function armBatchImageOrder(driver,selector,files){
  const key=crypto.randomUUID();
  const metadata=await Promise.all(files.map(async file=>{
    const bytes=await fs.readFile(file),size=imageSize(bytes);
    if(!size.width||!size.height)throw Error('上传图片无法读取尺寸：'+path.basename(file));
    const rotated=[5,6,7,8].includes(size.orientation);
    return{file,pathLength:file.length,name:path.basename(file),bytes:bytes.length,
      width:rotated?size.height:size.width,height:rotated?size.width:size.height,orientation:size.orientation||1};
  }));
  await driver.read(({selector,key})=>{
    const input=document.querySelector(selector);
    if(!input)throw Error('批量图片上传输入已变化');
    const registry=window.__wenqingBatchImages ||= {};
    const record=registry[key]={};
    const signature=file=>new Promise((resolve,reject)=>{
      const image=new Image(),url=URL.createObjectURL(file);
      const cleanup=()=>{clearTimeout(timer);URL.revokeObjectURL(url);};
      const timer=setTimeout(()=>{cleanup();reject(Error('原图解码超时'));},8000);
      image.onerror=()=>{cleanup();reject(Error('原图无法解码'));};
      image.onload=()=>{try{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,128,128);ctx.drawImage(image,0,0,128,128);
        const result={width:image.naturalWidth,height:image.naturalHeight,pixels:ctx.getImageData(0,0,128,128).data};
        cleanup();resolve(result);
      }catch(e){cleanup();reject(e);}};
      image.src=url;
    });
    record.listener=e=>{if(e.target!==input)return;
      document.removeEventListener('change',record.listener,true);
      const selected=[...input.files];record.names=selected.map(f=>f.name);
      record.files=selected.map(f=>({name:f.name,bytes:f.size,type:f.type,lastModified:f.lastModified}));
      record.pending=Promise.all(selected.map(file=>signature(file).catch(e=>{throw Error(file.name+'：'+e.message);})))
        .then(values=>{record.values=values;},e=>{record.error=e.message;});
    };
    document.addEventListener('change',record.listener,true);
  },{selector,key});
  return {key,names:metadata.map(f=>f.name),files:metadata};
}

export async function verifyBatchImageOrder(driver,evidence,urls){
  await driver.guard();
  const result=await driver.read(async({key,names,urls})=>{
    const record=window.__wenqingBatchImages?.[key];
    if(!record?.pending)throw Error('没有观察到本次批量图片选择，不能确认顺序');
    await record.pending;
    if(record.error)throw Error(record.error);
    if(JSON.stringify(record.names)!==JSON.stringify(names)||urls.length!==names.length)throw Error('批量选择文件数量或顺序不符');
    const comparisons=await Promise.all(urls.map((url,index)=>new Promise((resolve,reject)=>{
      const image=new Image();image.crossOrigin='anonymous';
      const timer=setTimeout(()=>{image.src='';reject(Error('批量图片内容核对超时'));},8000);
      image.onerror=()=>{clearTimeout(timer);reject(Error('批量图片无法读取，不能仅凭数量确认顺序'));};
      image.onload=()=>{try{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,128,128);ctx.drawImage(image,0,0,128,128);
        const pixels=ctx.getImageData(0,0,128,128).data;
        const distances=record.values.map(a=>{
          let absolute=0,squares=0;
          for(let i=0;i<pixels.length;i++)if(i%4!==3){const d=Math.abs(pixels[i]-a.pixels[i]);absolute+=d;squares+=d*d;}
          return {meanError:absolute/(128*128*3),rmsError:Math.sqrt(squares/(128*128*3)),aspectError:Math.abs(a.width/a.height-image.naturalWidth/image.naturalHeight)};
        });
        const own=distances[index],nearest=Math.min(...distances.filter(d=>d.aspectError<0.001).map(d=>d.rmsError));
        // Original -> uploaded JPEG can incur more error than PFS -> saved JPEG.
        // Allow bounded recompression only when this is still the closest source
        // among all selected images; a similar but wrong first image must fail.
        const same=own.aspectError<0.001&&own.meanError<=3&&own.rmsError<=7&&own.rmsError<=nearest+0.1;
        clearTimeout(timer);resolve({slot:index+1,same,...own,nearestRmsError:nearest});
      }catch(e){clearTimeout(timer);reject(e);}};
      image.src=url;
    })));
    return comparisons;
  },{...evidence,urls});
  if(result.some(c=>!c.same))throw Object.assign(Error('批量上传后第'+result.find(c=>!c.same).slot+'张图片内容或顺序不符；已停止，未保存草稿'),{imageOrder:result});
  return result;
}

export async function verifyBatchImageSelection(driver,evidence){
  await driver.wait(key=>Array.isArray(window.__wenqingBatchImages?.[key]?.names),evidence.key,5000);
  const selected=await driver.read(async key=>{
    const record=window.__wenqingBatchImages[key];await record.pending;
    return{names:record.names,files:record.files,error:record.error||null,images:record.values?.map(v=>({width:v.width,height:v.height}))||[]};
  },evidence.key);
  const selection={count:selected.names.length,...selected,at:new Date().toISOString()};
  const fail=text=>{throw Object.assign(Error(text),{selection});};
  if(JSON.stringify(selected.names)!==JSON.stringify(evidence.names))fail('本次文件选择事件的数量或顺序不符，禁止重新选择文件');
  if(selected.error)fail('浏览器读取上传图片失败：'+selected.error);
  for(const [i,file]of evidence.files.entries()){
    const actual=selected.files[i],image=selected.images[i];
    if(actual.bytes!==file.bytes||image?.width!==file.width||image?.height!==file.height)
      fail(file.name+'浏览器读取结果不一致；本地'+file.bytes+'字节、'+file.width+'×'+file.height+'；浏览器'+actual.bytes+'字节、'+(image?.width||0)+'×'+(image?.height||0));
  }
  return selection;
}

export async function releaseBatchImageOrder(driver,evidence){
  if(!evidence)return;
  await driver.read(key=>{
    const registry=window.__wenqingBatchImages,record=registry?.[key];
    if(record)document.removeEventListener('change',record.listener,true);
    if(registry)delete registry[key];
  },evidence.key);
}
