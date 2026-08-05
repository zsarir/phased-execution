#!/usr/bin/env node
/**
 * `npm start`'s staleness warning: says when the built client is older than
 * the code, and never does anything about it.
 *
 * Warning rather than building is deliberate. A start must serve exactly what
 * was last deliberately built — an implicit rebuild would mean `git pull &&
 * npm start` ships whatever HEAD happens to be, unverified, and a broken build
 * would stop the console from starting at all. The console itself already
 * degrades honestly (an unbuilt client gets a page naming the commands), so
 * this only has to inform.
 *
 * Always exits 0: a warning that prevents startup is not a warning.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(VIEWER, 'client', 'dist');

// A packaged install (npm, Homebrew) is not a git checkout: dist ships prebuilt
// and staleness is the package manager's concern. Worse, `git rev-parse` walks
// UP — Homebrew's Cellar sits inside Homebrew's own git repository, so the
// comparison below would hold this build against a HEAD it was never built
// from and cry STALE on every start. No repo at the package root → nothing to say.
if (!existsSync(join(VIEWER, '..', '.git'))) {
  process.exit(0);
}

const warn = (message) => process.stderr.write(`\n  phase-console: ${message}\n\n`);

if (!existsSync(join(DIST, 'index.html'))) {
  warn('the client is not built — the console will serve a page saying so.\n'
    + '  Build it with: npm ci && npm run build   (or deploy/agent.sh update)');
  process.exit(0);
}

let head = null;
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: VIEWER, encoding: 'utf8' }).trim();
} catch { /* no repository — nothing to compare against */ }

const stampFile = join(DIST, '.build-rev');
if (!existsSync(stampFile)) {
  warn('client/dist carries no .build-rev stamp (built by a bare `vite build`?).\n'
    + '  `npm run build` stamps what it builds, so staleness can be told.');
  process.exit(0);
}

const stamp = readFileSync(stampFile, 'utf8').trim();
if (head && stamp !== 'unknown' && stamp !== head) {
  warn(`the built client is STALE — built at ${stamp.slice(0, 12)}, the repo is at ${head.slice(0, 12)}.\n`
    + '  It will serve until you rebuild: npm run build   (or deploy/agent.sh update)');
}
process.exit(0);
