/** Compare retained-pose patches with independent full worker snapshots. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs'),{emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {ThumbnailRenderer}=await import('/src/thumbnail-renderer.mjs');
    const report=emptyDocument();report.canvas_width=320;report.canvas_height=180;
    const figure=report.figure_types[0];figure.segments=[{...figure.segments[0],length:40,angle_rad:0,thickness:8,color_rgb:[0,0,0]}];figure.segment_count=1;
    report.keyframes=[30,130,230].map(x=>createFrame([createObject(figure,1,x,90)],100));
    const editor=new Editor({demo:false,layerTimeline:true}).load(report);
    editor.sheetInsertKey(['layer-1'],50);editor.sheetInsertKey(['layer-1'],150);
    const renderer=new ThumbnailRenderer(editor),checks=[],stats=[];
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    canvas.style.cssText='position:fixed;left:50px;top:100px;z-index:9999;border:2px solid blue';document.body.append(canvas);
    const pixels=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    const verify=async(name,tick=50)=>{
      const fresh=new ThumbnailRenderer(editor),reference=document.createElement('canvas');reference.width=320;reference.height=180;
      try {
        if(!await renderer.renderThumbnail(0,canvas,{tick})||!await fresh.renderThumbnail(0,reference,{tick}))throw new Error(name+': no preview');
        const actual=pixels(canvas),expected=pixels(reference);
        if(actual.some((value,i)=>value!==expected[i]))throw new Error(name+': differs from full snapshot');
        if(!actual.some((value,i)=>i%4!==3&&value<100))throw new Error(name+': blank preview');
        checks.push(name);stats.push({name,...renderer.stats});return [...actual].join();
      }finally{fresh.destroy();}
    };
    try {
      const before=await verify('Initial retained poses');
      editor.seek(50);editor.select(1);editor.updateObject({root_x:180});
      const edited=await verify('Edited pose equals full snapshot');if(edited===before)throw new Error('Pose did not change');
      if(renderer.stats.sourceUpserts!==1||renderer.stats.snapshots!==1)throw new Error('Edit must patch only one pose');
      editor.undo();if(await verify('Undo restores exact pixels')!==before)throw new Error('Undo mismatch');
      editor.redo();if(await verify('Redo restores exact pixels')!==edited)throw new Error('Redo mismatch');
      editor.sheetInsertKey(['layer-1'],75);await verify('New key source',75);
      editor.undo();await verify('Undo prunes inserted source',75);
      editor.report.figure_types[0].segments[0].color_rgb=[250,20,20];editor._emit('edit',{definition:true});
      await verify('Definition edit retains historical poses');
      editor.load(structuredClone(report));await verify('Document replacement rebuilds mirror');
      return {checks,stats};
    } finally {renderer.destroy();}
  });
  assert.deepEqual(errors,[]);
  await mkdir('artifacts/thumbnail-source-patches',{recursive:true});
  await page.screenshot({path:'artifacts/thumbnail-source-patches/preview.png'});
  await writeFile('artifacts/thumbnail-source-patches/report.json',JSON.stringify({...result,errors},null,2));
  console.log(result.checks.map(name=>'PASS '+name).join('\n'));
}finally{await browser.close();}
