// A distance-windowed, linear-ramp centroid. Running sums avoid rescanning the
// trailing path for every pen sample, especially when zoom makes steps tiny.
// The sample ceiling also bounds stationary input and the release drain.
export const MAX_SMOOTHING_SAMPLES=4096;
export class DrawingSmoother {
  constructor(window){this.window=window;this.points=[];this.head=0;this.sum=[0,0,0,0,0,0];this.weighted=[0,0,0,0,0,0];}
  get size(){return this.points.length-this.head;}
  add(p){
    this.origin??=[p.x,p.y,p.pressure,p.time,p.ax??0,p.ay??0];
    const previous=this.points.at(-1),distance=(previous?.distance??0)+(previous?Math.hypot(p.x-previous.p.x,p.y-previous.p.y):0);
    const values=[p.x,p.y,p.pressure,p.time,p.ax??0,p.ay??0].map((v,i)=>v-this.origin[i]),weight=this.size+1;
    this.points.push({p,values,distance});
    for(let i=0;i<6;i++){this.sum[i]+=values[i];this.weighted[i]+=weight*values[i];}
    while(this.size>2&&(distance-this.points[this.head].distance>this.window||this.size>MAX_SMOOTHING_SAMPLES))this.shift();
    return this.value();
  }
  shift(){
    const old=this.points[this.head++];
    for(let i=0;i<6;i++){this.weighted[i]-=this.sum[i];this.sum[i]-=old.values[i];}
    // Release consumed points and amortize compaction instead of Array.shift.
    if(this.head>=1024&&this.head*2>=this.points.length){this.points=this.points.slice(this.head);this.head=0;}
  }
  value(){
    const divisor=this.size*(this.size+1)/2;
    const v=this.weighted.map((n,i)=>this.origin[i]+n/divisor);
    return {x:v[0],y:v[1],pressure:v[2],time:v[3],ax:v[4],ay:v[5]};
  }
}
