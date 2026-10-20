import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../demo/task-plan.js';
const product=(id,sku)=>({id,code:'P'+id,title:'商品'+id,sku});
const shop=(id,extra={})=>({id,name:id,actualName:id,platform:'dou',loggedIn:true,verified:true,...extra});
test('2商品×2店生成4个唯一任务，按店铺外层串行，全部仅保存草稿',()=>{
 const p=api.buildPlan({platform:'dou',products:[product(1,4),product(2,12)],shops:[shop('A'),shop('B')]});
 assert.equal(p.taskCount,4);assert.equal(p.totalSkuWrites,32);assert.equal(new Set(p.tasks.map(t=>t.id)).size,4);
 assert.deepEqual(p.tasks.map(t=>[t.shopId,t.productId]),[['A',1],['A',2],['B',1],['B',2]]);
 assert(p.draftOnly&&p.tasks.every(t=>t.operation==='save-draft'));
});
test('未登录、未核对、身份不符、跨平台、空选择和重复选择均阻断',()=>{
 for(const shops of [[shop('A',{loggedIn:false})],[shop('A',{verified:false})],[shop('A',{actualName:'B'})],[shop('A',{platform:'pdd'})],[],[shop('A'),shop('A')]])assert.throws(()=>api.buildPlan({platform:'dou',products:[product(1,4)],shops}));
 assert.throws(()=>api.buildPlan({platform:'dou',products:[],shops:[shop('A')]}));
 assert.throws(()=>api.buildPlan({platform:'dou',products:[product(1,4),product(1,4)],shops:[shop('A')]}));
});
test('任务快照与源对象分离，后续改商品或店铺不会改历史目标',()=>{
 const a=shop('A'),p=product(1,4);const plan=api.buildPlan({platform:'dou',products:[p],shops:[a]});
 a.name='其他店';p.code='新货号';assert.equal(plan.shops[0].name,'A');assert.equal(plan.products[0].code,'P1');assert.equal(plan.tasks[0].shopName,'A');
});
test('确认后改变商品或店铺会使任务选择签名变化',()=>{
 const base={platform:'dou',products:[product(1,4)],shops:[shop('A')]};const p1=api.buildPlan(base);
 const p2=api.buildPlan({...base,shops:[shop('B')]});const p3=api.buildPlan({...base,products:[product(2,12)]});
 assert.notEqual(api.selectionKey(p1),api.selectionKey(p2));assert.notEqual(api.selectionKey(p1),api.selectionKey(p3));
});
