#!/usr/bin/env node
/**
 * Stamp the build: `dist/.build-rev` holds the commit the client was built
 * from. `npm run build` writes it (after `vite build` — vite empties the out
 * directory, so the stamp has to come second); `npm start`'s staleness check
 * reads it, `check-dist.mjs` asserts it exists, and it answers "what is this
 * machine actually serving" without guessing from file dates.
 *
 * No repository is not an error: a tarball copy stamps `unknown`, and the
 * staleness check treats that as "cannot tell", not as stale.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(VIEWER, 'client', 'dist');

if (!existsSync(join(DIST, 'index.html'))) {
  process.stderr.write('stamp-build: no client/dist to stamp — run `vite build` first.\n');
  process.exit(1);
}

let rev = 'unknown';
try {
  rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: VIEWER, encoding: 'utf8' }).trim();
} catch { /* not a repository, or no git — `unknown` says so */ }

writeFileSync(join(DIST, '.build-rev'), `${rev}\n`, 'utf8');
process.stdout.write(`stamped client/dist/.build-rev = ${rev.slice(0, 12)}\n`);
