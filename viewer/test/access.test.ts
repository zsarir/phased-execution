/**
 * Who may talk to the console.
 *
 * Two halves. The first is `classify` on its own, because the interesting
 * cases are combinations of two headers and there are more of them than a
 * round-trip test would be pleasant to write. The second boots the real server
 * and speaks HTTP to it, because the decision being correct is worth nothing if
 * it is not actually consulted — and it has to be consulted ahead of the API,
 * the event stream and the static files alike.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

import { VIEWER_DIR, flagsRefusal, parseFlags } from '../server/config.ts';
import { classify, hostnameOf } from '../server/api/access.ts';

const HOST = 'console.example.ts.net';
const USER = 'operator@example.com';

function req(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const remote = parseFlags(['--remote', HOST, '--remote-user', USER]);
const local = parseFlags([]);

/* ------------------------------------------------------------------ *
 * hostnameOf
 * ------------------------------------------------------------------ */

test('hostnameOf strips the port without mangling IPv6', () => {
  assert.equal(hostnameOf('127.0.0.1:4123'), '127.0.0.1');
  assert.equal(hostnameOf('localhost'), 'localhost');
  assert.equal(hostnameOf('[::1]:4123'), '[::1]');
  // A bare IPv6 has colons but no port; splitting on the last one would leave
  // `::` and quietly stop matching loopback.
  assert.equal(hostnameOf('::1'), '::1');
  assert.equal(hostnameOf('Console.Example.TS.net.'), 'console.example.ts.net');
  assert.equal(hostnameOf(undefined), '');
});

/* ------------------------------------------------------------------ *
 * classify — local-only, which is the default and the common case
 * ------------------------------------------------------------------ */

test('without --remote nothing is refused, whatever the Host', () => {
  for (const host of ['127.0.0.1:4123', 'anything.example', '192.168.1.4:4123', undefined]) {
    const verdict = classify(req(host ? { host } : {}), local);
    assert.equal(verdict.ok, true, `${host} should be served`);
    assert.equal(verdict.ok && verdict.scope, 'local');
  }
});

test('without --remote a stray identity header changes nothing', () => {
  const verdict = classify(req({ host: 'anything.example', 'tailscale-user-login': USER }), local);
  assert.equal(verdict.ok, true);
});

/* ------------------------------------------------------------------ *
 * classify — with --remote
 * ------------------------------------------------------------------ */

test('loopback with no identity is still the local console', () => {
  for (const host of ['127.0.0.1:4123', 'localhost:4123', '[::1]:4123', '::1']) {
    const verdict = classify(req({ host }), remote);
    assert.equal(verdict.ok, true, `${host} should be local`);
    assert.equal(verdict.ok && verdict.scope, 'local');
  }
});

test('a request with no Host header at all is local', () => {
  // HTTP/1.0 and some scripted clients send none. Only loopback can reach the
  // socket in the first place, so this is the same trust as any other loopback.
  const verdict = classify(req({}), remote);
  assert.equal(verdict.ok, true);
});

test('the remote hostname with an allowed login is admitted, case-insensitively', () => {
  const verdict = classify(req({ host: 'Console.Example.TS.net', 'tailscale-user-login': 'Operator@Example.com' }), remote);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.scope, 'remote');
  assert.equal(verdict.ok && verdict.login, USER);
});

