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
 *   • precache sanity — `index.html` and the six destination chunks precached
 *     (the offline shell), the EMULATOR chunk not (89 KB of xterm is no use to
 *     someone who cannot open a shell, and Sessions is a destination: the page
 *     belongs in the precache, the terminal inside it does not).
 *   • the entry stays under the ~300 KB gzipped budget, and the terminal stays
 *     a lazy chunk the entry document never references — in the precache OR
 *     as a `modulepreload`, which is the second way a lazy chunk stops being
 *     lazy and the one nothing checked until Phase 7.
 *   • first paint (entry + every modulepreload) is GATED at 200 KB gz. It was
 *     advisory for four phases, drifted 211 → 220 KB, and nobody read the
 *     printed line; the cause turned out to be a one-line barrel import, not a
 *     dependency bump. See the note above the constant.
 *   • `dist/.build-rev` exists — proves the stamp stayed wired into
 *     `npm run build`, which is what `npm start`'s staleness warning reads.
 *
 * Exits non-zero on the first summary with any ✗. Read the lines; each names
 * the file and the promise it holds.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const VIEWER = dirname(dirname(fileURLToPath(import.meta.url)));
// Which build to read: `client/dist` (what the server serves) unless
// `PC_DIST_DIR` names another — `npm run verify:dist` builds into a scratch
// directory so the live console is never touched. Same variable, same
// resolution as vite.config.ts: relative to `client/`, or absolute.
const DIST = resolve(join(VIEWER, 'client'), process.env.PC_DIST_DIR || 'dist');

/** The plan's bundle budget: ~300 KB gzipped for the entry's JS. */
const BUDGET_GZ = 300 * 1024;

if (!existsSync(join(DIST, 'index.html'))) {
  process.stderr.write(
    `check-dist: no ${DIST.replace(VIEWER + '/', '')}/index.html — run \`npm run build\` first.\n`,
  );
  process.exit(1);
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, condition, detail });
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');

check(
  'index.html starts with <!doctype html> (standards mode)',
  /^<!doctype html>/i.test(html.trimStart().slice(0, 40)),
);
check('<html> declares lang', /<html[^>]+lang=/.test(html));
check('index.html links the manifest', /<link[^>]+rel="manifest"/.test(html));
check('manifest.webmanifest is in dist', existsSync(join(DIST, 'manifest.webmanifest')));

/* The worker — the three checks two live devices depend on. */
const swPath = join(DIST, 'sw.js');
check('sw.js is at the ROOT of dist (subscriptions are bound to /sw.js)', existsSync(swPath));

