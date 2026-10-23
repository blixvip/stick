import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import {DrawingStroke} from '../src/drawing-pixels.mjs';
import {TileStore} from '../src/drawing-tiles.mjs';
import {DrawingSmoother} from '../src/drawing-smoother.mjs';
import {ReferenceSmoother} from '../tests/helpers/drawing-reference-smoother.mjs';
const results=[];
for(const zoom of [1,8,32]){
  for(const [algorithm,Type] of [['original',ReferenceSmoother],['incremental',DrawingSmoother]]){
    const runs=[];
    for(let run=0;run<4;run++){
      const stroke=new DrawingStroke(new TileStore(),{size:8,stabilization:.95});
      stroke.smoother=new Type(.95*48);
      const start=performance.now();
      for(let i=0;i<4000;i++)stroke.sample({x:i*.2/zoom,y:20+Math.sin(i/400)*2/zoom,pressure:.8,time:i*4});
      const sampled=performance.now();stroke.finish();
      if(run)runs.push({sampleMs:sampled-start,releaseMs:performance.now()-sampled});
    }
    results.push({zoom,algorithm,runs});
  }
}
await mkdir('artifacts/drawing-zoom',{recursive:true});
const result={node:process.version,cpu:os.cpus()[0].model,note:'4000 identical source samples; same smoothing distance and brush for both algorithms. Three runs after warm-up. Kernel time, not input-to-photon latency.',results};
await writeFile('artifacts/drawing-zoom/smoothing.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
