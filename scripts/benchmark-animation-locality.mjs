/** Compare immutable editor snapshots in alternating fresh Node processes.
 * Usage: node --expose-gc scripts/benchmark-animation-locality.mjs [source-root] [output.json] */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root=path.resolve(process.argv[2]??'.'),output=process.argv[3]??'artifacts/animation-locality/current.json';
const {createPerformanceEditor,summary}=await import(pathToFileURL(path.join(root,'tests/animation-mode-performance-fixture.mjs')));
const files=['src/editor.mjs','src/editor-animation.mjs','src/frame-clipboard-authored.mjs','src/animation-history.mjs','tests/animation-mode-performance-fixture.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async name=>[name,createHash('sha256').update(await readFile(path.join(root,name))).digest('hex')])));
const sourceHashes=await hashes(),results=[];
for(const config of [{name:'small',frames:100,figures:10,channels:10,keys:100},
  {name:'long',frames:10000,figures:10,channels:10,keys:1000},
  {name:'many-keys',frames:1000,figures:20,channels:20,keys:10000}]) {
  const editor=createPerformanceEditor(config),samples={},measure=(name,fn)=>{const start=performance.now();fn();(samples[name]??=[]).push(performance.now()-start);};
  globalThis.gc?.();const heapBefore=process.memoryUsage().heapUsed;
  const target={kind:'figure',uid:1};let value;
  for(let gesture=0;gesture<12;gesture++) {
    editor.beginAnimationEdit(target,'x');measure('firstPreview',()=>editor.previewAnimationEdit(600+gesture));
    for(let step=0;step<64;step++){value=700+gesture*100+step;measure('repeatedPreview',()=>editor.previewAnimationEdit(value));}
    measure('commit',()=>editor.commitAnimationEdit());measure('undo',()=>editor.undo());measure('redo',()=>editor.redo());
    assert.equal(editor.evaluatedFrame.objects[0].root_x,value);
  }
  editor.enableFrameDrafts({mode:'add'});
  for(let i=0;i<5;i++) {measure('addFrame',()=>editor.addDraftFrame());measure('undoAdd',()=>editor.undo());}
  globalThis.gc?.();const heapAfter=process.memoryUsage().heapUsed;
  results.push({config,timingsMs:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,summary(values)])),
    retainedHeapGrowthBytes:heapAfter-heapBefore,historyBytes:editor.historySize,
    documentSHA256:createHash('sha256').update(JSON.stringify(editor.serialize())).digest('hex')});
  console.log(config.name,JSON.stringify(results.at(-1).timingsMs));
}
assert.deepEqual(await hashes(),sourceHashes,'Sources changed while measuring.');
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),node:process.version,cpu:os.cpus()[0].model,sourceHashes,results},null,2));
