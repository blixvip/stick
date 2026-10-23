import test from 'node:test';
import assert from 'node:assert/strict';
import {createReleaseHistory} from '../desktop/release-history.cjs';
import {parseReleaseNotes} from '../src/release-notes.mjs';

test('release history is bounded, fixed-origin, deduplicated and cached',async()=>{
  let calls=0,time=0;
  const get=createReleaseHistory({now:()=>time,fetcher:async(url,options)=>{
    calls++;assert.equal(url,'https://stykanimate.com/api/v1/releases');assert.equal(options.redirect,'error');
    return Response.json({releases:[{version:'1.0.0',channel:'stable',notes:'Old'},{version:'1.0.1',channel:'stable',notes:'New'},{version:'1.0.1',channel:'stable',notes:'Duplicate'},{version:'2.0.0',channel:'beta',notes:'Beta'},{version:'invalid',channel:'stable',notes:'Bad'}]});
  }});
  const [a,b]=await Promise.all([get(),get()]);assert.deepEqual(a,b);assert.deepEqual(a.map(x=>x.version),['1.0.1','1.0.0']);assert.equal(calls,1);
  await get();assert.equal(calls,1);time=300001;await get();assert.equal(calls,2);
});
test('oversized and failed responses can be retried without poisoning history',async()=>{
  let count=0;
  const get=createReleaseHistory({fetcher:async()=>++count===1?new Response('x'.repeat(524289)):Response.json({releases:[{version:'1.0.0',channel:'stable',notes:'Fine'}]})});
  await assert.rejects(get(),/too large/);assert.equal((await get())[0].version,'1.0.0');
});
test('categorized and legacy release notes omit promotional prose and retain inert text',()=>{
  const modern=parseReleaseNotes('# StykAnimate 1.0.1\n\nA small update\n\n### Changed\n- Better **controls**.\n\n### Fixed\n- <img src=x onerror=alert(1)>\n\nDonate today.');
  assert.equal(modern.title,'A small update');assert.deepEqual(modern.groups.map(x=>x.name),['Changed','Fixed']);assert.equal(modern.groups[1].notes[0],'<img src=x onerror=alert(1)>');
  assert.deepEqual(parseReleaseNotes('# Old\n\nEarlier update\n- One fix.\n\nDonate today.').groups,[{name:'Changes',notes:['One fix.']}]);
});
