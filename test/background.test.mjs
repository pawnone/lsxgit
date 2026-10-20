import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
const {createBackgroundController}=createRequire(import.meta.url)('../desktop/background.cjs');
test('background sleep protection releases on pause/end; notifications deduplicate and reopen',()=>{
 const starts=[],stops=[],notes=[];let opened=0;
 class Notification extends EventEmitter {static isSupported(){return true} constructor(p){super();this.p=p;notes.push(this)} show(){} close(){}}
 const c=createBackgroundController({powerSaveBlocker:{start:t=>(starts.push(t),0),stop:id=>stops.push(id)},Notification,showWindow:()=>opened++,fallback:()=>assert.fail()});
 const run={id:'one',status:'running',tasks:[{status:'confirmed'}]};
 c.update(run,true);c.update(run,true);assert.equal(starts.length,1);assert.equal(notes.length,0);
 run.status='paused';c.update(run,true);assert.deepEqual(stops,[0]);assert.equal(notes.length,1);
 notes[0].emit('click');assert.equal(opened,1);
 c.update(run,true);assert.equal(notes.length,1);
 run.status='running';c.update(run,true);run.status='safety-blocked';c.update(run,false);
 assert.equal(notes.length,2);assert.equal(stops.length,2);c.dispose();
});
test('historical runs stay silent, failed native notification falls back',()=>{
 let fallback=0,n;
 class Notification extends EventEmitter {static isSupported(){return true}constructor(){super();n=this}show(){this.emit('failed')}close(){}}
 const c=createBackgroundController({powerSaveBlocker:{start:()=>1,stop:()=>{}},Notification,showWindow:()=>{},fallback:()=>fallback++});
 const r={id:'restored',status:'complete',tasks:[]};c.update(r,false);assert.equal(fallback,0);
 r.status='running';c.update(r,true);r.status='failed';c.update(r,false);assert.equal(fallback,1);c.dispose();
});
