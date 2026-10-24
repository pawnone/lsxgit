import { deflateSync } from "node:zlib";
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

// Real decodable synthetic PNGs for file-format and dimension checks.
export function png(width = 512, height = 512, rgb) {
  const chunk = (type, value) => {
    const payload = Buffer.concat([Buffer.from(type), value]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const output = Buffer.alloc(value.length + 12);
    output.writeUInt32BE(value.length, 0);
    payload.copy(output, 4);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  if(rgb)for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++)pixels[y*(width*3+1)+1+x*3+c]=rgb[c];
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export async function imageFixture(dir,{names=['相机1.png','相机2.png','相机3.png','相机4.png','相机5.png'],folder='主图',ref='02'}={}){
  await fs.mkdir(path.join(dir,folder),{recursive:true});
  for(const [i,name] of names.entries())await fs.writeFile(path.join(dir,folder,name),png(512,512,[30+i*20,70+i*10,110]));
  await fs.mkdir(path.join(dir,'尺码图'));await fs.writeFile(path.join(dir,'尺码图','尺码.png'),png(512,512,[210,210,210]));
  const wb=new ExcelJS.Workbook(),basic=wb.addWorksheet('基础信息');
  basic.addRow(['字段','填写值','说明']);
  for(const pair of Object.entries({'适用平台':'拼多多','商品业务标识':'IMAGE-FIXTURE','商品货号':'IMAGE-FIXTURE','商品标题':'本地图片设置合成商品','完整类目路径':'女装/女士精品 > 套装/学生校服/工作制服 > 时尚套装','材质':'涤纶（聚酯纤维）','成分含量':'100%','商品参考价（元）':50,'满件折扣':'停用'}))basic.addRow(pair);
  const service=wb.addWorksheet('服务与承诺');service.addRow(['字段','值']);
  for(const pair of Object.entries({'商品类型':'普通商品','是否二手':'非二手','是否定制':'非定制','发货模式':'普通发货','承诺发货时间/时效':'48小时','运费模板':'合成模板'}))service.addRow(pair);
  const styles=wb.addWorksheet('款式与尺码');styles.getRow(1).values=['款式名称','备注','拼单价','单买价','库存','主图编号','编码前缀','状态'];
  styles.getRow(2).values=['测试款','原备注',19.9,29.9,8,ref,'REAL-CODE','启用'];
  styles.getRow(14).values=['尺码','备注'];styles.getRow(15).values=['M','备注'];
  const overrides=wb.addWorksheet('个别尺码调整（选填）');overrides.getRow(1).values=['款式','尺码','拼单价','单买价','库存','编码','图片','状态'];
  overrides.getRow(2).values=['测试款','M',null,null,null,'USER-EXACT-CODE',null,null];
  const archive=wb.addWorksheet('原始备注');archive.mergeCells('A1:C1');archive.getCell('A1').value='保留的原说明';archive.state='hidden';
  const file=path.join(dir,'商品信息表.xlsx');await wb.xlsx.writeFile(file);
  return {dir,file,wb,main:path.join(dir,folder),names};
}
