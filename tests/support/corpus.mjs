// Private sample projects used by profiling and audit scripts (for example the
// dense "Akane" scene). They are not in the repository. Scripts used to default
// to one developer's Windows path; this resolves the same file from the home
// directory, which is the identical path on that machine and works anywhere the
// files are kept in the same place, or in the folder STYK_CORPUS_DIR names.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} relative Path under the home directory, for example "Downloads/scene.piv".
 * @param {{env?: object, home?: string, exists?: (file: string) => boolean}} [options]
 * @returns {string} The file to read. Throws, saying what to do, when it is missing.
 */
export function corpusPath(relative, { env = process.env, home = os.homedir(), exists = existsSync } = {}) {
  const name = path.basename(relative);
  const file = env.STYK_CORPUS_DIR ? path.join(env.STYK_CORPUS_DIR, name) : path.join(home, ...relative.split('/'));
  if (!exists(file)) {
    throw new Error(`Sample project not found: ${file}\nPass its path as the first argument, or set STYK_CORPUS_DIR to the folder that contains "${name}".`);
  }
  return file;
}
