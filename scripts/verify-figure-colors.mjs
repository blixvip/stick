/** Local regression evidence for the supplied hands pack; runs outside the UI. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import backend from '../desktop/backend.cjs';
import {Editor} from '../src/editor.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {synchronizeExistingDerived} from '../src/document-normalize.mjs';
import {buildGeometry,evaluatedFrame,timeline} from '../src/pivot/geometry.mjs';

const directory='artifacts/figure-palette';await mkdir(directory,{recursive:true});
const source=JSON.parse(await readFile(process.argv[2]??`${directory}/hands-source.json`,'utf8'));
const e=new Editor({demo:false,propertyChannels:true,layerTimeline:true}).load(source);
const uid=e.evaluatedFrame.objects[0].unique_id;e.select(uid);
const timings={},measure=(key,fn)=>{const start=performance.now(),value=fn();timings[key]=performance.now()-start;return value;};
const initial=e.figurePalette(),count=e.figure.segments.length;
measure('figureColorMs',()=>e.setFigureColor('#44aacc'));
e.select(uid,0);measure('segmentColorMs',()=>e.updateBuilderSegmentStyle({color:'#eecc11'}));
measure('paletteReplaceMs',()=>e.replaceFigureColor('#44aacc','#778899'));
assert.deepEqual(e.figurePalette().map(p=>[p.color,p.segments.length]),[['#778899',count-1],['#eecc11',1]]);
const historyBytes=e._undo.reduce((sum,command)=>sum+Buffer.byteLength(JSON.stringify(command)),0);
const saved=measure('serializeMs',()=>e.serialize());await writeFile(`${directory}/hands-edited.json`,JSON.stringify(saved));
const materialized=measure('materializeMs',()=>materializePivotDocument(saved));synchronizeExistingDerived(materialized);
await writeFile(`${directory}/hands-pivot.json`,JSON.stringify(materialized));
const script=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,'backend')
import server
out=Path('artifacts/figure-palette')
for format_name,stem in [('styk','hands-edited'),('piv','hands-pivot')]:
 store=server.ProjectStore(server.WORKSPACE)
 document=json.loads((out/(stem+'.json')).read_text(encoding='utf8'))
 data,name=store.export({'document':document,'format':format_name,'filename':stem+'.'+format_name})
 (out/(stem+'.'+format_name)).write_bytes(data)
 reopened=store.import_bytes(data,name)['document']
 (out/(stem+'-reopened.json')).write_text(json.dumps(reopened),encoding='utf8')
 print(format_name,len(data),'bytes',len(reopened['keyframes']),'keys')
`;
const python=backend.pythonCandidates()[0],conversion=spawnSync(python.command,[...python.args,'-c',script],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
assert.equal(conversion.status,0,conversion.error?.message||conversion.stderr);console.log(conversion.stdout.trim());
const reopened=JSON.parse(await readFile(`${directory}/hands-edited-reopened.json`,'utf8'));
const native=JSON.parse(await readFile(`${directory}/hands-pivot-reopened.json`,'utf8'));
const digest=(report,frame)=>{
  const geometry=buildGeometry(report,frame);
  return [...geometry.objects.values()].map(g=>({uid:g.obj.unique_id,segments:g.segments.map(s=>({rgb:s.rgb,alpha:s.alpha,start:s.start,end:s.end})),polys:g.polys.map(p=>({rgb:p.rgb,alpha:p.alpha}))})).sort((a,b)=>a.uid-b.uid);
};
const sample=(report,tick)=>{const rows=timeline(report);let index=0;while(index+1<rows.length&&rows[index+1].start<=tick)index++;return evaluatedFrame(report,index,rows[index].count?(tick-rows[index].start)/rows[index].count:0,tick);};
const ticks=[0,1,10,Math.max(0,e.totalTicks-1)];
for(const tick of new Set(ticks)){
  const expected=digest(e.report,sample(e.report,tick));
  assert.deepEqual(digest(reopened,sample(reopened,tick)),expected,`STYK round trip at ${tick}`);
  const actual=digest(native,sample(native,tick));
  assert.equal(actual.length,expected.length,`PIV object count at ${tick}`);
  for(let i=0;i<actual.length;i++)assert.ok(JSON.stringify([actual[i].uid,actual[i].segments.map(s=>[s.rgb,s.alpha]),actual[i].polys])===JSON.stringify([expected[i].uid,expected[i].segments.map(s=>[s.rgb,s.alpha]),expected[i].polys]),`PIV colors at ${tick}, figure ${expected[i].uid}`);
  for(let i=0;i<actual.length;i++)for(let j=0;j<actual[i].segments.length;j++)for(const point of ['start','end'])for(const axis of ['x','y'])assert.ok(Math.abs(actual[i].segments[j][point][axis]-expected[i].segments[j][point][axis])<.002,`PIV geometry at ${tick}`);
}
const evidence={source:{version:source.version,frames:source.keyframes.length,figureTypes:source.figure_types.length,firstFrameObjects:source.keyframes[0].objects.length},uid,segments:count,initial:initial.map(p=>[p.color,p.segments.length]),final:e.figurePalette().map(p=>[p.color,p.segments.length]),historyBytes,timings,verifiedTicks: ticks};
await writeFile(`${directory}/roundtrip-report.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
