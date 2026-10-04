import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../src-tauri/resources/',import.meta.url));
if(Number(process.versions.node.split('.')[0])<22) throw new Error('Bridge requires Node 22 or newer');
const npm=process.platform==='win32'?'npm.cmd':'npm';
const result=spawnSync(npm,['ci','--omit=dev','--ignore-scripts','--prefix',path.join(root,'bridge')],{stdio:'inherit',shell:process.platform==='win32'});
if(result.status!==0) throw new Error('Unable to prepare pinned Bridge dependencies');
const files={};
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()) walk(file);else if(entry.name!=='manifest.json') files[path.relative(root,file)]=createHash('sha256').update(readFileSync(file)).digest('hex');}}
walk(path.join(root,'bridge'));
if (!files[path.join('bridge','node_modules','ws','package.json')] || !files[path.join('bridge','server.mjs')]) throw new Error('Bridge resources are incomplete');
writeFileSync(path.join(root,'manifest.json'),JSON.stringify({externalRuntime:true,minimumNodeMajor:22,files},null,2)+'\n');
