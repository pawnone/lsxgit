// Static demo build only. Does not produce an Electron installer.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const out=path.join(root,'dist');
await fs.rm(out,{recursive:true,force:true});await fs.cp(path.join(root,'demo'),out,{recursive:true});
console.log('静态Demo构建完成：dist/；包含index.html与desktop.html，不是APP安装包。');
