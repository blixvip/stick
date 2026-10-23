import {test} from 'node:test';
import assert from 'node:assert/strict';
import {glyphTextureDescriptor,glyphTextureKey,glyphTextureShape,glyphVisible,cropGlyphTexture,glyphPathContours} from '../src/renderer-glyphs.mjs';

function item() {
  return {type:'text',start:{x:10,y:80},end:{x:50,y:80},angle:0,rgb:[32,64,128],alpha:.8,opacity:.5,
    obj:{scale:2,color_override_raw:0},fig:{},seg:{},asset:{normalized_svg_path:'M0 0H20V30H0Z',
      bounds:{left:100,bottom:30,width:20},placements:[{visible:true,x:100,y:0,glyph_index:0}],
      glyphs:[{svg_path:'M0 0H20V30H0Z',bounds:{left:0,top:0,right:20,bottom:30}}]}};
}
test('glyph contour bounds include Bezier control hulls, implicit lines and close-point resets',()=>{
  const source='M1e-3 2 8 4 C-10 50 60 -20 12 5 Q90 70 6 7 Z H100 V-30 M200 210H240V250H200Z';
  const contours=glyphPathContours(source);assert.equal(contours.length,2);
  assert.deepEqual(contours.map(({left,top,right,bottom})=>[left,top,right,bottom]),[[-10,-30,100,70],[200,210,240,250]]);
  assert.equal(source.slice(contours[1].start,contours[1].end),'M200 210H240V250H200Z');
  for(const path of ['m0 0h2v2z','M0 0a1 1 0 0 0 2 2','M0 0S2 3 4 5','M0 0T3 4','M0 0C1 2 3','M0 0LInfinity 2','M0 0!L2 3'])assert.equal(glyphPathContours(path),null,path);
  assert.equal(glyphPathContours('M0 0'+' '.repeat(256*1024)),null,'analysis source is bounded');
  assert.equal(glyphPathContours('M0 0H1V1Z '.repeat(1024)).length,1024);
  assert.equal(glyphPathContours('M0 0H1V1Z '.repeat(1025)),null,'analysis contour count is bounded');
});

test('glyph masks retain exact path identity across translation, tint, opacity, rotation and stretching',async()=>{
  const s=item(),first=glyphTextureDescriptor([s],1),key=await glyphTextureKey(first);
  const changed={...s,start:{x:210,y:180},end:{x:210,y:220},angle:Math.PI/2,rgb:[255,0,0],opacity:.25};
  const next=glyphTextureDescriptor([changed],1);
  assert.equal(await glyphTextureKey(next),key);assert.deepEqual(next.color,[1,0,0,.2]);
  assert.notDeepEqual(glyphTextureShape(first,s.start,1),glyphTextureShape(next,changed.start,1));
  assert.equal(first.mask,next.mask);
  s.asset.glyphs[0].svg_path='M0 0H10V30H0Z';
  assert.notEqual(await glyphTextureKey(glyphTextureDescriptor([s],1)),key);
});
test('glyph quad follows native reverse, mirror, signed vertical scale and root-local transforms',()=>{
  for(const reverse of[false,true])for(const mirror of[false,true])for(const scale of[2,-2]){
    const s=item();s.seg.extra_u8_a=+reverse;s.seg.extra_u8_b=+mirror;s.obj.scale=scale;s.angle=.43;
    s.end={x:s.start.x+40*Math.cos(s.angle),y:s.start.y+40*Math.sin(s.angle)};
    const g=glyphTextureDescriptor([s],2),record=glyphTextureShape(g,{x:5,y:7},9);
    // Independently map the actual top-left ink corner through the Canvas order.
    const angle=s.angle+(reverse?Math.PI:0)-(mirror?Math.PI:0),start=reverse?s.end:s.start;
    const px=0,py=-30*scale;
    const actual={x:g.x+g.axes[0]*2/g.width+g.axes[2]*2/g.height,y:g.y+g.axes[1]*2/g.width+g.axes[3]*2/g.height};
    assert.ok(Math.abs(actual.x-(start.x+px*Math.cos(angle)-py*Math.sin(angle)))<1e-10);
    assert.ok(Math.abs(actual.y-(start.y+px*Math.sin(angle)+py*Math.cos(angle)))<1e-10);
    assert.equal(record[21],9);assert.ok(Math.abs(record[0]-(g.x-5))<1e-4);
    assert.ok(glyphVisible(g,{x:-1000,y:-1000,width:2000,height:2000}));
    assert.equal(glyphVisible(g,{x:5000,y:5000,width:2,height:2}),false);
  }
});
test('unsupported compositing and undersampled huge glyphs use the complete painter',()=>{
  for(const mutate of[
    s=>{s.seg.paint={type:'solid',color:[0,1,2]};},s=>{s.seg.secondary={a:0,rgb:[1,2,3]};},
    s=>{s.fig.segment_decode={global_style:{u28:1}};},s=>{s._movieclipOwner={opacity:.5};},
    s=>{s.asset.placements.push({...s.asset.placements[0]});},s=>{s.asset.glyphs[0].bounds.right=NaN;},
    s=>{s.end.x=100000;},
  ]){const s=item();mutate(s);assert.equal(glyphTextureDescriptor([s],1),null);}
  const s=item();assert.equal(glyphTextureDescriptor([s,s],1),null);
  const g=glyphTextureDescriptor([s],2);assert.ok(g.width<=4096&&g.height<=4096);
  assert.ok(g.scaleX>=4&&g.scaleY>=4,'Mask preserves requested pixel density in both axes');
});

