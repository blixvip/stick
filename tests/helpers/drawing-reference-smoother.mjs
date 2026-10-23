// Original scan-based algorithm, retained only as an independent test oracle.
export class ReferenceSmoother {
  constructor(window){this.window=window;this.points=[];}
  get size(){return this.points.length;}
  add(p){
    this.points.push(p);let keep=1,arc=0;
    for(let i=this.points.length-1;i>0;i--){arc+=Math.hypot(this.points[i].x-this.points[i-1].x,this.points[i].y-this.points[i-1].y);if(arc>this.window)break;keep++;}
    if(this.size>Math.max(2,keep))this.points.splice(0,this.size-Math.max(2,keep));
    return this.value();
  }
  shift(){this.points.shift();}
  value(){let sum=0,x=0,y=0,pressure=0,time=0;this.points.forEach((p,i)=>{const w=i+1;sum+=w;x+=p.x*w;y+=p.y*w;pressure+=p.pressure*w;time+=p.time*w;});return {x:x/sum,y:y/sum,pressure:pressure/sum,time:time/sum};}
}
