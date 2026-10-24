import test from 'node:test';
import assert from 'node:assert/strict';
import {materialComponents} from '../engine/pdd/composition.mjs';
import {attributePlan} from '../engine/pdd/form-contract.mjs';
import {KNIT_CATEGORY,SET_CATEGORY} from '../engine/pdd/categories.mjs';

test('针织衫成分读取明确百分比，兼容全角和旧单项格式',()=>{
  assert.deepEqual(materialComponents({'材质成分':'涤纶４０％；腈纶60%'}),[{name:'涤纶（聚酯纤维）',percent:40},{name:'腈纶',percent:60}]);
  assert.deepEqual(materialComponents({'材质':'涤纶（聚酯纤维）','成分含量':'100%'}),[{name:'涤纶（聚酯纤维）',percent:100}]);
  assert.deepEqual(materialComponents({'材质成分':'涤纶(聚酯纤维): 99.5%'}),[{name:'涤纶（聚酯纤维）',percent:99.5}]);
});
test('不把成分区间猜成具体百分比，不接受重复、超额或无效含量',()=>{
  for(const basic of [{'材质':'涤纶','成分含量':'30%（含）-50%（不含）'},{'材质成分':'涤纶30%-50%'},{'材质成分':'涤纶100%；聚酯纤维100%'},{'材质成分':'棉80%,腈纶30%'},{'材质成分':'棉0%'}])assert.throws(()=>materialComponents(basic));
});
test('套装与针织衫按真实类目使用不同字段，旧表无需改写',()=>{
  const fields={'品牌':'无品牌','面料俗称':'涤纶','材质':'涤纶','成分含量':'30%（含）-50%（不含）','材质成分':'涤纶100%','主风格':'简约通勤','风格':'简约','款式':'裤套装','弹力':'微弹','流行元素':'纯色'};
  const knit=attributePlan({pdd:{basic:{...fields,'完整类目路径':KNIT_CATEGORY}}});
  assert.deepEqual(knit.map(p=>p.field),['品牌','面料俗称','材质成分','主风格','风格','流行元素/工艺']);
  const set=attributePlan({pdd:{basic:{...fields,'完整类目路径':SET_CATEGORY}}});assert(set.some(p=>p.field==='款式'));assert(set.some(p=>p.field==='成分含量'));assert(!set.some(p=>p.kind==='composition'));
});
