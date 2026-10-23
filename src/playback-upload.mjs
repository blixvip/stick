/** Upload the bounded startup window one packet per animation frame. Playback
 * begins after those uploads finish on the GPU; packet compilation alone does
 * not mean a large texture is ready to display. */
export class PlaybackUploadWarmup {
  constructor(onReady = () => {}) {this.onReady=onReady;this.reset();}
  reset() {this.fence=null;}
  step(renderer, packets, options) {
    const cache=renderer.preparedFrames;
    if(!packets.length || !cache?.canWarm || !renderer.device?.queue.onSubmittedWorkDone)return true;
    const warmed=[];
    for(const packet of packets) {
      if(!renderer.hasPreparedFrame(packet.key)) {
        if(!renderer.backgroundsReady(options.report,packet.frame))return false;
        // Never evict the first presentation or retained sibling uploads merely
        // to warm a larger window. Ordinary rendering owns cache eviction.
        if(warmed.length&&!cache.canWarm(packet,options))break;
        renderer.prepareFrame(packet,options);this.reset();return false;
      }
      warmed.push(packet.key);
    }
    if(!warmed.length)return false;
    const key=warmed.join('|');
    if(this.fence?.renderer===renderer&&this.fence.key===key)return this.fence.ready;
    const fence=this.fence={renderer,key,ready:false};
    renderer.device.queue.onSubmittedWorkDone().then(()=>{
      if(this.fence!==fence)return;fence.ready=true;this.onReady();
    },()=>{if(this.fence===fence){this.reset();this.onReady();}});
    return false;
  }
}

const yieldUpload=()=>globalThis.scheduler?.yield?scheduler.yield():new Promise(resolve=>{
  const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);
});

/** A few ready successors share the existing GPU cache. Upload work yields
 * between textures; input, revision changes and the displayed frame take priority. */
export class PlaybackUploadAhead {
  constructor({yieldControl=yieldUpload,onError=()=>{}}={}){this.yieldControl=yieldControl;this.onError=onError;this.request=null;this.running=false;}
  reset(){this.request=null;this.cache?.cancelWarm();this.cache=null;}
  update(renderer, packets, options, isCurrent){
    const cache=renderer?.preparedFrames;
    if(!cache?.beginWarm||renderer.destroyed||renderer.deviceLost){this.reset();return;}
    if(this.cache!==cache)this.reset();
    if(packets.every(packet=>cache.has(packet.key))){this.reset();return;}
    this.cache=cache;this.request={renderer,packets,options,isCurrent};
    if(!this.running)void this.drain();
  }
  async drain(){
    this.running=true;
    try{
      // Start after the current presentation task can return to the browser.
      await this.yieldControl();
      while(this.request){
        const request=this.request,{packets,options,isCurrent}=request,cache=this.cache;
        const packet=packets.find(p=>!cache.has(p.key));
        if(request.renderer.destroyed||request.renderer.deviceLost||!packet||!isCurrent(packet))break;
        let warm=cache.warming;
        if(warm&&warm.packet!==packet){cache.cancelWarm();warm=null;}
        warm??=cache.beginWarm(packet,options,new Set(packets.map(p=>String(p.key))));
        if(!warm)break;
        cache.stepWarm(warm);
        await this.yieldControl();
      }
    }catch(error){
      // Foreground preparation remains authoritative if speculative allocation
      // fails. Keep the failure visible in diagnostics without discarding frames.
      if(this.cache?.stats)this.cache.stats.warmFailures++;
      this.cache?.cancelWarm();this.onError(error);
    }
    finally{this.running=false;this.cache?.cancelWarm();}
  }
}
