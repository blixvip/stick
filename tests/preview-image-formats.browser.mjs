import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  const result=await page.evaluate(async()=>{
    const {decodePreview,imageInfo}=await import('/src/preview-image.mjs');
    const {PreviewImages}=await import('/src/preview-images.mjs');
    const width=80,height=48,stride=width*3,fixtures=[];
    for(const topDown of [false,true]){
      const bytes=new Uint8Array(54+stride*height),v=new DataView(bytes.buffer);
      bytes.set([66,77]);v.setUint32(2,bytes.length,true);v.setUint32(10,54,true);v.setUint32(14,40,true);
      v.setInt32(18,width,true);v.setInt32(22,topDown?-height:height,true);v.setUint16(26,1,true);v.setUint16(28,24,true);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const row=topDown?y:height-1-y,p=54+row*stride+x*3;bytes.set([x*3,y*5,(x+y)*2],p);
      }
      fixtures.push({name:topDown?'BMP top-down':'BMP bottom-up',blob:new Blob([bytes],{type:'image/bmp'})});
    }
    const surface=new OffscreenCanvas(width,height),ctx=surface.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='#e9583f';ctx.fillRect(0,0,width,height);ctx.fillStyle='#246bdb';ctx.fillRect(17,9,23,28);
    const jpeg=await surface.convertToBlob({type:'image/jpeg',quality:1});fixtures.push({name:'JPEG',blob:jpeg});
    const original=new Uint8Array(await jpeg.arrayBuffer()),exif=new Uint8Array(36),v=new DataView(exif.buffer);
    exif.set([255,225,0,34,69,120,105,102,0,0,73,73]);v.setUint16(12,42,true);v.setUint32(14,8,true);v.setUint16(18,1,true);
    v.setUint16(20,0x112,true);v.setUint16(22,3,true);v.setUint32(24,1,true);v.setUint16(28,6,true);
    fixtures.push({name:'JPEG EXIF rotation',blob:new Blob([original.subarray(0,2),exif,original.subarray(2)],{type:'image/jpeg'})});
    const rows=[];
    const pixels=bitmap=>{
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d',{willReadFrequently:true});
      context.drawImage(bitmap,0,0);return context.getImageData(0,0,canvas.width,canvas.height).data;
    };
    for(const fixture of fixtures){
      const native=await createImageBitmap(fixture.blob),info=await imageInfo(fixture.blob);
      for(const crop of [null,{x:7,y:5,width:19,height:17}]){
        const actual=await decodePreview(fixture.blob,{width:4096,height:4096,maxPixels:width*height,crop});
        const reference=crop?await createImageBitmap(fixture.blob,crop.x,crop.y,crop.width,crop.height):native;
        const a=pixels(actual),b=pixels(reference);let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));
        rows.push({name:fixture.name,crop:Boolean(crop),actual:[actual.width,actual.height],expected:[reference.width,reference.height],
          logical:[actual.naturalWidth,actual.naturalHeight],source:[native.width,native.height],info:[info.width,info.height],max});
        actual.close();if(crop)reference.close();
      }
      native.close();
    }
    const images=new PreviewImages({maxBytes:256*1024}),urls=fixtures.map(f=>URL.createObjectURL(f.blob));
    try {
      const pending=urls.map(url=>images.image(url));await Promise.all(pending.map(image=>image.decode()));
      rows.push({name:'lazy worker formats',logical:urls.map(url=>[images.get(url).naturalWidth,images.get(url).naturalHeight]),bytes:images.bytes,reduced:images.reduced});
    } finally {images.clear();urls.forEach(url=>URL.revokeObjectURL(url));}
    return rows;
  });
  await mkdir('artifacts/preview-image-formats',{recursive:true});
  await writeFile('artifacts/preview-image-formats/report.json',JSON.stringify({result,errors},null,2));
  assert.deepEqual(errors,[]);
  for(const row of result.filter(r=>r.actual)){
    assert.deepEqual(row.actual,row.expected,row.name);assert.deepEqual(row.logical,row.source,row.name);
    assert.deepEqual(row.info,row.source,row.name);assert.equal(row.max,0,`${row.name} native pixels`);
  }
  assert.deepEqual(result.at(-1).logical,[[80,48],[80,48],[80,48],[48,80]]);assert.equal(result.at(-1).reduced,false);
  console.log(JSON.stringify({passed:true,result,errors}));
} finally {await browser.close();}
