/** In-page paired benchmark. Call with the same evaluated scene/resources and
 * a frozen baseline renderer URL; no document data is saved by this module. */
export async function zoomGestureBenchmark({rendererURL='/src/renderer.mjs',forceCanvas2D=false,report,frame,geometry,resources,width=960,height=432,dpr=1,defer=false,steps=32,onProgress=()=>{},awaitRefinement=false,subscribeResources,waitResourcesReady,warmWorker=false}) {
  const {createRenderer}=await import(rendererURL),rows=[],errors=[],callbacks=[],resourceCallbacks=[],tasks=[],callbackFences=new Set();
  let renderer,latestOptions,latestPhase,observer,memoryTimer,gestureStart,gestureEnd,refinementStart,refinementEnd,refinement,unsubscribeResources,repaintVersion=0;
  let gestureLongTasks=[],postSettlementLongTasks=[],interactionLongTasks=[],interactionPhaseBounds=[];
  let peakPublishedBytes=0,peakReservationBytes=0,peakPublishedAndReservedBytes=0;
  const refinementStats=()=>Object.fromEntries(['pending','bytes','completed','failed','cancelled'].map(key=>[key,renderer.stats.artworkRefinement?.[key]??0]));
  const sampleMemory=()=>{
    const published=renderer.artworkBytes===undefined?renderer.rasterCache?.stats.activeBytes??0:
      renderer.artworkBytes+(renderer.onionArtworkBytes??0),reservation=renderer.stats.artworkRefinement?.bytes??0;
    peakPublishedBytes=Math.max(peakPublishedBytes,published);peakReservationBytes=Math.max(peakReservationBytes,reservation);
    peakPublishedAndReservedBytes=Math.max(peakPublishedAndReservedBytes,published+reservation);
  };
  const repaint=kind=>{
    if(!renderer||!latestOptions)return;
    const at=performance.now(),row={at,kind,phase:latestPhase,scale:latestOptions.view.scale};repaintVersion++;
    try{renderer.render(latestOptions);}
    catch(error){errors.push(error.message);}
    row.cpuMs=performance.now()-at;(kind==='resources'?resourceCallbacks:callbacks).push(row);
    if(renderer.device){
      const fence=renderer.device.queue.onSubmittedWorkDone().then(()=>{row.completeMs=performance.now()-at;})
        .catch(error=>errors.push(error.message)).finally(()=>callbackFences.delete(fence));callbackFences.add(fence);
    }else row.completeMs=row.cpuMs;
    if(memoryTimer)sampleMemory();
  };
  const fitted=Math.min((width-128)/report.canvas_width,(height-16)/report.canvas_height),anchor={x:width/2,y:height/2};
  const viewAt=progress=>{const scale=fitted*Math.exp(2.4*progress);return {scale,x:anchor.x-report.canvas_width/2*scale,y:anchor.y-report.canvas_height/2*scale};};
  const base={report,frame,geometry,cameraEnabled:false,clipToCanvas:false};
  const submit=async(view,viewChanging,phase)=>{
    const before=renderer.stats.rasterizedObjects??0,start=performance.now();
    latestOptions={...base,view,viewChanging};latestPhase=phase;renderer.render(latestOptions);
    const cpuMs=performance.now()-start;
    await renderer.device?.queue.onSubmittedWorkDone();
    const row={phase,scale:view.scale,cpuMs,completeMs:performance.now()-start,rasters:renderer.device?(renderer.stats.rasterizedObjects??0):(renderer.stats.rasterizedObjects??0)-before,
      uploadBytes:renderer.stats.uploadBytes??0,bytes:(renderer.stats.gpuBytes??renderer.artworkBytes??0)+(renderer.rasterCache?.recycledBytes??0),activeBytes:renderer.rasterCache?.stats.activeBytes??renderer.artworkBytes??0,preparation:renderer.stats.preparation};
    rows.push(row);if(memoryTimer)sampleMemory();return row;
  };
  // Resource publication may repaint and enqueue more artwork. Require a full
  // idle pass with no intervening repaint, including each callback queue fence.
  const drain=async()=>{
    for(let pass=0;pass<64;pass++){
      const version=repaintVersion;
      await renderer.whenArtworkReady?.();await waitResourcesReady?.();await renderer.whenArtworkReady?.();
      await Promise.all([...callbackFences]);const state=refinementStats();
      if(version===repaintVersion&&!renderer.artworkRefining&&!state.pending&&!state.bytes)return;
    }
    throw new Error('Zoom refinement did not become idle.');
  };
  try {
    renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D,resources,...(awaitRefinement?{onInvalidate:()=>repaint('artwork')}:{})});
    renderer.resize(width,height,dpr);renderer.device?.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    unsubscribeResources=subscribeResources?.(()=>repaint('resources'));
    await submit(viewAt(0),false,'initial');
    // A fresh renderer per trial starts its capture worker cold. The app keeps
    // one renderer; waiting here (untimed) measures that established state.
    if(warmWorker&&renderer.refinement){
      // Renderers that predate warming load their worker with an empty snapshot header.
      if(renderer.refinement.warm)await renderer.refinement.warming;
      else await renderer.refinement.worker.request('composite-chunk',{chunk:{header:true,estimatedBytes:64},maxBytes:1024*1024});
    }
    if(awaitRefinement){
      // End the initial paint's task before observing the interaction. Canvas
      // submission otherwise resumes in a microtask within that same task.
      await new Promise(resolve=>setTimeout(resolve,0));
      if(typeof PerformanceObserver!=='undefined'&&(!PerformanceObserver.supportedEntryTypes||PerformanceObserver.supportedEntryTypes.includes('longtask'))){
        try{observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())tasks.push({at:entry.startTime,ms:entry.duration,name:entry.name});});observer.observe({type:'longtask'});}
        catch{observer?.disconnect();observer=null;}
      }
      sampleMemory();memoryTimer=setInterval(sampleMemory,8);
    }
    gestureStart=performance.now();
    // A fixed input interval keeps an automation tab's background animation
    // throttling out of the renderer timing. Completion includes a queue fence;
    // this measures rendering work, not display cadence or input-to-screen time.
    for(let i=1;i<=steps;i++) {await submit(viewAt(i/steps),defer,'gesture');onProgress({step:i,steps,backend:renderer.stats.backend});await new Promise(resolve=>setTimeout(resolve,16));}
    gestureEnd=performance.now();
    let beforeRefinement,settleEnd;
    if(awaitRefinement){
      beforeRefinement=refinementStats();refinementStart=performance.now();sampleMemory();
    }
    const firstSettle=await submit(viewAt(1),false,'settle');
    if(awaitRefinement){
      settleEnd=performance.now();
      await drain();
      const readyAt=performance.now();sampleMemory();
      const final=await submit(viewAt(1),false,'refined');await drain();refinementEnd=performance.now();
      refinement={elapsedMs:readyAt-settleEnd,settlementElapsedMs:refinementEnd-refinementStart,
        settleCpuMs:firstSettle.cpuMs,finalCpuMs:final.cpuMs,before:beforeRefinement,ready:refinementStats(),
        callbacks:callbacks.filter(row=>row.at>=refinementStart&&row.at<refinementEnd),
        resourceCallbacks:resourceCallbacks.filter(row=>row.at>=refinementStart&&row.at<refinementEnd)};
    }
    const steadyStart=performance.now();
    for(let i=0;i<16;i++)await submit(viewAt(1),false,'steady');
    const steadyEnd=performance.now();
    if(awaitRefinement){
      await drain();const interactionEnd=performance.now();refinement.postSteadyReadyMs=interactionEnd-steadyEnd;sampleMemory();
      clearInterval(memoryTimer);memoryTimer=null;
      // Keep observing through steady paints and their final callback jobs.
      // Entries become available only when their owning task has finished.
      await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setTimeout(resolve,0));
      if(observer){for(const entry of observer.takeRecords())tasks.push({at:entry.startTime,ms:entry.duration,name:entry.name});observer.disconnect();}
      interactionPhaseBounds=[['gesture',gestureStart,gestureEnd],['settle',refinementStart,settleEnd],
        ['refinement',settleEnd,refinementEnd],['steady',steadyStart,steadyEnd],['finalReady',steadyEnd,interactionEnd]]
        .map(([phase,start,end])=>({phase,start,end}));
      interactionLongTasks=tasks.flatMap(task=>{
        const overlaps=interactionPhaseBounds.map(({phase,start,end})=>({phase,ms:Math.max(0,Math.min(end,task.at+task.ms)-Math.max(start,task.at))})).filter(overlap=>overlap.ms>0);
        if(!overlaps.length)return [];
        // A browser task can span promise continuations across phase borders.
        // Count it once, assigning its largest overlap and retaining all spans.
        const largest=overlaps.reduce((a,b)=>a.ms>=b.ms?a:b);
        return [{...task,phase:largest.phase,overlapMs:largest.ms,phaseOverlaps:Object.fromEntries(overlaps.map(overlap=>[overlap.phase,overlap.ms]))}];
      });
      gestureLongTasks=interactionLongTasks.filter(task=>task.phase==='gesture');
      postSettlementLongTasks=interactionLongTasks.filter(task=>task.phase==='steady'||task.phase==='finalReady');
      const after=refinementStats();Object.assign(refinement,{after,completed:after.completed-beforeRefinement.completed,
        failed:after.failed-beforeRefinement.failed,cancelled:after.cancelled-beforeRefinement.cancelled,
        peakPublishedBytes,peakReservationBytes,peakPublishedAndReservedBytes,memorySampleIntervalMs:8,
        memorySamplingScope:'after initial paint through gesture, settlement and final steady readiness',
        memoryOwner:renderer.artworkBytes===undefined?'WebGPU active raster cache':'Canvas published artwork/onion and worker reservation',
        artworkBudgetBytes:renderer.artworkBudget??renderer.rasterCache?.maxBytes??0,
        longTasksSupported:Boolean(observer),longTasks:interactionLongTasks.filter(task=>task.phase==='settle'||task.phase==='refinement'),observedEnd:performance.now()});
      if(renderer.artworkBytes!==undefined)refinement.withinArtworkAllowance=peakPublishedAndReservedBytes<=
        (renderer.artworkBudget??0)+(renderer.onionArtworkBytes?(renderer.onionBudget??0)/2:0);
    }else await Promise.all([...callbackFences]);
    clearInterval(memoryTimer);memoryTimer=null;
    const copy=new OffscreenCanvas(renderer.canvas.width,renderer.canvas.height),context=copy.getContext('2d',{willReadFrequently:true});context.drawImage(renderer.canvas,0,0);
    let pixels;try{pixels=context.getImageData(0,0,copy.width,copy.height).data;}finally{copy.width=copy.height=1;}
    const percentile=values=>{const v=[...values].sort((a,b)=>a-b);return {p50:v[Math.floor(v.length*.5)],p95:v[Math.max(0,Math.ceil(v.length*.95)-1)],max:v.at(-1)};};
    if(refinement){
      // Refined pixels reach the canvas in publication repaints. Record when the
      // first, half and last of them finished, relative to the settlement paint.
      const published=refinement.callbacks.map(row=>row.at+row.cpuMs-refinementStart);
      refinement.firstPublicationMs=published[0]??null;refinement.halfPublicationMs=published[Math.ceil(published.length/2)-1]??null;refinement.lastPublicationMs=published.at(-1)??null;
      refinement.callbackCount=refinement.callbacks.length;refinement.callbackCpuMs=refinement.callbackCount?percentile(refinement.callbacks.map(row=>row.cpuMs)):{p50:null,p95:null,max:null};}
    const group=phase=>{const list=rows.filter(r=>r.phase===phase);return {cpuMs:percentile(list.map(r=>r.cpuMs)),completeMs:percentile(list.map(r=>r.completeMs)),rasters:list.reduce((n,r)=>n+r.rasters,0),uploadBytes:list.reduce((n,r)=>n+r.uploadBytes,0)};};
    return {backend:renderer.stats.backend,adapter:renderer.stats.adapter,width,height,dpr,steps,defer,objects:geometry.objects.size,drawables:geometry.drawables.length,errors,
      gesture:group('gesture'),settle:group('settle'),steady:group('steady'),peakBytes:Math.max(...rows.map(r=>r.bytes)),peakActiveBytes:Math.max(...rows.map(r=>r.activeBytes)),
      artworkCallbacks:callbacks,resourceCallbacks,gestureLongTasks,postSettlementLongTasks,interactionLongTasks,interactionPhaseBounds,rows,pixels,...(refinement?{refinement}:{})};
  }finally{latestOptions=null;unsubscribeResources?.();clearInterval(memoryTimer);observer?.disconnect();renderer?.destroy();}
}
