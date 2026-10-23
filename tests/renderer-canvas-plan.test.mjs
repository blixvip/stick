import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasCoverageBounds,canvasBoundsOutside,canvasArtworkCropSafe,canvasArtworkPlan,canvasArtworkPlanWithin,canvasGestureStandIn,canvasLayerBounds} from '../src/renderer-canvas-plan.mjs';
import {rasterCovers,gestureProxyResolution,GESTURE_STAND_IN_PIXELS} from '../src/raster-view.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';

const bounds={x:0,y:0,width:1000,height:800};
test('compatibility coverage remains conservative for square caps and minified edges',()=>{
  const coverage=canvasCoverageBounds([{type:'line',obj:{scale:1},thickness:20,seg:{segment_kind:'squareLine'}}],bounds);
  assert.deepEqual(coverage,{x:-20,y:-20,width:1040,height:840});
  assert.equal(canvasBoundsOutside(coverage,{x:1015,y:0,width:50,height:50}),false);
  assert.equal(canvasBoundsOutside(coverage,{x:1025,y:0,width:50,height:50}),true);
  assert.equal(canvasBoundsOutside(bounds,{x:1010,y:0,width:50,height:50},20),false);
  assert.equal(canvasBoundsOutside(null,{x:2000,y:0,width:50,height:50}),false);
});

test('unknown media, nested clips and depth retain the complete Canvas painter',()=>{
  for(const item of [{type:'image',asset:{width:100,height:80}},{type:'text',asset:{}},{type:'mesh'},
    {type:'poly',poly:{_stykSurface:{depthTest:true}}},{type:'line',_movieclipOwner:{}},{type:'futurePrimitive'}]){
    assert.equal(canvasCoverageBounds([item],bounds),null);
  }
  assert.ok(canvasCoverageBounds([{type:'image',asset:{display_width:100,display_height:80}}],bounds));
  assert.ok(canvasCoverageBounds([{type:'image',fig:createDrawingFigure({celId:'bounded',figureTypeId:1})}],bounds));
  assert.ok(canvasCoverageBounds([{type:'text',asset:{bounds:{width:100,height:80}}}],bounds));
});

test('ordinary zoom crops substantial off-screen artwork on its original grid',()=>{
  const visible={x:650,y:300,width:200,height:150},resolution=1.25;
  const crop=canvasArtworkPlan(bounds,visible,resolution,{safe:true});
  assert.equal(crop.cropped,true);assert.equal(crop.pixelScale,resolution);
  assert.ok(crop.pixelWidth*crop.pixelHeight<crop.fullPixels*.6);
  assert.ok(rasterCovers(crop,bounds,visible));
  assert.equal((crop.x-bounds.x)*resolution%1,0);
  assert.equal((crop.y-bounds.y)*resolution%1,0);
  assert.equal(canvasArtworkPlan(bounds,visible,resolution,{safe:false}),undefined);
  assert.equal(canvasArtworkPlan({x:0,y:0,width:100,height:80},visible,1,{safe:true}),undefined);
  assert.equal(canvasArtworkPlan(bounds,{x:0,y:0,width:950,height:780},1,{safe:true}),undefined);
});

test('ordinary native paths and glyphs retain their complete Canvas source domain',()=>{
  const visible={x:650,y:300,width:200,height:150},resolution=1.25;
  for(const items of [[{type:'line'}],[{type:'circle'}],[{type:'poly'}],[{type:'text',asset:{bounds}}],
    [{type:'image',asset:{display_width:1000,display_height:800}},{type:'line'}]]){
    assert.ok(canvasCoverageBounds(items,bounds),'Native coverage remains available for culling.');
    assert.equal(canvasArtworkCropSafe(items),false);
    assert.equal(canvasArtworkPlan(bounds,visible,resolution,{safe:canvasArtworkCropSafe(items)}),undefined);
    assert.equal(canvasArtworkPlan(bounds,visible,16,{safe:canvasArtworkCropSafe(items)}).cropped,true,
      'Required high-density cropping remains bounded.');
  }
  assert.equal(canvasArtworkCropSafe([]),false);
  assert.equal(canvasArtworkCropSafe([{type:'image',asset:{width:1000,height:800}}]),false);
  for(const items of [[{type:'image',asset:{display_width:1000,display_height:800}}],
    [{type:'image',fig:createDrawingFigure({celId:'verified',figureTypeId:1})}]]){
    assert.equal(canvasArtworkCropSafe(items),true);
    assert.equal(canvasArtworkPlan(bounds,visible,resolution,{safe:canvasArtworkCropSafe(items)}).cropped,true);
  }
});

