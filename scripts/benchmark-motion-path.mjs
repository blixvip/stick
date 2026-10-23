import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {chromium} from '../tests/support/playwright.mjs';
await mkdir('artifacts/motion-path-ux',{recursive:true});
await mkdir('tmp',{recursive:true});
const before=execFileSync('git',['show','HEAD:src/motion-path.mjs'],{encoding:'utf8'}).replaceAll("from './","from '../src/");
await writeFile('tmp/motion-path-before.mjs',before);
const baseline=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
const page=await browser.newPage();await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
await page.waitForFunction(()=>window.styk?.ready);
const result=await page.evaluate(async()=>{
 const old=await import('/tmp/motion-path-before.mjs'),now=await import('/src/motion-path.mjs');
 const {worldToScreen}=await import('/src/renderer-geometry.mjs');
 const median=list=>{const s=[...list].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
 const p90=list=>{const s=[...list].sort((a,b)=>a-b);return s[Math.floor(s.length*.9)];};
 const rows=[];

 // 1. Draw submission: 1600 synthetic samples per trail, 400 keys, labels on.
 const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=1000;
 const ctx=canvas.getContext('2d'),points=Array.from({length:1600},(_,tick)=>({tick,x:60+(tick%400)*3,y:150+Math.floor(tick/400)*160+Math.sin(tick*.03)*60,key:tick%4===0}));
 for (const paths of [1,24]) for (const [name,module] of [['before',old],['after',now]]) {
   const limit=Math.min(1600,Math.floor(6400/paths));
   const selected=Array.from({length:limit},(_,i)=>points[Math.round(i*(points.length-1)/(limit-1))]);
   // Fresh entries per run so the after-module projection cache cannot hide work.
   const samples=[];
   for(let run=0;run<14;run++){
     const inputs=Array.from({length:paths},()=>({ticks:selected.map(p=>p.tick),points:new Map(selected.map(p=>[p.tick,p])),version:0}));
     ctx.getImageData(0,0,1,1);ctx.clearRect(0,0,1440,1000);const start=performance.now();
     for(let i=0;i<paths;i++)module.drawMotionPath(ctx,inputs[i],p=>({x:p.x,y:p.y+i*.3}),{tick:800,labels:true});
     const time=performance.now()-start;if(run>=4)samples.push(time);}
   rows.push({measure:'draw (cold projection)',name,paths,samplesPerPath:limit,medianMs:median(samples),p90Ms:p90(samples)});
 }

 // 2. Real evaluator: complete trails for 24 figures x 240 frames ("All figures").
 const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
 const {Editor}=await import('/src/editor.mjs');
 const makeEditor=()=>{
   const r=emptyDocument(),f=r.figure_types[0];
   r.keyframes=Array.from({length:30},(_,k)=>createFrame(Array.from({length:24},(_,i)=>{
     const o=createObject(f,i+1,40+i*38+k*6,120+(i%4)*110+Math.sin(k*.7+i)*30);
     o.angles=o.angles.map((a,j)=>j?a+Math.sin(k*.9+j+i)*.5:a);return o;}),8));
   const e=new Editor({demo:false}).load(r);e.seek(100);return e;
 };
 for (const [label,joints] of [['24 figure origins','selected'],['24 figures, limb tips (48 trails)','tips']]) for (const [name,module] of [['before',old],['after',now]]) {
   if (name==='before'&&joints==='tips') {
     // The baseline has no tip targets: sample the same targets through its per-target cache.
   }
   const samples=[];
   for(let run=0;run<5;run++){
     const editor=makeEditor();
     const targets=now.motionPathTargets(editor,{all:true,joints});
     const maxPoints=Math.min(1600,Math.floor(6400/targets.length));
     const cache=new module.MotionPathCache({budgetMs:Infinity});
     const start=performance.now();
     if(cache.sample)cache.sample(editor,targets,{maxPoints});
     else for(const t of targets)cache.get(editor,t,{maxPoints});
     samples.push(performance.now()-start);
   }
   rows.push({measure:`sample to completion: ${label}`,name,medianMs:median(samples),p90Ms:p90(samples)});
 }

 // 3. Hover: hit-test 24 trails x 266 samples through the app's camera projection.
 {
   const editor=makeEditor(),targets=now.motionPathTargets(editor,{all:true});
   const cache=new now.MotionPathCache({budgetMs:Infinity}),entries=cache.sample(editor,targets,{maxPoints:266});
   const options={report:editor.report,frame:editor.evaluatedFrame,view:{x:12,y:30,scale:.9},cameraEnabled:false};
   const project=p=>worldToScreen(p,options);
   for (const [name,module] of [['before',old],['after',now]]) {
     const samples=[];
     for(let run=0;run<40;run++){
       const start=performance.now();
       for(let move=0;move<10;move++){
         const screen={x:200+move*13,y:300};
         const proj=module.affineProjection?module.affineProjection(project):project;
         for(const entry of entries)module.pickMotionPathPoint(entry,screen,{project:proj,radius:10,tick:100});
       }
       samples.push((performance.now()-start)/10);
     }
     rows.push({measure:'hover hit test per pointer move (24 trails)',name,medianMs:median(samples),p90Ms:p90(samples)});
   }
 }
 return {description:'Draw: synthetic canvas submission with fresh entries (4 warmups + 10 runs, raster queue drained). Sample: real evaluator, 24 native figures over 240 frames, the app point allowance, one uninterrupted budget (5 runs). Hover: per pointer move over 24 sampled trails with worldToScreen projection (40 runs x 10 moves). Excludes GPU presentation.',rows};
});
await writeFile('artifacts/motion-path-ux/benchmark.json',JSON.stringify({...result,baseline},null,2));console.log(JSON.stringify({...result,baseline},null,2));
} finally {await browser.close();}
