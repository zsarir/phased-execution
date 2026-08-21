#!/usr/bin/env node
/**
 * `npm run verify:dist` — prove the client BUILDS and passes the build gate,
 * without touching the `client/dist` the live console is serving.
 *
 * `client/dist` is the one client the server serves, and a build into it cuts
 * the live console over on the next request. A phase that only needs to know
 * "does this tree still build and pass check-dist?" must not do that — so this
 * builds into `client/.dist-verify` (gitignored), stamps it, runs the same 21+
 * assertions `check-dist.mjs` runs against the real output, and deletes the
 * scratch directory afterwards unless asked to keep it.
 *
 * `PC_DIST_DIR` is the one knob: `vite.config.ts` (build.outDir),
 * `stamp-build.mjs` and `check-dist.mjs` all read it, relative to `client/`
 * when not absolute, default `dist`. The server's static root never reads it.
 *
 *   node scripts/verify-dist.mjs            # build → stamp → check, then clean up
 *   node scripts/verify-dist.mjs --keep     # leave client/.dist-verify in place
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRATCH = '.dist-verify';
const keep = process.argv.includes('--keep');
const env = { ...process.env, PC_DIST_DIR: SCRATCH };

function run(label, command, args) {
  process.stdout.write(`verify-dist: ${label}\n`);
  const result = spawnSync(command, args, { cwd: VIEWER, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.stderr.write(`verify-dist: ${label} failed (exit ${result.status ?? 'signal'}).\n`);
    return false;
  }
  return true;
}

const out = join(VIEWER, 'client', SCRATCH);
let ok = run('vite build → client/.dist-verify', 'npx', ['vite', 'build'])
  && run('stamp', process.execPath, [join(VIEWER, 'scripts', 'stamp-build.mjs')])
  && run('check-dist', process.execPath, [join(VIEWER, 'scripts', 'check-dist.mjs')]);

if (!keep && existsSync(out)) rmSync(out, { recursive: true, force: true });
process.stdout.write(ok
  ? `verify-dist: OK — the tree builds and passes the gate${keep ? ` (kept ${out})` : ''}.\n`
  : 'verify-dist: FAILED.\n');
process.exit(ok ? 0 : 1);