test('large glyph crops retain the full mask sampling grid under signed, rotated transforms',async()=>{
  for(const mirror of[0,1])for(const scale of[24,-24])for(const angle of[0,.43,Math.PI/2]){
    const s=item();s.seg.extra_u8_b=mirror;s.obj.scale=scale;s.angle=angle;
    s.end={x:s.start.x+480*Math.cos(angle),y:s.start.y+480*Math.sin(angle)};
    const full=glyphTextureDescriptor([s],4,8192),[ax,ay,bx,by]=full.axes;
    const center={x:full.x+(ax+bx)/2,y:full.y+(ay+by)/2},visible={x:center.x-20,y:center.y-20,width:40,height:40};
    const crop=cropGlyphTexture(full,visible);
    assert.ok(crop.bytes<full.bytes/2);assert.equal(crop.mask,full.mask);
    assert.equal(crop.scaleX,full.scaleX);assert.equal(crop.scaleY,full.scaleY);
    const dx=(crop.left-full.left)*full.scaleX,dy=(crop.top-full.top)*full.scaleY;
    assert.ok(Math.abs(dx-Math.round(dx))<1e-9);assert.ok(Math.abs(dy-Math.round(dy))<1e-9);
    assert.ok(Math.abs(crop.x-(full.x+ax*dx/full.width+bx*dy/full.height))<1e-9);
    assert.ok(Math.abs(crop.y-(full.y+ay*dx/full.width+by*dy/full.height))<1e-9);
    assert.deepEqual(crop.color,full.color);assert.notEqual(await glyphTextureKey(crop),await glyphTextureKey(full));
    const det=crop.axes[0]*crop.axes[3]-crop.axes[1]*crop.axes[2];
    for(const x of[visible.x,visible.x+visible.width])for(const y of[visible.y,visible.y+visible.height]){
      const u=((x-crop.x)*crop.axes[3]-(y-crop.y)*crop.axes[2])/det*crop.width;
      const v=((y-crop.y)*crop.axes[0]-(x-crop.x)*crop.axes[1])/det*crop.height;
      assert.ok(u>=2&&u<=crop.width-2&&v>=2&&v<=crop.height-2,'visible pixels retain filtering neighbors');
    }
    const near=cropGlyphTexture(full,{...visible,x:visible.x+.01,y:visible.y+.01});
    assert.equal(await glyphTextureKey(near),await glyphTextureKey(crop),'tiny camera movement keeps the crop variant');
  }
});

test('glyph crops preserve whole-mask sharing for small or mostly visible artwork',()=>{
  const small=glyphTextureDescriptor([item()],1);
  assert.equal(cropGlyphTexture(small,{x:0,y:0,width:1,height:1}),small);
  const s=item();s.obj.scale=24;s.end.x=490;
  const full=glyphTextureDescriptor([s],4,8192);
  assert.equal(cropGlyphTexture(full,null),full);
  assert.equal(cropGlyphTexture(full,{x:-1e6,y:-1e6,width:2e6,height:2e6}),full);
  assert.equal(cropGlyphTexture(full,{x:1e6,y:1e6,width:100,height:100}),null);
});
