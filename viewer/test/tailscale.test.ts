/**
 * Reading the tailnet.
 *
 * This module's whole job is to be wrong safely. It shells out to a binary
 * that may not exist, to a daemon that may not be running, and hands the
 * result to a settings page — so what is pinned here is mostly the degenerate
 * paths, plus the one hard rule the happy path has to keep: that the CLI's
 * JSON, which contains an `AuthURL` a stranger could join the tailnet with,
 * never reaches the browser.
 *
 * Every fixture is invented. Hostnames, tailnet names and DNS suffixes here
 * are `alpha`/`beta`/`example.ts.net` and nothing from the machine that ran
 * this — writing the real ones down in order to assert about them would BE the
 * leak the scrub looks for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tailscaleStatus, resetTailscaleCache } from '../server/tailscale.ts';

const PORT = 4123;

/** A status payload shaped like the CLI's, including the parts that must not escape. */
const RUNNING = {
  Version: '1.80.0',
  BackendState: 'Running',
  // Three secrets, one per class: a join URL, a key, and a capability map.
  AuthURL: 'https://login.example.com/a/SUPERSECRETJOINTOKEN',
  HaveNodeKey: true,
  MagicDNSSuffix: 'example.ts.net',
  CurrentTailnet: { Name: 'alpha@example.com', MagicDNSSuffix: 'example.ts.net', MagicDNSEnabled: true },
  Self: {
    HostName: 'alpha',
    DNSName: 'alpha.example.ts.net.',
    OS: 'macOS',
    TailscaleIPs: ['100.64.0.1'],
    Online: true,
    PublicKey: 'nodekey:SUPERSECRETPUBLICKEY',
    CapMap: { 'https://example.com/cap/admin': null },
  },
  Peer: {
    'nodekey:aaa': {
      HostName: 'beta',
      DNSName: 'beta.example.ts.net.',
      OS: 'iOS',
      TailscaleIPs: ['100.64.0.2'],
      Online: true,
      PublicKey: 'nodekey:SUPERSECRETPUBLICKEY',
    },
    'nodekey:bbb': {
      HostName: 'gamma',
      DNSName: 'gamma.example.ts.net.',
      OS: 'windows',
      TailscaleIPs: ['100.64.0.3'],
      Online: false,
      LastSeen: '2026-06-01T10:00:00Z',
    },
  },
};

const SERVED = {
  TCP: { 443: { HTTPS: true } },
  Web: { 'alpha.example.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` } } } },
};

/**
 * A stand-in `tailscale` that answers the two subcommands this module calls.
 *
 * It also appends a line per invocation, which is how the cache is proved: the
 * only honest evidence that a second call did not shell out is that the binary
 * did not run.
 */
function fakeCli(options: { status?: unknown; serve?: unknown; exit?: number; stderr?: string }): {
  bin: string; calls: () => string[]; cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'pc-tailscale-'));
  const bin = join(dir, 'tailscale');
  const calls = join(dir, 'calls.log');

  const emit = (value: unknown) => (value === undefined ? '' : JSON.stringify(value));

  writeFileSync(bin, `#!/usr/bin/env bash
echo "$1 $2" >> ${JSON.stringify(calls)}
if [ "$1" = "serve" ]; then
  cat <<'SERVE_EOF'
${emit(options.serve)}
SERVE_EOF
  exit 0
fi
${options.stderr ? `echo ${JSON.stringify(options.stderr)} >&2` : ''}
cat <<'STATUS_EOF'
${emit(options.status)}
STATUS_EOF
exit ${options.exit ?? 0}
`, 'utf8');
  chmodSync(bin, 0o755);

  return {
    bin,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Point the module at a binary for one probe, with the memo cleared either side. */
async function probeWith(bin: string, port = PORT) {
  process.env.PHASE_CONSOLE_TAILSCALE_BIN = bin;
  resetTailscaleCache();
  try {
    return await tailscaleStatus(port);
  } finally {
    delete process.env.PHASE_CONSOLE_TAILSCALE_BIN;
    resetTailscaleCache();
  }
}

test('no binary at all reads as not-installed, not as an error', async () => {
  const status = await probeWith(join(tmpdir(), 'pc-tailscale-does-not-exist', 'tailscale'));
  assert.deepEqual(status, { state: 'not-installed' });
});

test('signed out is installed-not-running, and says which state in the CLI\'s own words', async () => {
  const cli = fakeCli({ status: { BackendState: 'NeedsLogin' } });
  try {
    const status = await probeWith(cli.bin);
    assert.deepEqual(status, { state: 'installed-not-running', detail: 'NeedsLogin' });
  } finally { cli.cleanup(); }
});

test('a daemon that answers nothing is installed-not-running, and its stderr is not repeated', async () => {
  // The real message names a local socket path; this asserts we say our own
  // sentence rather than passing the CLI's through to a web page.
  const cli = fakeCli({ exit: 1, stderr: 'failed to connect to local tailscaled at /var/run/tailscale/x.sock' });
  try {
    const status = await probeWith(cli.bin);
    assert.equal(status.state, 'installed-not-running');
    const detail = 'detail' in status ? status.detail ?? '' : '';
    assert.match(detail, /daemon is not responding/);
    assert.doesNotMatch(detail, /sock|tailscaled/);
  } finally { cli.cleanup(); }
});

test('a running tailnet reports its devices, newest facts first', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  try {
    const status = await probeWith(cli.bin);
    assert.equal(status.state, 'running');
    if (status.state !== 'running') return;

    assert.equal(status.tailnet, 'alpha@example.com');
    assert.equal(status.magicDns, true);
    assert.equal(status.magicDnsSuffix, 'example.ts.net');

    // The trailing dot on a DNSName is a wire detail, not something to render.
    assert.equal(status.self.dnsName, 'alpha.example.ts.net');
    assert.deepEqual(status.self.ips, ['100.64.0.1']);

    // Online first, so the devices you could actually open this on lead.
    assert.deepEqual(status.peers.map((p) => p.hostName), ['beta', 'gamma']);
    assert.equal(status.peers[0].online, true);
    assert.equal(status.peers[0].os, 'iOS');
  } finally { cli.cleanup(); }
});

