import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUIScale, applyUIScale, autoUIScale, effectiveUIScale} from '../src/ui-scale.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
test('UI scale migrates old settings and rejects invalid stored values',()=>{
 for(const value of [undefined,null,NaN,Infinity,'150',{},[]]) assert.equal(normalizeUIScale(value),100);
 assert.equal(normalizeEditorSettings({}).uiScale,100);
 assert.equal(normalizeEditorSettings({uiScale:157}).uiScale,155);
 assert.equal(normalizeUIScale(-1),75);assert.equal(normalizeUIScale(900),200);
});
test('UI scale uses a bounded native presentation API',()=>{
 const values=[];assert.equal(applyUIScale(128,{setUIScale:value=>values.push(value)}),130);
 assert.deepEqual(values,[130]);assert.equal(applyUIScale(150,{}),150);
});
test('Automatic scale follows the screen, and a scale chosen before modes stays the user\'s',()=>{
 for(const [width,height,expected] of [[1366,768,100],[1536,864,100],[1920,1080,110],[1920,1200,110],[2560,1440,125],[3072,1728,125],[3840,2160,150],[2560,1080,110]])
  assert.equal(autoUIScale({width,height}),expected,`${width}x${height}`);
 assert.equal(normalizeEditorSettings({}).uiScaleMode,'auto','a new profile follows the screen');
 assert.equal(normalizeEditorSettings({uiScale:100}).uiScaleMode,'auto','an untouched 100% becomes Automatic');
 assert.equal(normalizeEditorSettings({uiScale:130}).uiScaleMode,'manual','a chosen scale stays Custom');
 assert.equal(normalizeEditorSettings({uiScale:100,uiScaleMode:'manual'}).uiScaleMode,'manual');
 assert.equal(normalizeEditorSettings({uiScaleMode:'bogus'}).uiScaleMode,'auto');
 assert.equal(effectiveUIScale({uiScaleMode:'auto',uiScale:130},{width:2560,height:1440}),125);
 assert.equal(effectiveUIScale({uiScaleMode:'manual',uiScale:130},{width:2560,height:1440}),130);
});
