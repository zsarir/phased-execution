/**
 * What the console serves — built or not.
 *
 * The client is built output (`client/dist`, gitignored), so a fresh clone
 * answers requests before any build exists, and a machine mid-build answers
 * them while `dist/` is empty. Two promises must hold in BOTH states, and this
 * file spawns the real server to hold them:
 *
 *   1. `GET /` is 200 with a real HTML document — never a hang, never a 404.
 *      Built, that is the app shell; not built, a page naming the two commands.
 *      (`access.test.ts` asserts 200 on `/` too, but only ever sees the state
 *      this machine happens to be in; this file is why both states pass.)
 *
 *   2. `GET /sw.js` is 200 with a PUSH-CAPABLE service worker. A registered
 *      worker whose script URL 404s on update is UNREGISTERED by the browser,
 *      and the push subscriptions bound to it die silently with it — and two
 *      real devices are subscribed to this exact URL. Built, the precaching
 *      worker answers; not built, `server/fallback-sw.js` (the retired legacy
 *      worker, verbatim) does. Either way the push listener must be present —
 *      the built output backtick-quotes its strings, so the pattern accepts
 *      any quote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join } from 'node:path';

import { VIEWER_DIR } from '../server/config.ts';

type Reply = { status: number; type: string; body: string };

function http(port: number, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers['content-type'] ?? '');
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status, type, body }));
      res.on('error', () => resolve({ status, type, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function freePort(): Promise<number> {
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

async function waitFor(port: number, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state')).status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('the console answers in both build states', async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    join(VIEWER_DIR, 'server', 'index.ts'), '--port', String(port), '--no-open', '--no-log-file',
  ], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  await t.test('GET / is a real HTML document', async () => {
    const reply = await http(port, '/');
    assert.equal(reply.status, 200);
    assert.match(reply.type, /text\/html/);
    assert.match(reply.body.trimStart().slice(0, 40).toLowerCase(), /^<!doctype html>/,
      'without a doctype every browser renders in quirks mode');
    assert.match(reply.body, /<html[^>]+lang=/, 'the document must declare its language');
  });

  await t.test('GET /sw.js is a push-capable worker', async () => {
    const reply = await http(port, '/sw.js');
    assert.equal(reply.status, 200, 'a 404 here UNREGISTERS every subscribed device');
    assert.match(reply.type, /javascript/);
    assert.match(reply.body, /addEventListener\((["'`])push\1/,
      'the worker at /sw.js must handle push, built or not');
  });

  await t.test('an unknown asset is a 404, an unknown page is the shell', async () => {
    assert.equal((await http(port, '/assets/definitely-not-here.js')).status, 404);
    const page = await http(port, '/no-such-page');
    assert.equal(page.status, 200, 'extensionless paths fall through to the SPA entry');
    assert.match(page.type, /text\/html/);
  });
});
