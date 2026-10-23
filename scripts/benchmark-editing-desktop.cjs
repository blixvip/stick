'use strict';
// Invoked by the existing isolated Electron runner. No DevTools attachment.
const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function installProbe(){
  const editor=styk.editor,renderer=styk.state.renderer,timeline=styk.timeline;
  if(!renderer.device||!timeline.scroll)throw new Error('Editing probe requires WebGPU and the Advanced timeline.');
  const p=window.__editingProbe={phase:'setup',inputs:[],frames:[],seeks:[],calls:[],geometry:[],tasks:[],errors:[],restore:[],sequence:0};
  const wrap=(owner,key,name)=>{
    const original=owner[key];
    owner[key]=function(...args){const at=performance.now(),phase=p.phase;try{return original.apply(this,args);}finally{p.calls.push({name,phase,at,ms:performance.now()-at});}};
    p.restore.push(()=>owner[key]=original);
  };
  for(const name of ['_extent','_offsetX','_offsetY','_paint','_syncPlayhead'])wrap(timeline,name,`timeline.${name}`);
  const prepare=editor.prepareGeometry;
  editor.prepareGeometry=function(options={}){
    const phase=p.phase,at=performance.now();
    return prepare.call(this,{...options,onTiming:value=>{p.geometry.push({phase,at,...value});options.onTiming?.(value);}});
  };
  p.restore.push(()=>editor.prepareGeometry=prepare);
  const input=event=>{
    if(!event.buttons)return;
    p.lastInput={at:performance.now(),phase:p.phase,kind:styk.state.drag?.kind,sequence:++p.sequence};p.inputs.push(p.lastInput);
  };
  document.addEventListener('pointermove',input,true);p.restore.push(()=>document.removeEventListener('pointermove',input,true));
  const render=renderer.render;
  renderer.render=function(...args){
    const at=performance.now(),result=render.apply(this,args),submitted=performance.now();
    if(!styk.state.editablePreparing&&!styk.state.playing){
      const frame={phase:p.phase,tick:editor.tick,revision:editor.revision,at:submitted,cpuMs:submitted-at,input:p.lastInput,
        kind:styk.state.drag?.kind,geometryObjects:args[0].geometry?.objects.size};
      p.frames.push(frame);renderer.device.queue.onSubmittedWorkDone().then(()=>frame.completed=performance.now());
    }
    return result;
  };
  p.restore.push(()=>renderer.render=render);
  const error=event=>p.errors.push(event.message);window.addEventListener('error',error);p.restore.push(()=>window.removeEventListener('error',error));
  p.observer=new PerformanceObserver(list=>p.tasks.push(...list.getEntries().map(entry=>({at:entry.startTime,ms:entry.duration,phase:p.phase}))));
  p.observer.observe({type:'longtask'});
  p.pose=()=>JSON.stringify([...editor.geometry.objects.values()].map(g=>({uid:g.obj.unique_id,root:g.root,
    joints:[...g.joints].sort((a,b)=>a[0]-b[0])})).sort((a,b)=>a.uid-b.uid));
  p.wait=async predicate=>{
    const deadline=performance.now()+120000;
    while(!predicate()){
      if(performance.now()>deadline)throw new Error(`Editing probe timed out in ${p.phase}`);
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
  };
  p.settle=()=>p.wait(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender);
}

module.exports=async function editingProbe(window){
  const execute=code=>window.webContents.executeJavaScript(code);
  // Electron's native input API requires a focused target. This disposable test
  // window is the only surface receiving input; source files remain read-only.
  window.setFocusable(true);window.setIgnoreMouseEvents(false);window.focus();window.webContents.focus();
  const mouse=(type,point,button='left',down=false)=>window.webContents.sendInputEvent({type,x:Math.round(point.x),y:Math.round(point.y),
    button,clickCount:type==='mouseMove'?0:1,modifiers:down?[`${button}ButtonDown`]:[]});
  await execute("styk.settingsUI.commit({timelineMode:'advanced'}); for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();");
  await execute(`(${installProbe.toString()})()`);
  try {
    await execute('__editingProbe.settle()');
    const before=await execute('({revision:styk.editor.revision,history:styk.editor.historySize,ticks:styk.editor.totalTicks})');
    const seeks=await execute(`(async()=>{
      const p=__editingProbe,e=styk.editor;
      const ticks=[1,.96,.92,.93,.99,.55,.7,.91,1].map(n=>Math.round((e.totalTicks-1)*n));
      for(const phase of ['first-seek','repeat-seek'])for(const tick of ticks){
        p.phase=phase;p.lastInput=null;
        const index=p.frames.length,at=performance.now();e.seek(tick);
        const row={phase,tick,at,commandMs:performance.now()-at};p.seeks.push(row);
        await p.wait(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender&&
          styk.state.lastEditingPresentation?.tick===tick&&styk.state.lastEditingPresentation.at>=at&&
          p.frames.slice(index).some(frame=>frame.tick===tick&&frame.completed));
        const frame=p.frames.slice(index).find(frame=>frame.tick===tick&&frame.completed);
        row.submitMs=frame.at-at;row.completeMs=frame.completed-at;
        row.geometry=p.geometry.filter(sample=>sample.at>=at);
      }
      return {revision:e.revision,history:e.historySize};
    })()`);
    assert.deepEqual(seeks,{revision:before.revision,history:before.history},'Seeks must not create edits or history');
    const gestures=[];
    for(const kind of ['pan','pose']){
      const target=await execute(`(async()=>{
        const p=__editingProbe,e=styk.editor,s=styk.state;p.phase='setup';p.lastInput=null;
        const rect=document.querySelector('#overlay').getBoundingClientRect();
        if('${kind}'==='pan')return {x:rect.x+rect.width*.4,y:rect.y+rect.height*.4};
        const editable=[...e.geometry.objects.values()].find(g=>g.segments.some(segment=>!segment.static&&segment.length>3));
        if(!editable)throw new Error('The fixture requires a poseable joint.');
        e.select(editable.obj.unique_id,0);
        const g=e.geometry.objects.get(e.selectedSlot),point=g.segments.find(segment=>!segment.static&&segment.length>3).end;
        const {worldToScreen}=await import('/src/renderer.mjs');
        const screen=worldToScreen(point,{report:e.report,frame:e.evaluatedFrame,view:s.view,cameraEnabled:false});
        s.view.x+=rect.width/2-screen.x;s.view.y+=rect.height/2-screen.y;window.dispatchEvent(new Event('resize'));
        return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      })()`);
      await execute('__editingProbe.settle()');
      const original=await execute('__editingProbe.pose()'),button=kind==='pan'?'middle':'left';
      await execute(`__editingProbe.phase='${kind}';__editingProbe.lastInput=null;`);
      mouse('mouseMove',target,button);mouse('mouseDown',target,button,true);
      const actual=await execute('new Promise(resolve=>requestAnimationFrame(()=>resolve(styk.state.drag?.kind)))');assert.equal(actual,kind);
      for(let step=1;step<=60;step++){
        mouse('mouseMove',{x:target.x+step*.8,y:target.y+step*.4},button,true);await delay(8);
      }
      mouse('mouseUp',{x:target.x+48,y:target.y+24},button);
      await execute('__editingProbe.settle()');
      const final=await execute('__editingProbe.pose()');
      if(kind==='pan')assert.equal(final,original,'Panning must not modify poses');
      else{
        assert.notEqual(final,original,'The pose gesture must change the scene');
        await execute("__editingProbe.phase='undo';__editingProbe.lastInput=null;styk.editor.undo();");await execute('__editingProbe.settle()');
        assert.equal(await execute('__editingProbe.pose()'),original,'Undo must restore every root and joint');
        await execute("__editingProbe.phase='redo';styk.editor.redo();");await execute('__editingProbe.settle()');
        assert.equal(await execute('__editingProbe.pose()'),final,'Redo must restore every root and joint');
      }
      gestures.push({kind,verified:true});
    }
    const ruler=await execute(`(()=>{const p=__editingProbe,t=styk.timeline,r=t.scroll.getBoundingClientRect();p.phase='scrub';p.lastInput=null;
      return {x:r.x+24,y:r.y+14,width:r.width,revision:styk.editor.revision,history:styk.editor.historySize};})()`);
    mouse('mouseMove',ruler);mouse('mouseDown',ruler,'left',true);
    for(let step=1;step<=60;step++){
      mouse('mouseMove',{x:ruler.x+Math.min(ruler.width-48,step*7),y:ruler.y},'left',true);await delay(8);
    }
    const release=await execute('({target:styk.timeline.pendingScrub??styk.editor.tick,active:styk.state.scrubbing,at:performance.now()})');
    assert.ok(release.active,'Ruler gesture must actually scrub');
    mouse('mouseUp',{x:ruler.x+Math.min(ruler.width-48,420),y:ruler.y});
    await execute('__editingProbe.settle()');
    const scrub=await execute('({tick:styk.editor.tick,revision:styk.editor.revision,history:styk.editor.historySize})');
    assert.deepEqual(scrub,{tick:release.target,revision:ruler.revision,history:ruler.history},'Release must publish the exact target without edits');
    const result=await execute(`(async()=>{
      const p=__editingProbe;await styk.state.renderer.device.queue.onSubmittedWorkDone();
      p.tasks.push(...p.observer.takeRecords().map(entry=>({at:entry.startTime,ms:entry.duration,phase:p.phase})));p.observer.disconnect();
      return {inputs:p.inputs,frames:p.frames,seeks:p.seeks,calls:p.calls,geometry:p.geometry,tasks:p.tasks,errors:p.errors,performance:styk.performance()};
    })()`);
    assert.deepEqual(result.errors,[]);
    return {gestures,scrub,release,...result,limitations:['Synthetic native Electron input at 8 ms intervals; not physical input/display latency.',
      'No debugger or CPU throttling. GPU completion callbacks describe queue completion, not scanout.',
      'Method timings include layout or native work reached from that method; do not add nested method durations together.',
      'First/repeat sweeps share the imported scene and live bounded caches; first is not an empty-cache guarantee.']};
  }finally{
    await execute('if(window.__editingProbe){__editingProbe.observer.disconnect();for(const restore of __editingProbe.restore)restore();delete window.__editingProbe;}');
    window.setIgnoreMouseEvents(true);window.setFocusable(false);
  }
};
