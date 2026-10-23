import {drawBackground,releaseBackgroundResources,backgroundResourceStats} from '../src/pivot/background.mjs';

/** Compare retained immutable backgrounds with the established transient painter. */
export async function backgroundResourcePixelChecks() {
  const images=[];
  for(const color of ['rgba(180,30,80,.65)','rgba(20,150,210,.45)']){
    const source=new OffscreenCanvas(31,23),context=source.getContext('2d');
    context.fillStyle=color;context.fillRect(0,0,31,23);
    context.fillStyle='rgba(40,230,90,.8)';context.fillRect(6,4,11,9);
    const bitmap=await createImageBitmap(source);bitmap.naturalWidth=31;bitmap.naturalHeight=23;bitmap.complete=true;
    images.push(bitmap);source.width=source.height=1;
  }
  const report={backgrounds:[{background_id:1,kind:1},{background_id:2,kind:1}]};
  const surfaces=[new OffscreenCanvas(280,210),new OffscreenCanvas(280,210)],contexts=surfaces.map(s=>s.getContext('2d',{willReadFrequently:true}));
  const checks=[];
  try {
    for(const [angle,scale,mix] of [[0,1,0],[.27,.625,128],[-.41,1.5,200]]){
      const cosine=Math.cos(angle)*scale,sine=Math.sin(angle)*scale;
      const frame={background_id:1,background_id_b:2,background_mix:mix};
      const resources={image:id=>images[id-1],url:bg=>bg.background_id,bounds:{x:-80,y:-60,width:400,height:330}};
      for(let pass=0;pass<2;pass++){
        for(const [index,context] of contexts.entries()){
          context.reset();context.setTransform(cosine,sine,-sine,cosine,52.37,31.61);
          drawBackground(context,report,frame,160,120,{...resources,backgroundBytes:index===0?1024*1024:0});
        }
        const pixels=contexts.map(c=>c.getImageData(0,0,280,210).data);let maximum=0;
        for(let i=0;i<pixels[0].length;i++)maximum=Math.max(maximum,Math.abs(pixels[0][i]-pixels[1][i]));
        if(maximum!==0)throw Error(`Retained edge background changed pixels: ${maximum}`);
        checks.push({angle,scale,mix,pass,maximum});
      }
      if(backgroundResourceStats().bytes>1024*1024)throw Error('Background retention exceeded its allowance');
    }
  }finally{
    contexts.forEach(releaseBackgroundResources);images.forEach(image=>image.close());surfaces.forEach(surface=>{surface.width=surface.height=1;});
  }
  if(backgroundResourceStats().bytes!==0)throw Error('Disposed backgrounds retained pixels');
  return {checks,disposed:backgroundResourceStats()};
}