test('last-seen is carried only for a device that is offline', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    // An online device with a "last seen" timestamp reads as staleness that is
    // not there.
    assert.equal(status.peers[0].lastSeen, undefined);
    assert.equal(status.peers[1].lastSeen, '2026-06-01T10:00:00Z');
  } finally { cli.cleanup(); }
});

test('nothing from the CLI survives that was not asked for by name', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  try {
    const status = await probeWith(cli.bin);
    const wire = JSON.stringify(status);
    // The join URL is the sharp one: it is a credential in a query string.
    assert.doesNotMatch(wire, /SUPERSECRETJOINTOKEN/);
    assert.doesNotMatch(wire, /SUPERSECRETPUBLICKEY/);
    assert.doesNotMatch(wire, /AuthURL|PublicKey|CapMap|HaveNodeKey/);
  } finally { cli.cleanup(); }
});

test('serve pointed at this console yields the URL that reaches it', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.deepEqual(status.serve, {
      active: true, forOurPort: true, url: 'https://alpha.example.ts.net',
    });
  } finally { cli.cleanup(); }
});

test('every spelling of loopback the CLI accepts still counts as this console', async () => {
  for (const proxy of [
    `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`,
    `http://127.0.0.1:${PORT}/`,
  ]) {
    const cli = fakeCli({
      status: RUNNING,
      serve: { Web: { 'alpha.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } },
    });
    try {
      const status = await probeWith(cli.bin);
      if (status.state !== 'running') return assert.fail('expected running');
      assert.equal(status.serve.forOurPort, true, `${proxy} should read as this console`);
    } finally { cli.cleanup(); }
  }
});

test('serving a different port is its own state, not "not serving"', async () => {
  // Collapsing this into inactive would tell someone to run a serve command
  // that is already running.
  const cli = fakeCli({
    status: RUNNING,
    serve: { Web: { 'alpha.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } },
  });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.deepEqual(status.serve, { active: true, forOurPort: false });
  } finally { cli.cleanup(); }
});

test('no serve configured is inactive, with no URL invented for it', async () => {
  const cli = fakeCli({ status: RUNNING, serve: {} });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.deepEqual(status.serve, { active: false, forOurPort: false });
  } finally { cli.cleanup(); }
});

test('a second read inside the window does not shell out again', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  process.env.PHASE_CONSOLE_TAILSCALE_BIN = cli.bin;
  resetTailscaleCache();
  try {
    await tailscaleStatus(PORT);
    const afterFirst = cli.calls().length;
    assert.ok(afterFirst > 0, 'the first read must actually run the CLI');

    await tailscaleStatus(PORT);
    assert.equal(cli.calls().length, afterFirst, 'the second read must come from the memo');

    // A different port is a different question and must not be answered from
    // the memo of the first one.
    await tailscaleStatus(9999);
    assert.ok(cli.calls().length > afterFirst, 'another port must re-probe');
  } finally {
    delete process.env.PHASE_CONSOLE_TAILSCALE_BIN;
    resetTailscaleCache();
    cli.cleanup();
  }
});

test('a named binary that is missing is not silently replaced by another one', async () => {
  // The fallback search exists for the macOS app bundle; it must not run when
  // someone has said exactly which binary to use.
  const status = await probeWith('/nonexistent/tailscale');
  assert.deepEqual(status, { state: 'not-installed' });
});

/* ---------------- the route ----------------
 * Through the real `handleApi`, because the thing worth pinning is that the
 * endpoint answers at all and asks about the console's OWN port — a probe
 * against the wrong port reports a working setup as a mismatch. */

const { handleApi } = await import('../server/api/routes.ts');

async function get(path: string, port: number) {
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = text; } },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  const req = {
    method: 'GET',
    headers: { host: `127.0.0.1:${port}` },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () {},
  };
  const service = { flags: { allowWrites: false, allowRun: false, scriptsDir: '/x', port } };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:${port}${path}`));
  return { status, payload };
}

test('GET /api/tailscale answers with the status for this console\'s port', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  process.env.PHASE_CONSOLE_TAILSCALE_BIN = cli.bin;
  resetTailscaleCache();
  try {
    const ok = await get('/api/tailscale', PORT);
    assert.equal(ok.status, 200);
    assert.equal((ok.payload as { state: string }).state, 'running');
    assert.equal((ok.payload as { serve: { forOurPort: boolean } }).serve.forOurPort, true);

    // Same tailnet, console on another port: the serve entry is no longer ours.
    resetTailscaleCache();
    const other = await get('/api/tailscale', 9999);
    assert.equal((other.payload as { serve: { forOurPort: boolean } }).serve.forOurPort, false);
  } finally {
    delete process.env.PHASE_CONSOLE_TAILSCALE_BIN;
    resetTailscaleCache();
    cli.cleanup();
  }
});

test('a machine with no Tailscale still answers 200, so the card can say so', async () => {
  process.env.PHASE_CONSOLE_TAILSCALE_BIN = '/nonexistent/tailscale';
  resetTailscaleCache();
  try {
    const { status, payload } = await get('/api/tailscale', PORT);
    assert.equal(status, 200, 'not-installed is an answer, not an error');
    assert.deepEqual(payload, { state: 'not-installed' });
  } finally {
    delete process.env.PHASE_CONSOLE_TAILSCALE_BIN;
    resetTailscaleCache();
  }
});
