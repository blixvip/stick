import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';
import {localizedText} from './localization-bindings.mjs';
import {drawExportScene} from './export-frame-core.mjs';
import {connectedVfxGeometry} from './vfx-connected.mjs';
import {activeVfx,vfxStack} from './vfx.mjs';
import {parallaxResolver} from './layer-parallax.mjs';
import {layerVisible} from './layers.mjs';
import {cameraValues} from './editor-camera.mjs';
import {cameraMatrix} from './renderer-geometry.mjs';
import {drawBackground, backgroundBounds} from './pivot/background.mjs';
import {buildGeometry,drawGeometry} from './pivot/geometry.mjs';
import {composeSceneGroups} from './scene-order.mjs';
import {canvasGenerators,canvasGeneratorWalker} from './vfx-generator-frame.mjs';
import {configureVfxSoftwareResources} from './vfx-canvas.mjs';
import {previewMemoryPlan} from './playback-budget.mjs';
import {formatPropertyValue} from './property-controls.mjs';
const playbackGeometry=new WeakMap();
const monitorSurfaces=new WeakMap();
const monitorStates=new WeakMap();

export function cameraMonitorVisible(canvas) {
  return Boolean(canvas && canvas.checkVisibility?.({contentVisibilityAuto:true,visibilityProperty:true}) !== false && canvas.clientWidth && canvas.clientHeight);
}

function monitorState(canvas, options) {
  let state=monitorStates.get(canvas);
  if(!state){
    state={retryAt:0};monitorStates.set(canvas,state);
    canvas.addEventListener?.('contextlost',()=>{state.lost=true;state.options.onRecovery?.('camera','started');});
    canvas.addEventListener?.('contextrestored',()=>{
      state.lost=false;state.retryAt=0;playbackGeometry.delete(canvas);state.options.onRecovery?.('camera','recovered');
      state.options.onInvalidate?.();
    });
  }
  if(state.options?.report!==options.report){state.retryAt=0;playbackGeometry.delete(canvas);}
  state.options=options;return state;
}
function reportMonitorError(error, options) {
  if(!error||typeof error!=='object')error=messageError(new Error(''), "errors.cameraMonitor.theCameraPreviewFailed", {});
  error.telemetryStage??='prepare';
  if(options.onError)options.onError(error);
  else globalThis.reportError?.(error);
}

/** Borrow software pixels directly, or use one small MSAA surface for GPU
 * presentation. Both paths reuse the renderer's admitted playback frame. */
class MonitorPreparedSource {
  constructor(renderer){
    this.renderer=renderer;
    if(renderer.softwarePlayback)return;
    this.canvas=new OffscreenCanvas(1,1);this.context=this.canvas.getContext('webgpu');
    renderer.device?.lost.then(()=>this.destroy());
  }
  destroy(){this.msaa?.destroy();this.msaa=null;this.context?.unconfigure();this.context=null;if(this.canvas)this.canvas.width=this.canvas.height=1;}
  render(ctx,{key,report,view,dpr,hiddenUids,hiddenKey}){
    const renderer=this.renderer;
    if(renderer.destroyed||renderer.deviceLost||!renderer?.renderPreparedInto)return false;
    if(renderer.softwarePlayback)return renderer.renderPreparedInto(key,{report,view,cameraEnabled:true,hiddenUids,hiddenKey,
      target:{context:ctx,dpr,clear:false}});
    if(!this.context)return false;
    const width=Math.max(1,Math.round(report.canvas_width*view.scale*dpr)),height=Math.max(1,Math.round(report.canvas_height*view.scale*dpr));
    const samples=renderer.msaaCount>1?renderer.msaaCount:0;
    if(this.width!==width||this.height!==height||this.msaaSamples!==samples){
      this.width=width;this.height=height;this.canvas.width=width;this.canvas.height=height;
      this.context.configure({device:renderer.device,format:renderer.format,alphaMode:'premultiplied'});
      this.msaa?.destroy();this.msaaSamples=samples;
      this.msaa=samples?renderer.device.createTexture({label:interfaceText("cameraMonitor.cameraMonitorMsaa"), labelKey: "cameraMonitor.cameraMonitorMsaa",size:[width,height],sampleCount:samples,format:renderer.format,usage:GPUTextureUsage.RENDER_ATTACHMENT}):null;
    }
    if(!renderer.renderPreparedInto(key,{report,view:{scale:width/report.canvas_width},target:{context:this.context,msaa:this.msaa,width,height},hiddenUids}))return false;
    ctx.drawImage(this.canvas,view.x,view.y,report.canvas_width*view.scale,report.canvas_height*view.scale);
    return true;
  }
}

/** Update only camera readouts, preserving focused inputs and their transaction. */
export function syncCameraControls(root, frame, {activeKey=null, guides=true}={}) {
  if(!root)return;
  const c=cameraValues(frame?.camera);
  const values={camera_x:c.x,camera_y:c.y,camera_scale:c.scale*100,camera_angle:c.angle_rad*180/Math.PI};
  for(const [key,value] of Object.entries(values)) {
    const input=root.querySelector(`[data-property="${key}"]`);
    if(!input || key===activeKey) continue;
    input.value=formatPropertyValue(value,Number(input.dataset.propertyDisplayPrecision??2));
    input.dataset.propertyValue=String(value);
  }
  const scale=root.querySelector('[data-camera-magnification]');
  if(scale) localizedText(scale, "cameraMonitor.zoom", {value: formatPropertyValue(100/c.scale,1)});
  root.querySelector('[data-action="camera-guides"]')?.setAttribute('aria-pressed',String(guides));
}

