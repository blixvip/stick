'use strict';
// Diagnostic only: GPU pass timestamps are read after both real seek sweeps.
const assert=require('node:assert/strict');

function install(timestamps){
  const editor=styk.editor,renderer=styk.state.renderer,device=renderer.device;
  const p=window.__seekGpuProbe={timestamps,rows:[],errors:[],restore:[],current:null,queries:new Set()};
  p.check=(ok,message)=>{if(!ok)throw new Error(message);};
  p.check(device&&(!timestamps||device.features.has('timestamp-query')),'GPU timestamps unavailable');
  const wrap=(owner,key,factory)=>{const original=owner[key];owner[key]=factory(original);p.restore.push(()=>owner[key]=original);};
  const error=event=>p.errors.push(event.error?.message||event.message||String(event.reason));
  for(const name of ['error','unhandledrejection']){window.addEventListener(name,error);p.restore.push(()=>window.removeEventListener(name,error));}
  device.addEventListener('uncapturederror',error);p.restore.push(()=>device.removeEventListener('uncapturederror',error));
  const extent=size=>Array.isArray(size)?{width:size[0],height:size[1]??1,depth:size[2]??1}:{width:size.width,height:size.height??1,depth:size.depthOrArrayLayers??1};
  wrap(device,'createTexture',original=>function(descriptor){
    const texture=original.call(this,descriptor);
    p.current?.textures.push({label:descriptor.label||'',format:descriptor.format,samples:descriptor.sampleCount||1,...extent(descriptor.size)});return texture;
  });
  wrap(device.queue,'writeBuffer',original=>function(buffer,offset,data,dataOffset=0,size){
    if(p.current){const unit=data.BYTES_PER_ELEMENT||1;p.current.writeBufferCalls++;p.current.writeBufferBytes+=size===undefined?data.byteLength-dataOffset*unit:size*unit;}
    return original.apply(this,arguments);
  });
  wrap(device.queue,'copyExternalImageToTexture',original=>function(source,destination,size){
    p.current?.imageCopies.push(extent(size));return original.apply(this,arguments);
  });
  wrap(device,'createCommandEncoder',original=>function(descriptor){
    const encoder=original.call(this,descriptor),begin=encoder.beginRenderPass;
    encoder.beginRenderPass=function(passDescriptor){
      const row=p.current;
      if(!row)return begin.call(this,passDescriptor);
      const index=row.passes.length*2;
      p.check(index<1024,'Seek exceeded the bounded GPU query capacity');
      row.passes.push({encoder:descriptor?.label||'',pass:passDescriptor.label||'',index,encodedMs:performance.now()-row.at});
      if(!timestamps)return begin.call(this,passDescriptor);
      p.check(!passDescriptor.timestampWrites,'Another timestamp owner is enabled');
      return begin.call(this,{...passDescriptor,timestampWrites:{querySet:row.querySet,beginningOfPassWriteIndex:index,endOfPassWriteIndex:index+1}});
    };
    return encoder;
  });
  wrap(renderer,'render',original=>function(...args){
    const at=performance.now(),result=original.apply(this,args),row=p.current;
    if(row&&!styk.state.editablePreparing&&editor.tick===row.tick){
      const frame={cpuMs:performance.now()-at,submitMs:performance.now()-row.at,generation:renderer.generation,
        rasterizedObjects:renderer.stats.rasterizedObjects,preparation:renderer.stats.preparation,uploadBytes:renderer.stats.uploadBytes};
      row.frames.push(frame);
      if(!row.frame){row.frame=frame;device.queue.onSubmittedWorkDone().then(()=>{frame.completeMs=performance.now()-row.at;});}
    }
    return result;
  });
  p.wait=async predicate=>{const end=performance.now()+120000;while(!predicate()){
    p.check(performance.now()<end,'Seek attribution timed out');await new Promise(resolve=>requestAnimationFrame(resolve));
  }};
  p.observer=new PerformanceObserver(list=>{if(p.current)p.current.longTasks.push(...list.getEntries().map(v=>({at:v.startTime,ms:v.duration})));});
  p.observer.observe({type:'longtask'});p.restore.push(()=>p.observer.disconnect());
  p.run=async()=>{
    await p.wait(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender);
    const report=editor.report,revision=editor.revision,history=editor.historySize;
    const ticks=[1,.96,.92,.93,.99,.55,.7,.91,1].map(n=>Math.round((editor.totalTicks-1)*n));
    for(const phase of ['first-seek','repeat-seek'])for(const tick of ticks){
      const row={phase,tick,at:performance.now(),frames:[],textures:[],imageCopies:[],passes:[],writeBufferCalls:0,writeBufferBytes:0,longTasks:[]};
      const previousPreparation=styk.state.editablePreparationStats;
      if(timestamps){row.querySet=device.createQuerySet({type:'timestamp',count:1024});p.queries.add(row.querySet);}
      p.current=row;
      try{
        row.at=performance.now();editor.seek(tick);row.commandMs=performance.now()-row.at;
        await p.wait(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender&&row.frame?.completeMs!==undefined&&
          styk.state.lastEditingPresentation?.tick===tick&&styk.state.lastEditingPresentation.at>=row.at);
        p.check(editor.report===report&&editor.revision===revision&&editor.historySize===history,'Seek changed document/history');
        row.preparation=styk.state.editablePreparationStats===previousPreparation?null:structuredClone(styk.performance().editablePreparation);
        row.renderer=structuredClone(renderer.stats);
        row.longTasks.push(...p.observer.takeRecords().map(v=>({at:v.startTime,ms:v.duration})));
        p.rows.push(row);
      }finally{p.current=null;}
    }
    // Reading after the complete sweep avoids inserting diagnostic readback
    // waits into the interval between consecutive measured seek requests.
    if(timestamps)for(const row of p.rows){
      let resolve,readback;
      try{
        const count=row.passes.length*2;
        if(count){
          const size=count*8;
          resolve=device.createBuffer({size,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
          readback=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
          const encoder=device.createCommandEncoder({label:'Seek diagnostic readback'});
          encoder.resolveQuerySet(row.querySet,0,count,resolve,0);encoder.copyBufferToBuffer(resolve,0,readback,0,size);device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);const values=new BigUint64Array(readback.getMappedRange());
          let first=values[0],last=values[1];
          for(const pass of row.passes){
            const begin=values[pass.index],end=values[pass.index+1];
            pass.gpuMs=Number(end-begin)/1e6;p.check(Number.isFinite(pass.gpuMs)&&pass.gpuMs>=0,'Invalid GPU duration');
            if(begin<first)first=begin;if(end>last)last=end;
          }
          row.gpuSpanMs=Number(last-first)/1e6;readback.unmap();row.queryReadbackBytes=size;
        }
      }finally{row.querySet.destroy();p.queries.delete(row.querySet);delete row.querySet;resolve?.destroy();readback?.destroy();}
    }
    p.check(p.errors.length===0,JSON.stringify(p.errors));
    return {timestamps,supported:device.features.has('timestamp-query'),rows:p.rows,errors:p.errors,limits:[
      'Diagnostic CPU wrappers and optional GPU timestamp writes perturb timing; compare timed/untimed runs without treating them as production gains.',
      'GPU pass time excludes transfer/driver/queue wait; the span covers only instrumented render passes, not all GPU execution.',
      'Queue completion callback includes prior submitted work and host scheduling, and is not physical scanout.',
      'Texture dimensions/sample counts are allocation descriptors, not actual driver residency. Image-copy extents do not establish physical transfer bytes.',
      'Queries are read only after both sweeps; query allocation/writes still add overhead. Warm caches and background work remain enabled.'
    ]};
  };
}

module.exports=async function seekGpuProbe(window,{timestamps=true}={}){
  const execute=code=>window.webContents.executeJavaScript(code);
  await execute("styk.settingsUI.commit({timelineMode:'advanced'});for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();");
  await execute(`(${install.toString()})(${JSON.stringify(timestamps)})`);
  try{const result=await execute('__seekGpuProbe.run()');assert.deepEqual(result.errors,[]);assert.equal(result.rows.length,18);return result;}
  finally{await execute('if(window.__seekGpuProbe){for(const restore of __seekGpuProbe.restore.reverse())restore();for(const query of __seekGpuProbe.queries)query.destroy();delete window.__seekGpuProbe;}');}
};
