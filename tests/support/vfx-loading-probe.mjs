/** Run in a fresh browser page after styk.ready. Same probe serves before/after
 * measurements through the collaborative browser; no timing threshold depends
 * on the local adapter or its driver cache. */
export async function probeVfxLoading() {
  const {Editor}=await import('/src/editor.mjs');
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
  const {createRenderer}=await import('/src/renderer.mjs');
  const {compilePlaybackPacket}=await import('/src/playback-worker.mjs');
  const e=new Editor({demo:false}),canvas=document.createElement('canvas');
  const begin=performance.now(),r=await createRenderer(canvas);
  if(!r.device)throw new Error('This probe requires hardware WebGPU');
  const initializationMs=performance.now()-begin;
  r.resize(1280,720,1);
  const syncPipelines=[],create=r.device.createRenderPipeline.bind(r.device);
  r.device.createRenderPipeline=descriptor=>{syncPipelines.push(descriptor.label);return create(descriptor);};
  const pixels=()=>{const c=new OffscreenCanvas(1280,720),ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,1280,720).data;};
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const rows=[];
  try {
    for(const [name,count,types] of [
      ['aura',1,['aura']],['smoke',1,['smoke']],['explosion',1,['explosion']],
      ['beam',1,['beam']],['particles',1,['particles']],
      ['dense',300,Array.from({length:16},(_,i)=>['aura','smoke','explosion','beam','particles'][i%5])],
    ]) {
      const doc=emptyDocument(),figure=doc.figure_types[0];doc.canvas_width=1280;doc.canvas_height=720;
      const frame=createFrame(Array.from({length:count},(_,i)=>createObject(figure,i+1,count===1?600:80+i%30*40,count===1?400:260+Math.floor(i/30)*30)),80);
      frame._stykBackgroundColor=0xff15131f;doc.keyframes=[frame];e.load(doc);
      for(const [i,type] of types.entries()){
        const id=e.addVfxClip({kind:'figure',uid:count===1?1:1+i*17},type,{start:0,duration:60});
        const effect=e.getVfxClips().find(c=>c.id===id).effects[0];e.setVfxClipParameters(id,effect.id,{seed:7});
      }
      e.seek(24);
      const options={report:e.report,frame:e.evaluatedFrame,geometry:e.geometry,view:{x:0,y:0,scale:1}};
      const start=performance.now();r.render(options);const submitMs=performance.now()-start;
      await r.device.queue.onSubmittedWorkDone();const firstMs=performance.now()-start;
      const live=pixels(),samples=[];
      for(let i=0;i<12;i++){const t=performance.now();r.render(options);await r.device.queue.onSubmittedWorkDone();samples.push(performance.now()-t);}
      const packet=await compilePlaybackPacket(e.report,24,{gpuIsolation:true});
      const key=r.prepareFrame(packet,{report:e.report,view:options.view});
      r.renderPrepared(key,{report:e.report,view:options.view});await r.device.queue.onSubmittedWorkDone();
      const prepared=pixels();let differences=0;for(let i=0;i<live.length;i++)if(live[i]!==prepared[i])differences++;
      samples.sort((a,b)=>a-b);
      rows.push({name,figures:count,particles:r.stats.generatedParticles,submitMs,firstMs,warmMedianMs:samples[6],preparedPixelDifferences:differences,hash:await hash(live)});
      for(const item of packet.compatibility)item.bitmap?.close();
    }
    return {adapter:r.stats.adapter,initializationMs,syncPipelines,pipelines:r.generators?.pipelines.size,rows,warnings:r.stats.warnings};
  } finally {r.destroy();}
}