test('the remote hostname without an identity is refused', () => {
  const verdict = classify(req({ host: HOST }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 403);
  assert.equal(!verdict.ok && verdict.reason, 'no-identity');
});

test('a login that is not on the list is refused', () => {
  const verdict = classify(req({ host: HOST, 'tailscale-user-login': 'mallory@example.com' }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 403);
  assert.equal(!verdict.ok && verdict.reason, 'not-allowed');
});

test('an unknown Host is refused rather than served', () => {
  // This is the DNS-rebinding case: a page on another origin resolving its own
  // name to 127.0.0.1 arrives with its own Host, and same-origin policy then
  // treats it as this app.
  const verdict = classify(req({ host: 'attacker.example:4123' }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 421);
  assert.equal(!verdict.ok && verdict.reason, 'unknown-host');
});

test('a proxied request asking for a loopback Host is refused', () => {
  // The one that makes the pair a pair. A caller on the tailnet can put any
  // Host they like in the request; if a loopback Host alone meant "local", it
  // would skip the identity check entirely. The proxy sets the identity header
  // on everything it forwards, so this combination cannot be honest.
  const verdict = classify(req({ host: '127.0.0.1:4123', 'tailscale-user-login': USER }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 421);
  assert.equal(!verdict.ok && verdict.reason, 'proxied-as-local');
});

test('a duplicated identity header is no identity', () => {
  // Node hands repeated headers over as an array. Taking the first would let a
  // caller bury the proxy's value behind one of their own.
  const verdict = classify(req({ host: HOST, 'tailscale-user-login': [USER, 'mallory@example.com'] }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.reason, 'no-identity');
});

/* ------------------------------------------------------------------ *
 * The flags themselves
 * ------------------------------------------------------------------ */

test('--remote and --remote-user fold to lower case and dedupe', () => {
  const flags = parseFlags(['--remote', 'A.Example.Ts.Net.', '--remote', 'a.example.ts.net',
    '--remote-user', 'Me@X.com', '--remote-user', 'me@x.com']);
  assert.deepEqual(flags.remoteHosts, ['a.example.ts.net']);
  assert.deepEqual(flags.remoteUsers, ['me@x.com']);
});

test('a comma-separated list is the same as repeating the flag', () => {
  const flags = parseFlags(['--remote-user', 'a@x.com, b@x.com']);
  assert.deepEqual(flags.remoteUsers, ['a@x.com', 'b@x.com']);
});

test('--remote without --remote-user is a refusal to start', () => {
  const refusal = flagsRefusal(parseFlags(['--remote', HOST]));
  assert.match(String(refusal), /needs at least one --remote-user/);
});

test('--remote-user without --remote is a refusal to start', () => {
  assert.match(String(flagsRefusal(parseFlags(['--remote-user', USER]))), /does nothing without/);
});

test('a URL where a hostname belongs is a refusal to start', () => {
  assert.match(String(flagsRefusal(parseFlags(['--remote', 'https://a.example', '--remote-user', USER]))),
    /is not a hostname/);
});

test('coherent flags start', () => {
  assert.equal(flagsRefusal(remote), null);
  assert.equal(flagsRefusal(local), null);
});

/* ------------------------------------------------------------------ *
 * The wiring: a real server, over HTTP
 * ------------------------------------------------------------------ */

/**
 * `fetch` cannot do this. `Host` is a forbidden header name, so undici drops it
 * without a word — which would make every Host case below silently pass as
 * loopback. The raw client is the only way to say what this test needs to say.
 */
type Reply = { status: number; type: string; body: string };

function http(
  port: number, path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; read?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req_ = request({
      host: '127.0.0.1', port, path,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
    }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers['content-type'] ?? '');
      // `/events` never ends. Take the status line and hang up.
      if (!opts.read) { res.destroy(); resolve({ status, type, body: '' }); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status, type, body }));
      res.on('error', () => resolve({ status, type, body }));
    });
    req_.on('error', reject);
    req_.end(opts.body);
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

test('the gate runs ahead of the API, the event stream and the static files', async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    join(VIEWER_DIR, 'server', 'index.ts'),
    '--port', String(port), '--no-open', '--no-log-file',
    '--remote', HOST, '--remote-user', USER,
  ], { stdio: 'ignore' });

  t.after(() => { child.kill('SIGKILL'); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  const status = async (path: string, headers: Record<string, string> = {}) =>
    (await http(port, path, { headers })).status;

  const allowed = { Host: HOST, 'Tailscale-User-Login': USER };

  // Every surface, not just /api.
  for (const path of ['/api/state', '/events', '/']) {
    assert.equal(await status(path), 200, `${path} from loopback`);
    assert.equal(await status(path, { Host: 'attacker.example' }), 421, `${path} with an unknown Host`);
    assert.equal(await status(path, { Host: HOST }), 403, `${path} with no identity`);
    assert.equal(await status(path, { Host: '127.0.0.1', 'Tailscale-User-Login': USER }), 421,
      `${path} proxied but asking for loopback`);
    assert.equal(await status(path, allowed), 200, `${path} with an allowed identity`);
  }

  // A refusal says why in words, because the alternative is debugging a blank
  // page on a phone.
  const refused = await http(port, '/api/state', { headers: { Host: 'attacker.example' }, read: true });
  assert.match(refused.type, /text\/plain/);
  assert.match(refused.body, /does not answer to/);
});

test('POST /api/prefs and /api/root are not drivable by another page', async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    join(VIEWER_DIR, 'server', 'index.ts'), '--port', String(port), '--no-open', '--no-log-file',
  ], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  const post = (path: string, headers: Record<string, string> = {}) =>
    http(port, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  // Neither is a capability — both have to work in a read-only console — but
  // neither may be driven from another origin either.
  for (const path of ['/api/prefs', '/api/root']) {
    assert.equal((await post(path)).status, 403, `${path} without the console header`);
    assert.equal((await post(path, { 'x-phase-console': '1', Origin: 'https://evil.example' })).status, 403,
      `${path} from another origin`);
  }
  assert.equal((await post('/api/prefs', { 'x-phase-console': '1' })).status, 200);
});

async function waitFor(port: number, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state')).status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
