/**
 * The usage poller against a mock endpoint.
 *
 * What must hold: the request looks exactly like the CLI's own (the User-Agent
 * is what keeps it out of the hostile rate-limit bucket); bucket names are
 * data, so a window that ships tomorrow renders today; failures serve the
 * last-known numbers rather than blanking them; a setup-token refusal is a
 * permanent "no usage data", not a retry loop; and concurrent kicks make one
 * request, not two.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsagePoller, parseBuckets, type AccountUsage, type TokenAnswer } from '../server/accounts/usage.ts';
import type { Exec } from '../server/accounts/credentials.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const versionExec: Exec = async (file, args) => {
  assert.equal(file, 'claude');
  assert.deepEqual(args, ['--version']);
  return { stdout: '9.9.9 (Claude Code)\n' };
};

type Answer = { status: number; body?: unknown };

/** A fetch stub that records requests and answers from a queue (last repeats). */
function fakeFetch(...answers: Answer[]) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)] ?? { status: 500 };
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, seen };
}

function poller(opts: {
  fetchFn: typeof fetch;
  resolveToken?: (id: string) => Promise<TokenAnswer>;
  onUpdate?: (id: string, usage: AccountUsage) => void;
  isActive?: (id: string) => boolean;
}): UsagePoller {
  return new UsagePoller({
    resolveToken: opts.resolveToken ?? (async () => ({ token: 'tok' })),
    exec: versionExec,
    base: 'http://usage.invalid/',
    fetchFn: opts.fetchFn,
    ...(opts.onUpdate ? { onUpdate: opts.onUpdate } : {}),
    ...(opts.isActive ? { isActive: opts.isActive } : {}),
  });
}

const OK = {
  status: 200,
  body: {
    five_hour: { utilization: 42.5, resets_at: '2026-08-06T20:00:00Z' },
    seven_day: { utilization: 12, resets_at: '2026-08-12T00:00:00Z' },
  },
};

/* ---------------- parsing ---------------- */

test('parseBuckets keeps every conforming key verbatim — including ones that do not exist yet', () => {
  const buckets = parseBuckets({
    five_hour: { utilization: 35, resets_at: '2026-08-06T22:00:00Z' },
    seven_day_fable: { utilization: 78.2, resets_at: '2026-08-12T20:00:00Z' },
    extra_usage: { enabled: true },              // no meter shape — ignored
    note: 'hello',                               // not an object — ignored
    clamped: { utilization: 250, resets_at: 'x' },
  });
  assert.deepEqual(Object.keys(buckets).sort(), ['clamped', 'five_hour', 'seven_day_fable']);
  assert.equal(buckets.seven_day_fable.utilization, 78.2);
  assert.equal(buckets.clamped.utilization, 100, 'utilization is clamped to a percent');
});

/* ---------------- the request ---------------- */

test('asks with the Bearer token, the oauth beta header, and the CLI-shaped User-Agent', async () => {
  const { fetchFn, seen } = fakeFetch(OK);
  const p = poller({ fetchFn });
  p.track('a');
  p.kick('a');
  await sleep(50);
  p.stop();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://usage.invalid/api/oauth/usage');
  assert.equal(seen[0].headers.authorization, 'Bearer tok');
  assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen[0].headers['user-agent'], 'claude-code/9.9.9', 'the version comes from `claude --version`');

  const snap = p.snapshot('a');
  assert.equal(snap?.buckets.five_hour.utilization, 42.5);
  assert.equal(snap?.buckets.five_hour.resetsAt, '2026-08-06T20:00:00Z');
});

test('two kicks in flight make one request', async () => {
  const { fetchFn, seen } = fakeFetch(OK);
  const p = poller({ fetchFn });
  p.track('a');
  p.kick('a');
  p.kick('a');
  await sleep(50);
  p.stop();
  assert.equal(seen.length, 1, 'single-flight');
});

/* ---------------- failure postures ---------------- */

test('a failure keeps the last-known buckets and stamps the reason beside them', async () => {
  const { fetchFn } = fakeFetch(OK, { status: 500 });
  const p = poller({ fetchFn });
  p.track('a');
  p.kick('a');
  await sleep(50);
  const good = p.snapshot('a');
  assert.ok(good && !good.error);

  p.kick('a');
  await sleep(50);
  p.stop();
  const stale = p.snapshot('a');
  assert.equal(stale?.buckets.five_hour.utilization, 42.5, 'yesterday beats blank');
  assert.equal(stale?.fetchedAt, good.fetchedAt, 'the age is honest — only a success moves it');
  assert.match(stale?.error ?? '', /500/);
});

test('429 backs off and says so', async () => {
  const { fetchFn } = fakeFetch({ status: 429 });
  const updates: AccountUsage[] = [];
  const p = poller({ fetchFn, onUpdate: (_, usage) => updates.push(usage) });
  p.track('a');
  p.kick('a');
  await sleep(50);
  p.stop();
  assert.match(updates.at(-1)?.error ?? '', /rate-limited/);
});

test('a refused setup-token becomes `unsupported` and stops the clock; a refused login is just an error', async () => {
  const refused = fakeFetch({ status: 403 });
  const p1 = poller({
    fetchFn: refused.fetchFn,
    resolveToken: async () => ({ token: 'oat', tokenKind: 'setup-token' }),
  });
  p1.track('a');
  p1.kick('a');
  await sleep(50);
  assert.equal(p1.snapshot('a')?.unsupported, true);
  p1.kick('a');
  await sleep(50);
  p1.stop();
  assert.equal(refused.seen.length, 2, 'an explicit kick may retry, but no timer re-arms on its own');

  const refused2 = fakeFetch({ status: 401 });
  const p2 = poller({ fetchFn: refused2.fetchFn });
  p2.track('b');
  p2.kick('b');
  await sleep(50);
  p2.stop();
  assert.equal(p2.snapshot('b')?.unsupported, undefined);
  assert.match(p2.snapshot('b')?.error ?? '', /refused/);
});

test('no credentials is a quiet state, not a crash', async () => {
  const { fetchFn, seen } = fakeFetch(OK);
  const p = poller({ fetchFn, resolveToken: async () => null });
  p.track('a');
  p.kick('a');
  await sleep(50);
  p.stop();
  assert.equal(seen.length, 0, 'nothing to ask with, nothing asked');
  assert.match(p.snapshot('a')?.error ?? '', /no credentials/);
});

test('untrack forgets the account entirely', async () => {
  const { fetchFn } = fakeFetch(OK);
  const p = poller({ fetchFn });
  p.track('a');
  p.kick('a');
  await sleep(50);
  p.untrack('a');
  assert.equal(p.snapshot('a'), undefined);
  p.stop();
});
