/** Native evaluated-tick audit. Returns measurements and pixel differences;
 * document, geometry and pixel contents are never included in the result.
 * CPU timings describe render submissions, not displayed FPS or input latency. */
const summary=values=>{
  const sorted=values.toSorted((a,b)=>a-b);
  return {samples:values.length,p50:sorted[Math.floor(sorted.length*.5)]??0,p95:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]??0,max:sorted.at(-1)??0};
};
const pixels=canvas=>{
  const copy=new OffscreenCanvas(canvas.width,canvas.height),context=copy.getContext('2d',{willReadFrequently:true});
  try{context.drawImage(canvas,0,0);return context.getImageData(0,0,copy.width,copy.height).data;}
  finally{copy.width=copy.height=1;}
};
function difference(actual,expected){
  let sum=0,max=0,alphaSum=0,alphaMax=0,premultipliedSum=0,changedPixels=0;
  for(let i=0;i<actual.length;i+=4){
    let changed=false;
    for(let c=0;c<4;c++){
      const delta=Math.abs(actual[i+c]-expected[i+c]);sum+=delta;max=Math.max(max,delta);changed||=delta>0;
      if(c===3){alphaSum+=delta;alphaMax=Math.max(alphaMax,delta);premultipliedSum+=delta;}
      else premultipliedSum+=Math.abs(actual[i+c]*actual[i+3]/255-expected[i+c]*expected[i+3]/255);
    }
    if(changed)changedPixels++;
  }
  return {mean:sum/actual.length,max,alphaMean:alphaSum/(actual.length/4),alphaMax,premultipliedMean:premultipliedSum/actual.length,changedPixels};
}

