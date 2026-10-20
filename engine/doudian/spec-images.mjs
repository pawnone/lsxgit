import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
export function specImageBindings(config){
 const images=config.product.mainImages;return config.colorSpecs.map(spec=>{
  const raw=String(spec.mainImageNo??'').trim();if(!/^(0?[1-5])$/.test(raw))throw new Error(`${spec.name}：对应主图编号必填，填写01～05`);
  const no=raw.padStart(2,'0');const matches=images.filter(f=>path.posix.basename(f.replaceAll('\\','/')).replace(/\.[^.]+$/,'')===no);
  if(matches.length!==1)throw new Error(`${spec.name}：主图编号${no}未找到唯一文件`);
  return {name:spec.name,no,file:path.resolve(config.materialRoot,matches[0])};
 });
}
export function imageIdentity(src){
 try{const u=new URL(src);if(u.protocol==='https:'&&/(^|\.)ecombdimg\.com$/.test(u.hostname)){const m=u.pathname.match(/_m_([a-f0-9]{32})_/);if(m)return 'md5:'+m[1];}}catch{}
 return src;
}
const proof=new WeakMap();
function section(page){return page.locator('[class*="style_contentBox__"]').filter({has:page.locator('[id="skuValue-颜色分类"]')});}
function rowFor(page,name){return page.locator('[id="skuValue-颜色分类"] [class*="style_skuValueInput__"]').filter({has:page.locator('.ecom-g-cascader-picker-label').getByText(name,{exact:true})});}
async function preview(row){
 const image=row.locator('[class*="style_imgUpload__"] img');
 if(await image.count()!==1)throw new Error('规格图必须有且只有一张预览');
 return image.evaluate(i=>{if(!i.complete||!i.naturalWidth||!/^(https?:|data:)/.test(i.currentSrc||i.src))throw new Error('规格图上传未完成');return i.currentSrc||i.src;});
}
export async function bindSpecImages(page,config){
 const bindings=specImageBindings(config),region=section(page);if(await region.count()!==1)throw new Error('无法唯一定位颜色规格区');
 const toggle=region.getByRole('switch');if(await toggle.count()!==1)throw new Error('规格图开关数量异常');
 if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click();
 if(await toggle.getAttribute('aria-checked')!=='true')throw new Error('规格图开关未开启');
 const names=await region.locator('.ecom-g-cascader-picker-label').allTextContents();
 if(names.length!==bindings.length||bindings.some(b=>!names.includes(b.name)))throw new Error('页面款式与规格图配置不一致');
 const evidence=[];proof.delete(page);
 for(const binding of bindings){
  const row=rowFor(page,binding.name);if(await row.count()!==1)throw new Error(`规格图款式定位不唯一：${binding.name}`);
  if(await row.locator('[class*="style_imgUpload__"] img').count())throw new Error(`${binding.name}已有规格图，无法证明来源；请从新建入口运行`);
  const input=row.locator('[class*="style_imgUpload__"] input[type=file]:not([multiple])');if(await input.count()!==1)throw new Error(`找不到${binding.name}的独立规格图入口`);
  await input.setInputFiles(binding.file,{timeout:15000});
  await row.locator('[class*="style_imgUpload__"] img').waitFor({state:'attached',timeout:90000});
  await page.waitForFunction(name=>{const rows=[...document.querySelectorAll('[id="skuValue-颜色分类"] [class*="style_skuValueInput__"]')];const r=rows.find(e=>e.querySelector('.ecom-g-cascader-picker-label')?.textContent.trim()===name);const i=r?.querySelector('[class*="style_imgUpload__"] img');return i?.complete&&i.naturalWidth>0&&/^(https?:|data:)/.test(i.currentSrc||i.src)&&!r.querySelector('[class*="uploading"],[class*="item-error"],[class*="item-loading"]');},binding.name,{timeout:90000});
  const src=await preview(row),identity=imageIdentity(src);
  if(identity.startsWith('md5:')&&identity!=='md5:'+crypto.createHash('md5').update(await fs.readFile(binding.file)).digest('hex'))throw new Error('规格图内容指纹与本地文件不符');
  evidence.push({...binding,src});
 }
 proof.set(page,evidence);return verifySpecImages(page,config);
}
export async function verifySpecImages(page,config){
 const bindings=specImageBindings(config),evidence=proof.get(page);
 if(!evidence||evidence.length!==bindings.length)throw new Error('缺少本次规格图上传证据');
 if(await section(page).getByRole('switch').getAttribute('aria-checked')!=='true')throw new Error('规格图开关已关闭');
 for(const b of bindings){const e=evidence.find(e=>e.name===b.name&&e.file===b.file);if(!e||imageIdentity(await preview(rowFor(page,b.name)))!==imageIdentity(e.src))throw new Error(`${b.name}规格图绑定已变化`);}
 return evidence.map(({name,no,file})=>({name,no,file}));
}
