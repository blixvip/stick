import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.'),output=path.join(root,'artifacts/rig-preparation');
await mkdir(output,{recursive:true});
const env={...process.env,STYK_USER_DATA_DIR:path.join(output,`profile-${Date.now()}`)};
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(env.STYK_USER_DATA_DIR,{recursive:true});
await writeFile(path.join(env.STYK_USER_DATA_DIR,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
const app=await electron.launch({args:[root],cwd:root,timeout:60000,env});
try {
  const page=await app.firstWindow(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];
    report.canvas_width=800;report.canvas_height=500;
    report.keyframes=Array.from({length:3},(_,frame)=>createFrame(Array.from({length:180},(_,i)=>
      createObject(figure,i+1,35+i%18*42,45+Math.floor(i/18)*42+frame*2,{scale:.12})),1));
    styk.editor.markSaved();await styk.acceptImport({document:report,kind:'piv'},'Rig preparation fixture.piv');
    styk.state.handles=false;styk.state.onion=false;styk.state.settings.autosaveSeconds=0;
    styk.editor.select(1,0);styk.fit();
    const renderer=styk.state.renderer,original=renderer.prepareSceneUpdate.bind(renderer);
    if(renderer.stats.backend!=='WebGPU')throw new Error('WebGPU required for rig preparation verification');
    window.rigTest={jobs:[],before:JSON.stringify(styk.editor.serialize()),original,renderer};
    renderer.prepareSceneUpdate=async request=>{
      const job={request,released:false,activated:false,disposed:false};rigTest.jobs.push(job);
      const prepared=await original(request);job.ready=true;
      await new Promise(resolve=>job.release=()=>{job.released=true;resolve();});
      return {...prepared,activate(){job.activated=true;prepared.activate();},dispose(){job.disposed=true;prepared.dispose();}};
    };
  });
  await page.waitForTimeout(100);
  await page.evaluate(()=>{
    const e=styk.editor,end=e.geometry.objects.get(e.selectedSlot).segments[0].end;
    e.beginRigDrag();e.editRigJoint(end.x+3,end.y+2);
  });
  await page.waitForTimeout(80);
  const preview=await page.locator('#scene').screenshot();
  await page.evaluate(()=>{styk.editor.commitRigDrag();rigTest.after=JSON.stringify(styk.editor.serialize());rigTest.revision=styk.editor.revision;rigTest.history=styk.editor._undo.length;});
  await page.waitForFunction(()=>rigTest.jobs[0]?.ready&&styk.state.editablePreparing);
  assert.deepEqual(await page.locator('#scene').screenshot(),preview,'Last gesture pixels remain visible during preparation');
  const pending=await page.evaluate(()=>({pending:styk.state.editablePreparing,activated:rigTest.jobs[0].activated,documentCommitted:rigTest.after!==rigTest.before}));
  assert.deepEqual(pending,{pending:true,activated:false,documentCommitted:true});
  await page.evaluate(()=>rigTest.jobs[0].release());
  await page.waitForFunction(()=>!styk.state.editablePreparing&&rigTest.jobs[0].activated);
  await page.waitForTimeout(80);
  const parity=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
    const r=rigTest.renderer,e=styk.editor,options={...r.last,geometry:e.geometry,canvasHandles:[]};
    r.render(options);const actual=r.canvas.toDataURL();
    const canvas=document.createElement('canvas'),fresh=await createRenderer(canvas,{resources:r.resources});
    fresh.resize(r.width,r.height,r.dpr);
    fresh.render({...options,geometry:buildGeometry(e.report,e.evaluatedFrame)});
    const reference=canvas.toDataURL();fresh.destroy();
    return {pixelsMatch:actual===reference,historyUnchanged:e._undo.length===rigTest.history&&e.revision===rigTest.revision,
      exactGeometry:JSON.stringify(e.geometry.drawables)===JSON.stringify(buildGeometry(e.report,e.evaluatedFrame).drawables),actual,reference};
  });
  assert.ok(parity.pixelsMatch,'Prepared final pixels match fresh geometry and GPU compilation');
  assert.ok(parity.exactGeometry&&parity.historyUnchanged,'Preparation preserves exact geometry and adds no command');
  // Undo stages the previous rig. Redo while it is pending must dispose that
  // obsolete layout and activate only the current document's scene.
  await page.evaluate(()=>styk.editor.undo());
  await page.waitForFunction(()=>rigTest.jobs[1]?.ready);
  assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())===rigTest.before),true);
  await page.evaluate(()=>{styk.editor.redo();rigTest.jobs[1].release();});
  await page.waitForFunction(()=>rigTest.jobs[2]?.ready&&rigTest.jobs[1].disposed);
  assert.equal(await page.evaluate(()=>rigTest.jobs[1].activated),false);
  await page.evaluate(()=>rigTest.jobs[2].release());
  await page.waitForFunction(()=>!styk.state.editablePreparing&&rigTest.jobs[2].activated);
  assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())===rigTest.after),true);
  // A document replacement owns the next scene even if an old stage finishes.
  await page.evaluate(()=>styk.editor.undo());await page.waitForFunction(()=>rigTest.jobs[3]?.ready);
  await page.evaluate(()=>{styk.editor.markSaved();styk.editor.newDocument();rigTest.jobs[3].release();});
  await page.waitForFunction(()=>!styk.state.editablePreparing&&rigTest.jobs[3].disposed);
  assert.equal(await page.evaluate(()=>rigTest.jobs[3].activated),false);
  assert.equal(await page.evaluate(()=>styk.editor._undo.length),0);
  await page.evaluate(()=>{rigTest.renderer.prepareSceneUpdate=rigTest.original;});
  assert.deepEqual(errors,[]);
  for(const key of ['actual','reference']){await writeFile(path.join(output,`${key}.png`),Buffer.from(parity[key].split(',')[1],'base64'));delete parity[key];}
  await writeFile(path.join(output,'held-preview.png'),preview);
  const report={pending,...parity,cancelledUndo:true,cancelledDocumentReplacement:true,errors};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(report);
}catch(error){console.error(error);throw error;}
finally{
  for(const page of app.windows())await page.evaluate(()=>window.styk?.editor.markSaved()).catch(()=>{});
  await app.close();
}
