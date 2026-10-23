import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {workspaceDirectory} = createRequire(import.meta.url)('../desktop/workspace-instance.cjs');

test('secondary workspaces leave live instances alone and recover inactive instances', async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'styk-instances-'));
  t.after(() => rm(profile, {recursive:true,force:true}));
  const live = path.join(profile,'workspaces','101'), stale = path.join(profile,'workspaces','102');
  await mkdir(live,{recursive:true}); await mkdir(stale,{recursive:true});
  await writeFile(path.join(live,'recovery.styk'),'live project'); await writeFile(path.join(stale,'recovery.styk'),'recover me');
  const chosen = workspaceDirectory(profile,{pid:103,alive:pid=>pid===101});
  assert.equal(chosen,path.join(profile,'workspaces','103'));
  assert.equal(await readFile(path.join(chosen,'recovery.styk'),'utf8'),'recover me');
  assert.equal(await readFile(path.join(live,'recovery.styk'),'utf8'),'live project');
  const next = workspaceDirectory(profile,{pid:104,alive:()=>true});
  assert.notEqual(next,chosen); assert.notEqual(next,live);
});
