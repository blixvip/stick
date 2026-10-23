import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraMonitorVisible,drawCameraMonitor} from '../src/camera-monitor.mjs';

test('collapsed camera monitors do not evaluate or rasterize a scene',()=>{
  const canvas={clientWidth:320,clientHeight:180,checkVisibility:()=>false,getContext(){throw Error('Hidden monitor rendered');}};
  assert.equal(cameraMonitorVisible(canvas),false);
  assert.equal(drawCameraMonitor(canvas,{report:{},frame:{}}),false);
  assert.equal(cameraMonitorVisible({...canvas,checkVisibility:()=>true}),true);
  assert.equal(cameraMonitorVisible({clientWidth:0,clientHeight:180}),false);
});

test('software camera monitors borrow prepared pixels without a GPU surface or scene evaluation',()=>{
  const report={canvas_width:640,canvas_height:400},calls=[];
  const context={setTransform(){},clearRect(){}};
  const canvas={clientWidth:320,clientHeight:240,getContext:type=>{assert.equal(type,'2d');return context;}};
  const renderer={softwarePlayback:true,renderPreparedInto(key,options){calls.push({key,options});return true;}};
  const options={report,frame:{},prepared:{renderer,key:'1:3',hiddenKey:'hidden-4'},hiddenUids:new Set([4])};
  options.geometry={get drawables(){throw Error('Prepared playback painted geometry.');}};
  assert.equal(drawCameraMonitor(canvas,options),true);
  assert.equal(calls.length,1);assert.equal(calls[0].key,'1:3');
  const forwarded=calls[0].options;
  assert.equal(forwarded.report,report);assert.equal(forwarded.target.context,context);assert.equal(forwarded.target.clear,false);
  assert.equal(forwarded.cameraEnabled,true);assert.equal(forwarded.hiddenKey,'hidden-4');assert.equal(forwarded.hiddenUids,options.hiddenUids);
  assert.deepEqual(forwarded.view,{scale:.5,x:0,y:20});
});
