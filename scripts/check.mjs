import {spawnSync} from 'node:child_process';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['demo/app.js','demo/task-plan.js','check-demo.mjs',...(await fs.readdir(path.join(root,'scripts'))).filter(n=>n.endsWith('.mjs')).map(n=>'scripts/'+n),...(await fs.readdir(path.join(root,'test'))).filter(n=>n.endsWith('.mjs')).map(n=>'test/'+n)];
for(const file of files){const r=spawnSync(process.execPath,['--check',path.join(root,file)],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
console.log(`语法检查通过：${files.length}个文件`);
