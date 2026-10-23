// One asynchronous readback at a time. Never wait for the GPU on the render path.
// Drawing tiles live in one storage pool; request the adapter's larger buffer
// limits (capped) so dense cels are not limited by the 128 MiB default.
const drawingLimits=adapter=>{const limits=adapter.limits,cap=1024*1024*1024;return limits?{maxStorageBufferBindingSize:Math.min(limits.maxStorageBufferBindingSize,cap),maxBufferSize:Math.min(limits.maxBufferSize,cap)}:undefined;};
export async function requestInstrumentedDevice(adapter){
  const requiredLimits=drawingLimits(adapter),limits=requiredLimits?{requiredLimits}:{};
  if(adapter.features?.has('timestamp-query')){
    try{return await adapter.requestDevice({requiredFeatures:['timestamp-query'],...limits});}catch{/* Optional instrumentation must not disable hardware rendering. */}
  }
  if(requiredLimits){try{return await adapter.requestDevice(limits);}catch{/* Default limits still render; the drawing pool stays smaller. */}}
  return adapter.requestDevice();
}
export class GpuTiming {
  constructor(device,{enabled=()=>false,onTiming=()=>{},onSupport=()=>{},getContext=()=>({})}={}){
    Object.assign(this,{device,enabled,onTiming,onSupport,getContext});this.supported=device.features?.has('timestamp-query')===true;this.busy=false;this.destroyed=false;
  }
  begin(sampled){
    if(this.destroyed||!this.enabled()){this.release();return undefined;}
    if(!this.reported){this.onSupport(this.supported);this.reported=true;}
    if(!sampled||!this.supported||this.busy)return undefined;
    try{
      this.queries??=this.device.createQuerySet({type:'timestamp',count:2});
      this.resolve??=this.device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
      this.readback??=this.device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      this.sampleContext=this.getContext();this.busy=true;return {querySet:this.queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1};
    }catch{this.supported=false;this.busy=false;this.release();return undefined;}
  }
  resolveInto(encoder,writes){if(writes){encoder.resolveQuerySet(this.queries,0,2,this.resolve,0);encoder.copyBufferToBuffer(this.resolve,0,this.readback,0,16);}}
  submitted(writes){
    if(!writes)return;
    const readback=this.readback;
    void readback.mapAsync(GPUMapMode.READ).then(()=>{
      try{if(!this.destroyed&&this.enabled()){const times=new BigUint64Array(readback.getMappedRange());const ms=Number(times[1]-times[0])/1e6;if(Number.isFinite(ms)&&ms>=0&&ms<=3600000)this.onTiming(ms,this.sampleContext);}}
      finally{readback.unmap();}
    }).catch(()=>{}).finally(()=>{this.busy=false;if(!this.enabled())this.release();});
  }
  release(){if(this.busy)return;this.queries?.destroy();this.resolve?.destroy();this.readback?.destroy();this.queries=this.resolve=this.readback=null;this.reported=false;}
  destroy(){this.destroyed=true;this.busy=false;this.release();}
}
