import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fieldTable} from '../engine/pdd/workbook-layout.mjs';
import {categoryOnlyFields,SET_CATEGORY,KNIT_CATEGORY} from '../engine/pdd/categories.mjs';

// Excel input validation discourages typing into inactive fields. Pasted values
// can bypass it; execution independently ignores fields of the other category.
export function configurePddTemplate(workbook){
  const basic=workbook.getWorksheet('基础信息'),rows=fieldTable(basic).rows;
  const type=rows.find(row=>row.key==='商品类型'),typeAddress='$'+type.valueCell.replace(/\d+$/,'')+'$'+type.row;
  for(const [category,fields]of Object.entries(categoryOnlyFields))for(const row of rows.filter(row=>fields.includes(row.key))){
    basic.getCell(row.valueCell).dataValidation={type:'custom',allowBlank:true,formulae:[typeAddress+'="'+(category===SET_CATEGORY?'时尚套装':'针织衫')+'"'],showErrorMessage:true,errorStyle:'stop',errorTitle:'当前类目不适用',error:'请先切换商品类型；保留的旧值不会用于当前类目。'};
  }
  basic.getCell('B4').dataValidation={type:'list',allowBlank:false,formulae:['"时尚套装,针织衫"'],showErrorMessage:true,errorStyle:'stop',errorTitle:'请选择商品类型',error:'当前只支持时尚套装或针织衫。'};
  basic.getCell('A2').value='浅蓝色格填写 / 按商品类型匹配填表 / 非当前类目变灰且限制直接输入 / 仅保存草稿';
  basic.getCell('A7').value='切换类目保留原值；灰色字段本次不读取。新类目缺少必填数据时先提示。输入校验不等同于加密锁定，粘贴可能绕过。';
  workbook.calcProperties.fullCalcOnLoad=true;
  for(const sheet of workbook.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{
    if(cell.formula&&(!cell.isMerged||cell.master.address===cell.address))cell.value={formula:cell.formula};
  }));
  return workbook;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const source=process.argv[2];if(!source)throw Error('用法：node scripts/prepare-pdd-templates.mjs <已确认的空白双类目预览.xlsx>');
  const out=fileURLToPath(new URL('../desktop/assets/pdd-templates/',import.meta.url));await fs.mkdir(out,{recursive:true});
  for(const [type,category]of [['时尚套装',SET_CATEGORY],['针织衫',KNIT_CATEGORY]]){
    const w=new ExcelJS.Workbook();await w.xlsx.readFile(source);configurePddTemplate(w);w.removeWorksheet('模板对照');w.getWorksheet('基础信息').getCell('B4').value=type;
    // Formula results are recalculated by LibreOffice before packaging.
    w.getWorksheet('基础信息').getCell('B5').value={formula:'IF(B4="时尚套装","'+SET_CATEGORY+'",IF(B4="针织衫","'+KNIT_CATEGORY+'","请选择商品类型"))'};
    await w.xlsx.writeFile(path.join(out,'拼多多商品信息模板_'+type+'.xlsx'));
  }
  console.log(out);
}
