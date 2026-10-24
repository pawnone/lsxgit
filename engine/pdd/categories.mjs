export const SET_CATEGORY='女装/女士精品 > 套装/学生校服/工作制服 > 时尚套装';
export const KNIT_CATEGORY='女装/女士精品 > 毛衣/针织衫 > 毛衣/针织衫';
export const SUPPORTED_CATEGORIES=[SET_CATEGORY,KNIT_CATEGORY];
export const isKnit=basic=>basic?.['完整类目路径']===KNIT_CATEGORY;
export const setSingles=['品牌','面料俗称','材质','成分含量','主风格','风格','袖长','是否加绒','上市时节','款式','适用年龄','弹力','穿着方式','裙长/裤长','服装版型','填充物','地理标志'];
export const knitSingles=['品牌','面料俗称','主风格','风格','袖长','衣长','服装版型','穿着方式','组合形式','领型','是否加绒','上市时节','适用年龄','重量'];
export const categoryOnlyFields={
  [SET_CATEGORY]:setSingles.filter(field=>!knitSingles.includes(field)),
  [KNIT_CATEGORY]:['材质成分',...knitSingles.filter(field=>!setSingles.includes(field))],
};
