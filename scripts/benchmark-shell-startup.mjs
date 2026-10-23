import electron from 'electron';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performanceSourceHashes} from './performance-source-hashes.mjs';
import {POLICY_VERSION} from '../src/telemetry-schema.mjs';

const label=process.argv[2],modes=(process.argv[3]||'delayed,failed,close').split(',');
assert.match(label||'',/^[a-zA-Z0-9_-]+$/);assert.ok(modes.every(mode=>['normal','delayed','failed','close'].includes(mode)));
const output=path.resolve('artifacts/shell-startup',label),control=process.env.STYK_SHELL_CONTROL==='1';
await mkdir(output,{recursive:true});
const report={at:new Date().toISOString(),control,sourceHashes:await performanceSourceHashes(),rows:[],
  limitations:['Source Electron on this host, no debugger. Fresh profiles, uncontrolled OS caches and other workstation work.',
    'The 6-second delay is a test gate before the ordinary codec launcher, not a measured typical Python startup cost.',
    'Early-close mode uses a 60-second startup gate; process-lifetime unit tests separately abort a real Python child.']};
for(const mode of modes){
  const directory=path.join(output,mode);await mkdir(directory,{recursive:true});
  const profile=path.join(directory,'profile');await mkdir(profile,{recursive:true});
  await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:POLICY_VERSION,updatedAt:Date.now()}}),{flag:'wx'});
  const env={STYK_STARTUP_VIEW:'editor',...process.env,STYK_SHELL_OUTPUT:directory,STYK_SHELL_MODE:mode,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(directory,'library')};
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(electron,['scripts/benchmark-shell-startup.cjs'],{cwd:process.cwd(),env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let log='',forced;child.stdin.on('error',()=>{});
    for(const stream of [child.stdout,child.stderr])stream.on('data',data=>log=(log+data).slice(-20000));
    const timeout=setTimeout(()=>{child.stdin.write('abort');forced=setTimeout(()=>child.kill(),5000);},90000);
    child.on('error',error=>{clearTimeout(timeout);clearTimeout(forced);reject(error);});
    child.on('exit',code=>{clearTimeout(timeout);clearTimeout(forced);child.stdin.destroy();
      writeFile(path.join(directory,'process.log'),log).then(()=>code===0?resolve():reject(new Error(`Startup test exited ${code}: ${log.slice(-2000)}`)),reject);});
  });
  const row=JSON.parse(await readFile(path.join(directory,'report.json'),'utf8'));report.rows.push(row);
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  if(mode!=='normal'){assert.equal(row.readyBeforeCodec,!control);assert.equal(row.operationsBeforeCodec,!control);}
  if(mode==='close')assert.equal(row.codecAborted,true);
  console.log(JSON.stringify({mode,readyMs:row.readyMs,operationsMs:row.operationsMs,codecReadyMs:row.codecReadyMs,codecAborted:row.codecAborted}));
}
const final=await performanceSourceHashes();report.changedSourcePaths=[...new Set([...Object.keys(final),...Object.keys(report.sourceHashes)])].filter(key=>final[key]!==report.sourceHashes[key]);
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
assert.deepEqual(report.changedSourcePaths,[]);
