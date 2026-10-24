import ExcelJS from 'exceljs';

// Layout is discovered from labels. Only this in-memory copy uses the upstream
// parser's fixed coordinates; the source workbook is never rearranged or saved.
export const cellValue=value=>Array.isArray(value?.richText)?value.richText.map(run=>run.text).join(''):value;
const text=value=>typeof cellValue(value)==='string'?cellValue(value).normalize('NFKC').replace(/\s+/g,'').trim():'';
const empty=value=>value===null||value===undefined||value==='';
const STYLE={name:['款式名称'],note:['款式备注','备注'],group:['统一拼单价（元）','拼单价（元）','拼单价'],
  single:['统一单买价（元）','单买价（元）','单买价'],stock:['每尺码库存','库存'],image:['对应主图编号','主图编号','图片'],code:['规格编码前缀','编码前缀'],state:['状态']};
const SIZE={size:['尺码'],note:['显示备注','尺码备注','备注']};
const OVERRIDE={style:['款式名称','款式'],size:['尺码'],group:STYLE.group,single:STYLE.single,stock:STYLE.stock,
  code:['规格编码','编码','覆盖编码'],image:STYLE.image,state:STYLE.state};
const matching=(value,labels)=>labels.some(label=>text(value)===text(label));

function rowWith(sheet,labels){
  const found=[];sheet?.eachRow(row=>{if(row.values.some(value=>matching(value,labels)))found.push(row.number);});
  if(found.length>1)throw Error(sheet.name+'：存在多个“'+labels[0]+'”表头，无法确定数据区域');
  return found[0]||null;
}
function columns(sheet,rowNumber,definition,required){
  const row=sheet.getRow(rowNumber),result={};
  for(const [key,labels] of Object.entries(definition)){
    const matches=[];row.eachCell((cell,column)=>{if(matching(cell.value,labels))matches.push(column);});
    if(matches.length>1)throw Error(sheet.name+'!'+rowNumber+'：列标题重复“'+labels[0]+'”');
    if(!matches.length&&required.includes(key))throw Error(sheet.name+'：缺少数据列“'+labels[0]+'”');
    result[key]=matches[0]||null;
  }
  return result;
}
const hasLabel=(sheet,label)=>{let found=false;sheet.eachRow(row=>{if(row.values.some(v=>matching(v,[label])))found=true;});return found;};
function worksheet(wb,name,recognize){
  if(wb.getWorksheet(name))return wb.getWorksheet(name);
  const found=wb.worksheets.filter(recognize);
  if(found.length>1)throw Error('多份工作表包含“'+name+'”数据，请保留唯一来源');
  return found[0]||null;
}
export function fieldTable(sheet){
  if(!sheet)return null;
  const header=rowWith(sheet,['字段']);
  // Older sheets without a header retain the original adjacent A/B key-value
  // convention. Moving columns requires their labels so values stay unambiguous.
  const cols=header?columns(sheet,header,{key:['字段'],value:['填写值','值'],note:['说明','备注']},['key','value']):{key:1,value:2,note:3};
  const rows=[];sheet.eachRow(row=>{
    if(row.number===header)return;
    const keyCell=row.getCell(cols.key),valueCell=row.getCell(cols.value),key=cellValue(keyCell.value);
    if(empty(key))return;
    if(keyCell.isMerged||valueCell.isMerged&&key!=='完整类目路径')return;
    if(header&&row.number<header&&!['商品类型','完整类目路径'].includes(key))return;
    rows.push({row:row.number,key:typeof key==='string'?key.trim():key,keyCell:row.getCell(cols.key).address,valueCell:row.getCell(cols.value).address});
  });
  return{sheet,header,columns:cols,rows};
}
function records(sheet,header,cols,end){
  const result=[];
  for(let row=header+1;row<end;row++){
    const source=sheet.getRow(row),values=Object.values(cols).filter(Boolean).map(col=>source.getCell(col).value);
    if(values.every(empty))continue;
    // The old templates end with a merged help paragraph. It is explanatory
    // content, never a style/SKU row. Unmerged incomplete rows remain errors.
    const first=source.getCell(Object.values(cols).find(Boolean));
    const cells=Object.values(cols).filter(Boolean).map(col=>source.getCell(col));
    if(first.isMerged&&cells.every(cell=>cell.isMerged&&cell.master.address===first.master.address))continue;
    result.push(row);
  }
  return result;
}
export function workbookLayout(wb){
  const basic=worksheet(wb,'基础信息',s=>hasLabel(s,'商品标题')&&(hasLabel(s,'完整类目路径')||hasLabel(s,'商品类型')));
  const service=worksheet(wb,'服务与承诺',s=>hasLabel(s,'发货模式')&&hasLabel(s,'运费模板'));
  const specs=worksheet(wb,'款式与尺码',s=>hasLabel(s,'款式名称')&&hasLabel(s,'尺码')&&!hasLabel(s,'字段'));
  const overrides=wb.getWorksheet('个别尺码调整（选填）')||wb.getWorksheet('个别尺码调整');
  let styles=null,sizes=null,adjustments=null;
  if(specs){
    const styleHeader=rowWith(specs,STYLE.name),sizeHeader=rowWith(specs,SIZE.size);
    if(!styleHeader)throw Error(specs.name+'：缺少“款式名称”表头');
    if(!sizeHeader)throw Error(specs.name+'：缺少“尺码”表头');
    const styleColumns=columns(specs,styleHeader,STYLE,['name','group','single','stock']);
    const sizeColumns=columns(specs,sizeHeader,SIZE,['size']);
    styles={sheet:specs,header:styleHeader,columns:styleColumns,rows:records(specs,styleHeader,styleColumns,sizeHeader>styleHeader?sizeHeader:specs.rowCount+1)};
    sizes={sheet:specs,header:sizeHeader,columns:sizeColumns,rows:records(specs,sizeHeader,sizeColumns,styleHeader>sizeHeader?styleHeader:specs.rowCount+1)};
    if(styles.rows.length>10)throw Error(specs.name+'：当前最多支持10个款式，不会截断额外数据');
    if(sizes.rows.length>12)throw Error(specs.name+'：当前最多支持12个尺码，不会截断额外数据');
  }
  if(overrides){
    const header=rowWith(overrides,OVERRIDE.style);
    if(!header)throw Error(overrides.name+'：缺少“款式”表头');
    const cols=columns(overrides,header,OVERRIDE,['style','size']);
    adjustments={sheet:overrides,header,columns:cols,rows:records(overrides,header,cols,overrides.rowCount+1)};
    if(adjustments.rows.length>20)throw Error(overrides.name+'：当前最多支持20个SKU调整，不会截断额外数据');
  }
  return{basic:fieldTable(basic),service:fieldTable(service),styles,sizes,adjustments};
}
export function normalizeWorkbook(source){
  const layout=workbookLayout(source),workbook=new ExcelJS.Workbook(),addresses=new Map();
  function copy(section,name,order,start){
    if(!section)return;
    const sheet=workbook.getWorksheet(name)||workbook.addWorksheet(name);
    section.rows.forEach((sourceRow,index)=>{
      const targetRow=start+index;
      order.forEach((key,i)=>{
        const column=section.columns[key];if(!column)return;
        const cell=section.sheet.getCell(sourceRow,column),target=sheet.getCell(targetRow,i+1);
        target.value=structuredClone(cellValue(cell.value));addresses.set(name+'!'+target.address,section.sheet.name+'!'+cell.address);
      });
    });
  }
  for(const [key,name]of [['basic','基础信息'],['service','服务与承诺']]){
    const table=layout[key];if(!table)continue;
    const sheet=workbook.addWorksheet(name);sheet.addRow(['字段','填写值']);
    for(const sourceRow of table.rows){
      const row=sheet.addRow([structuredClone(cellValue(table.sheet.getCell(sourceRow.row,table.columns.key).value)),structuredClone(cellValue(table.sheet.getCell(sourceRow.row,table.columns.value).value))]);
      for(const [column,address]of [[1,sourceRow.keyCell],[2,sourceRow.valueCell]])addresses.set(name+'!'+row.getCell(column).address,table.sheet.name+'!'+address);
    }
  }
  copy(layout.styles,'款式与尺码',Object.keys(STYLE),2);
  copy(layout.sizes,'款式与尺码',Object.keys(SIZE),15);
  const specs=workbook.getWorksheet('款式与尺码');if(specs){specs.getCell('A1').value='款式名称';specs.getCell('A14').value='尺码';}
  copy(layout.adjustments,'个别尺码调整（选填）',Object.keys(OVERRIDE),2);
  return{workbook,layout,addresses};
}