export async function zoomRefinementSweep({editor,resources,baselineRendererURL,currentRendererURL='/src/renderer.mjs',
  forceCanvas2D=true,width=960,height=432,dpr=1,ticks,meanTolerance=.02,alphaTolerance=1,onProgress=()=>{},afterFrame,
  subscribeResources,waitResourcesReady}={}){
  if(!editor?.seek||!Number.isInteger(editor.totalTicks)||!baselineRendererURL)throw new TypeError('A native Editor and frozen baseline renderer URL are required.');
  const originalTick=editor.tick,totalTicks=editor.totalTicks,requested=ticks??Array.from({length:totalTicks},(_,i)=>i);
  const modules=await Promise.all([import(baselineRendererURL),import(currentRendererURL)]),renderers=[],rows=[],errors=[];
  const fitted=Math.min((width-128)/editor.report.canvas_width,(height-16)/editor.report.canvas_height);
  const view=scale=>({scale,x:width/2-editor.report.canvas_width/2*scale,y:height/2-editor.report.canvas_height/2*scale});
  const matches=diff=>diff.mean<meanTolerance&&diff.alphaMax<=alphaTolerance;
  let currentOptions,currentRow,currentPhase='idle',unsubscribeResources,memoryTimer,repaintVersion=0;
  const memory=renderer=>({publishedBytes:renderer.artworkBytes??renderer.rasterCache?.stats.activeBytes??0,
    reservedBytes:renderer.stats.artworkRefinement?.bytes??0,pending:renderer.stats.artworkRefinement?.pending??0,
    budgetBytes:renderer.artworkBudget??renderer.rasterCache?.maxBytes??0});
  const sampleMemory=(renderer,row)=>{
    const state=memory(renderer);row.peakPublishedBytes=Math.max(row.peakPublishedBytes??0,state.publishedBytes);
    row.peakReservedBytes=Math.max(row.peakReservedBytes??0,state.reservedBytes);
    row.peakCombinedBytes=Math.max(row.peakCombinedBytes??0,state.publishedBytes+state.reservedBytes);
    row.budgetBytes=state.budgetBytes;
  };
  const submit=async(renderer,options)=>{
    const before=renderer.stats.rasterizedObjects??0,start=performance.now();renderer.render(options);const cpuMs=performance.now()-start;
    await renderer.device?.queue.onSubmittedWorkDone();
    return {cpuMs,completeMs:performance.now()-start,rasters:renderer.device?renderer.stats.rasterizedObjects??0:(renderer.stats.rasterizedObjects??0)-before};
  };
  const drain=async(targets=[renderers[1]])=>{
    for(let pass=0;pass<64;pass++){
      const version=repaintVersion;
      for(const renderer of targets)await renderer.whenArtworkReady?.();
      await waitResourcesReady?.();
      for(const renderer of targets){await renderer.whenArtworkReady?.();await renderer.device?.queue.onSubmittedWorkDone();}
      if(version===repaintVersion&&targets.every(renderer=>{
        const state=memory(renderer);return !renderer.artworkRefining&&!state.pending&&!state.reservedBytes;
      }))return;
    }
    throw new Error('Zoom refinement did not become idle.');
  };
  const stableInitial=async(options)=>{
    for(let pass=0;pass<64;pass++){
      await drain(renderers);const version=repaintVersion,captured=[],readbacks=[];
      for(let i=0;i<2;i++){
        // Resource-idle parity is untimed; preserve the original submissions.
        await submit(renderers[i],options);
        readbacks.push({variant:i?'current':'baseline',repaintVersion});captured.push(pixels(renderers[i].canvas));
      }
      await drain(renderers);
      if(version===repaintVersion)return {difference:difference(captured[1],captured[0]),readbacks};
    }
    throw new Error('Fitted-view captures did not become stable.');
  };
  try{
    for(let i=0;i<2;i++){
      const renderer=await modules[i].createRenderer(document.createElement('canvas'),{forceCanvas2D,resources,onInvalidate:i===1?()=>{
        if(!currentOptions||!currentRow||renderer.destroyed)return;
        const start=performance.now();repaintVersion++;renderer.render(currentOptions);const cpuMs=performance.now()-start;currentRow.callbacks.push(cpuMs);
        // Publications after settlement present refined pixels; the first is the first visibly sharper paint.
        currentRow.publications.push({phase:currentPhase,atMs:currentRow.settledAt===undefined?null:start+cpuMs-currentRow.settledAt,cpuMs});sampleMemory(renderer,currentRow);
      }:undefined});
      renderer.resize(width,height,dpr);renderer.device?.addEventListener('uncapturederror',event=>errors.push(event.error.message));renderers.push(renderer);
    }
    unsubscribeResources=subscribeResources?.(()=>{
      if(!currentOptions||!currentRow)return;
      repaintVersion++;
      for(let i=0;i<renderers.length;i++){
        const start=performance.now();renderers[i].render(currentOptions);
        currentRow.resourceCallbacks.push({variant:i?'current':'baseline',cpuMs:performance.now()-start,phase:currentPhase});
        if(i)sampleMemory(renderers[i],currentRow);
      }
    });
    for(const tick of requested){
      const row={tick,callbacks:[],publications:[],resourceCallbacks:[]};rows.push(row);currentRow=row;currentPhase='prepare';
      try{
        if(!Number.isInteger(tick)||tick<0||tick>=totalTicks)throw new RangeError('Sweep tick exceeds the native timeline.');
        const evaluationStart=performance.now();editor.seek(tick);const frame=editor.evaluatedFrame,geometry=editor.geometry;
        row.evaluationMs=performance.now()-evaluationStart;row.objects=geometry.objects.size;row.drawables=geometry.drawables.length;
        const drawingFigures=[...new Map(geometry.drawables.filter(item=>item.fig?._styk?.drawing?.version===2)
          .map(item=>[item.fig._styk.drawing.celId,item.fig])).values()];
        row.drawingCels=drawingFigures.length;row.readyDrawingCels=0;
        const preparationStart=performance.now();await resources?.preload?.(geometry.drawables);row.resourcePreparationMs=performance.now()-preparationStart;
        row.readyDrawingCels=drawingFigures.filter(figure=>resources?.drawing?.(figure)?.store).length;
        if(row.readyDrawingCels!==row.drawingCels)throw new Error('The sweep requires decoded presenters for every visible version 2 drawing cel.');
        const base={report:editor.report,frame,geometry,cameraEnabled:false,clipToCanvas:false},normal={...base,view:view(fitted),viewChanging:false};
        currentOptions=normal;currentPhase='initial';const normalPixels=[];row.initialReadbacks=[];
        for(let i=0;i<2;i++){
          row[i?'currentInitial':'baselineInitial']=await submit(renderers[i],normal);
          row.initialReadbacks.push({variant:i?'current':'baseline',repaintVersion});normalPixels.push(pixels(renderers[i].canvas));
        }
        row.initialDifference=difference(normalPixels[1],normalPixels[0]);row.rawInitialPassed=matches(row.initialDifference);
        currentPhase='initialDrain';const stable=await stableInitial(normal);row.stableInitialDifference=stable.difference;row.stableInitialReadbacks=stable.readbacks;
        row.stableInitialPassed=matches(row.stableInitialDifference);
        sampleMemory(renderers[1],row);memoryTimer=setInterval(()=>sampleMemory(renderers[1],row),8);
        const changing={...base,view:view(fitted*Math.exp(2.4)),viewChanging:true},settled={...changing,viewChanging:false};
        currentOptions=changing;currentPhase='gesture';row.baselineGesture=await submit(renderers[0],changing);row.currentGesture=await submit(renderers[1],changing);
        const completedBefore=renderers[1].stats.artworkRefinement?.completed??0,failedBefore=renderers[1].stats.artworkRefinement?.failed??0;
        currentPhase='settle';row.baselineSettle=await submit(renderers[0],settled);currentOptions=settled;const readyStart=performance.now();row.settledAt=readyStart;
        row.currentSettle=await submit(renderers[1],settled);sampleMemory(renderers[1],row);currentPhase='refinement';await drain();
        row.readyMs=performance.now()-readyStart;currentPhase='steady';row.currentReady=await submit(renderers[1],settled);sampleMemory(renderers[1],row);
        row.baselineSteady=await submit(renderers[0],settled);row.currentSteady=await submit(renderers[1],settled);
        await drain();sampleMemory(renderers[1],row);clearInterval(memoryTimer);memoryTimer=null;currentPhase='verify';
        // First refined publication after settlement; null when this view needed no refinement.
        row.firstPublicationMs=row.publications.find(publication=>publication.atMs!==null)?.atMs??null;
        row.workerCompleted=(renderers[1].stats.artworkRefinement?.completed??0)-completedBefore;
        row.workerFailed=(renderers[1].stats.artworkRefinement?.failed??0)-failedBefore;row.finalMemory=memory(renderers[1]);
        row.lastRefinementError=renderers[1].stats.lastRefinementError??null;
        const currentPixels=pixels(renderers[1].canvas),baselinePixels=pixels(renderers[0].canvas);
        row.settledDifference=difference(currentPixels,baselinePixels);
        let reference;
        try{
          reference=await modules[0].createRenderer(document.createElement('canvas'),{forceCanvas2D,resources,asyncArtwork:false});reference.resize(width,height,dpr);
          await submit(reference,settled);const referencePixels=pixels(reference.canvas);
          row.finalDifference=difference(currentPixels,referencePixels);row.baselineDifference=difference(baselinePixels,referencePixels);
        }finally{reference?.destroy();}
        // The unchanged baseline can itself differ from a cold capture. Keep
        // strict matched-history parity and forbid increased cold variance.
        row.baselineColdVariance=!matches(row.baselineDifference);
        row.coldReferencePassed=row.finalDifference.mean<=row.baselineDifference.mean+meanTolerance&&row.finalDifference.alphaMax<=row.baselineDifference.alphaMax+alphaTolerance;
        row.withinArtworkAllowance=row.peakCombinedBytes<=row.budgetBytes;
        row.passed=row.stableInitialPassed&&matches(row.settledDifference)&&row.coldReferencePassed&&row.withinArtworkAllowance&&!row.workerFailed&&!row.finalMemory.pending&&!row.finalMemory.reservedBytes;
      }catch(error){row.passed=false;row.error={name:error.name,message:error.message};}
      finally{clearInterval(memoryTimer);memoryTimer=null;currentOptions=null;currentRow=null;currentPhase='idle';
        // Optional audit cleanup happens after all render/pixel measurements.
        try{await afterFrame?.({tick});}catch(error){row.passed=false;row.afterFrameError={name:error.name,message:error.message};}
        onProgress({tick,completed:rows.length,total:requested.length,passed:row.passed,
        drawingCels:row.drawingCels,readyDrawingCels:row.readyDrawingCels,resourcePreparationMs:row.resourcePreparationMs,
        initialDifference:row.initialDifference,initialReadbacks:row.initialReadbacks,rawInitialPassed:row.rawInitialPassed,
        stableInitialDifference:row.stableInitialDifference,stableInitialReadbacks:row.stableInitialReadbacks,stableInitialPassed:row.stableInitialPassed,
        currentSettle:row.currentSettle,workerCompleted:row.workerCompleted,workerFailed:row.workerFailed,readyMs:row.readyMs,settledDifference:row.settledDifference,
        baselineColdVariance:row.baselineColdVariance,coldReferencePassed:row.coldReferencePassed,error:row.error,afterFrameError:row.afterFrameError});}
    }
    const timings={};for(const phase of ['Initial','Gesture','Settle','Steady'])for(const label of ['baseline','current'])timings[label+phase]=summary(rows.flatMap(row=>row[label+phase]?[row[label+phase].cpuMs]:[]));
    timings.currentReady=summary(rows.flatMap(row=>row.currentReady?[row.currentReady.cpuMs]:[]));
    timings.currentResourceCallbacks=summary(rows.flatMap(row=>row.resourceCallbacks.filter(callback=>callback.variant==='current').map(callback=>callback.cpuMs)));
    timings.callbacks=summary(rows.flatMap(row=>row.callbacks));timings.workerReady=summary(rows.flatMap(row=>Number.isFinite(row.readyMs)?[row.readyMs]:[]));
    timings.firstPublication=summary(rows.flatMap(row=>Number.isFinite(row.firstPublicationMs)?[row.firstPublicationMs]:[]));
    return {totalTicks,checkedTicks:rows.length,forceCanvas2D,width,height,dpr,initialScale:fitted,finalScale:fitted*Math.exp(2.4),meanTolerance,alphaTolerance,
      backend:renderers.map(renderer=>renderer.stats.backend),errors,timings,passed:rows.every(row=>row.passed)&&!errors.length,failedTicks:rows.filter(row=>!row.passed).map(row=>row.tick),
      baselineColdVarianceTicks:rows.filter(row=>row.baselineColdVariance).map(row=>row.tick),rows};
  }finally{clearInterval(memoryTimer);currentOptions=null;currentRow=null;unsubscribeResources?.();for(const renderer of renderers)renderer.destroy();editor.seek(originalTick);}
}
