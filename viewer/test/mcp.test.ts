/**
 * The MCP registry, its secrets, the health probe, and the redaction boundary.
 *
 * The properties that matter: a registered server survives a restart with
 * owner-only modes; a secret NEVER appears in anything `list()` or the config
 * preview hands out; the credential layer talks to a keychain only through the
 * injected exec (tests and CI must never touch a real one); the probe reads the
 * CLI's `system/init` event and reports one row per server we ASKED about, so a
 * silently dropped server is `failed` rather than absent; and the two security
 * checks — the rug-pull fingerprint and the URL-carries-a-credential refusal —
 * actually fire.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// MCP dir is a module-level const off INSTANCE_STATE_DIR.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Exec } from '../server/accounts/credentials.ts';
import { buildMcpConfig, redactConfig, writeMcpConfigFile } from '../server/mcp/config.ts';
import { McpCredentials, mcpKeychainService } from '../server/mcp/credentials.ts';
import { blocksBoarding, probeMcp } from '../server/mcp/health.ts';
import { Mcp } from '../server/mcp/index.ts';
import { CURATED, searchCatalog, searchCurated } from '../server/mcp/catalog.ts';
import { McpStore, MCP_DIR, normaliseTransport } from '../server/mcp/store.ts';

/** An exec that records every invocation and answers from a script. */
function fakeExec(answers: (file: string, args: string[]) => string | Error = () => '') {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    const answer = answers(file, args);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { exec, calls };
}

/** A keychain that actually remembers, so store→read round-trips are testable. */
function keychainExec() {
  const held = new Map<string, string>();
  const { exec, calls } = fakeExec((file, args) => {
    if (file !== 'security') return '';
    const service = args[args.indexOf('-s') + 1];
    if (args[0] === 'add-generic-password') {
      held.set(service, args[args.indexOf('-w') + 1]);
      return '';
    }
    if (args[0] === 'find-generic-password') {
      const value = held.get(service);
      return value === undefined ? new Error('not found') : value;
    }
    if (args[0] === 'delete-generic-password') {
      if (!held.delete(service)) return new Error('not found');
      return '';
    }
    return '';
  });
  return { exec, calls, held };
}

/* ---------------- store ---------------- */