test('gesture layers crop transformed device extents, preserving uncertain and off-screen coverage',()=>{
  assert.deepEqual(canvasLayerBounds([{x:100,y:50,width:80,height:60}],[2,0,0,2,10,20],8000,6000),
    {x:208,y:118,width:164,height:124});
  assert.deepEqual(canvasLayerBounds([{x:100,y:50,width:80,height:60}],[2,0,0,2,10,20],8000,6000,0,true),
    {x:0,y:0,width:372,height:242},'Exact editing keeps cached-image sampling at the destination origin.');
  assert.deepEqual(canvasLayerBounds([{x:100,y:50,width:80,height:60}],[0,2,-2,0,400,0],800,600),
    {x:178,y:198,width:124,height:164});
  assert.deepEqual(canvasLayerBounds([null],[2,0,0,2,10,20],800,600,40),{x:-40,y:-40,width:880,height:680});
  assert.deepEqual(canvasLayerBounds([{x:10000,y:10000,width:10,height:10}],[1,0,0,1,0,0],800,600),{x:0,y:0,width:1,height:1});
  assert.deepEqual(canvasLayerBounds([],[1,0,0,1,0,0],800,600),{x:0,y:0,width:1,height:1});
});

test('a raster allowance lowers the planned density until the raster fits and keeps cropping to the view',()=>{
  const visible={x:650,y:300,width:200,height:150},area=plan=>plan.pixelWidth*plan.pixelHeight;
  // Within the allowance the ordinary plan is unchanged.
  const ordinary=canvasArtworkPlan(bounds,visible,24,{});
  assert.deepEqual(canvasArtworkPlanWithin(bounds,visible,24,{maxPixels:Infinity}),{plan:ordinary,density:24});
  // Over the allowance the raster stays a crop of the view, at a lower density,
  // including below the density at which ordinary detail would stop cropping.
  const large={x:0,y:0,width:10000,height:6000},view={x:4100,y:2900,width:400,height:300};
  for(const [resolution,maxPixels] of [[24,2e6],[6,2e6],[3,4e5]]){
    const fitted=canvasArtworkPlanWithin(large,view,resolution,{maxPixels});
    assert.ok(fitted.density<resolution,resolution);
    assert.ok(fitted.plan.cropped&&area(fitted.plan)<=maxPixels&&area(fitted.plan)>maxPixels/2,`${resolution}: the crop uses most of its allowance`);
    assert.ok(rasterCovers(fitted.plan,large,view),'The reduced crop still covers the view.');
  }
  // Artwork that is entirely in view scales as a whole.
  const small={x:0,y:0,width:100,height:80},whole=canvasArtworkPlanWithin(small,{x:-10,y:-10,width:200,height:200},6,{maxPixels:40000});
  assert.equal(whole.plan?.cropped??false,false);assert.ok(whole.density<6&&whole.plan.pixelWidth*whole.plan.pixelHeight<=40000);
  assert.equal(canvasArtworkPlanWithin(bounds,{x:5000,y:5000,width:10,height:10},24,{maxPixels:1000}).plan,null);
});

test('Canvas pans crop a stand-in only where settled detail crops; zooming out shows the whole artwork',()=>{
  const large={x:0,y:0,width:10000,height:6000},view={x:4100,y:2900,width:40,height:20},area=plan=>plan.pixelWidth*plan.pixelHeight;
  const pan=canvasGestureStandIn(large,view,64,false,4*1024*1024,3);
  assert.ok(pan.plan.cropped&&area(pan.plan)<=GESTURE_STAND_IN_PIXELS&&rasterCovers(pan.plan,large,view));
  assert.ok(area(canvasGestureStandIn(large,view,64,false,1<<18,3).plan)<=1<<18,'A shared allowance bounds the crop.');
  assert.deepEqual(canvasGestureStandIn(large,view,64,true,4*1024*1024,3),{plan:undefined,density:gestureProxyResolution(64,large,4096,4*1024*1024)});
  // Settled artwork at an ordinary density is whole: a crop would stay in its place.
  const small={x:0,y:0,width:300,height:200};
  assert.deepEqual(canvasGestureStandIn(small,{x:100,y:50,width:40,height:30},4,false,1<<20),{plan:undefined,density:4});
});

