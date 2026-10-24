import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const blank = v => v === '' || v === null || v === undefined;
export function parseWorkbook(wb) {
  const issues = [];
  const error = (cell, message) => issues.push({cell, message});
  const sheet = name => {
    const s = wb.getWorksheet(name);
    if (!s) error(name, '缺少工作表');
    return s;
  };
  const read = (s, r, c) => {
    if (!s) return null;
    const cell = s.getCell(r,c), v = cell.value;
    if (v !== null && typeof v === 'object') {
      error(`${s.name}!${cell.address}`, '只接受纯文本或数字，不接受公式、链接或富文本');
      return null;
    }
    return typeof v === 'string' ? v.trim() : v;
  };
  const fields = (name) => {
    const s = sheet(name), values = {}, cells = {};
    if (s) for (let r=2; r<=s.rowCount; r++) {
      const k=read(s,r,1), v=read(s,r,2);
      if (!k) continue;
      const addr=`${name}!B${r}`;
      if (Object.hasOwn(values,k)) error(addr, `重复字段：${k}`);
      values[k]=v; cells[k]=addr;
      if (!['实际成分依据','参考价依据'].includes(k) && (blank(v) || /待补充|待填写|待确认|【/.test(String(v)))) error(addr, `${k}尚未填写完整`);
    }
    return {values,cells};
  };
  const basic=fields('基础信息'), service=fields('服务与承诺');
  for (const [k,v] of Object.entries({'适用平台':'拼多多','平台尺码表':'停用','详情尺码图':'保留','最终操作':'保存草稿','资料已核对':'是'})) {
    if (basic.values[k]!==v) error(basic.cells[k] || `基础信息:${k}`, `${k}必须为“${v}”`);
  }
  for (const k of ['商品业务标识','商品标题','完整类目路径']) {
    if (!Object.hasOwn(basic.values,k)) error(`基础信息:${k}`, '缺少必需字段行');
  }
  for (const k of ['发货模式','预售起止日期/时段','承诺发货时间/时效','运费模板','运费范围及收费规则','其他服务设置']) {
    if (!Object.hasOwn(service.values,k)) error(`服务与承诺:${k}`, '缺少必需字段行');
  }
  const s=sheet('款式与尺码'), a=sheet('个别尺码调整（选填）');
  if(s && (read(s,1,1)!=='款式名称' || read(s,14,1)!=='尺码')) error(s.name,'模板结构变化：第1行应为款式名称，第14行应为尺码');
  const styles=[], sizes=[], seenStyles=new Set(), seenSizes=new Set();
  if(s) {
    for(let r=2;r<=11;r++) {
      const row=Array.from({length:8},(_,i)=>read(s,r,i+1));
      if(row.every(blank)) continue;
      const [name,note,group,single,stock,image,code,state]=row;
      if(blank(name)) {error(`款式与尺码!A${r}`,'款式名称为空');continue;}
      if(seenStyles.has(name)) error(`款式与尺码!A${r}`,'款式名称重复');
      seenStyles.add(name);
      styles.push({name,note,group,single,stock,image,code,state,row:r});
    }
    for(let r=15;r<=26;r++) {
      const size=read(s,r,1), note=read(s,r,2);
      if(blank(size)&&blank(note)) continue;
      if(blank(size)) {error(`款式与尺码!A${r}`,'尺码名称为空');continue;}
      if(seenSizes.has(size)) error(`款式与尺码!A${r}`,'尺码重复');
      seenSizes.add(size);sizes.push({size,note});
    }
  }
  if(!styles.length) error('款式与尺码','至少填写一个款式');
  if(!sizes.length) error('款式与尺码','至少填写一个尺码');
  const overrides=new Map(), key=(style,size)=>JSON.stringify([style,size]);
  if(a) for(let r=2;r<=21;r++) {
    const row=Array.from({length:8},(_,i)=>read(a,r,i+1));
    if(row.every(blank)) continue;
    const [style,size,...values]=row, k=key(style,size);
    if(!seenStyles.has(style)||!seenSizes.has(size)) error(`${a.name}!A${r}`, '覆盖项引用未知款式或尺码');
    if(overrides.has(k)) error(`${a.name}!A${r}`, '同一SKU覆盖项重复');
    overrides.set(k,{values,row:r});
  }
  const number=(v,loc,label,money=false)=>{
    const pattern=money?/^\d+(?:\.\d{1,2})?$/:/^\d+$/;
    if(blank(v)||!pattern.test(String(v))) {error(loc,`${label}必须是${money?'最多两位小数的正金额':'非负整数'}`);return null;}
    const n=money?Math.round(Number(v)*100):Number(v);
    if(!Number.isSafeInteger(n)||(money&&n<=0)) {error(loc,`${label}数值超出范围`);return null;}
    return n;
  };
  // 基础价格和库存必须存在，不能通过局部覆盖掩盖缺项。
  for(const st of styles) for(const [prop,col,label,money] of [['group','C','拼单价',true],['single','D','单买价',true],['stock','E','库存',false]]) number(st[prop],`款式与尺码!${col}${st.row}`,label,money);
  const skus=[];
  for(const st of styles) for(const sz of sizes) {
    const override=overrides.get(key(st.name,sz.size));
    const v=override?.values||[];
    const fallback=[st.group,st.single,st.stock,blank(st.code)?null:`${st.code} ${sz.size}`,st.image,st.state];
    const values=fallback.map((base,i)=>blank(v[i])?base:v[i]);
    const loc=i=>!blank(v[i])?`个别尺码调整（选填）!${'CDEFGH'[i]}${override.row}`:`款式与尺码!${['C','D','E','G','F','H'][i]}${st.row}`;
    const groupPriceCents=number(values[0],loc(0),'拼单价',true), singlePriceCents=number(values[1],loc(1),'单买价',true), stock=number(values[2],loc(2),'库存');
    if(!['启用','停用'].includes(values[5])) error(loc(5),'状态必须为启用或停用');
    if(blank(values[3]) || /待填写|待补充|待确认|【填写/.test(String(values[3]))) error(loc(3),'规格编码前缀或覆盖编码缺失');
    if(!/^\d{2}$/.test(String(values[4]))) error(loc(4),'主图编号必须为两位文本，如01');
    skus.push({style:st.name,styleNote:st.note,size:sz.size,sizeNote:sz.note,groupPriceCents,singlePriceCents,stock,code:values[3],image:values[4],state:values[5]});
  }
  const ref=number(basic.values['商品参考价（元）'],basic.cells['商品参考价（元）']||'基础信息:商品参考价','参考价',true);
  if(ref!==null && skus.some(s=>s.singlePriceCents!==null&&ref<=s.singlePriceCents)) error(basic.cells['商品参考价（元）'],'参考价必须大于最大单买价（按已有截图输入提示进行离线校验）');
  if(basic.values['满件折扣']==='启用') {
    const count=number(basic.values['满件数量'],basic.cells['满件数量'],'满件数量');
    if(count!==null&&count<2)error(basic.cells['满件数量'],'满件数量至少2');
    const discount=Number(basic.values['折扣（几折）']);
    if(!Number.isFinite(discount)||discount<=0||discount>10)error(basic.cells['折扣（几折）'],'折扣必须大于0且不超过10');
  } else if(basic.values['满件折扣']!=='停用') error(basic.cells['满件折扣'],'满件折扣必须明确启用或停用');
  const codes=new Set();
  for(const sku of skus) if(sku.code) {if(codes.has(sku.code)) error('SKU规格编码',`重复编码：${sku.code}`);codes.add(sku.code);}
  return {scope:'offline-only',browserImplemented:false,basic:basic.values,service:service.values,skus,totalStock:skus.every(x=>x.stock!==null)?skus.reduce((sum,x)=>sum+x.stock,0):null,issues:[...new Map(issues.map(i=>[JSON.stringify(i),i])).values()]};
}

