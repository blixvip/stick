import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
// Krita-parity drawing tools: selection shapes and modes clip painting and
// fills, magic wand, fill selection, symmetry, straight lines, colour picking,
// brush resizing, view flipping, blend modes and alpha lock — driven through
// real pointer and keyboard input.
const output=path.resolve(process.env.STYK_TOOLS_ARTIFACTS||'artifacts/drawing-tools'),url=process.env.STYK_URL||'http://127.0.0.1:47839';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.stack));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
const settle=()=>page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.loading&&!styk.drawing.operation);
try{
  await page.goto(url);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{styk.state.settings.autosaveSeconds=0;});
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.locator('[data-draw-action="new"]').first().click();
  const box=await page.locator('#viewport').boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height/2;
  // Screen ↔ cel pixel helpers evaluated in the page.
  await page.evaluate(()=>{
    window.store=()=>styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store;
    window.alphaAt=(clientX,clientY)=>{const d=styk.drawing,t=styk.editor.drawingTarget();if(!t.figure)return 0;const p=d.pixel({clientX,clientY},t);return store().pixel(Math.floor(p.x),Math.floor(p.y))[3];};
    window.rgbAt=(clientX,clientY)=>{const d=styk.drawing,t=styk.editor.drawingTarget(),p=d.pixel({clientX,clientY},t);return store().pixel(Math.floor(p.x),Math.floor(p.y));};
  });
  const stroke=async(points,{modifiers=[]}={})=>{for(const key of modifiers)await page.keyboard.down(key);await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();for(const p of points.slice(1))await page.mouse.move(p.x,p.y,{steps:4});await page.mouse.up();for(const key of modifiers)await page.keyboard.up(key);await settle();};
  const line=(x0,y0,x1,y1,n=12)=>Array.from({length:n+1},(_,i)=>({x:x0+(x1-x0)*i/n,y:y0+(y1-y0)*i/n}));

  // Presets and painting modes.
  await page.locator('[data-tool="drawing-brush"]').click();
  check('fourteen brush presets are offered',await page.locator('[data-draw-preset]').count()===14);
  await page.locator('[data-draw-preset="calligraphy"]').click();
  check('the nib preset sets a flat, angled tip',await page.evaluate(()=>styk.drawing.settings.roundness===.2&&styk.drawing.settings.angle===40));
  await page.locator('[data-draw-preset="ink"]').click();
  await page.locator('select[data-draw-setting="blend"]').selectOption('multiply');
  check('the blend mode select stores its named mode',await page.evaluate(()=>styk.drawing.settings.blend==='multiply'));
  await page.locator('select[data-draw-setting="blend"]').selectOption('normal');
  await page.evaluate(()=>Object.assign(styk.drawing.settings,{size:10,color:'#202020',opacity:1,flow:1,hardness:1,stabilization:0}));

  // The canvas quick bar and Krita-style sliders.
  const quickSize=page.locator('.drawing-quickbar [data-draw-slider="size"]');
  await page.waitForSelector('.drawing-quickbar:not([hidden]) [data-draw-slider="size"]');
  const qb=await quickSize.boundingBox();
  await page.mouse.move(qb.x+4,qb.y+qb.height/2);await page.mouse.down();await page.mouse.move(qb.x+qb.width*.62,qb.y+qb.height/2,{steps:6});
  check('dragging the quick bar size slider resizes the brush live with a readout',await page.evaluate(()=>styk.drawing.settings.size>40&&document.querySelector('.drawing-hud.is-visible')?.textContent.startsWith('Size')));
  await page.mouse.up();
  check('Properties does not duplicate the quick bar size slider',await page.locator('#inspector [data-draw-slider="size"]').count()===0);
  await quickSize.dblclick();await page.keyboard.type('12');await page.keyboard.press('Enter');await settle();
  check('double-clicking a slider types an exact value',await page.evaluate(()=>styk.drawing.settings.size===12));
  await quickSize.hover();await page.mouse.wheel(0,-100);
  check('the wheel steps a quick bar slider',await page.evaluate(()=>styk.drawing.settings.size>12));
  await page.locator('#viewport').focus();await page.keyboard.press('5');
  check('number keys set brush opacity like Photoshop',await page.evaluate(()=>styk.drawing.settings.opacity===.5));
  await page.keyboard.press('0');await page.keyboard.press('Shift+BracketLeft');
  check('Shift+[ softens the brush',await page.evaluate(()=>styk.drawing.settings.opacity===1&&Math.abs(styk.drawing.settings.hardness-.9)<1e-9));
  await page.locator('.drawing-quickbar [data-draw-action="toggle-quick-presets"]').click();
  await page.locator('.drawing-quickbar [data-draw-preset="pencil"]').click();
  check('the quick bar picks presets from thumbnails',await page.evaluate(()=>styk.drawing.settings.preset==='pencil'&&!styk.drawing.quickPresets));
  check('the quick bar names its tool',await page.locator('.drawing-quickbar .draw-quick-tool').innerText()==='Brush');
  // The colour picker applies live while dragging and keeps working after the
  // bar re-renders under it; recent colours in the bar apply in one click.
  await page.locator('.drawing-quickbar .draw-color-primary').click();
  const sv=await page.locator('.paint-picker .paint-sv').boundingBox(),swatch=await page.locator('.drawing-quickbar .draw-color-primary').boundingBox();
  check('the drawing colour picker opens below the bar',sv.y>swatch.y+swatch.height&&await page.locator('.paint-picker header strong').innerText()==='Color');
  const firstColor=await page.evaluate(()=>styk.drawing.settings.color);
  await page.mouse.move(sv.x+sv.width*.2,sv.y+sv.height*.2);await page.mouse.down();await page.mouse.move(sv.x+sv.width*.8,sv.y+sv.height*.3,{steps:5});
  const liveColor=await page.evaluate(()=>styk.drawing.settings.color);await page.mouse.up();
  await page.mouse.click(sv.x+sv.width*.9,sv.y+sv.height*.9);
  const secondPick=await page.evaluate(()=>styk.drawing.settings.color);
  const pickerError=await page.locator('.paint-picker .paint-error').innerText();await page.waitForTimeout(50);
  const barSwatch=await page.locator('.drawing-quickbar .draw-color-primary').inputValue();
  check('the colour picker applies live and after the bar re-renders',liveColor!==firstColor&&secondPick!==liveColor&&!pickerError&&barSwatch===secondPick,{pickerError,barSwatch,secondPick});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{styk.drawing.library.recent=['#10a0e0','#e04010'];styk.drawing.onUI();});
  await page.locator('.drawing-quickbar .draw-quick-swatch[data-draw-color="#e04010"]').click();
  check('recent colours in the bar apply in one click',await page.evaluate(()=>styk.drawing.settings.color==='#e04010'));
  // Right-click opens Krita's pop-up palette at the pointer.
  await page.mouse.click(cx+150,cy+150,{button:'right'});
  check('right-click opens the pop-up palette',await page.locator('.drawing-palette:not([hidden])').isVisible());
  await page.locator('.drawing-palette [data-draw-preset="marker"]').click();
  check('choosing a preset in the palette applies it and closes the palette',await page.evaluate(()=>styk.drawing.settings.preset==='marker'&&document.querySelector('.drawing-palette').hidden));
  await page.mouse.click(cx+150,cy+150,{button:'right'});await page.keyboard.press('Escape');
  check('Escape closes the palette without painting',await page.evaluate(()=>document.querySelector('.drawing-palette').hidden&&!styk.drawing.gesture));
  await page.locator('[data-draw-preset="ink"]').first().click();
  await page.evaluate(()=>Object.assign(styk.drawing.settings,{size:10,color:'#202020',opacity:1,flow:1,hardness:1,stabilization:0}));
  // Base artwork: a horizontal band.
  await stroke(line(cx-300,cy,cx+300,cy));
  check('the base stroke painted',await page.evaluate(({x,y})=>alphaAt(x,y)===255,{x:cx,y:cy}));

  // Rectangle selection clips painting.
  await page.locator('[data-tool="drawing-lasso"]').click();
  await page.locator('.drawing-quickbar [data-draw-choice="selectShape"][data-value="rect"]').click();
  await stroke([{x:cx-100,y:cy-120},{x:cx+100,y:cy+120}]);
  check('a rectangle selection creates an outline',await page.evaluate(()=>Boolean(styk.drawing.marquee)&&styk.drawing.marquee.mask.width>100));
  // The artwork stays on screen while a selection exists: the selection
  // preview once reported no extent, and the whole cel vanished until Enter.
  const onScreen=await page.evaluate(({x,y})=>new Promise(resolve=>{const r=styk.state.renderer,scene=document.querySelector('#scene'),render=r.render;
    r.render=function(...a){const v=render.apply(this,a);r.render=render;const b=scene.getBoundingClientRect(),c=new OffscreenCanvas(1,1),g=c.getContext('2d');g.drawImage(scene,Math.round((x-b.left)*scene.width/b.width),Math.round((y-b.top)*scene.height/b.height),1,1,0,0,1,1);resolve([...g.getImageData(0,0,1,1).data]);return v;};styk.drawing.onRender();}),{x:cx,y:cy});
  check('the selected artwork stays on screen while the selection is active',onScreen[0]<90&&onScreen[3]>200);
  await page.locator('[data-tool="drawing-brush"]').click();
  check('switching tools keeps the untouched selection outline',await page.evaluate(()=>Boolean(styk.drawing.marquee)&&!styk.drawing.selection));
  await stroke(line(cx-250,cy-60,cx+250,cy-60));
  check('painting stays inside the selection',await page.evaluate(({cx,cy})=>alphaAt(cx,cy-60)===255&&alphaAt(cx-200,cy-60)===0&&alphaAt(cx+200,cy-60)===0,{cx,cy}));
  // Fill inside the selection stays inside it.
  await page.locator('[data-tool="drawing-fill"]').click();
  await page.evaluate(()=>{styk.drawing.settings.color='#3060d0';styk.drawing.settings.gap=0;});
  await page.mouse.click(cx+40,cy+80);await page.waitForFunction(()=>!styk.drawing.fillAbort);
  check('fill is clipped by the selection',await page.evaluate(({cx,cy})=>rgbAt(cx+40,cy+80)[2]>150&&alphaAt(cx+160,cy+80)===0,{cx,cy}));
  await page.keyboard.press('Control+z');

  // Select all, invert, deselect through the drawing shortcuts.
  await page.locator('#viewport').focus();
  await page.keyboard.press('Control+a');await page.waitForFunction(()=>Boolean(styk.drawing.marquee));
  const all=await page.evaluate(()=>styk.drawing.marquee.mask.width*styk.drawing.marquee.mask.height);
  await page.keyboard.press('Control+Shift+I');
  check('Ctrl+A selects everything and Ctrl+Shift+I inverts it to nothing',all>10000&&await page.evaluate(()=>!styk.drawing.marquee));
  await page.keyboard.press('Control+a');await page.keyboard.press('Control+Shift+A');
  check('Ctrl+Shift+A deselects',await page.evaluate(()=>!styk.drawing.marquee&&!styk.drawing.selection));

  // Add and subtract.
  await page.locator('[data-tool="drawing-lasso"]').click();
  await stroke([{x:cx-150,y:cy-40},{x:cx-50,y:cy+40}]);
  await stroke([{x:cx+50,y:cy-40},{x:cx+150,y:cy+40}],{modifiers:['Shift']});
  const added=await page.evaluate(()=>{const m=styk.drawing.marquee.mask;let n=0;for(const v of m.mask)n+=v;return {n,w:m.width};});
  await stroke([{x:cx-150,y:cy-40},{x:cx-50,y:cy+40}],{modifiers:['Alt']});
  const sub=await page.evaluate(()=>{const m=styk.drawing.marquee.mask;let n=0;for(const v of m.mask)n+=v;return n;});
  check('Shift adds a second region and Alt subtracts it again',added.w>250&&sub>0&&sub<added.n*.6);
  await page.keyboard.press('Control+Shift+A');

  // Magic wand selects the painted band.
  await page.locator('.drawing-quickbar [data-draw-choice="selectShape"][data-value="wand"]').click();
  await page.mouse.click(cx-280,cy);
  await page.waitForFunction(()=>Boolean(styk.drawing.marquee),null,{timeout:10000});await settle();
  const wand=await page.evaluate(({cx,cy})=>{const d=styk.drawing,t=styk.editor.drawingTarget(),inside=d.marqueeContains(d.pixel({clientX:cx,clientY:cy},t)),outside=d.marqueeContains(d.pixel({clientX:cx,clientY:cy-100},t));return {inside,outside};},{cx,cy});
  check('the magic wand selects the connected band only',wand.inside&&!wand.outside);
  // Fill selection recolours exactly the band, undoably.
  await page.evaluate(()=>{styk.drawing.settings.color='#10c040';});
  await page.keyboard.press('Shift+Backspace');await page.waitForFunction(()=>styk.editor.undoLabel==='Fill selection');
  check('Fill selection recolours the selected pixels',await page.evaluate(({cx,cy})=>rgbAt(cx,cy)[1]>150&&alphaAt(cx,cy-100)===0,{cx,cy}));
  await page.keyboard.press('Control+z');await page.keyboard.press('Control+Shift+A');
  check('undo restores the band colour',await page.evaluate(({cx,cy})=>rgbAt(cx,cy)[1]<60,{cx,cy}));

  // Symmetry mirrors a stroke across the stage centre.
  await page.locator('[data-tool="drawing-brush"]').click();
  await page.evaluate(()=>{styk.drawing.settings.mirrorX=true;styk.drawing.settings.color='#202020';});
  const axis=await page.evaluate(async()=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs'),r=styk.editor.report,rect=styk.drawing.viewRect(),p=worldToScreen({x:r.canvas_width/2,y:r.canvas_height/2},{report:r,frame:styk.editor.evaluatedFrame,view:styk.state.view,cameraEnabled:false});return {x:rect.left+p.x*rect.width/rect.clientWidth,y:rect.top+p.y*rect.height/rect.clientHeight};});
  await stroke(line(axis.x-200,axis.y+150,axis.x-120,axis.y+190,6));
  check('mirror painting draws the reflected stroke',await page.evaluate(({x,y})=>alphaAt(x-160,y+170)===255&&alphaAt(x+160,y+170)===255,axis));
  await page.evaluate(()=>{styk.drawing.settings.mirrorX=false;});

  // Shift-click continues with a straight line from the last stroke's end.
  await stroke(line(cx-300,cy+250,cx-280,cy+250,2));
  await page.keyboard.down('Shift');await page.mouse.click(cx+100,cy+250);await page.keyboard.up('Shift');await settle();
  check('Shift-click draws a straight line from the previous stroke',await page.evaluate(({cx,cy})=>[-200,-100,0,50].every(dx=>alphaAt(cx+dx,cy+250)===255),{cx,cy}));

  // Alt-click picks the visible colour.
  await page.evaluate(()=>{styk.drawing.settings.color='#ff00ff';});
  await page.keyboard.down('Alt');await page.mouse.click(cx,cy);await page.keyboard.up('Alt');
  await page.waitForFunction(()=>styk.drawing.settings.color!=='#ff00ff',null,{timeout:5000});
  check('Alt-click picks the painted colour',await page.evaluate(()=>{const c=styk.drawing.settings.color;return parseInt(c.slice(1,3),16)<80&&parseInt(c.slice(3,5),16)<80;}));

  // Ctrl-drag resizes the brush.
  const before=await page.evaluate(()=>styk.drawing.settings.size);
  await page.keyboard.down('Control');await page.mouse.move(cx,cy-200);await page.mouse.down();await page.mouse.move(cx+120,cy-200,{steps:6});await page.mouse.up();await page.keyboard.up('Control');
  check('Ctrl-drag enlarges the brush without painting',await page.evaluate(({before,cx,cy})=>styk.drawing.settings.size>before*1.5&&alphaAt(cx+60,cy-200)===0,{before,cx,cy}));
  await page.evaluate(()=>{styk.drawing.settings.size=10;});

  // Flip view: pointer mapping stays exact while the view is mirrored.
  await page.keyboard.press('m');
  check('M flips the view',await page.evaluate(()=>styk.state.view.flip===true));
  await page.keyboard.press('Equal');
  check('zooming keeps the flipped view',await page.evaluate(()=>styk.state.view.flip===true&&styk.state.view.scale>1.01));
  await stroke(line(cx+200,cy-150,cx+260,cy-150,4));
  check('painting in a flipped view lands under the pointer',await page.evaluate(({cx,cy})=>alphaAt(cx+230,cy-150)===255,{cx,cy}));
  await page.screenshot({path:path.join(output,'flipped.png')});
  await page.keyboard.press('m');

  // Alpha lock recolours only existing pixels.
  await page.evaluate(()=>{Object.assign(styk.drawing.settings,{alphaLock:true,color:'#e02020',size:40});});
  await stroke(line(cx-50,cy-20,cx+50,cy+20,6));
  check('alpha lock recolours paint without covering empty pixels',await page.evaluate(({cx,cy})=>rgbAt(cx,cy)[0]>150&&alphaAt(cx,cy-15)===0,{cx,cy}));
  await page.evaluate(()=>{styk.drawing.settings.alphaLock=false;});

  // The Blender preset smudges existing paint across empty canvas.
  await page.locator('[data-draw-preset="blender"]').click();
  check('the Blender preset selects the smudge blend',await page.evaluate(()=>styk.drawing.settings.blend==='smudge'));
  const beforeSmudge=await page.evaluate(({cx,cy})=>alphaAt(cx+10,cy+45),{cx,cy});
  await stroke(line(cx+10,cy,cx+10,cy+60,10));
  check('smudging drags paint into empty pixels',await page.evaluate(({cx,cy})=>alphaAt(cx+10,cy+45),{cx,cy})>beforeSmudge+20);
  await page.locator('[data-draw-preset="ink"]').click();
  // Shapes: a rectangle outline uses the brush; a filled ellipse fills its interior.
  await page.keyboard.press('u');
  check('U selects the shape tool',await page.evaluate(()=>styk.drawing.tool==='shape'));
  await page.evaluate(()=>Object.assign(styk.drawing.settings,{shapeKind:'rect',shapeFill:false,size:6,color:'#108040',opacity:1}));
  await stroke([{x:cx-380,y:cy-230},{x:cx-280,y:cy-170}]);
  check('a rectangle outline is stroked with the brush and leaves its interior empty',await page.evaluate(({cx,cy})=>alphaAt(cx-380,cy-200)===255&&alphaAt(cx-280,cy-200)===255&&alphaAt(cx-330,cy-230)===255&&alphaAt(cx-330,cy-200)===0&&styk.editor.undoLabel==='Brush stroke',{cx,cy}));
  await page.evaluate(()=>Object.assign(styk.drawing.settings,{shapeKind:'ellipse',shapeFill:true}));
  await stroke([{x:cx+280,y:cy-230},{x:cx+380,y:cy-170}]);
  await page.waitForFunction(()=>styk.editor.undoLabel==='Fill shape');
  check('a filled ellipse fills its interior but not its bounding corners',await page.evaluate(({cx,cy})=>alphaAt(cx+330,cy-200)===255&&alphaAt(cx+282,cy-228)===0,{cx,cy}));
  // The gradient tool was removed: no rail button, shortcut or quick bar.
  check('the gradient tool is gone',await page.evaluate(()=>!document.querySelector('[data-tool="drawing-gradient"]')));
  await page.keyboard.press('b');
  // On-canvas handles: drag a corner to scale and the top handle to rotate.
  await page.locator('[data-tool="drawing-lasso"]').click();
  await page.locator('.drawing-quickbar [data-draw-choice="selectShape"][data-value="rect"]').click();
  await stroke([{x:cx-320,y:cy-30},{x:cx-120,y:cy+30}]);
  const handleClient=async which=>page.evaluate(async which=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs'),{transformPoint}=await import('/src/drawing-model.mjs');
    const d=styk.drawing,t=styk.editor.drawingTarget(),f=d.selectionFrame(t),p=which==='rotate'?f.rotate:f.corners[2],w=transformPoint(d.pixelMatrix(t),p),r=d.viewRect(),s=worldToScreen(w,{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view,cameraEnabled:false});
    return {x:r.left+s.x*r.width/r.clientWidth,y:r.top+s.y*r.height/r.clientHeight};},which);
  const corner=await handleClient('corner');
  await stroke([corner,{x:corner.x+50,y:corner.y+15}]);
  check('dragging a corner handle scales the floating selection',await page.evaluate(()=>styk.drawing.selection?.scale>1.1&&styk.drawing.selection.angle===0));
  const rot=await handleClient('rotate');
  await page.mouse.move(rot.x,rot.y);await page.mouse.down();await page.mouse.move(rot.x+40,rot.y+20,{steps:3});await page.keyboard.down('Shift');await page.mouse.move(rot.x+120,rot.y+60,{steps:4});await page.mouse.up();await page.keyboard.up('Shift');await settle();
  check('dragging the rotate handle turns the selection, snapping with Shift',await page.evaluate(()=>{const a=styk.drawing.selection?.angle;return a!==0&&Math.abs(a%15)<1e-9;}));
  await page.keyboard.press('Enter');await settle();
  check('Enter commits the scaled and rotated pixels as one step',await page.evaluate(()=>styk.editor.undoLabel==='Transform selected pixels'&&!styk.drawing.selection));
  await page.keyboard.press('Control+z');
  // Recent colours, swapping and saved brushes.
  await page.locator('[data-tool="drawing-brush"]').click();await page.waitForSelector('.drawing-swatch');
  check('recently used colours appear as swatches',await page.locator('.drawing-swatch').count()>=3);
  await page.evaluate(()=>{styk.drawing.settings.color='#112233';styk.drawing.settings.color2='#445566';});
  await page.locator('#viewport').focus();await page.keyboard.press('x');
  check('X swaps the drawing colours',await page.evaluate(()=>styk.drawing.settings.color==='#445566'&&styk.drawing.settings.color2==='#112233'));
  await page.locator('[data-draw-preset="calligraphy"]').click();await page.evaluate(()=>{styk.drawing.settings.size=33;});
  await page.locator('[data-draw-action="save-preset"]').click();
  const saved=await page.evaluate(()=>styk.drawing.settings.preset);
  await page.waitForSelector(`[data-draw-preset="${saved}"]`);
  check('Save brush adds a custom preset',saved.startsWith('custom-'));
  // Flip and filters on a selection.
  await page.locator('[data-tool="drawing-lasso"]').click();
  await page.locator('.drawing-quickbar [data-draw-choice="selectShape"][data-value="rect"]').click();
  await stroke([{x:cx-320,y:cy-20},{x:cx-120,y:cy+20}]);
  const flipBefore=await page.evaluate(({cx,cy})=>[alphaAt(cx-300,cy),alphaAt(cx-140,cy)],{cx,cy});
  await page.locator('[data-draw-action="flip-selection-x"]').click();await page.keyboard.press('Enter');await settle();
  check('flipping a selection mirrors its pixels and commits as one step',await page.evaluate(({cx,cy,flipBefore})=>styk.editor.undoLabel==='Transform selected pixels'&&alphaAt(cx-300,cy)===flipBefore[1]&&alphaAt(cx-140,cy)===flipBefore[0],{cx,cy,flipBefore}));
  await page.keyboard.press('Control+z');
  await stroke([{x:cx-320,y:cy-20},{x:cx-120,y:cy+20}]);
  const profile=()=>page.evaluate(({cx,cy})=>{const col=x=>Array.from({length:31},(_,i)=>alphaAt(x,cy-15+i));return {inside:col(cx-200),outside:col(cx+200)};},{cx,cy});
  const sharp=await profile();
  await page.locator('details[data-section="Filters"] summary').click();
  await page.locator('[data-draw-action="filter-blur"]').click();await page.waitForFunction(()=>styk.editor.undoLabel==='Blur drawing');
  const soft=await profile(),partial=a=>a.filter(v=>v>0&&v<255).length;
  check('blur softens the stroke inside the selection and leaves the rest untouched',partial(soft.inside)>partial(sharp.inside)+2&&JSON.stringify(soft.outside)===JSON.stringify(sharp.outside));
  await page.keyboard.press('Control+z');await page.keyboard.press('Control+Shift+A');
  check('undo restores the unblurred stroke',JSON.stringify((await profile()).inside)===JSON.stringify(sharp.inside));
  await page.reload();await page.waitForFunction(()=>window.styk?.ready);await page.locator('[data-workspace-mode="draw"]').click();await page.locator('[data-tool="drawing-brush"]').click();await page.waitForSelector(`[data-draw-preset="${saved}"]`);
  check('saved brushes and recent colours persist after a reload',await page.locator(`[data-draw-preset="${saved}"]`).count()===1&&await page.locator('.drawing-swatch').count()>=3);
  await page.locator(`[data-draw-preset="${saved}"]`).click();
  check('a saved brush restores its tip',await page.evaluate(()=>styk.drawing.settings.size===33&&styk.drawing.settings.roundness===.2));
  await page.locator('[data-draw-action="delete-preset"]').click();await page.waitForSelector(`[data-draw-preset="${saved}"]`,{state:'detached'});
  check('Delete brush removes a saved preset',await page.locator(`[data-draw-preset="${saved}"]`).count()===0);
  await page.screenshot({path:path.join(output,'tools.png')});
  check('no uncaught browser errors',errors.length===0);
  await writeFile(path.join(output,'tools.json'),JSON.stringify({checks,errors,browser:await browser.version()},null,2));
}catch(error){console.log(await page.evaluate(()=>({status:document.body.innerText.slice(-1500),operation:Boolean(styk.drawing.operation),selection:Boolean(styk.drawing.selection),marquee:Boolean(styk.drawing.marquee),undo:styk.editor.undoLabel})));await page.screenshot({path:path.join(output,'failure.png')});await writeFile(path.join(output,'failure.json'),JSON.stringify({message:error.message,errors,checks},null,2));throw error;}
finally{await browser.close();}
