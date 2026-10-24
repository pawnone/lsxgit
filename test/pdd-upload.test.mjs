import test from 'node:test';
import assert from 'node:assert/strict';
import {PddDriver} from '../engine/pdd/dom-driver.mjs';
import {waitForMainImages,waitForEntryReady} from '../engine/pdd/category-entry.mjs';

test('hidden carousel upload opens its native chooser once, before dispatching any files',async()=>{
  const calls=[],files=['/first.png','/second.png'];
  const page={hover:async()=>calls.push('hover'),waitForFileChooser:()=>{
    calls.push('listen');return Promise.resolve({setFiles:async got=>{assert.deepEqual(got,files);calls.push('files');}});
  },setInputFiles:()=>assert.fail('hidden assignment must not be used')};
  const d=new PddDriver({page,kind:'ego',expectedShop:'测试店'});
  d.guard=async()=>{};const states=[1,'#upload-card','#local-upload'];d.read=async()=>states.shift();
  d.click=async()=>calls.push('click');await d.setFiles('#file',files);
  assert.deepEqual(calls,['hover','listen','click','files']);
});
test('upload action rejection is preserved and files are not dispatched or retried',async()=>{
  let dispatched=0;
  const page={hover:async()=>{},waitForFileChooser:()=>Promise.resolve({setFiles:()=>dispatched++}),setInputFiles:()=>assert.fail('no fallback')};
  const d=new PddDriver({page,kind:'ego',expectedShop:'测试店'});d.guard=async()=>{};
  const states=[1,'#card','#button'];d.read=async()=>states.shift();d.click=async()=>{throw Error('control returned to user');};
  await assert.rejects(d.setFiles('#file',['/one.png']),/control returned/);assert.equal(dispatched,0);
});
test('Ego editing uses the same 15-second action budget as the existing executor, without retry',async()=>{
  const calls=[];const page={fill:async(...args)=>calls.push(['fill',...args]),press:async(...args)=>calls.push(['press',...args])};
  const d=new PddDriver({page,kind:'ego',expectedShop:'测试店'});d.guard=async()=>{};
  const states=[[{type:'text',disabled:false}],{count:1,value:'99.9'}];d.read=async()=>states.shift();
  await d.fill('#price','99.9');assert.equal(calls.length,2);assert.equal(calls[0][3].timeout,15000);assert.equal(calls[1][3].timeout,15000);
});
test('input mismatch identifies the field and expected/actual values without retry',async()=>{
  let fills=0;const d=new PddDriver({page:{fill:async()=>fills++,press:async()=>{}},kind:'ego',expectedShop:'测试店'});
  d.guard=async()=>{};const states=[[{type:'text',disabled:false}],{count:1,value:'',field:'备注（偏深/浅等）'}];d.read=async()=>states.shift();
  await assert.rejects(d.fill('#note','（单件）'),/备注（偏深\/浅等）.*预期"（单件）"，实际""/);assert.equal(fills,1);
});
test('Ego exact XPath click retains text and publish guards without converting it to CSS',async()=>{
  const calls=[],d=new PddDriver({page:{click:async(...args)=>calls.push(args)},kind:'ego',expectedShop:'测试店'});
  d.guard=async()=>{};d.read=async()=>[{text:'涤纶',id:'',tracking:null}];
  const selector='xpath=//label[.//text()[.="涤纶"]]';await d.click(selector,{expectedText:'涤纶'});assert.equal(calls[0][0],selector);
  d.read=async()=>[{text:'提交并上架',id:'submit_button',tracking:null}];await assert.rejects(d.click('xpath=//*[@id="submit_button"]'),/禁止正式发布/);assert.equal(calls.length,1);
});
const state=(n,{pending=false,error=false,slots=n}={})=>({count:n,slots,uploaded:Array.from({length:n},(_,i)=>'url-'+i),pending,error});
const observer=states=>{let guards=0;const events=[];return{events,get guards(){return guards;},guard:async()=>{guards++;},read:async()=>states.length>1?states.shift():states[0],onEvent:async e=>events.push(e)};};
test('main upload reports incremental server previews and verifies the full set',async()=>{
  const d=observer([state(0),state(1),state(2)]);
  const result=await waitForMainImages(d,2,{interval:1,stableMs:0});
  assert.equal(result.uploaded.length,2);assert.equal(d.guards,3);assert.equal(d.events.length,3);
  assert.match(d.events[1].text,/1\/2/);
});
test('main upload distinguishes platform error, stalled zero progress and surplus media',async()=>{
  await assert.rejects(waitForMainImages(observer([state(0,{error:true})]),2),/平台显示主图上传失败/);
  await assert.rejects(waitForMainImages(observer([state(0)]),2,{timeout:0}),/服务端预览 0\/2/);
  await assert.rejects(waitForMainImages(observer([state(3)]),2),/超过本次计划/);
});
test('security rejection interrupts upload observation immediately',async()=>{
  const d=observer([state(0)]);d.guard=async()=>{throw Error('SAFETY_BLOCKED');};
  await assert.rejects(waitForMainImages(d,2),/SAFETY_BLOCKED/);assert.equal(d.events.length,0);
});
test('visible title alone cannot enable upload before initialization settles',async()=>{
  const d=observer([{loaded:true,controls:true,initialization:null}]);
  await assert.rejects(waitForEntryReady(d,{timeout:0}),/初始化未就绪/);
  const ready=observer([{loaded:true,controls:true,initialization:{status:200,settledFor:2500}}]);
  assert.equal((await waitForEntryReady(ready)).initialization.status,200);
  const early=observer([{loaded:true,controls:true,initialization:{status:200,settledFor:500}}]);
  await assert.rejects(waitForEntryReady(early,{timeout:0}),/初始化未就绪/);
});
test('platform initialization rejection stops before any upload',async()=>{
  await assert.rejects(waitForEntryReady(observer([{loaded:true,controls:true,initialization:{status:500,settledFor:3000}}])),/初始化失败（500）/);
});
