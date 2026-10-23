// Builds, verifies and deploys the editor to Cloudflare (see docs/WEB.md).
//
//   npm run web:deploy                deploy to the account wrangler is logged in to
//   npm run web:deploy -- --dry-run   build, verify and let wrangler validate, without deploying
//
// Authentication is wrangler's: `wrangler login`, or CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID in the environment. wrangler is the pinned copy installed
// in web/ (`npm ci --prefix web`).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWeb } from './build-web.mjs';
import { verifyWeb } from './verify-web.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function wranglerEntry(root = appRoot) {
  const entry = path.join(root, 'web', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return existsSync(entry) ? entry : null;
}

async function main(args) {
  const entry = wranglerEntry();
  if (!entry) {
    console.error('wrangler is not installed. Run: npm ci --prefix web');
    return 1;
  }
  const built = await buildWeb();
  console.log(`Built ${built.files} files (${(built.bytes / 1048576).toFixed(1)} MiB).`);
  const { problems } = await verifyWeb(built.output);
  if (problems.length) {
    console.error(`Not deploying: the site failed verification.\n${problems.map((problem) => ` - ${problem}`).join('\n')}`);
    return 1;
  }
  const result = spawnSync(process.execPath, [entry, 'deploy', '--config', path.join('web', 'wrangler.jsonc'), ...args], { cwd: appRoot, stdio: 'inherit' });
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
