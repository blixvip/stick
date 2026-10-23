/** Optional diagnostic instrumentation; never enabled in cadence measurements. */
export async function probePreviewImages(page) {
  await page.evaluate(async () => {
    const {PreviewImages}=await import('/src/preview-images.mjs');
    const {assetURL}=await import('/src/playback-resources.mjs');
    const events=corpusProbe.images=[],identities=new Map(),workers=new WeakSet();
    const id=url=>{if(!identities.has(url))identities.set(url,identities.size+1);return identities.get(url);};
    const describe=item=>{
      const url=assetURL(item.asset),result={id:id(url)};
      if(url?.startsWith('data:image/png;base64,')){
        const bytes=Uint8Array.from(atob(url.split(',')[1].slice(0,44)),c=>c.charCodeAt(0));
        const view=new DataView(bytes.buffer);result.source=[view.getUint32(16),view.getUint32(20)];result.depth=bytes[24];result.color=bytes[25];
      }
      return result;
    };
    const drain=PreviewImages.prototype.drain;
    PreviewImages.prototype.drain=function(){
      if(!this.busy&&this.queued)events.push({event:'request',at:performance.now(),sequence:this.queued.id,
        items:this.queued.items.map(describe),options:this.queued.options,bytes:this.bytes,maxBytes:this.maxBytes,pending:this.pendingImages.size});
      const result=drain.call(this),worker=this.worker;
      if(worker&&!workers.has(worker)){
        workers.add(worker);worker.addEventListener('message',({data})=>events.push({event:'response',at:performance.now(),sequence:data.id,error:data.error,
          images:data.images?.map(i=>({id:id(i.url),source:[i.width,i.height],decoded:[i.bitmap.width,i.bitmap.height]})),bytes:this.bytes,pending:this.pendingImages.size}));
      }
      return result;
    };
  });
}