/** Draw on the app's animation frame, reusing evaluated geometry and media.
 * A prepared playback packet uses the renderer's presentation contract; other
 * states fall back to the Canvas 2D artwork path below. */
export function drawCameraMonitor(canvas, options) {
  let {report,frame,geometry,resources,hiddenUids,prepared}=options;
  if(!cameraMonitorVisible(canvas) || !report || !frame) return false;
  const state=monitorState(canvas,options);
  if(state.lost || performance.now()<state.retryAt)return false;
  try {
  const width=canvas.clientWidth, height=canvas.clientHeight, dpr=Math.min(globalThis.devicePixelRatio || 1,2);
  if(canvas.width!==Math.round(width*dpr) || canvas.height!==Math.round(height*dpr)) {
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  }
  const ctx=canvas.getContext('2d',{willReadFrequently:true}), scale=Math.min(width/report.canvas_width,height/report.canvas_height);
  if(!ctx || ctx.isContextLost?.())throw Object.assign(messageError(new Error(''), "errors.cameraMonitor.theCameraPreviewCanvasIsUnavailable", {}),{telemetryCode:'device_lost'});
  configureVfxSoftwareResources(ctx,{maxBytes:options.maxSoftwareFilterBytes??previewMemoryPlan().editorSoftwareFilters});
  const view={scale,x:(width-report.canvas_width*scale)/2,y:(height-report.canvas_height*scale)/2};
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  if(prepared){
    let source=monitorSurfaces.get(prepared.renderer);
    if(!source){source=new MonitorPreparedSource(prepared.renderer);monitorSurfaces.set(prepared.renderer,source);}
    if(source.render(ctx,{key:prepared.key,report,view,dpr,hiddenUids,hiddenKey:prepared.hiddenKey})){if(state.retryAt)options.onRecovery?.('camera','recovered');state.retryAt=0;return true;}
  }
  if(!geometry) {
    let cached=playbackGeometry.get(canvas);
    if(cached?.frame!==frame || cached?.report!==report) {
      cached={frame,report,geometry:buildGeometry(report,frame)};playbackGeometry.set(canvas,cached);
    }
    geometry=cached.geometry;
  } else playbackGeometry.delete(canvas);
  geometry=connectedVfxGeometry(geometry,frame,report,hiddenUids);
  if(activeVfx(vfxStack(frame)).length){
    const surface=state.effects??=new OffscreenCanvas(1,1),w=Math.max(1,Math.round(report.canvas_width*scale*dpr)),h=Math.max(1,Math.round(report.canvas_height*scale*dpr));
    if(surface.width!==w)surface.width=w;if(surface.height!==h)surface.height=h;
    const effectContext=surface.getContext('2d');configureVfxSoftwareResources(effectContext,{owner:ctx});
    drawExportScene(effectContext,report,frame,{...geometry,drawables:geometry.drawables.filter(item=>!hiddenUids?.has(item.obj.unique_id)&&layerVisible(report,item.obj.unique_id))},resources);
    ctx.drawImage(surface,view.x,view.y,report.canvas_width*scale,report.canvas_height*scale);state.retryAt=0;return true;
  }
  ctx.save();
  try {
  ctx.beginPath();ctx.rect(view.x,view.y,report.canvas_width*scale,report.canvas_height*scale);ctx.clip();
  ctx.transform(...cameraMatrix({report,frame,view,cameraEnabled:true}));
  drawBackground(ctx,report,frame,report.canvas_width,report.canvas_height,
    {...resources,bounds:backgroundBounds(frame,report.canvas_width,report.canvas_height,true,report)});
  const parallax=parallaxResolver(report,frame);
  const walker=canvasGeneratorWalker(canvasGenerators(report,frame,geometry,parallax,{hidden:{has:uid=>hiddenUids?.has(uid)||!layerVisible(report,uid)}}),ctx);
  walker?.begin();
  for(const group of composeSceneGroups(geometry,[],frame)) {
    if(hiddenUids?.has(group.g.obj.unique_id)||!layerVisible(report,group.g.obj.unique_id)) continue;
    walker?.object(group.g.obj.unique_id);
    ctx.save();try {ctx.globalAlpha=group.opacity;const depth=parallax(group.g.obj.unique_id);ctx.translate(depth.x,depth.y);drawGeometry(ctx,{drawables:group.items},resources);}finally{ctx.restore();}
  }
  walker?.end();
  } finally {ctx.restore();}
  if(state.retryAt)options.onRecovery?.('camera','recovered');state.retryAt=0;return true;
  } catch(error) {
    // The monitor is auxiliary. A failure must not abort the editor's frame or
    // re-evaluate a dense scene again on every animation frame.
    state.retryAt=performance.now()+1500;
    options.onRecovery?.('camera','started');
    if(prepared){monitorSurfaces.get(prepared.renderer)?.destroy();monitorSurfaces.delete(prepared.renderer);}
    playbackGeometry.delete(canvas);
    reportMonitorError(error,options);return false;
  }
}
