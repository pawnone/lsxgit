import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {egoExecutableCandidates,egoCommand,egoScriptEntry} from '../desktop/ego-command.mjs';import {probeEgo} from '../desktop/check-environment.mjs';

test('Windows查找用户bin及PATH的四种CLI入口，路径可含空格、中文和特殊字符',()=>{
 const home='C:\\Users\\测试 用户 & (!)',bin='D:\\Ego Browser\\bin';const list=egoExecutableCandidates({platform:'win32',home,env:{Path:'"'+bin+'";C:\\Windows;'}});
 for(const ext of ['.exe','.cmd','.bat','.ps1']){assert(list.includes(path.win32.join(home,'.local','bin','ego-browser'+ext)));assert(list.includes(path.win32.join(bin,'ego-browser'+ext)));}
 assert(!list.some(p=>p.startsWith('\\usr')));assert(!list.some(p=>p==='ego-browser.exe'));
 assert.deepEqual(egoExecutableCandidates({platform:'darwin',home:'/Users/test'}),['/Users/test/.local/bin/ego-browser','/usr/local/bin/ego-browser']);
});
test('Windows ps1入口使用系统PowerShell，exe/cmd保持独立参数且不拼接脚本内容',()=>{
 const exe='C:\\Users\\测试 用户 & (!)\\ego-browser.ps1',args=['nodejs'];const result=egoCommand(exe,args,{platform:'win32',env:{SystemRoot:'C:\\Windows'}});
 assert.equal(result.command,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');assert.deepEqual(result.args.slice(-3),['-File',exe,'nodejs']);
 assert.deepEqual(egoCommand(exe.replace('.ps1','.cmd'),args,{platform:'win32'}),{command:exe.replace('.ps1','.cmd'),args});assert(!result.args.includes('-Command'));
});
test('UTF-8文件入口只向CLI发送ASCII，文件名的引号、中文和特殊字符不能变成脚本',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wq-中文 & !-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'test \' $().mjs');await fs.writeFile(file,'globalThis.wqEntryProof="中文";');
 const entry=egoScriptEntry(file);assert(/^[\x00-\x7f]+$/.test(entry));assert(entry.includes('%'));const url=JSON.parse(entry.match(/^await import\((.*)\);$/)[1]);assert.equal(url,pathToFileURL(file).href);await import(url);assert.equal(globalThis.wqEntryProof,'中文');delete globalThis.wqEntryProof;
});
async function fakeEgo(t,mode){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wq-env-probe-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const executable=path.join(dir,'fake-ego.mjs');
 await fs.writeFile(executable,`#!/usr/bin/env node
if(process.argv[2]==='skill'){console.log(${JSON.stringify(mode==='bad-guide'?'old cli':'[ego-browser:skill] end of guide v2.1.0')});}
else{const names=['taskSpace','listTaskSpaces','claimTaskSpace','takeOverTaskSpace'];for(const name of names)if(name!==${JSON.stringify(mode==='missing-sdk'?'claimTaskSpace':'none')})globalThis[name]=()=>{throw Error('Probe must not open any space');};let input='';for await(const chunk of process.stdin)input+=chunk;const url=JSON.parse(input.match(/^await import\\((.*)\\);$/)[1]);await import(url);}
`,{mode:0o700});return{root:path.join(dir,'requests'),executable};}
test('环境检查使用官方guide及SDK存在性，不创建工作空间',async t=>{const input=await fakeEgo(t,'good');const result=await probeEgo(input);assert.equal(result.ok,true);assert.equal(result.executable,input.executable);});
test('CLI存在但API缺失时明确拒绝就绪',async t=>{await assert.rejects(probeEgo(await fakeEgo(t,'missing-sdk')),/缺少.*claimTaskSpace/);});
test('旧CLI或不完整使用指南不能通过环境检查',async t=>{await assert.rejects(probeEgo(await fakeEgo(t,'bad-guide')),/版本不兼容/);});
