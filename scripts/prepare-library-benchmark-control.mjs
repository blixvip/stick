/** Prepare the frozen UserLibrary owner for the same-origin browser fixture. */
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const ref = process.argv[2] ?? '35ebad9b';
const target = 'artifacts/performance-improvements/control/user-library-before.mjs';
const source = execFileSync('git', ['show', `${ref}:src/user-library.mjs`], {encoding: 'utf8'});
const rewritten = source.replace(/(\bfrom\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
  (match, prefix, quote, specifier) => `${prefix}${quote}/src/${path.posix.normalize(specifier)}${quote}`);
await mkdir(path.dirname(target), {recursive: true});
await writeFile(target, rewritten);
console.log(`Prepared ${target} from ${ref}; dependencies resolve to current /src/ modules.`);