const sw = existsSync(swPath) ? readFileSync(swPath, 'utf8') : '';
check(
  'the worker still handles push',
  /addEventListener\((["'`])push\1/.test(sw),
  'a worker without a push listener silently ends notifications for every subscribed device',
);
check('the precache includes index.html (the offline shell)', sw.includes('index.html'));
check(
  'the precache does NOT include the pane chunk (where xterm lives)',
  !sw.includes('pane-'),
  'the emulator chunk `features/sessions/session-page.tsx` lazy-loads — 89 KB no reader of a route map needs',
);
check(
  'the precache DOES include the Sessions destination chunk',
  /\bsessions-[^"'`\s]*\.js/.test(sw),
  'Sessions is one of the six destinations; its chunk belongs in the offline shell like the other five. ' +
    'If this fails while the emulator check passes, the destination chunk was excluded by name — the thing ' +
    'to exclude is the pane, never the page.',
);
/*
 * The other two destinations Phase 11 built, by the same rule.
 *
 * A destination is precached; the expensive thing INSIDE it is not. Settings
 * is eight sections and only two of them are heavy (the MCP catalog with its
 * search and add dialog; the permissions rule editor), so both are `lazy()`
 * inside the section chunk — the same shape as Sessions and its pane, for the
 * same reason: nobody who opened Settings to flip a theme should download a
 * rule grammar.
 */
check('the precache DOES include the Settings destination chunk', /\bsettings-[^"'`\s]*\.js/.test(sw));
check('the precache DOES include the Insights destination chunk', /\binsights-[^"'`\s]*\.js/.test(sw));

/* The entry — parsed from the document, not guessed from filenames. */
const entryMatch = /<script[^>]+type="module"[^>]+src="\/assets\/(index-[^"]+\.js)"/.exec(html);
check('index.html references exactly one module entry under /assets/', Boolean(entryMatch));

if (entryMatch) {
  const entry = readFileSync(join(DIST, 'assets', entryMatch[1]), 'utf8');
  const gz = gzipSync(entry).length;
  check(
    `entry ${entryMatch[1]} is under the budget (${(gz / 1024).toFixed(1)} KB gz of ${BUDGET_GZ / 1024} KB)`,
    gz <= BUDGET_GZ,
  );
  check(
    'the entry registers the worker at /sw.js',
    /["'`]\/sw\.js["'`]/.test(entry),
    'the registration URL is the contract the two live subscriptions depend on',
  );
}

const assets = existsSync(join(DIST, 'assets')) ? readdirSync(join(DIST, 'assets')) : [];
check(
  'the Sessions destination is its own lazy chunk',
  assets.some((name) => /^sessions-.*\.js$/.test(name)),
);
check(
  'xterm rides in one lazy pane-* chunk (the name the globIgnores exclude)',
  assets.some((name) => /^pane-.*\.js$/.test(name)),
  'if the bundler renamed the emulator chunk, update vite.config.ts globIgnores AND this check together',
);
check(
  'index.html never references the pane chunk',
  !html.includes('pane-'),
  'referenced from the document, it would load for every reader of a route map',
);
check(
  "Settings' two heavy sections are chunks of their own",
  assets.some((name) => /^mcp-.*\.js$/.test(name)) &&
    assets.some((name) => /^permissions-.*\.js$/.test(name)),
  'features/settings/index.tsx reaches the MCP catalog and the permissions editor through `lazy()`. ' +
    'A static import folds both into the precached Settings chunk — which every visitor downloads ' +
    'on install, including one who only ever changes the theme.',
);

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
const xtermChunks = assets.filter(
  (name) => name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes('xterm'),
);
check('the terminal emulator is in a chunk at all (nothing to check otherwise)', xtermChunks.length > 0);
const precachedXterm = xtermChunks.filter((name) => sw.includes(name));
check(
  `the precache excludes the emulator, whatever the chunk is called (${xtermChunks.join(', ') || 'none'})`,
  precachedXterm.length === 0,
  `precached: ${precachedXterm.join(', ')} — add it to globIgnores in vite.config.ts. ` +
    'A renamed emulator chunk is the usual cause; see the note in features/sessions/pane.tsx.',
);

/*
 * The modulepreload twin of the check above.
 *
 * The precache is one of TWO ways a lazy chunk stops being lazy. The other is
 * `<link rel="modulepreload">` in the document: a preloaded chunk is fetched
 * by every visitor on first paint, on the same connection as the entry, and
 * nothing about it looks lazy from the network tab's point of view — it is
 * simply there before anything asked.
 *
 * The named check above (`index.html never references the pane or agent
 * chunks`) is the version of this that a rename defeats, for exactly the
 * reason the note above gives. This one asks the build the same question the
 * emulator-precache check asks: whichever chunk actually contains xterm, is
 * the document pulling it in?
 */
/*
 * The Phase-10 failure mode, named.
 *
 * Sessions is a DESTINATION, so unlike the two pages it replaced its chunk is
 * precached as part of the offline shell. That makes one ordinary-looking edit
 * expensive: turning `lazy(() => import('./pane'))` in `session-page.tsx` back
 * into a static import would fold the emulator into `sessions-*` — and the
 * rename-proof precache check below would catch it, but only as "some chunk
 * you have never heard of is precached". This says which edit did it.
 */
const sessionChunks = assets.filter((name) => /^sessions-.*\.js$/.test(name));
const emulatorInSessions = sessionChunks.filter((name) =>
  readFileSync(join(DIST, 'assets', name), 'utf8').includes('xterm'),
);
check(
  'the Sessions destination chunk carries no emulator',
  emulatorInSessions.length === 0,
  `${emulatorInSessions.join(', ')} contains xterm — the pane must stay behind ` +
    "`lazy(() => import('./pane'))` in features/sessions/session-page.tsx; a static import puts 89 KB gz " +
    'of emulator into a chunk every visitor precaches.',
);

const preloaded = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/assets\/([^"]+)"/g)].map(
  (match) => match[1],
);
const preloadedXterm = xtermChunks.filter((name) => preloaded.includes(name));
check(
  `the document never modulepreloads the emulator, whatever the chunk is called (${preloaded.length} preloaded)`,
  preloadedXterm.length === 0,
  `modulepreloaded: ${preloadedXterm.join(', ')} — a preloaded chunk is fetched by every visitor on ` +
    'first paint. Usually a static import that should be a `lazy()`; see the note in vite.config.ts.',
);

/*
 * First paint, as a number rather than as a name.
 *
 * The entry budget above (~300 KB gz) only counts the entry. What a visitor
 * actually downloads before the first frame is the entry PLUS everything the
 * document preloads, and a chunk that migrates out of the entry into a
 * preload costs exactly as much while making the entry check greener. This
 * counts the real total.
 *
 * HARD since 3.0. It was advisory for four phases on the reasoning that a
 * figure moving with every dependency bump becomes a gate people raise rather
 * than read — and in those four phases it drifted 211 → 220 KB and nobody
 * acted on a single printed line.
 *
 * What it was hiding was not a dependency bump. The help sheet is mounted in
 * the composition root, so it is on every page, and it imported its section
 * panel STATICALLY — which put the guide's eleven `?raw` markdown bodies and
 * `marked` in the entry chunk for every visitor, including one who never opens
 * the guide. One `lazy()` took first paint from 220.5 to 172.8 KB.
 *
 * That is the argument for the gate rather than against it, and the entry
 * budget above is why: with the panel static the ENTRY check reads a
 * comfortable 128.6 of 300 KB and says nothing is wrong. Only the total says
 * so. Raise this deliberately if a real dependency needs the room — with the
 * reason, here.
 */
const FIRST_PAINT_GZ = 200 * 1024;
const firstPaintGz =
  (entryMatch ? gzipSync(readFileSync(join(DIST, 'assets', entryMatch[1]))).length : 0) +
  preloaded.reduce(
    (sum, name) =>
      sum +
      (existsSync(join(DIST, 'assets', name))
        ? gzipSync(readFileSync(join(DIST, 'assets', name))).length
        : 0),
    0,
  );
check(
  `first paint is ${(firstPaintGz / 1024).toFixed(1)} KB gz (entry + ${preloaded.length} ` +
    `modulepreload${preloaded.length === 1 ? '' : 's'}) of ${FIRST_PAINT_GZ / 1024} KB`,
  firstPaintGz <= FIRST_PAINT_GZ,
  'the entry PLUS everything index.html preloads — a chunk that migrates from the entry into a ' +
    'preload costs exactly as much while making the entry check greener. Usually a static import ' +
    'that should be a `lazy()`, or a barrel re-export pulling a parser in behind a helper.',
);

check('dist/.build-rev exists (npm run build stamps what it built)', existsSync(join(DIST, '.build-rev')));

/* ------------------------------------------------------------------ */

let failed = 0;
for (const { name, condition, detail } of results) {
  process.stdout.write(`${condition ? '✓' : '✗'} ${name}\n`);
  if (!condition) {
    failed += 1;
    if (detail) process.stdout.write(`  ${detail}\n`);
  }
}
process.stdout.write(
  failed === 0
    ? `check-dist: all ${results.length} checks passed.\n`
    : `check-dist: ${failed} of ${results.length} checks FAILED.\n`,
);
process.exit(failed === 0 ? 0 : 1);
