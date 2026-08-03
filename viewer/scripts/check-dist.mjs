#!/usr/bin/env node
/**
 * The build gate: `npm run build && node scripts/check-dist.mjs`.
 *
 * `web-imports.test.ts` policed the legacy client until it retired; the built
 * client's equivalent risks live in the build output, so this checks the output
 * itself — every assertion below is something that actually went wrong once, or
 * something two live devices depend on:
 *
 *   • doctype + `<html lang>` — the legacy document spent its whole life in
 *     quirks mode because nothing held the one line that prevents it.
 *   • the manifest link + file — iOS silently ignores a missing or mistyped
 *     manifest, and "silently not installable" looks exactly like working.
 *   • `sw.js` AT THE ROOT, still push-capable, still what the entry registers —
 *     the two live push subscriptions are bound to `('/sw.js', scope '/')`;
 *     moving or renaming the worker unsubscribes every device silently. Do not
 *     weaken these three.
 *   • precache sanity — `index.html` precached (the offline shell), the
 *     terminal chunk NOT (89 KB of xterm is no use to someone who cannot open
 *     a shell).
 *   • the entry stays under the ~300 KB gzipped budget, and the terminal stays
 *     a lazy chunk the entry document never references.
 *   • `dist/.build-rev` exists — proves the stamp stayed wired into
 *     `npm run build`, which is what `npm start`'s staleness warning reads.
 *
 * Exits non-zero on the first summary with any ✗. Read the lines; each names
 * the file and the promise it holds.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const VIEWER = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(VIEWER, 'client', 'dist');

/** The plan's bundle budget: ~300 KB gzipped for the entry's JS. */
const BUDGET_GZ = 300 * 1024;

if (!existsSync(join(DIST, 'index.html'))) {
  process.stderr.write('check-dist: no client/dist/index.html — run `npm run build` first.\n');
  process.exit(1);
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, condition, detail });
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');

check('index.html starts with <!doctype html> (standards mode)',
  /^<!doctype html>/i.test(html.trimStart().slice(0, 40)));
check('<html> declares lang', /<html[^>]+lang=/.test(html));
check('index.html links the manifest', /<link[^>]+rel="manifest"/.test(html));
check('manifest.webmanifest is in dist', existsSync(join(DIST, 'manifest.webmanifest')));

/* The worker — the three checks two live devices depend on. */
const swPath = join(DIST, 'sw.js');
check('sw.js is at the ROOT of dist (subscriptions are bound to /sw.js)', existsSync(swPath));

const sw = existsSync(swPath) ? readFileSync(swPath, 'utf8') : '';
check('the worker still handles push', /addEventListener\((["'`])push\1/.test(sw),
  'a worker without a push listener silently ends notifications for every subscribed device');
check('the precache includes index.html (the offline shell)', sw.includes('index.html'));
check('the precache does NOT include the terminal chunk', !sw.includes('terminal-'),
  'xterm is no use to someone who cannot open a shell, and it is 89 KB');
check('the precache does NOT include the pane chunk (where xterm lives)', !sw.includes('pane-'),
  'the shared emulator chunk both terminal routes lazy-load — same reasoning, same 89 KB');
check('the precache does NOT include the agent chunk', !sw.includes('agent-'),
  'the agent route is no use to someone whose console has no --allow-agent');

/* The entry — parsed from the document, not guessed from filenames. */
const entryMatch = /<script[^>]+type="module"[^>]+src="\/assets\/(index-[^"]+\.js)"/.exec(html);
check('index.html references exactly one module entry under /assets/', Boolean(entryMatch));

if (entryMatch) {
  const entry = readFileSync(join(DIST, 'assets', entryMatch[1]), 'utf8');
  const gz = gzipSync(entry).length;
  check(`entry ${entryMatch[1]} is under the budget (${(gz / 1024).toFixed(1)} KB gz of ${BUDGET_GZ / 1024} KB)`,
    gz <= BUDGET_GZ);
  check('the entry registers the worker at /sw.js', /["'`]\/sw\.js["'`]/.test(entry),
    'the registration URL is the contract the two live subscriptions depend on');
}

const assets = existsSync(join(DIST, 'assets')) ? readdirSync(join(DIST, 'assets')) : [];
check('the terminal is its own lazy chunk', assets.some((name) => /^terminal-.*\.js$/.test(name)));
check('the agent page is its own lazy chunk', assets.some((name) => /^agent-.*\.js$/.test(name)));
check('xterm rides in one shared lazy pane-* chunk (the name the globIgnores exclude)',
  assets.some((name) => /^pane-.*\.js$/.test(name)),
  'if the bundler renamed the shared chunk, update vite.config.ts globIgnores AND this check together');
check('index.html never references the terminal chunk', !html.includes('terminal-'),
  'referenced from the document, it would load for every reader of a route map');
check('index.html never references the pane or agent chunks',
  !html.includes('pane-') && !html.includes('agent-'),
  'referenced from the document, they would load for every reader of a route map');

/*
 * The same promise as the three precache checks above, asserted against the
 * BUILD rather than against three chunk names.
 *
 * Every check above pins a name, and a name is exactly what a bundler is free
 * to change: adding one module that both terminal routes import made it a
 * second facade of the shared chunk and renamed it `pane-*` → `ended-*`, which
 * matched no `globIgnores` entry and put 346 KB of xterm in the precache. The
 * named checks caught it here, but only because one of them happened to assert
 * the old name still existed — update the name in `vite.config.ts` alone and
 * every check would pass while the regression shipped.
 *
 * So: find whichever asset actually contains the emulator, and assert the
 * worker does not precache that one. Rename-proof by construction.
 */
const xtermChunks = assets.filter((name) => name.endsWith('.js')
  && readFileSync(join(DIST, 'assets', name), 'utf8').includes('xterm'));
check('the terminal emulator is in a chunk at all (nothing to check otherwise)',
  xtermChunks.length > 0);
const precachedXterm = xtermChunks.filter((name) => sw.includes(name));
check(`the precache excludes the emulator, whatever the chunk is called (${xtermChunks.join(', ') || 'none'})`,
  precachedXterm.length === 0,
  `precached: ${precachedXterm.join(', ')} — add it to globIgnores in vite.config.ts. `
  + 'A renamed shared chunk is the usual cause; see the note in views/terminal/pane.tsx.');

check('dist/.build-rev exists (npm run build stamps what it built)',
  existsSync(join(DIST, '.build-rev')));

/* ------------------------------------------------------------------ */

let failed = 0;
for (const { name, condition, detail } of results) {
  process.stdout.write(`${condition ? '✓' : '✗'} ${name}\n`);
  if (!condition) {
    failed += 1;
    if (detail) process.stdout.write(`  ${detail}\n`);
  }
}
process.stdout.write(failed === 0
  ? `check-dist: all ${results.length} checks passed.\n`
  : `check-dist: ${failed} of ${results.length} checks FAILED.\n`);
process.exit(failed === 0 ? 0 : 1);
