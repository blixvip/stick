import {messageError} from './localized-error.mjs';
/** Coordinates one cancellable return to the editable canvas. Preparation never
 * records an edit, moves the playhead, or publishes a superseded scene. */
export class EditableScenePreparation {
  constructor(editor,{onPending=()=>{},onReady=()=>{},onError=()=>{},diagnostics}={}){
    Object.assign(this,{editor,onPending,onReady,onError,diagnostics});this.job=null;this.stats=null;
  }
  get pending(){return Boolean(this.job);}
  cancel(){
    const job=this.job;if(!job)return;
    this.job=null;job.controller.abort();job.prepared?.dispose();
    this.stats={...job.timings,cancelled:true,elapsedMs:performance.now()-job.started};this.onPending(false);
  }
  start(renderer,getOptions){
    this.cancel();const editor=this.editor,report=editor.report,tick=editor.tick,revision=editor.revision,draftRevision=editor.frameDraftRevision;
    const job={controller:new AbortController(),started:performance.now(),timings:{},diagnosticGeneration:this.diagnostics?.generation,context:this.diagnostics?.enabled?this.diagnostics.context():null};this.job=job;this.onPending(true);
    const checkCurrent=()=>this.job===job&&editor.report===report&&editor.tick===tick&&editor.revision===revision&&editor.frameDraftRevision===draftRevision;
    job.promise=(async()=>{
      // Capture the final seek/draft state without delaying every scrub request
      // by a display frame. The bounded geometry and GPU slices yield as needed.
      await Promise.resolve();
      if(!checkCurrent())throw messageError(new DOMException('', 'AbortError'), "errors.editableScenePreparation.editablePreparationWasCancelled", {});
      const geometry=await editor.prepareGeometry({signal:job.controller.signal,checkCurrent,onTiming:value=>{job.timings.geometry=value;}});
      if(!checkCurrent())throw messageError(new DOMException('', 'AbortError'), "errors.editableScenePreparation.editablePreparationWasSuperseded", {});
      const options=getOptions(geometry);
      job.prepared=await renderer.prepareSceneUpdate({...options,report,geometry,signal:job.controller.signal,checkCurrent});
      if(!checkCurrent())throw messageError(new DOMException('', 'AbortError'), "errors.editableScenePreparation.editablePreparationWasSuperseded", {});
      job.prepared.activate();job.timings.gpu=job.prepared.timings;
      this.stats={...job.timings,completed:true,elapsedMs:performance.now()-job.started};
      if(job.context&&this.diagnostics?.enabled&&job.diagnosticGeneration===this.diagnostics.generation){
        this.diagnostics.record('geometry',job.timings.geometry?.elapsedMs,job.context);
        this.diagnostics.record('prepare',job.timings.gpu?.elapsedMs,job.context);
      }
      this.job=null;this.onPending(false);this.onReady();return true;
    })().catch(error=>{
      job.prepared?.dispose();
      if(this.job===job){
        this.job=null;this.stats={...job.timings,cancelled:error.name==='AbortError',error:error.name==='AbortError'?undefined:error.message,elapsedMs:performance.now()-job.started};
        this.onPending(false);this.onReady();
        if(error.name!=='AbortError')this.onError(error);
      }
      return false;
    });
    return job.promise;
  }
}