export async function prepareProduct(dir) {
  dir=path.resolve(dir);
  const wb=new ExcelJS.Workbook();
  // 命名规范：<货号>pdd商品信息表.xlsx；兼容旧名 商品信息.xlsx。忽略 ~$ 临时锁文件。
  const infoDir=path.join(dir,'商品信息');
  const names=(await fs.readdir(infoDir)).filter(n=>n.endsWith('.xlsx')&&!n.startsWith('~$'));
  if(names.length!==1) throw new Error(`商品信息必须恰好一份Excel，找到${names.length}份：${names.join('、')}`);
  const picked=names.find(n=>/pdd商品信息表\.xlsx$/i.test(n))||names.find(n=>n==='商品信息.xlsx');
  if(!picked) throw new Error(`商品信息目录未找到信息表（支持 *pdd商品信息表.xlsx 或 商品信息.xlsx），现有：${names.join('、')||'空'}`);
  await wb.xlsx.readFile(path.join(infoDir,picked));
  const report={...parseWorkbook(wb),infoFile:picked};
  report.inputSchema={source:'当前商品Excel，不使用历史商品值兜底',worksheets:wb.worksheets.map(s=>s.name),stylesHeaderRow:1,sizesHeaderRow:14,auxiliaryFields:['实际成分依据','参考价依据']};
  report.notes=['辅助依据字段按原表保留，但不强制存在；不会把历史百分比、价格、编码写回商品资料。','成分或参考价辅助说明是否与实际值一致需要人工核实，本地通过不证明商品事实。'];
  report.productDir=dir;
  const files=async folder=>{
    try {return (await fs.readdir(path.join(dir,folder),{withFileTypes:true})).filter(x=>x.isFile()&&!x.name.startsWith('.')).map(x=>x.name);}
    catch(e) {if(e.code==='ENOENT') return [];throw e;}
  };
  const main=await files('主图'), size=await files('尺码图'), details=await files('详情图');
  report.media={main,size,details};
  const images=list=>list.filter(x=>/\.(png|jpe?g|webp)$/i.test(x));
  for(const [folder,list,min,max] of [['主图',main,1,10],['尺码图',size,1,1],['详情图',details,1,Infinity]]) {
    if(list.length<min||list.length>max) report.issues.push({cell:folder,message:`文件数量必须为${min}～${max===Infinity?'不限':max}，当前${list.length}`});
    for(const name of list) if(!images([name]).length) report.issues.push({cell:`${folder}/${name}`,message:'不支持的图片扩展名'});
  }
  const byNumber=new Map();
  for(const name of images(main)) {
    const match=/^(\d{2})\.(png|jpe?g|webp)$/i.exec(name);
    if(!match) {report.issues.push({cell:`主图/${name}`,message:'文件名应为01.jpg等两位编号'});continue;}
    if(byNumber.has(match[1])) report.issues.push({cell:'主图',message:`重复编号${match[1]}`});
    byNumber.set(match[1],name);
  }
  for(let i=1;i<=main.length;i++) if(!byNumber.has(String(i).padStart(2,'0'))) report.issues.push({cell:'主图',message:`缺少连续编号${String(i).padStart(2,'0')}`});
  for(const image of new Set(report.skus.map(s=>s.image))) if(!byNumber.has(image)) report.issues.push({cell:'主图',message:`SKU引用的主图${image}不存在`});
  report.status=report.issues.length?'needs-input':'offline-check-passed';
  report.unverified=['图片真实格式、尺寸、文件大小及画面内容','视频及其他可选素材','平台属性选项与服务规则','登录、页面填写、草稿保存'];
  return report;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.length!==1 || args[0].startsWith('--')) throw Error('用法：node prepare-product.mjs <单品目录>；仅离线检查');
    const report=await prepareProduct(args[0]);
    const out=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','output');
    await fs.mkdir(out,{recursive:true});
    const filename=path.join(out,`preflight-${Date.now()}.json`);
    await fs.writeFile(filename,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(`SKU数：${report.skus.length}；总库存：${report.totalStock}；问题数：${report.issues.length}`);
    for(const issue of report.issues) console.log(`${issue.cell}：${issue.message}`);
    console.log(`报告：${filename}\n仅离线检查，未连接浏览器，未保存草稿。`);
    process.exitCode=report.issues.length?2:0;
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
