import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {assertRequiredMediaInput} from './field-policy.mjs';
import { mediaPlan, mediaName, assertPlanInput, assertMediaTarget, beginMediaPlan, mediaState, verifySkuPreviewImages } from "./media.mjs";

// Production entry: reject every input problem before dispatching any media.
// The developer's separate inspection calls cannot enable draft saving.
export async function beginCompleteMedia(driver, config, validation, receiptRoot) {
  if (!validation.ok || validation.errors.length) throw Error("完整素材流程要求先补齐并核实全部资料");
  await assertMediaTarget(driver, config, validation);
  await assertRequiredMediaInput(driver,config);
  const plans = mediaPlan(config);
  for (const plan of plans) assertPlanInput(plan, config, validation);
  const pageUrl = await driver.page.url();
  const key = crypto.createHash("sha256").update(config.input.inputHash + "|" + pageUrl).digest("hex");
  const dir = path.join(receiptRoot, key);
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, "upload.lock");
  const handle = await fs.open(lock, "wx").catch(e => { if (e.code === "EEXIST") throw Error("素材上传已有运行锁，请核实原进程及上传结果"); throw e; });
  const receipts = [],styleGuards=new Set();let video,detach,closed=false;
  const start=async plan=>{
      const filename = path.join(dir, crypto.createHash("sha256").update(plan.key).digest("hex") + ".json");
      const receipt = await fs.readFile(filename, "utf8").then(JSON.parse).catch(e => { if (e.code === "ENOENT") return null; throw e; });
      const persist = async record => {
        await fs.appendFile(path.join(dir, "journal.jsonl"), JSON.stringify(record) + "\n");
        const temporary = filename + "." + crypto.randomUUID() + ".tmp";
        await fs.writeFile(temporary, JSON.stringify(record, null, 2));
        await fs.rename(temporary, filename);
      };
      return beginMediaPlan(driver,{config,validation,plan,receipt,persist,cacheDir:path.join(dir,crypto.createHash('sha256').update(plan.key).digest('hex')+'-slots'),timeout:/video/i.test(plan.kind)?240000:120000});
  };
  const close=async()=>{
    if(closed)return;closed=true;detach?.();for(const detachStyle of styleGuards)detachStyle();styleGuards.clear();
    await handle.close();
    await fs.unlink(lock);
  };
  try{await handle.writeFile(JSON.stringify({pid:process.pid,pageUrl,startedAt:new Date().toISOString()}));}catch(e){await close();throw e;}
  return {
    startVideo:async()=>{
      const plan=plans.find(p=>p.kind==='video');if(!plan)return;
      if(video)throw Error('本次视频已经启动，禁止重复上传');
      video=await driver.step('优先启动商品视频上传',()=>start(plan));
      detach=driver.addGuardCheck(video.probe);
      await driver.onEvent({type:'log',text:'商品视频已提交上传，后台处理期间继续填写属性、规格、价格与服务'});
    },
    finish:async()=>{
      if(closed)throw Error('素材上传会话已结束');
      const remaining=plans.filter(p=>p.kind!=='style');
      // Keep video overlapped with form filling, then release its upload before images.
      if(video)remaining.sort((a,b)=>Number(b.kind==='video')-Number(a.kind==='video'));
      for(const plan of remaining){
        const result=await driver.step((video&&plan.kind==='video'?'等待并核对':'批量上传并核对')+mediaName(plan.kind)+(plan.style?'：'+plan.style.name:''),async()=>{
          const job=plan.kind==='video'&&video?video:await start(plan);return job.wait();
        });
        if(plan.kind==='video'){detach?.();detach=null;}
        receipts.push({key:plan.key,...result});
      }
      // Dispatch each native file selection serially. The merchant can process
      // all style uploads while we wait once at the end; no same-page calls run
      // concurrently, and every selection already has its own pending receipt.
      const styles=[];
      for(const plan of plans.filter(p=>p.kind==='style')){
        const job=await driver.step('启动款式图上传：'+plan.style.name,()=>start(plan));
        const detachStyle=driver.addGuardCheck(job.probe);styleGuards.add(detachStyle);
        styles.push({plan,job,detachStyle});
      }
      if(styles.length)await driver.step('统一等待并核对'+styles.length+'款式图',async()=>{
        for(const {plan,job,detachStyle}of styles){
          const result=await job.wait();detachStyle();styleGuards.delete(detachStyle);receipts.push({key:plan.key,...result});
        }
      });
      await verifySkuPreviewImages(driver,config,receipts);return receipts;
    },close
  };
}
export async function uploadCompleteMedia(driver,config,validation,receiptRoot){
  const session=await beginCompleteMedia(driver,config,validation,receiptRoot);
  try{return await session.finish();}finally{await session.close();}
}

export async function verifyMediaReceipts(driver, receipts, { config, validation } = {}) {
  if (!config || !validation) throw Error("完整素材复核需要本次冻结配置与预检");
  await assertMediaTarget(driver, config, validation);
  const plans = mediaPlan(config);
  const expected = plans.map(p => p.key).sort();
  if (JSON.stringify(receipts.map(r => r.key).sort()) !== JSON.stringify(expected))
    throw Error("素材回执未覆盖完整上传计划");
  const url = await driver.page.url();
  for (const receipt of receipts) {
    if (receipt.status !== "confirmed" || receipt.identity.url !== url) throw Error("素材尚未确认完成或页面已变化");
    const plan = plans.find(p => p.key === receipt.key);
    const expectedFiles = plan.files.map(file => {
      const relative = path.relative(config.materialRoot, file).split(path.sep).join("/");
      const source = config.input.files.find(f => f.file === relative);
      if (!source) throw Error("素材不在冻结输入中");
      return { file: relative, sha256: source.sha256 };
    });
    if (receipt.identity.inputHash !== config.input.inputHash || receipt.identity.executionHash !== validation.executionHash ||
        JSON.stringify(receipt.identity.files) !== JSON.stringify(expectedFiles))
      throw Error("素材回执数量或顺序不符合当前上传计划：" + receipt.key);
    const actual = await mediaState(driver, receipt.descriptor);
    if (actual.error || actual.pending || !actual.loaded || actual.slots !== receipt.identity.files.length ||
        actual.count !== null && actual.count !== receipt.identity.files.length || JSON.stringify(actual.urls) !== JSON.stringify(receipt.urls))
      throw Error("保存前素材回读与本次上传回执不一致：" + receipt.key);
  }
  return { ok: true, confirmed: receipts.length };
}
