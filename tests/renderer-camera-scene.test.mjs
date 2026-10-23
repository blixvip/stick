import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraSceneDrawables,cameraRefinementScene} from '../src/renderer-camera-scene.mjs';
import {createLayerState} from '../src/layers.mjs';

function fixture(){
  const obj={unique_id:1,root_x:10,root_y:20},item={type:'line',slot:0,obj,start:{x:10,y:20},end:{x:30,y:40},points:[{x:10,y:20}],seg:{}};
  return {report:{canvas_width:320,canvas_height:240,backgrounds:[{background_id:0,kind:2,color:0xff123456}],
    figure_types:[{privateDefinition:true}],keyframes:[{privateAnimation:true}],_styk:{layers:createLayerState()}},
    frame:{objects:[obj],background_id:0,camera:{x:20,y:0,scale:1}},geometry:{drawables:[item],objects:new Map([[0,{obj,drawables:[item]}]])},generatorBatch:null};
}
test('camera scene capture keeps only native evaluated camera/effects and referenced vector backgrounds',()=>{
  const options=fixture(),scene=cameraRefinementScene(options,options.geometry.drawables);
  assert.deepEqual(scene.report,{canvas_width:320,canvas_height:240,backgrounds:options.report.backgrounds});
  assert.equal(scene.frame.objects,undefined);assert.deepEqual(scene.frame.camera,options.frame.camera);
  assert.equal(scene.report.figure_types,undefined);assert.equal(scene.report.keyframes,undefined);assert.equal(scene.report._styk,undefined);
});
test('native camera filtering and drag translation preserve the original pose',()=>{
  const options=fixture(),item=options.geometry.drawables[0];options.dragTranslations=new Map([[1,{x:3,y:-2}]]);
  const items=cameraSceneDrawables(options);assert.deepEqual(items[0].start,{x:13,y:18});assert.deepEqual(items[0].end,{x:33,y:38});
  assert.deepEqual(items[0].points,[{x:13,y:18}]);assert.deepEqual(item.start,{x:10,y:20});
  options.hiddenUids=new Set([1]);assert.deepEqual(cameraSceneDrawables(options),[]);
});
test('unsupported media, depth, diamond brushes and generated painters keep native preparation',()=>{
  for(const patch of [{type:'image'},{type:'mesh'},{type:'poly',poly:{_stykSurface:{depthTest:true}}},{seg:{paint:{type:'diamond'}}}]){
    const options=fixture();Object.assign(options.geometry.drawables[0],patch);assert.equal(cameraRefinementScene(options,options.geometry.drawables),null);
  }
  for(const background of [{kind:1,data_url:'data:image/png;base64,private'},{paint:{type:'diamond'}}]){
    const options=fixture();Object.assign(options.report.backgrounds[0],background);assert.equal(cameraRefinementScene(options,options.geometry.drawables),null);
  }
  for(const generatorBatch of [{particles:1},{draws:[{}]},{incomplete:true}]){
    const options=fixture();options.generatorBatch=generatorBatch;assert.equal(cameraRefinementScene(options,options.geometry.drawables),null);
  }
});
test('actual nonzero parallax stays native while fixed scene/camera visibility is baked into metadata',()=>{
  const options=fixture();options.report._styk.layers.byId['layer-1'].parallax={enabled:true,linked:true,x:.5,y:.5,reference:{x:0,y:0}};
  assert.equal(cameraRefinementScene(options,options.geometry.drawables),null);
  options.report._styk.layers.fixed.camera.visible=false;options.report._styk.layers.fixed.scene.visible=false;
  const scene=cameraRefinementScene(options,options.geometry.drawables);assert.equal(scene.frame.camera,null);assert.equal(scene.frame._stykBackgroundColor,0);
  assert.deepEqual(scene.report.backgrounds,[]);
});

test('scene capture accepts only current published V2 drawing presenters',()=>{
  const options=fixture(),item=options.geometry.drawables[0];
  item.type='image';item.fig={_styk:{drawing:{version:2,celId:'cel-camera',revision:3}},image_assets:[{styk_tiles:'published-tiles'}]};
  const entry={id:'cel-camera',revision:3,store:{},published:{revision:3,url:'published-tiles'},deferred:[]},resources={drawing:()=>entry};
  const scene=cameraRefinementScene(options,[item],resources);
  assert.ok(scene);assert.equal(scene.report.figure_types,undefined);assert.equal(scene.frame.objects,undefined);
  assert.equal(cameraRefinementScene(options,[item]),null,'A tile publication cannot replace missing live authority.');
  for(const [key,value] of [['pinned',true],['transient',true],['loading',{}],['deferred',[{}]],['revision',4],['store',null],['id','other']]){
    const prior=entry[key];entry[key]=value;assert.equal(cameraRefinementScene(options,[item],resources),null,key);entry[key]=prior;
  }
  entry.published={revision:2,url:'published-tiles'};assert.equal(cameraRefinementScene(options,[item],resources),null);
  entry.published={revision:3,url:'different-tiles'};assert.equal(cameraRefinementScene(options,[item],resources),null);
  delete entry.published;assert.ok(cameraRefinementScene(options,[item],resources),'An immutable provider owns its matching revision without a live publication field.');
  item.fig._styk.drawing.version=1;assert.equal(cameraRefinementScene(options,[item],resources),null);
});
