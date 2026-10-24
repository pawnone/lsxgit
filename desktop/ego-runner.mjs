import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import spawn from 'cross-spawn';
import {egoExecutableCandidates,egoCommand,egoScriptEntry} from './ego-command.mjs';

// The main process supplies an operation and typed data, never renderer code.
export class EgoRunner {
  constructor({root, executable}={}) {Object.assign(this,{root,executable});}
  async detectExecutable() {
    let configured;
    if(process.platform==='win32'&&this.root){
      const saved=await fs.readFile(path.join(path.dirname(this.root),'ego-runtime.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(saved?.schema===1&&typeof saved.executable==='string'&&path.isAbsolute(saved.executable)&&/\.(?:exe|cmd|bat|ps1)$/i.test(saved.executable))configured=saved.executable;
    }
    const candidates=[this.executable,configured,...egoExecutableCandidates()].filter(Boolean);
    for(const file of candidates)try{if((await fs.stat(file)).isFile())return file;}catch{}
    throw Error(process.platform==='win32'?'未找到 Ego 命令。请运行交付包中的“一键配置环境.cmd”，完成 Ego 首次设置后再试。':'未找到 Ego。请先打开 ego lite 完成首次设置，再重新打开文青尚品。');
  }
  async call(op,payload,{onEvent=()=>{},timeout=0}={}) {
    if(!['open','observe','verify','run'].includes(op))throw Error('未开放的 Ego 操作');
    const controlFile=payload.workspaceName ? path.join(this.root,'control',crypto.createHash('sha256').update(payload.workspaceName).digest('hex')+'.json') : null;
    const setControl=async (phase,details={})=>{if(controlFile){await fs.mkdir(path.dirname(controlFile),{recursive:true});await fs.writeFile(controlFile,JSON.stringify({phase,...details,at:new Date().toISOString()}),{mode:0o600});}};
    if(op==='observe'&&controlFile){
      const control=await fs.readFile(controlFile,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(control?.phase==='awaiting-user')return{status:'awaiting-user',loggedIn:false,actualName:null,error:'请先在 Ego 中登录，再点击“核对”交给 App。'};
      if(control?.phase==='connection-error')return{status:'connection-error',loggedIn:false,actualName:null,error:control.error};
    }
    const executable=await this.detectExecutable();
    const dir=path.join(this.root,crypto.randomUUID());await fs.mkdir(dir,{recursive:true,mode:0o700});
    const input=path.join(dir,'request.json'),result=path.join(dir,'result.json');
    await fs.writeFile(input,JSON.stringify({op,payload}),{mode:0o600});
    const entry=pathToFileURL(fileURLToPath(new URL('../engine/pdd/ego-entry.mjs',import.meta.url))).href;
    const script=`const {runEgoRequest}=await import(${JSON.stringify(entry)}); await runEgoRequest(${JSON.stringify(input)},${JSON.stringify(result)});`;
    const scriptFile=path.join(dir,'round.mjs');await fs.writeFile(scriptFile,script,{mode:0o600});
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    let lastSeq=0,linesSeen=0,polling=false,pollError,child,eventError,processExit;
    const deliver=event=>{
      if(eventError)return;
      if(Number.isInteger(event.seq)){if(event.seq<=lastSeq)return;lastSeq=event.seq;}
      try{onEvent(event);}catch(error){eventError=error;child?.kill();}
    };
    const poll=async()=>{
      if(polling)return;polling=true;
      try{
        const content=await fs.readFile(result+'.events.jsonl','utf8').catch(e=>{if(e.code==='ENOENT')return'';throw e;});
        const lines=content.split('\n');
        while(linesSeen<lines.length-1){const line=lines[linesSeen++];if(line)deliver(JSON.parse(line));}
      }catch(e){pollError=e;}finally{polling=false;}
    };
    const pollTimer=setInterval(()=>{void poll();},100);
    try{await new Promise((resolve,reject)=>{
      const invocation=egoCommand(executable,['nodejs'],{env});
      child=spawn(invocation.command,invocation.args,{env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
      let tail='',timedOut=false;const buffers={stdout:'',stderr:''};
      const timer=timeout?setTimeout(()=>{timedOut=true;child.kill();},timeout):null;
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      const output=(channel,chunk)=>{
        buffers[channel]+=chunk;let i;
        while((i=buffers[channel].indexOf('\n'))>=0){
          const line=buffers[channel].slice(0,i);buffers[channel]=buffers[channel].slice(i+1);
          if(line.startsWith('WQ_EVENT ')){try{deliver(JSON.parse(line.slice(9)));}catch{}}
          else if(line.trim()){tail=(tail+'\n'+line).slice(-3000);deliver({type:'log',text:line.slice(0,3000)});}
        }
      };
      child.stdout.on('data',chunk=>output('stdout',chunk));
      child.stderr.on('data',chunk=>output('stderr',chunk));
      child.once('error',e=>{processExit={at:new Date().toISOString(),spawnError:e.message};if(timer)clearTimeout(timer);reject(e);});
      child.once('close',(code,signal)=>{
        for(const channel of ['stdout','stderr'])if(buffers[channel])output(channel,'\n');if(timer)clearTimeout(timer);
        processExit={...processExit,at:new Date().toISOString(),exitCode:code,signal,timedOut,tail,eventError:eventError?.message};
        if(eventError)reject(Object.assign(Error('实时事件处理失败，已停止 Ego 执行：'+eventError.message),{code:'EGO_EVENT_FAILED'}));
        else if(code!==0||signal)reject(Object.assign(Error(timedOut?'Ego 连接超时；窗口已保留，请检查浏览器提示':'Ego 连接已中断（退出码 '+code+'，信号 '+(signal||'无')+'），现场与记录保留。'+tail),{code:'EGO_CONNECTION_LOST',diagnostic:processExit}));
        else resolve();
      });
      child.stdin.on('error',()=>{});
      child.stdin.end(process.platform==='win32'?egoScriptEntry(scriptFile):script);
    });}catch(error){
      const reply=await fs.readFile(result,'utf8').then(JSON.parse).catch(()=>null);
      if(reply?.ok===false&&reply.code)error=Object.assign(Error(reply.error),{code:reply.code,diagnostic:reply.diagnostic});
      if(error.code==='EGO_USER_CONTROL')await setControl('awaiting-user');
      else if(['EGO_CONNECTION_LOST','EGO_SPACE_INACTIVE'].includes(error.code))await setControl('connection-error',{error:error.message});
      throw error;
    }finally{
      clearInterval(pollTimer);
      while(polling)await new Promise(resolve=>setTimeout(resolve,10));
      await poll();
      if(processExit)await fs.writeFile(path.join(dir,'process-exit.json'),JSON.stringify(processExit,null,2));
    }
    if(eventError)throw Object.assign(Error('实时事件处理失败：'+eventError.message),{code:'EGO_EVENT_FAILED'});
    if(pollError)throw Error('实时日志读取失败，已停止：'+pollError.message);
    const response=JSON.parse(await fs.readFile(result,'utf8').catch(()=>{throw Error('Ego 未返回本次操作结果；请检查原工作空间，不要重复提交');}));
    if(!response.ok){
      if(response.code==='EGO_USER_CONTROL'||/由你控制/.test(response.error))await setControl('awaiting-user');
      else if(['EGO_SPACE_INACTIVE','EGO_CONNECTION_LOST'].includes(response.code))await setControl('connection-error',{error:response.error});
      throw Object.assign(Error(response.error),{code:response.code,diagnostic:response.diagnostic});
    }
    if(op==='open'||op==='run')await setControl('awaiting-user');
    else if(op==='verify')await setControl('agent');
    return response.result;
  }
}
