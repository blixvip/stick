import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {corpusPath} from './support/corpus.mjs';

test('by default the sample is looked up under the home directory', () => {
  const found = corpusPath('Downloads/scene (3).piv', {env: {}, home: '/home/dev', exists: () => true});
  assert.equal(found, path.join('/home/dev', 'Downloads', 'scene (3).piv'));
});

test('STYK_CORPUS_DIR names a flat folder holding the samples', () => {
  const found = corpusPath('Downloads/scene (3).piv', {env: {STYK_CORPUS_DIR: '/data/samples'}, home: '/home/dev', exists: () => true});
  assert.equal(found, path.join('/data/samples', 'scene (3).piv'));
});

test('a missing sample fails immediately with the way to fix it', () => {
  assert.throws(() => corpusPath('Downloads/absent.piv', {env: {}, home: '/home/dev', exists: () => false}),
    error => error.message.includes(path.join('/home/dev', 'Downloads', 'absent.piv')) && /STYK_CORPUS_DIR/.test(error.message) && /first argument/.test(error.message));
});

test('the check only runs when the default is actually needed', () => {
  // Scripts write `process.argv[2] ?? corpusPath(...)`: an explicit path never touches the default.
  const pick = override => override ?? corpusPath('Downloads/absent.piv', {env: {}, home: '/home/dev', exists: () => false});
  assert.equal(pick('explicit.piv'), 'explicit.piv');
  assert.throws(() => pick(undefined), /Sample project not found/);
});
