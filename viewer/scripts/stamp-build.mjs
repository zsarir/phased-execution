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
import { join } from 'node:path';

// One computation for the stamp AND the client's baked `__BUILD_REV__` —
// see build-rev.mjs; the Interface row compares the two, so they must agree.
import { VIEWER_DIR as VIEWER, buildRev } from './build-rev.mjs';

const DIST = join(VIEWER, 'client', 'dist');

if (!existsSync(join(DIST, 'index.html'))) {
  process.stderr.write('stamp-build: no client/dist to stamp — run `vite build` first.\n');
  process.exit(1);
}

const rev = buildRev();

writeFileSync(join(DIST, '.build-rev'), `${rev}\n`, 'utf8');
process.stdout.write(`stamped client/dist/.build-rev = ${rev.slice(0, 12)}\n`);
