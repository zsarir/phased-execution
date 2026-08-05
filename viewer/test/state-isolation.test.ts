/**
 * The suite writes under its own temporary directory, and nowhere else.
 *
 * This exists because it once did not. A phase lock owned by
 * `test…/test` turned up in a real handoff folder — in a plan
 * nobody was working on — and `phase-lock.sh conflicts` scans every plan, so
 * that one stray file refused a claim on unrelated work until someone found and
 * deleted it by hand. Whatever wrote it, the shape of the accident is the same:
 * a test booting real machinery against the operator's real state.
 *
 * Two rules keep it from happening again, and both are checked here rather than
 * remembered:
 *
 *   1. Every console the suite spawns gets its own `XDG_CONFIG_HOME` — the
 *      console keeps everything it persists under that one directory, so an
 *      isolated one means an isolated console.
 *   2. Every console the suite spawns gets a sandbox `--root`. Without one it
 *      opens whatever the config remembers, which on a working machine is the
 *      operator's real plan library, and then watches it, schedules against it
 *      and offers to write to it.
 *
 * Both are enforced by construction: `test/spawn-console.ts` is the only way to
 * spawn one. The source check below is what stops the next test file from
 * quietly going back to a bare `spawn()`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';

import { VIEWER_DIR } from '../server/config.ts';
import { spawnConsole } from './spawn-console.ts';

const TEST_DIR = join(VIEWER_DIR, 'test');

/**
 * The one that reaches people. `~/.local/state/phase-console/push/subscriptions.json`
 * is the operator's actual subscribed browsers and phones; anything that
 * constructs a real Service or spawns a real console loads it and can deliver.
 * It happened: a shutdown test's console announced its own shutdown, and the
 * notification arrived on the operator's machine from a console they never
 * started.
 */
test('no test file touches the console state directory for real', () => {
  // Deliberately "imports anything from server/" rather than a list of the
  // modules that resolve STATE_DIR. Those seven are reached transitively as
  // often as directly — `runner/transcript.ts` pulls in `runner/state.ts`, and
  // an import list that has to be right about the whole graph is an import list
  // that will be wrong. Redirecting costs one line and is never wrong.
  const consumers = /from '\.\.\/server\//;
  const offenders: string[] = [];

  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts'))) {
    const source = readFileSync(join(TEST_DIR, file), 'utf8');
    if (!consumers.test(source)) continue;
    // Either redirect inline before your own dynamic imports, or import the
    // sandbox module first. Both resolve before `server/config.ts` reads them.
    const redirects = /XDG_STATE_HOME/.test(source) || /from '\.\/state-sandbox\.ts'|'\.\/state-sandbox\.ts'/.test(source);
    if (!redirects) offenders.push(file);
  }

  assert.deepEqual(offenders, [],
    `these files would read the operator's real push subscriptions — import './state-sandbox.ts' first:\n  ${offenders.join('\n  ')}`);
});

test('a sandboxed console keeps its state out of the real state directory', async (t) => {
  const port = await freePort();
  const { child, box } = spawnConsole(VIEWER_DIR, port, [], { withRoot: true });
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });
  if (!await up(port)) assert.fail('the console did not come up');

  // A console writes its log the moment it starts; that it landed in the
  // sandbox is proof the whole state directory moved with it — push register
  // included, which is the file this is really about.
  assert.ok(existsSync(join(box.stateHome, 'phase-console')),
    `the console put its state somewhere else — expected it under ${box.stateHome}`);
});

test('no test file spawns the console without the sandbox helper', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts'))) {
    if (file === 'spawn-console.ts') continue;
    const source = readFileSync(join(TEST_DIR, file), 'utf8');
    // The server entry point named inside a spawn argv is the tell. Naming it in
    // prose or in a path is fine; handing it to a child process is not.
    if (/spawn\([^)]*\bserver['"]?\s*,\s*['"]index\.ts|spawn\([^)]*server\/index\.ts/s.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    `these files spawn a console directly — use spawnConsole() from test/spawn-console.ts:\n  ${offenders.join('\n  ')}`);
});

test('no test points a live console at the operator\'s real plan library', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(TEST_DIR, file), 'utf8');
    // `PHASE_CONSOLE_TEST_ROOT` is a *reading* root for the parity tests. A
    // `--root` argument next to it is a console told to open real work.
    if (/--root['"]?\s*,\s*[^)\n]*PHASE_CONSOLE_TEST_ROOT/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    `a spawned console must never be rooted at the real library:\n  ${offenders.join('\n  ')}`);
});

/**
 * The runtime half: boot one for real and prove its whole footprint landed in
 * the sandbox. A source check alone would pass just as happily if the helper
 * stopped isolating anything.
 */
test('a spawned console keeps its state inside the sandbox', async (t) => {
  const port = await freePort();
  const { child, box } = spawnConsole(VIEWER_DIR, port, [], { withRoot: true });
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  if (!await up(port)) assert.fail('the console did not come up');

  // Ask it to remember something: `/api/prefs` is the write every console makes
  // whether or not `--allow-writes` was passed, so it is the honest probe.
  const wrote = await post(port, '/api/prefs', JSON.stringify({ theme: 'dark' }));
  assert.equal(wrote, 200);

  const configFile = join(box.configHome, 'phase-console', 'config.json');
  assert.ok(existsSync(configFile), `the console wrote its config somewhere else — expected ${configFile}`);
  assert.match(readFileSync(configFile, 'utf8'), /"theme"\s*:\s*"dark"/);

  // And it is reading the sandbox library, not one it remembered from elsewhere.
  const state = JSON.parse(await get(port, '/api/state')) as { root?: { path?: string } };
  assert.equal(state.root?.path, box.root);
});

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function call(port: number, path: string, init: { method?: string; body?: string } = {}): Promise<{
  status: number; body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: init.method ?? 'GET',
      headers: init.body ? { 'content-type': 'application/json', 'x-phase-console': '1' } : {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function up(port: number, tries = 120): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await call(port, '/api/state')).status === 200) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function get(port: number, path: string): Promise<string> {
  return (await call(port, path)).body;
}

async function post(port: number, path: string, body: string): Promise<number> {
  return (await call(port, path, { method: 'POST', body })).status;
}