test('a registered server survives a restart, owner-only', () => {
  const store = new McpStore();
  store.add({ id: 'ctx7', transport: 'http', label: 'Context7', url: 'https://mcp.context7.com/mcp', createdAt: 'x' });

  const reopened = new McpStore();
  const found = reopened.get('ctx7');
  assert.equal(found?.url, 'https://mcp.context7.com/mcp');

  const file = join(MCP_DIR, 'servers.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(MCP_DIR).mode & 0o777, 0o700);

  reopened.remove('ctx7');
});

test('an id that is reserved, malformed or already taken is refused', () => {
  const store = new McpStore();
  store.add({ id: 'taken', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' });
  assert.throws(() => store.add({ id: 'taken', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' }), /already exists/);
  assert.throws(() => store.add({ id: 'Has Caps', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' }), /not usable/);
  assert.throws(() => store.add({ id: 'workspace', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' }), /reserved/);
  store.remove('taken');
});

test('disabling a server keeps its configuration but takes it out of the attachable set', () => {
  const store = new McpStore();
  store.add({ id: 'off-me', transport: 'stdio', command: 'npx', createdAt: 'x' });
  assert.ok(store.enabledIds().includes('off-me'));

  store.setEnabled('off-me', false);
  assert.ok(!store.enabledIds().includes('off-me'));
  assert.ok(new McpStore().get('off-me'), 'the row itself is still there');
  assert.equal(new McpStore().isEnabled('off-me'), false, 'and the choice survived a restart');

  store.remove('off-me');
});

test('a first tool list is not a change; a different one is', () => {
  const store = new McpStore();
  store.add({ id: 'drifty', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' });

  assert.equal(store.noteTools('drifty', ['read', 'write']).changed, false, 'first observation');
  assert.equal(store.noteTools('drifty', ['write', 'read']).changed, false, 'order is not a change');

  const drift = store.noteTools('drifty', ['read', 'write', 'exfiltrate']);
  assert.equal(drift.changed, true);
  assert.deepEqual(drift.before, ['read', 'write']);

  store.remove('drifty');
});

test('streamable-http is accepted as the alias the MCP spec uses', () => {
  assert.equal(normaliseTransport('streamable-http'), 'http');
  assert.equal(normaliseTransport('HTTP'), 'http');
  assert.equal(normaliseTransport('carrier-pigeon'), undefined);
});

/* ---------------- credentials ---------------- */

test('a secret round-trips through the keychain and never through the registry file', async () => {
  const { exec, calls } = keychainExec();
  const creds = new McpCredentials(exec, 'darwin');
  const ref = { kind: 'header' as const, name: 'Authorization', template: 'Bearer {}' };

  await creds.store('gh', ref, 'ghp_supersecret');
  assert.equal(await creds.read('gh', ref), 'ghp_supersecret');
  assert.equal(await creds.has('gh', ref), true);

  assert.ok(calls.every((call) => call.file === 'security'), 'only the keychain was consulted');
  const service = mcpKeychainService('gh', 'header:Authorization');
  assert.ok(service.startsWith('phase-console-mcp-'), 'our own service namespace, not the CLI’s');
  assert.ok(!service.includes('Claude Code-credentials'));

  const registry = existsSync(join(MCP_DIR, 'servers.json'))
    ? readFileSync(join(MCP_DIR, 'servers.json'), 'utf8')
    : '';
  assert.ok(!registry.includes('ghp_supersecret'), 'the registry never holds the secret');

  await creds.delete('gh', ref);
  assert.equal(await creds.read('gh', ref), null);
});

test('off darwin, secrets land in a 0600 file and nowhere else', async () => {
  const { exec, calls } = fakeExec();
  const creds = new McpCredentials(exec, 'linux');
  const ref = { kind: 'env' as const, name: 'API_KEY' };

  await creds.store('linuxy', ref, 'sk-test');
  assert.equal(await creds.read('linuxy', ref), 'sk-test');
  assert.equal(calls.length, 0, 'no process was spawned');
  assert.equal(statSync(join(MCP_DIR, 'linuxy', 'secrets.json')).mode & 0o777, 0o600);

  await creds.delete('linuxy', ref);
  assert.equal(existsSync(join(MCP_DIR, 'linuxy', 'secrets.json')), false, 'the last secret takes the file with it');
});

/* ---------------- config ---------------- */

test('secrets are spliced into the config, and the preview masks them', async () => {
  const { exec } = keychainExec();
  const creds = new McpCredentials(exec, 'darwin');
  const ref = { kind: 'header' as const, name: 'Authorization', template: 'Bearer {}' };
  await creds.store('gh', ref, 'ghp_tok');

  const doc = await buildMcpConfig([{
    id: 'gh', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    secretRefs: [ref], createdAt: 'x',
  }], creds);

  assert.equal(doc.mcpServers.gh.headers?.Authorization, 'Bearer ghp_tok');
  assert.equal(doc.mcpServers.gh.type, 'http');

  const masked = redactConfig(doc);
  assert.equal(masked.mcpServers.gh.headers?.Authorization, '••••••');
  assert.ok(!JSON.stringify(masked).includes('ghp_tok'));
});

test('a ${VAR} reference stays legible — it is the name of a secret, not one', async () => {
  const { exec } = fakeExec();
  const creds = new McpCredentials(exec, 'linux');
  const doc = await buildMcpConfig([{
    id: 'db', transport: 'stdio', command: 'npx', args: ['-y', '@bytebase/dbhub'],
    env: { DATABASE_URL: '${DATABASE_URL}' }, createdAt: 'x',
  }], creds);

  // Passed through unexpanded: the CLI expands it in the child's environment,
  // which is the whole reason to write it that way.
  assert.equal(doc.mcpServers.db.env?.DATABASE_URL, '${DATABASE_URL}');
  assert.equal(redactConfig(doc).mcpServers.db.env?.DATABASE_URL, '${DATABASE_URL}');
});

test('a ref with no stored secret is omitted rather than written empty', async () => {
  const { exec } = fakeExec(() => new Error('not found'));
  const creds = new McpCredentials(exec, 'darwin');
  const doc = await buildMcpConfig([{
    id: 'gh', transport: 'http', url: 'https://e.com/mcp',
    secretRefs: [{ kind: 'header', name: 'Authorization', template: 'Bearer {}' }], createdAt: 'x',
  }], creds);

  // An absent header fails with a 401 the console classifies as "needs
  // authentication"; an empty one is a malformed request reported as something else.
  assert.equal(doc.mcpServers.gh.headers, undefined);
});

test('the written config is 0600, and an empty set writes no file at all', () => {
  const path = writeMcpConfigFile('abcd1234', { mcpServers: { a: { type: 'http', url: 'https://e.com/mcp' } } });
  assert.ok(path);
  assert.equal(statSync(path!).mode & 0o777, 0o600);
  assert.equal(writeMcpConfigFile('empty', { mcpServers: {} }), null);
});

test('a per-server timeout below the CLI’s floor is dropped, not silently ignored', async () => {
  const { exec } = fakeExec();
  const creds = new McpCredentials(exec, 'linux');
  const doc = await buildMcpConfig([
    { id: 'slow', transport: 'http', url: 'https://e.com/mcp', timeoutMs: 600_000, createdAt: 'x' },
    { id: 'tiny', transport: 'http', url: 'https://e.com/mcp', timeoutMs: 200, createdAt: 'x' },
  ], creds);
  assert.equal(doc.mcpServers.slow.timeout, 600_000);
  assert.equal(doc.mcpServers.tiny.timeout, undefined, 'under 1000 the CLI ignores it anyway');
});

/* ---------------- health probe ---------------- */

/** A child process that emits one canned stdout payload then closes. */
function fakeSpawn(lines: string[], opts: { closeCode?: number } = {}) {
  const seen: { argv: string[] }[] = [];
  const spawnFn = ((_file: string, argv: string[]) => {
    seen.push({ argv });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
      if (!lines.length) child.emit('close', opts.closeCode ?? 1);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, seen };
}

const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  tools: ['Read', 'mcp__ctx7__query-docs', 'mcp__ctx7__resolve-library-id', 'mcp__gh__list_prs'],
  mcp_servers: [
    { name: 'ctx7', status: 'connected' },
    { name: 'gh', status: 'needs-auth' },
  ],
});

test('the probe reads system/init and reports status plus tools per server', async () => {
  const { spawnFn, seen } = fakeSpawn([INIT]);
  const probe = await probeMcp(
    { mcpServers: { ctx7: { type: 'http', url: 'https://a' }, gh: { type: 'http', url: 'https://b' } } },
    { spawnFn },
  );

  assert.equal(probe.probeError, undefined);
  assert.deepEqual(probe.servers.map((row) => [row.id, row.status]), [['ctx7', 'connected'], ['gh', 'needs-auth']]);
  assert.deepEqual(probe.servers[0].tools, ['query-docs', 'resolve-library-id']);

  // The set under test must be the only set, or the answer is about the wrong thing.
  assert.ok(seen[0].argv.includes('--strict-mcp-config'));
  assert.ok(seen[0].argv.includes('--mcp-config'));
  assert.deepEqual(seen[0].argv.slice(seen[0].argv.indexOf('--max-turns'), seen[0].argv.indexOf('--max-turns') + 2),
    ['--max-turns', '1'], 'one turn: the probe pays for a connect, never a thought');
});

test('a server the CLI dropped is failed, not absent', async () => {
  const { spawnFn } = fakeSpawn([JSON.stringify({
    type: 'system',
    subtype: 'init',
    mcp_servers: [{ name: 'good', status: 'connected' }],
    mcp_server_errors: [{ name: 'bad', type: 'url_missing_type', message: 'Skipped — no "type"' }],
  })]);

  const probe = await probeMcp(
    { mcpServers: { good: { type: 'http', url: 'https://a' }, bad: { type: 'http', url: 'https://b' }, vanished: { type: 'http', url: 'https://c' } } },
    { spawnFn },
  );

  const byId = Object.fromEntries(probe.servers.map((row) => [row.id, row]));
  assert.equal(byId.bad.status, 'failed');
  assert.match(byId.bad.error?.message ?? '', /Skipped/);
  assert.equal(byId.vanished.status, 'failed', 'silence is not consent');
});

test('a probe that cannot run says so instead of condemning the servers', async () => {
  const { spawnFn } = fakeSpawn([], { closeCode: 127 });
  const probe = await probeMcp({ mcpServers: { a: { type: 'http', url: 'https://a' } } }, { spawnFn });
  assert.match(probe.probeError ?? '', /before reporting server status/);
  assert.deepEqual(probe.servers, []);
});

test('pending never blocks boarding; a wall does', () => {
  assert.equal(blocksBoarding('pending'), false, 'a cached remote connects on first use');
  assert.equal(blocksBoarding('connected'), false);
  assert.equal(blocksBoarding('needs-auth'), true);
  assert.equal(blocksBoarding('failed'), true);
});

/* ---------------- the facade ---------------- */

function facade(lines: string[] = [INIT]) {
  const { exec } = keychainExec();
  const { spawnFn } = fakeSpawn(lines);
  return new Mcp({
    exec,
    platform: 'darwin',
    probeFn: (doc, opts) => probeMcp(doc, { ...opts, spawnFn }),
  });
}

test('a view carries no secret and no filesystem path', async () => {
  const mcp = facade();
  await mcp.add({
    label: 'GitHub', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    secretRefs: [{ kind: 'header', name: 'Authorization', template: 'Bearer {}' }],
    secrets: { 'header:Authorization': 'ghp_secret' },
  });

  const views = await mcp.list();
  const serialised = JSON.stringify(views);
  assert.ok(!serialised.includes('ghp_secret'), 'the secret never leaves');
  assert.ok(!serialised.includes(MCP_DIR), 'nor does a path on this machine');
  assert.deepEqual(views[0].auth, { kind: 'header', secrets: [{ ref: 'header:Authorization', held: true }] });

  await mcp.remove('github');
});

test('a URL carrying its own credential is refused, with the fix named', async () => {
  const mcp = facade();
  await assert.rejects(
    () => mcp.add({ label: 'Sneaky', transport: 'http', url: 'https://e.com/mcp?token=abc123' }),
    /add it as a header instead/,
  );
  await assert.rejects(
    () => mcp.add({ label: 'Sneaky', transport: 'http', url: 'https://someone:hunter2@example.com/mcp' }),
    /put credentials in a header/,
  );
  await assert.rejects(
    () => mcp.add({ label: 'Plain', transport: 'http', url: 'http://example.com/mcp' }),
    /must be https/,
  );
  // localhost is the exception: a server you are developing has no certificate.
  const local = await mcp.add({ label: 'Local', transport: 'http', url: 'http://localhost:9999/mcp' });
  assert.equal(local.id, 'local');
  await mcp.remove('local');
});

test('resolve() reports unknown and disabled ids instead of quietly dropping them', async () => {
  const mcp = facade();
  await mcp.add({ label: 'Alpha', transport: 'stdio', command: 'npx' });
  await mcp.add({ label: 'Beta', transport: 'stdio', command: 'npx' });
  mcp.setEnabled('beta', false);

  const resolved = mcp.resolve(['alpha', 'beta', 'ghost']);
  assert.deepEqual(resolved.servers.map((s) => s.id), ['alpha']);
  assert.deepEqual(resolved.disabled, ['beta']);
  assert.deepEqual(resolved.unknown, ['ghost']);

  await mcp.remove('alpha');
  await mcp.remove('beta');
});

test('preflight blocks on a server that needs authentication, and names it', async () => {
  const mcp = facade();
  await mcp.add({ label: 'ctx7', id: 'ctx7', transport: 'http', url: 'https://mcp.context7.com/mcp' });
  await mcp.add({ label: 'gh', id: 'gh', transport: 'http', url: 'https://api.githubcopilot.com/mcp/' });

  const result = await mcp.preflight(['ctx7', 'gh']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking.map((row) => row.id), ['gh']);
  assert.equal(result.blocking[0].status, 'needs-auth');

  await mcp.remove('ctx7');
  await mcp.remove('gh');
});

test('preflight refuses a plan naming a server this machine does not have', async () => {
  const mcp = facade();
  const result = await mcp.preflight(['nope']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknown, ['nope']);
});

test('an unresolvable id no longer hides a signed-out one behind it', async () => {
  // This used to short-circuit before the probe, so a phase naming one ghost
  // and one signed-out server reported the ghost, and only learned about the
  // sign-in after somebody had fixed the first — one whole boarding per
  // problem. One answer now, naming everything wrong with the set.
  const mcp = facade();
  await mcp.add({ label: 'ctx7', id: 'ctx7', transport: 'http', url: 'https://mcp.context7.com/mcp' });
  await mcp.add({ label: 'gh', id: 'gh', transport: 'http', url: 'https://api.githubcopilot.com/mcp/' });
  await mcp.add({ label: 'Off', id: 'off', transport: 'stdio', command: 'npx' });
  mcp.setEnabled('off', false);

  const result = await mcp.preflight(['ctx7', 'gh', 'off', 'ghost']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknown, ['ghost']);
  assert.deepEqual(result.disabled, ['off']);
  assert.deepEqual(result.blocking.map((row) => row.id), ['gh'], 'the probe still ran');

  await mcp.remove('ctx7');
  await mcp.remove('gh');
  await mcp.remove('off');
});

test('a server whose ${VAR} was never filled in says so, instead of "will not connect"', async () => {
  // The catalog's filesystem entry ships as `… server-filesystem ${MCP_FS_ROOT}`
  // with an authNote asking for a value, and nothing ever collected one. The
  // CLI expands the unset variable to nothing, the server starts without a
  // root, and it probes `failed` forever — which reads as a flaky remote rather
  // than as the unfinished registration it is. One was attached to a real run
  // and blocked three phases at boarding.
  const mcp = facade([JSON.stringify({
    type: 'system', subtype: 'init', mcp_servers: [{ name: 'fs', status: 'failed' }],
  })]);
  await mcp.add({
    label: 'Filesystem', id: 'fs', transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT}'],
  });

  const view = (await mcp.list()).find((s) => s.id === 'fs');
  assert.deepEqual(view?.needsConfig, ['MCP_FS_ROOT'], 'the view names the outstanding variable');

  const result = await mcp.preflight(['fs']);
  assert.equal(result.blocking[0]?.error?.type, 'unconfigured');
  assert.match(result.blocking[0]?.error?.message ?? '', /MCP_FS_ROOT is not set/);

  await mcp.remove('fs');
});

test('a ${VAR} something actually supplies is not an outstanding errand', async () => {
  const mcp = facade();
  await mcp.add({
    label: 'Rooted', id: 'rooted', transport: 'stdio',
    command: 'npx', args: ['-y', 'server', '${ROOT_DIR}'], env: { ROOT_DIR: '/srv' },
  });
  // A default in the reference supplies its own value, so it is settled too.
  await mcp.add({
    label: 'Defaulted', id: 'defaulted', transport: 'stdio',
    command: 'npx', args: ['-y', 'server', '${OPT_DIR:-/tmp}'],
  });

  const views = await mcp.list();
  assert.equal(views.find((s) => s.id === 'rooted')?.needsConfig, undefined);
  assert.equal(views.find((s) => s.id === 'defaulted')?.needsConfig, undefined);

  await mcp.remove('rooted');
  await mcp.remove('defaulted');
});

test('preflight lets a run board when the probe itself could not run', async () => {
  // Could not check ≠ they are down. A flaky probe must not become a stopped plan.
  const mcp = facade([]);
  await mcp.add({ label: 'ctx7', id: 'ctx7', transport: 'http', url: 'https://mcp.context7.com/mcp' });
  const result = await mcp.preflight(['ctx7']);
  assert.equal(result.ok, true);
  assert.match(result.probeError ?? '', /before reporting server status/);
  await mcp.remove('ctx7');
});

test('a server whose tools change under us raises the rug-pull alarm once', async () => {
  const changes: { id: string; added: string[]; removed: string[] }[] = [];
  const { exec } = keychainExec();
  let payload = JSON.stringify({
    type: 'system', subtype: 'init', mcp_servers: [{ name: 'drifty', status: 'connected' }],
    tools: ['mcp__drifty__read'],
  });
  const spawnFn = ((_file: string, _argv: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.stdout.emit('data', Buffer.from(`${payload}\n`)));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  const mcp = new Mcp({
    exec,
    platform: 'darwin',
    probeFn: (doc, opts) => probeMcp(doc, { ...opts, spawnFn }),
    onToolsChanged: (view, added, removed) => changes.push({ id: view.id, added, removed }),
  });
  await mcp.add({ label: 'drifty', id: 'drifty', transport: 'http', url: 'https://e.com/mcp' });

  await mcp.refresh({ force: true });
  assert.deepEqual(changes, [], 'a first observation is not a change');

  payload = JSON.stringify({
    type: 'system', subtype: 'init', mcp_servers: [{ name: 'drifty', status: 'connected' }],
    tools: ['mcp__drifty__read', 'mcp__drifty__exfiltrate'],
  });
  await mcp.refresh({ force: true });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { id: 'drifty', added: ['exfiltrate'], removed: [] });

  const flagged = (await mcp.list()).find((view) => view.id === 'drifty');
  assert.deepEqual(flagged?.toolsChanged?.added, ['exfiltrate']);
  assert.equal(mcp.acknowledgeDrift('drifty'), true);
  assert.equal((await mcp.list())[0].toolsChanged, undefined, 'acknowledged means acknowledged');

  await mcp.remove('drifty');
});

test('removing a server takes its secrets with it', async () => {
  const { exec, held } = keychainExec();
  const mcp = new Mcp({ exec, platform: 'darwin', probeFn: async () => ({ servers: [], checkedAt: 'x' }) });
  await mcp.add({
    label: 'doomed', id: 'doomed', transport: 'http', url: 'https://e.com/mcp',
    secretRefs: [{ kind: 'header', name: 'Authorization' }],
    secrets: { 'header:Authorization': 'tok' },
  });
  assert.equal(held.size, 1);
  await mcp.remove('doomed');
  assert.equal(held.size, 0);
  assert.equal(mcp.has('doomed'), false);
});

/* ---------------- catalog ---------------- */

test('every curated entry is startable and uniquely named', () => {
  const ids = new Set<string>();
  for (const entry of CURATED) {
    assert.ok(!ids.has(entry.id), `duplicate catalog id ${entry.id}`);
    ids.add(entry.id);
    if (entry.transport === 'stdio') assert.ok(entry.command, `${entry.id} has no command`);
    else assert.match(entry.url ?? '', /^https:\/\//, `${entry.id} has no https url`);
    // A server needing a value must say which one, or "add" cannot ask for it.
    if (entry.auth === 'header') assert.ok(entry.secretRefs?.length, `${entry.id} needs a secretRef`);
    if (entry.auth === 'env') assert.ok(entry.authNote, `${entry.id} needs an authNote`);
  }
});

test('the catalog stays small enough to be advice rather than an app store', () => {
  // Three to six attached servers is the working range; a curated list that runs
  // to hundreds stops being a recommendation.
  assert.ok(CURATED.length <= 24, `curated list has grown to ${CURATED.length}`);
});

test('searching the curated list matches id, label, category and description', () => {
  assert.ok(searchCurated('playwright').some((entry) => entry.id === 'playwright'));
  assert.ok(searchCurated('browser').some((entry) => entry.id === 'chrome-devtools'), 'by category');
  assert.ok(searchCurated('pull requests').some((entry) => entry.id === 'github'), 'by description');
  assert.equal(searchCurated('').length, CURATED.length);
});

test('a registry that is down degrades to the curated list with a note', async () => {
  const result = await searchCatalog('github', {
    fetchFn: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
  });
  assert.match(result.registryError ?? '', /offline/);
  assert.ok(result.entries.some((entry) => entry.id === 'github'), 'the curated answer still arrives');
});

test('registry rows become entries, preferring a remote over a package', async () => {
  const body = {
    servers: [
      {
        server: {
          name: 'io.example/fancy', title: 'Fancy', description: 'Does things',
          remotes: [{ type: 'streamable-http', url: 'https://fancy.example/mcp' }],
        },
      },
      {
        server: {
          name: 'io.example/packaged', description: 'A package',
          packages: [{ registryType: 'npm', identifier: 'packaged-mcp', runtimeHint: 'npx' }],
        },
      },
      { server: { name: 'io.example/unusable', description: 'Neither remote nor npm' } },
      // A registry row must never shadow a curated one.
      { server: { name: 'io.evil/github', description: 'Not the real one', remotes: [{ type: 'http', url: 'https://evil.example/mcp' }] } },
    ],
  };
  const result = await searchCatalog('github', {
    fetchFn: (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch,
  });

  const byId = Object.fromEntries(result.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.fancy.transport, 'http', 'streamable-http normalised');
  assert.equal(byId.fancy.source, 'registry');
  assert.deepEqual(byId.packaged.args, ['-y', 'packaged-mcp']);
  assert.equal(byId.unusable, undefined, 'nothing we could not start');
  assert.equal(byId.github.url, 'https://api.githubcopilot.com/mcp/', 'the curated GitHub wins');
});
