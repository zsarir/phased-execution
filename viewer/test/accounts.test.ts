/**
 * The accounts registry, its secrets, and the facade's redaction boundary.
 *
 * The properties that matter: registered metadata survives a restart with
 * owner-only modes; a secret NEVER appears in anything `list()` hands out;
 * the credential layer talks to a keychain only through the injected exec
 * (tests and CI must never touch a real one) and never to the CLI's own
 * `Claude Code-credentials*` items; and `pickAccount` chooses by headroom
 * while respecting learned-exhausted windows.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// accounts dir is a module-level const off INSTANCE_STATE_DIR.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { AccountStore, ACCOUNTS_DIR, profileConfigDir } from '../server/accounts/store.ts';
import { Credentials, claudeKeychainService, consoleKeychainService, type Exec } from '../server/accounts/credentials.ts';
import { Accounts } from '../server/accounts/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An exec that records every invocation and answers from a script. */
function fakeExec(answers: (file: string, args: string[]) => string | Error = () => '') {
  const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, ...(opts?.env ? { env: opts.env } : {}) });
    const answer = answers(file, args);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { exec, calls };
}

/* ---------------- store ---------------- */

test('store: add, update, remove round-trip through disk with owner-only modes', () => {
  const store = new AccountStore();
  const id = store.newId('Work Max');
  store.add({ id, kind: 'token', name: 'Work Max', createdAt: '2026-08-06T00:00:00Z' });

  const file = join(ACCOUNTS_DIR, 'accounts.json');
  assert.ok(existsSync(file), 'registry written');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'registry is owner-only');
  assert.equal(statSync(ACCOUNTS_DIR).mode & 0o777, 0o700, 'accounts dir is owner-only');

  const reread = new AccountStore();
  assert.equal(reread.get(id)?.name, 'Work Max');

  store.update(id, { email: 'work@example.com' });
  assert.equal(new AccountStore().get(id)?.email, 'work@example.com');

  assert.ok(store.remove(id));
  assert.equal(new AccountStore().get(id), undefined);
});

test('store: ids are readable, collision-suffixed, and never the built-in one', () => {
  const store = new AccountStore();
  assert.equal(store.newId('Work Max!'), 'work-max');
  store.add({ id: 'work-max', kind: 'token', createdAt: 'x' });
  const second = store.newId('Work MAX');
  assert.notEqual(second, 'work-max');
  assert.match(second, /^work-max-[0-9a-f]{4}$/);
  assert.equal(store.newId('Default'), 'default-2', 'the built-in id is never minted');
  store.remove('work-max');
});

test('store: markLimited keeps future windows and drops the ones already reset', () => {
  const store = new AccountStore();
  const id = store.newId('limits');
  store.add({ id, kind: 'token', createdAt: 'x' });
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  store.markLimited(id, 'five_hour', past);
  store.markLimited(id, 'seven_day', future);
  const kept = store.get(id)?.limitedUntil ?? {};
  assert.equal(kept.five_hour, undefined, 'a reset that has passed is not carried around');
  assert.equal(kept.seven_day, future);
  store.remove(id);
});

/* ---------------- credentials ---------------- */

test('credentials: linux token secrets are 0600 files under the account dir', async () => {
  const creds = new Credentials(fakeExec().exec, 'linux');
  await creds.storeToken('tok-a', 'sk-ant-oat01-abcdefghijklmnop');
  const file = join(ACCOUNTS_DIR, 'tok-a', 'token');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await creds.readToken('tok-a'), 'sk-ant-oat01-abcdefghijklmnop');
  await creds.deleteToken('tok-a');
  assert.equal(await creds.readToken('tok-a'), null);
});

test('credentials: macOS token secrets go through `security` under OUR service name', async () => {
  const { exec, calls } = fakeExec((file, args) => {
    if (file === 'security' && args[0] === 'find-generic-password') return 'the-token\n';
    return '';
  });
  const creds = new Credentials(exec, 'darwin');
  await creds.storeToken('tok-b', 'the-token');
  await creds.readToken('tok-b');
  await creds.deleteToken('tok-b');
  assert.ok(calls.every((c) => c.file === 'security'), 'nothing but `security` is spawned');
  for (const call of calls) {
    const service = call.args[call.args.indexOf('-s') + 1];
    assert.equal(service, consoleKeychainService('tok-b'));
    assert.ok(!service.startsWith('Claude Code'), "never the CLI's own items");
  }
});

