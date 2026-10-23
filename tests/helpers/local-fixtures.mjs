import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** Pivot corpora live beside the repository (the codec's WORKSPACE) and built
 * encoders/generated inventories are not committed. Tests that read them skip,
 * naming the missing path, in a clean checkout such as CI. Set
 * STYK_REQUIRE_FIXTURES=1 to run them anyway so a missing corpus fails loudly.
 * Paths are relative to the repository root. */
export function missingFixture(...paths) {
  if (process.env.STYK_REQUIRE_FIXTURES === '1') return false;
  const missing = paths.filter(relative => !existsSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url))));
  return missing.length ? `requires local fixture: ${missing.join(', ')}` : false;
}
