import {verifySpecImages} from './spec-images.mjs';
import {verifyProductAttributes} from './product-attributes.mjs';
import { verifyWhiteImage } from './platforms/doudian.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function verifyBeforeSave(page,config,skuReadback) {
  if(!config.draftOnly || skuReadback.length!==config.skuMatrix.length) throw new Error('保存前SKU校验未完成');
  for(const [selector,expected] of [['[attr-field-id="商品标题"] input[type=text]',config.product.title],['[attr-field-id="货号"] input',config.product.itemCode]]){
    if(await page.locator(selector).first().inputValue()!==expected) throw new Error(`保存前字段不符：${selector}`);
  }
  for(const [field,value] of [['商品类目',config.product.categoryPath],['品牌',config.product.brand],['运费模板',config.service.freightTemplate],['售后政策',config.service.returnPolicy]]){
    await page.locator(`[attr-field-id="${field}"]`).getByText(value,{exact:true}).waitFor({state:'visible',timeout:10000});
  }
  await verifyProductAttributes(page,config);
  await verifySpecImages(page,config);
  await verifyWhiteImage(page,config);
  const shipping=page.locator('[attr-field-id="现货发货时间"] label').filter({hasText:config.inventory.inStockDelivery}).locator('input[type="radio"]');
  if(!await shipping.isChecked()) throw new Error('保存前现货发货时间不符');
  const material=await page.locator('[attr-field-id="面料材质"]').last().locator('.aurora-select-selection-item-content').allTextContents();
  if(material.length!==1 || material[0].trim()!==`${config.product.material} ${config.product.materialPercent}%`) throw new Error('保存前材质不符');
  for(const field of ['主图','主图3:4']) if(await page.locator(`[attr-field-id="${field}"] img`).count()!==config.product.mainImages.length) throw new Error(`保存前${field}数量不符`);
  if(config.product.video && !await page.locator('[attr-field-id="主图视频"] [class*="item-success"]').count()) throw new Error('视频未完成上传');
  await page.getByText(`商详图片（${config.product.mainImages.length}/50）`,{exact:true}).waitFor({state:'visible',timeout:10000});
  for(const [field,label] of [['订单库存计数',config.inventory.stockCountMode],['售后服务承诺','不包含']]){
    const radio=page.locator(`[attr-field-id="${field}"] label`).filter({hasText:label}).locator('input');
    await radio.check();
    if(!await radio.isChecked()) throw new Error(`保存前服务设置失败：${field}`);
  }
}

export async function saveDraft(page,config,outputDir,inputHash) {
  const receiptFile=path.join(outputDir,`draft-save-${inputHash}.json`);
  let previous;
  try{previous=JSON.parse(await fs.readFile(receiptFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous) throw new Error(`同一输入已有保存记录（${previous.status}）；需检查草稿箱后再决定是否创建，避免重复草稿。${receiptFile}`);
  const receipt={status:'pending',inputHash,title:config.product.title,startedAt:new Date().toISOString(),pageUrl:page.url()};
  await fs.writeFile(receiptFile,JSON.stringify(receipt,null,2));
  try{
    // 只匹配精确的保存草稿按钮；任何失败均不退回点击发布。
    await page.getByRole('button',{name:'保存草稿',exact:true}).click({timeout:30000});
    await page.waitForFunction(title=>{
      const text=document.body.innerText;
      return /草稿保存成功|保存草稿成功|保存成功|已保存至草稿箱|已保存到草稿箱/.test(text) || (/\/g\/draft/.test(location.pathname)&&text.includes(title));
    },config.product.title,{timeout:30000});
    receipt.status='confirmed';receipt.finishedAt=new Date().toISOString();receipt.pageUrl=page.url();
    receipt.evidence=(await page.locator('body').innerText()).split('\n').filter(line=>/保存成功|草稿|已保存/.test(line)).slice(-12);
    await fs.writeFile(receiptFile,JSON.stringify(receipt,null,2));
    return {...receipt,receiptFile};
  }catch(error){
    receipt.status='unconfirmed';receipt.error=error.message;
    await fs.writeFile(receiptFile,JSON.stringify(receipt,null,2));
    throw new Error(`草稿保存结果未确认，禁止盲目重试；请检查草稿箱。${error.message}`);
  }
}