test('credentials: the CLI keychain service derives from the config dir hash', () => {
  assert.equal(claudeKeychainService(null), 'Claude Code-credentials');
  const derived = claudeKeychainService('/tmp/some/profile');
  assert.match(derived, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.equal(derived, claudeKeychainService('/tmp/some/profile'), 'stable');
  assert.notEqual(derived, claudeKeychainService('/tmp/other/profile'));
});

test('credentials: envFor shapes — profile gets a config dir, token gets a token, default inherits', async () => {
  const creds = new Credentials(fakeExec().exec, 'linux');
  await creds.storeToken('tok-c', 'sekret');
  assert.equal(await creds.envFor(null), null);
  assert.equal(await creds.envFor({ id: 'default', kind: 'default', createdAt: '' } as never), null);
  assert.deepEqual(
    await creds.envFor({ id: 'prof-a', kind: 'profile', createdAt: '' }),
    { CLAUDE_CONFIG_DIR: profileConfigDir('prof-a') },
  );
  const tokenEnv = await creds.envFor({ id: 'tok-c', kind: 'token', createdAt: '' });
  assert.deepEqual(tokenEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'sekret' });
  assert.equal(
    (tokenEnv as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR,
    undefined,
    'a token account keeps the default config dir so transcripts stay portable',
  );
  await creds.deleteToken('tok-c');
});

/* ---------------- the facade ---------------- */

function makeAccounts(overrides: {
  fetchFn?: typeof fetch;
  exec?: Exec;
  onChange?: () => void;
} = {}): Accounts {
  return new Accounts({
    platform: 'linux',
    exec: overrides.exec ?? fakeExec().exec,
    ...(overrides.fetchFn ? { fetchFn: overrides.fetchFn, usageBase: 'http://usage.invalid' } : {}),
    ...(overrides.onChange ? { onChange: overrides.onChange } : {}),
  });
}

test('facade: a token never leaves through list(), and remove() forgets everything', async () => {
  const accounts = makeAccounts();
  const view = await accounts.addToken('Spare Max', 'sk-ant-oat01-supersecretvalue00');
  assert.equal(view.kind, 'token');
  assert.equal(view.name, 'Spare Max');

  const everything = JSON.stringify(await accounts.list());
  assert.ok(!everything.includes('supersecretvalue'), 'no secret in any view');
  assert.ok(!everything.includes(ACCOUNTS_DIR), 'no state paths in any view');

  assert.ok(await accounts.remove(view.id));
  const after = await accounts.list();
  assert.equal(after.some((a) => a.id === view.id), false);
  accounts.stop();
});

test('facade: the default account is always first, built in, and irremovable', async () => {
  const accounts = makeAccounts();
  const list = await accounts.list();
  assert.equal(list[0]?.id, 'default');
  assert.equal(list[0]?.builtIn, true);
  await assert.rejects(() => accounts.remove('default'));
  accounts.stop();
});

test('facade: envFor answers null for the default and unknown ids', async () => {
  const accounts = makeAccounts();
  assert.equal(await accounts.envFor(undefined), null);
  assert.equal(await accounts.envFor('default'), null);
  assert.equal(await accounts.envFor('never-registered'), null);
  accounts.stop();
});

test('facade: pickAccount prefers measured headroom and skips learned-exhausted windows', async () => {
  const usage: Record<string, number> = { fresh: 15, busy: 85 };
  const tokens = new Map<string, string>();
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).authorization ?? '');
    const id = tokens.get(auth.replace('Bearer ', '')) ?? 'unknown';
    return new Response(JSON.stringify({
      five_hour: { utilization: usage[id] ?? 50, resets_at: '2026-08-06T20:00:00Z' },
      seven_day: { utilization: 10, resets_at: '2026-08-12T00:00:00Z' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const accounts = makeAccounts({ fetchFn });
  const fresh = await accounts.addToken('fresh', 'token-fresh-aaaaaaaaaaaa');
  const busy = await accounts.addToken('busy', 'token-busy-bbbbbbbbbbbbb');
  tokens.set('token-fresh-aaaaaaaaaaaa', 'fresh');
  tokens.set('token-busy-bbbbbbbbbbbbb', 'busy');
  await sleep(80);   // both kicks land

  // The default account has no meters here (no login on the sandbox box) —
  // unknown scores 50, so measured-15 wins, measured-85 loses to unknown.
  assert.equal(accounts.pickAccount('default'), fresh.id);

  accounts.markLimited(fresh.id, 'five_hour', new Date(Date.now() + 3_600_000).toISOString());
  assert.notEqual(accounts.pickAccount('default'), fresh.id, 'a learned-exhausted window disqualifies');

  const noOne = accounts.pickAccount(busy.id);
  assert.notEqual(noOne, busy.id, 'never answers the account being escaped from');
  accounts.stop();
  await accounts.remove(fresh.id);
  await accounts.remove(busy.id);
});

test('facade: limitedUntil for the default account lives in memory and prunes itself', () => {
  const accounts = makeAccounts();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  accounts.markLimited(undefined, 'five_hour', future);
  accounts.markLimited('default', 'seven_day', new Date(Date.now() - 1_000).toISOString());
  const live = accounts.limitedUntil('default');
  assert.equal(live.five_hour, future);
  assert.equal(live.seven_day, undefined);
  accounts.stop();
});

test('facade: registry file never contains a secret even after many operations', async () => {
  const accounts = makeAccounts();
  const v = await accounts.addToken('Scrub Me', 'sk-ant-oat01-scrubbablevalue11');
  accounts.markLimited(v.id, 'five_hour', new Date(Date.now() + 1000 * 60).toISOString());
  const raw = readFileSync(join(ACCOUNTS_DIR, 'accounts.json'), 'utf8');
  assert.ok(!raw.includes('scrubbablevalue'), 'accounts.json holds metadata only');
  await accounts.remove(v.id);
  accounts.stop();
});
