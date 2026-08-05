/**
 * One install, several consoles — and none of them standing on another's state.
 *
 * Before instances, a machine ran one console and every path it used was a
 * constant. A second one did not fail: it shared the first's log, notification
 * inbox, push keys and approvals queue while reporting itself as a separate
 * thing. That is the failure worth testing for, because it is silent — nothing
 * errors, the wrong console simply answers, and the operator's phone gets a
 * notification from a project they were not looking at.
 *
 * So the coexistence tests boot two REAL consoles against one home directory
 * and then go looking for the crossover. The rest are unit tests of the pieces
 * that decide who is who, which is where a drift would start.
 *
 * ⚠️ `state-sandbox.ts` first, before anything reaches `server/`. `config.ts`
 * resolves the state and config directories at module load, and this file's
 * whole subject is which directory a console writes to — importing it late
 * would silently point the assertions at the operator's real one.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_PORT, PORT_RANGE_SIZE, PORT_RANGE_START,
  derivePort, getInstance, instanceForPort, instanceId, instancePrefsPath,
  isDefaultRoot, listInstances, preferredPort, readProjectFile, readRegistry,
  registerInstance, registryPath, removeInstance, resolveInstance as resolveFromCwd,
  reservedPorts, runCli,
} from '../shared/instances.mjs';
import {
  INSTANCE_STATE_DIR, LEGACY_UNIT, STATE_DIR, VIEWER_DIR,
  instancePrefsFile, instanceStateDir, legacyFootprint, loadPrefs, parseFlags,
  resolveInstance, savePrefs, type Instance,
} from '../server/config.ts';
import { runDir } from '../server/runner/state.ts';
import { sandbox, spawnConsole } from './spawn-console.ts';

/** Neutral fixture roots. Never a real slug or a real path — see the scrub rule. */
const ALPHA = '/tmp/alpha-project';
const BETA = '/tmp/beta-project';

/** The registry is process-wide state; each test that writes it starts clean. */
function clearRegistry(): void {
  rmSync(registryPath(), { force: true });
  rmSync(`${registryPath()}.lock`, { force: true });
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

test('an instance id is a stable, readable function of the root path', () => {
  const id = instanceId(ALPHA);
  assert.match(id, /^[0-9a-f]{8}-alpha-project$/);
  assert.equal(id, instanceId(ALPHA), 'the same path must always answer the same id');
  assert.notEqual(id, instanceId(BETA), 'two projects are two instances');
});

test('paths that name the same directory are one instance, not three', () => {
  const id = instanceId(ALPHA);
  assert.equal(instanceId(`${ALPHA}/`), id, 'a trailing slash is not a different project');
  assert.equal(instanceId(`${ALPHA}/docs/..`), id, 'nor is a path that walks back to it');
});

/**
 * The anti-drift check, and the reason `runDir` imports `instanceId` instead of
 * keeping its own copy of the hash. Two checkouts of one repository must land in
 * two run directories AND two instances; if these ever disagree, a console would
 * be writing run journals under a key that names a different project.
 */
test('run keying and instance keying are the same function', () => {
  assert.equal(runDir(ALPHA, 'demo'), join(STATE_DIR, 'runs', instanceId(ALPHA), 'demo'));
  assert.notEqual(runDir(ALPHA, 'demo'), runDir(BETA, 'demo'));
});

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

test('the registry round-trips, and exactly one instance can be the default', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  registerInstance(ALPHA, { name: 'alpha', port: 4123, default: true });
  registerInstance(BETA, { name: 'beta', port: 4180 });

  const alpha = getInstance(instanceId(ALPHA));
  assert.equal(alpha?.name, 'alpha');
  assert.equal(alpha?.port, 4123);
  assert.equal(alpha?.default, true);
  assert.equal(getInstance(instanceId(BETA))?.default, undefined);

  // Promoting beta demotes alpha in the same write. Two defaults would make
  // "the default keeps the legacy paths" ambiguous, and those are the paths
  // with the operator's real push subscriptions in them.
  registerInstance(BETA, { default: true });
  assert.equal(getInstance(instanceId(BETA))?.default, true);
  assert.equal(getInstance(instanceId(ALPHA))?.default, false);

  assert.equal(removeInstance(instanceId(ALPHA)), true);
  assert.equal(getInstance(instanceId(ALPHA)), null);
  assert.equal(removeInstance('no-such-instance'), false, 'removing nothing is not an error');
});

test('an unreadable registry degrades to empty rather than refusing to boot', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  mkdirSync(join(registryPath(), '..'), { recursive: true });
  writeFileSync(registryPath(), '{ this is not json', 'utf8');
  assert.deepEqual(readRegistry().instances, {}, 'a corrupt registry reads as no instances');

  // And it is repaired by the next write rather than staying broken forever.
  registerInstance(ALPHA, { name: 'alpha' });
  assert.equal(getInstance(instanceId(ALPHA))?.name, 'alpha');
});

test('an entry with no root is dropped — a registry cannot invent a project', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  mkdirSync(join(registryPath(), '..'), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify({
    version: 1, instances: { 'broken-entry': { name: 'broken' }, 'ok-entry': { name: 'ok', root: ALPHA } },
  }), 'utf8');

  const ids = listInstances().map((entry) => entry.id);
  assert.deepEqual(ids, ['ok-entry']);
});

/**
 * A console killed mid-register must not wedge every future one. The lock is
 * reclaimed once it is older than the lease, and a lock held *right now* falls
 * through to the write rather than blocking a boot — the write is atomic
 * either way, so the worst case is a lost update, not a corrupt file.
 */
test('a stale registry lock is reclaimed, and a live one never wedges a boot', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  const lock = `${registryPath()}.lock`;
  mkdirSync(join(registryPath(), '..'), { recursive: true });

  writeFileSync(lock, '', 'utf8');
  const longAgo = new Date(Date.now() - 60_000);
  utimesSync(lock, longAgo, longAgo);
  registerInstance(ALPHA, { name: 'alpha' });
  assert.equal(getInstance(instanceId(ALPHA))?.name, 'alpha', 'a stale lock must not block the write');
  assert.equal(existsSync(lock), false, 'and it is released, not left behind');

  writeFileSync(lock, '', 'utf8');   // fresh: someone is genuinely mid-write
  registerInstance(BETA, { name: 'beta' });
  assert.equal(getInstance(instanceId(BETA))?.name, 'beta', 'a live lock must not lose the write either');
  rmSync(lock, { force: true });
});

/* ------------------------------------------------------------------ *
 * Ports
 * ------------------------------------------------------------------ */

test('a derived port is stable and stays inside the reserved range', () => {
  for (const root of [ALPHA, BETA, '/tmp/gamma', '/tmp/delta']) {
    const port = derivePort(instanceId(root));
    assert.ok(port >= PORT_RANGE_START && port < PORT_RANGE_START + PORT_RANGE_SIZE,
      `${port} is outside the reserved range`);
    assert.equal(port, derivePort(instanceId(root)), 'the same project keeps its bookmarked port');
  }
});

test('the port precedence chain is flag, env, project file, registry, derived', (t) => {
  clearRegistry();
  const projectRoot = join(sandboxDir(t), 'ported');
  mkdirSync(projectRoot, { recursive: true });
  t.after(clearRegistry);

  // Nothing said anywhere: the first instance on a machine is the default, and
  // the default keeps the port a single-console machine has always used.
  assert.equal(preferredPort(projectRoot, {}, {}), DEFAULT_PORT);

  // Registered, non-default: whatever it actually bound last time.
  registerInstance(ALPHA, { name: 'alpha', default: true });
  registerInstance(projectRoot, { name: 'ported', port: 4199 });
  assert.equal(preferredPort(projectRoot, {}, {}), 4199);

  // A committed project file outranks the registry: it is what the team said.
  writeFileSync(join(projectRoot, '.phase-console.json'), JSON.stringify({ port: 4150 }), 'utf8');
  assert.equal(preferredPort(projectRoot, {}, {}), 4150);

  // The environment outranks the file, and an explicit flag outranks everything.
  assert.equal(preferredPort(projectRoot, {}, { PHASE_CONSOLE_PORT: '4160' }), 4160);
  assert.equal(preferredPort(projectRoot, { flagPort: 4170 }, { PHASE_CONSOLE_PORT: '4160' }), 4170);

  // With the file gone and the entry unregistered, it falls through to derived.
  rmSync(join(projectRoot, '.phase-console.json'), { force: true });
  removeInstance(instanceId(projectRoot));
  assert.equal(preferredPort(projectRoot, {}, {}), derivePort(instanceId(projectRoot)));
});

test('a port another instance registered is spoken for, even while that console is stopped', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  registerInstance(ALPHA, { name: 'alpha', port: 4130 });
  registerInstance(BETA, { name: 'beta', port: 4131 });

  assert.deepEqual([...reservedPorts(BETA)].sort(), [4130], 'an instance does not reserve against itself');
  assert.equal(instanceForPort(4130)?.name, 'alpha');
  assert.equal(instanceForPort(4999), null);
});

/* ------------------------------------------------------------------ *
 * The project file
 * ------------------------------------------------------------------ */

test('the project file is an allowlist — a committed file cannot widen what a console may do', (t) => {
  const root = join(sandboxDir(t), 'project-file');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.phase-console.json'), JSON.stringify({
    name: 'alpha', port: 4150,
    // None of these may survive: a repository someone clones must not be able
    // to hand its console a state directory, a shell, or the autopilot.
    root: '/somewhere/else', allowRun: true, allowTerminal: true, logFile: '/tmp/anywhere',
  }), 'utf8');

  assert.deepEqual(readProjectFile(root), { name: 'alpha', port: 4150 });
});

test('a malformed project file is ignored, never fatal', (t) => {
  const root = join(sandboxDir(t), 'bad-project-file');
  mkdirSync(root, { recursive: true });
  assert.deepEqual(readProjectFile(root), {}, 'no file at all is simply nothing said');

  writeFileSync(join(root, '.phase-console.json'), 'not json', 'utf8');
  assert.deepEqual(readProjectFile(root), {});

  writeFileSync(join(root, '.phase-console.json'), JSON.stringify({ port: 'banana', name: 42 }), 'utf8');
  assert.deepEqual(readProjectFile(root), {}, 'a value of the wrong type is not said either');
});

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

test('resolve walks up to the console that owns a directory, and says when none does', (t) => {
  clearRegistry();
  const base = sandboxDir(t);
  const root = join(base, 'walkable');
  const deep = join(root, 'src', 'nested');
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  t.after(clearRegistry);

  // Not registered yet, but it looks like a project: a candidate, which is what
  // `phase-console start` in a fresh checkout has to be able to tell apart from
  // "you are nowhere near a project".
  const before = resolveFromCwd(deep);
  assert.equal(before.kind, 'candidate');
  assert.equal(before.root, root);

  registerInstance(root, { name: 'walkable', port: 4140 });
  const after = resolveFromCwd(deep);
  assert.equal(after.kind, 'registered');
  assert.equal(after.root, root);
  assert.equal(after.port, 4140);
});

test('--instance names a registered console, and --root still outranks it', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  registerInstance(BETA, { name: 'beta', port: 4180, default: false });
  registerInstance(ALPHA, { name: 'alpha', default: true });

  assert.equal(resolveInstance(['--instance', 'beta'], {}).root, BETA);
  assert.equal(resolveInstance(['--instance', instanceId(BETA)], {}).root, BETA, 'by id as well as by name');
  assert.equal(resolveInstance(['--instance', 'beta', '--root', ALPHA], {}).root, ALPHA);
  assert.equal(resolveInstance([], { PHASE_CONSOLE_ROOT: BETA }).root, BETA);
});

test('a console with no root at all is the default one, and is not pinned', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  const nowhere = resolveInstance([], {});
  assert.equal(nowhere.root, null);
  assert.equal(nowhere.default, true);
  assert.equal(nowhere.pinned, false, 'the picker is the whole point of a rootless console');
});

test('the first instance on a machine is the default; the next one is pinned', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  assert.equal(isDefaultRoot(ALPHA), true, 'an empty registry means nobody has claimed default yet');
  const alpha = resolveInstance(['--root', ALPHA], {});
  assert.equal(alpha.default, true);
  assert.equal(alpha.pinned, false);

  registerInstance(ALPHA, { name: 'alpha', default: true });
  const beta = resolveInstance(['--root', BETA], {});
  assert.equal(beta.default, false);
  assert.equal(beta.pinned, true);
  assert.equal(beta.id, instanceId(BETA));
});

/* ------------------------------------------------------------------ *
 * State directories
 * ------------------------------------------------------------------ */

test('the default instance keeps the flat legacy state directory; others are keyed', () => {
  const alpha: Instance = { id: instanceId(ALPHA), name: 'alpha', root: ALPHA, default: true, pinned: false };
  const beta: Instance = { id: instanceId(BETA), name: 'beta', root: BETA, default: false, pinned: true };

  assert.equal(instanceStateDir(alpha), STATE_DIR, 'no move, no rename — that is the migration promise');
  assert.equal(instanceStateDir(beta), join(STATE_DIR, 'instances', instanceId(BETA)));
  assert.notEqual(instanceStateDir(alpha), instanceStateDir(beta));
});

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

test('preferences split: the person\'s follow them, the project\'s stay put', (t) => {
  const configFile = instancePrefsFile({ id: 'x', name: 'x', root: null, default: true, pinned: false });
  const beta: Instance = { id: instanceId(BETA), name: 'beta', root: BETA, default: false, pinned: true };
  t.after(() => {
    rmSync(configFile, { force: true });
    rmSync(instancePrefsPath(beta.id), { force: true });
  });

  // A machine that has been running one console: everything in one file.
  mkdirSync(join(configFile, '..'), { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    theme: 'dark', density: 'compact', qaByDefault: true, lastRoot: ALPHA,
  }), 'utf8');

  // A second console with no keyed file of its own inherits BOTH halves — that
  // is adoption, and it is why a new instance does not open on a blank slate.
  const inherited = loadPrefs(beta);
  assert.equal(inherited.theme, 'dark');
  assert.equal(inherited.qaByDefault, true);
  assert.equal(inherited.lastRoot, ALPHA);

  // Once it saves, the two halves part company.
  savePrefs({ ...inherited, theme: 'light', qaByDefault: false, lastRoot: BETA }, beta);

  const shared = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  assert.equal(shared.theme, 'light', 'a person\'s theme follows them to every console');
  assert.equal(shared.qaByDefault, true, 'the shared file keeps ITS project setting, untouched');
  assert.equal(shared.lastRoot, ALPHA, 'and its own last root');

  const own = JSON.parse(readFileSync(instancePrefsPath(beta.id), 'utf8')) as Record<string, unknown>;
  assert.equal(own.qaByDefault, false);
  assert.equal(own.lastRoot, BETA);
  assert.equal(own.theme, undefined, 'the keyed file never stores a user-global key');

  // And reading beta back gives beta's project settings with the person's theme.
  const reread = loadPrefs(beta);
  assert.equal(reread.theme, 'light');
  assert.equal(reread.qaByDefault, false);
  assert.equal(reread.lastRoot, BETA);
});

test('the default instance writes one file, exactly where it always did', (t) => {
  const alpha: Instance = { id: instanceId(ALPHA), name: 'alpha', root: ALPHA, default: true, pinned: false };
  const configFile = instancePrefsFile(alpha);
  t.after(() => {
    rmSync(configFile, { force: true });
    rmSync(instancePrefsPath(alpha.id), { force: true });
  });

  savePrefs({ ...loadPrefs(alpha), theme: 'dark', qaByDefault: true }, alpha);

  assert.ok(existsSync(configFile), 'the default keeps config.json');
  assert.equal(existsSync(instancePrefsPath(alpha.id)), false,
    'and gains no keyed file — a single-project user sees no new files at all');
  assert.equal(loadPrefs(alpha).qaByDefault, true);
});

/* ------------------------------------------------------------------ *
 * Adoption
 * ------------------------------------------------------------------ */

test('a legacy footprint is recognised, and a clean machine is not mistaken for one', (t) => {
  const configFile = instancePrefsFile({ id: 'x', name: 'x', root: null, default: true, pinned: false });
  t.after(() => rmSync(configFile, { force: true }));

  rmSync(configFile, { force: true });
  rmSync(join(STATE_DIR, 'console.log'), { force: true });
  assert.equal(legacyFootprint({}), false, 'a machine with no console files has never run one');

  mkdirSync(join(configFile, '..'), { recursive: true });
  writeFileSync(configFile, '{}', 'utf8');
  assert.equal(legacyFootprint({}), true, 'a config file is proof a console has run here');

  // And a loaded agent announces itself even on a machine with no files yet.
  rmSync(configFile, { force: true });
  assert.equal(legacyFootprint({}), false);
  assert.equal(legacyFootprint({ PHASE_CONSOLE_UNIT: 'com.phase-console' }), true);
});

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

test('parseFlags takes its port from the instance, and --instance is not mistaken for a root', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  const beta: Instance = { id: instanceId(BETA), name: 'beta', root: BETA, default: false, pinned: true };
  assert.equal(parseFlags([], beta).port, derivePort(beta.id));
  assert.equal(parseFlags(['--port', '4321'], beta).port, 4321);

  // `--instance beta` consumes its value; a parser that did not would read
  // `beta` as the next positional and could mis-assign a later flag.
  const flags = parseFlags(['--instance', 'beta', '--allow-writes'], beta);
  assert.equal(flags.allowWrites, true);
  assert.equal(flags.root, undefined);
});

/* ------------------------------------------------------------------ *
 * The CLI bash and the lifecycle verbs shell out to
 * ------------------------------------------------------------------ */

test('the CLI answers one line per question, with no prose to parse around', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  assert.equal(runCli(['id', ALPHA]).out, instanceId(ALPHA));
  assert.equal(runCli(['register', ALPHA, '--name', 'alpha', '--port', '4123', '--default']).code, 0);
  assert.equal(runCli(['register', BETA, '--name', 'beta', '--port', '4180']).code, 0);

  const rows = String(runCli(['list']).out).split('\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].split('\t'), [instanceId(ALPHA), 'alpha', '4123', 'default', ALPHA]);

  assert.equal(runCli(['port', BETA]).out, '4180');
  assert.equal(runCli(['url', BETA]).out, 'http://127.0.0.1:4180');
  assert.equal(JSON.parse(String(runCli(['list', '--json']).out)).length, 2);

  assert.equal(runCli(['update', instanceId(BETA), '--port', '4181']).code, 0);
  assert.equal(getInstance(instanceId(BETA))?.port, 4181);

  assert.equal(runCli(['remove', instanceId(BETA)]).code, 0);
  assert.equal(runCli(['remove', instanceId(BETA)]).code, 1, 'removing what is gone is an error, not a lie');
  assert.equal(runCli(['nonsense']).code, 2);
});

/* ------------------------------------------------------------------ *
 * Two real consoles, one machine
 * ------------------------------------------------------------------ */

/**
 * The whole phase in one test: two consoles, two projects, one home directory.
 *
 * Every assertion here failed before this phase — not by erroring, but by both
 * consoles answering from the same files.
 */
test('two consoles serve two projects at once, with nothing shared but the machine', async (t) => {
  const box = sandbox('coexist');
  const beta = join(box.stateHome, '..', 'beta-root');
  mkdirSync(join(beta, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(beta, 'docs', 'handoffs'), { recursive: true });
  writeFileSync(join(beta, 'docs', 'plans', 'other.md'), readFileSync(join(box.root, 'docs', 'plans', 'demo.md')));

  const portA = await freePort();
  const portB = await freePort();
  const first = spawnConsole(VIEWER_DIR, portA, ['--root', box.root], { sandbox: box });
  t.after(() => { first.child.kill('SIGKILL'); box.cleanup(); });
  if (!await up(portA)) assert.fail('the first console did not come up');

  // Same sandbox — same XDG_CONFIG_HOME and XDG_STATE_HOME — so this is a
  // second console on ONE machine, which is the only arrangement that can
  // expose crossover.
  const second = spawnConsole(VIEWER_DIR, portB, ['--root', beta], { sandbox: box });
  t.after(() => second.child.kill('SIGKILL'));
  if (!await up(portB)) assert.fail('the second console did not come up');

  const stateA = JSON.parse(await get(portA, '/api/state')) as ApiState;
  const stateB = JSON.parse(await get(portB, '/api/state')) as ApiState;

  // 1. They know they are different, and each is serving its own project.
  assert.notEqual(stateA.instance?.id, stateB.instance?.id);
  assert.equal(stateA.root?.path, box.root);
  assert.equal(stateB.root?.path, beta);

  // 2. Exactly one is the default, and the other is pinned to its project.
  assert.equal(stateA.instance?.pinned, false, 'the first console adopted the machine as default');
  assert.equal(stateB.instance?.pinned, true);

  // 3. Their state directories do not overlap. The default keeps the flat one;
  //    the second lives under `instances/<id>` and its log is proof it got
  //    there before anything computed a path.
  const stateRoot = join(box.stateHome, 'phase-console');
  const keyed = join(stateRoot, 'instances', String(stateB.instance?.id));
  assert.ok(existsSync(keyed), `the second console's state is missing — expected ${keyed}`);
  assert.equal(existsSync(join(keyed, 'instances')), false, 'and it is not nested inside itself');

  // 4. The registry holds both, with the ports they ACTUALLY bound.
  const registry = readRegistry(box.env as NodeJS.ProcessEnv);
  const entries = Object.values(registry.instances);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.port).sort(), [portA, portB].sort());

  // 5. The pinned one refuses to be repointed — 409, naming what to run instead.
  const refused = await call(portB, '/api/root', { method: 'POST', body: JSON.stringify({ path: box.root }) });
  assert.equal(refused.status, 409);
  assert.match(refused.body, /pinned/i);
  assert.match(refused.body, /phase-console start/);
  assert.equal((JSON.parse(await get(portB, '/api/state')) as ApiState).root?.path, beta,
    'and it is still serving its own project afterwards');

  // 6. The default one still has its picker.
  const allowed = await call(portA, '/api/root', { method: 'POST', body: JSON.stringify({ path: beta }) });
  assert.equal(allowed.status, 200);
});

test('a legacy install is adopted as the default, with nothing moved', async (t) => {
  const box = sandbox('adopt');
  t.after(() => box.cleanup());

  // A machine that has been running one console since before instances existed:
  // a config file where the flat layout put it, and no registry at all.
  const configDir = join(box.configHome, 'phase-console');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
  assert.equal(existsSync(join(configDir, 'instances.json')), false);

  const port = await freePort();
  const { child } = spawnConsole(VIEWER_DIR, port, [], { sandbox: box, withRoot: true });
  t.after(() => child.kill('SIGKILL'));
  if (!await up(port)) assert.fail('the console did not come up');

  const state = JSON.parse(await get(port, '/api/state')) as ApiState;
  assert.equal(state.instance?.pinned, false, 'the console that was already here is the default');

  const registry = readRegistry(box.env as NodeJS.ProcessEnv);
  const entries = Object.values(registry.instances);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].default, true);
  assert.equal(entries[0].port, port);
  // The BARE unit label, not a generated per-instance one: an adopted console
  // is the agent that is already loaded, and P6's lifecycle verbs have to find
  // that one rather than install a second beside it.
  assert.equal(entries[0].unit, LEGACY_UNIT);

  // The promise: no file moved. Its state is still the flat directory, and its
  // preferences are still the file that was there before.
  const stateRoot = join(box.stateHome, 'phase-console');
  assert.equal(existsSync(join(stateRoot, 'instances')), false,
    'a single-project user must gain no per-instance directory at all');
  assert.match(readFileSync(join(configDir, 'config.json'), 'utf8'), /"theme"\s*:\s*"dark"/);

  // Idempotent: restarting adopts the same entry rather than minting a second.
  child.kill('SIGKILL');
  const again = spawnConsole(VIEWER_DIR, port, [], { sandbox: box, withRoot: true });
  t.after(() => again.child.kill('SIGKILL'));
  if (!await up(port)) assert.fail('the console did not come back up');
  assert.equal(Object.keys(readRegistry(box.env as NodeJS.ProcessEnv).instances).length, 1);
});

test('a port collision names the project already on that port', async (t) => {
  const box = sandbox('collide');
  const beta = join(box.stateHome, '..', 'beta-root');
  mkdirSync(join(beta, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(beta, 'docs', 'plans', 'other.md'), readFileSync(join(box.root, 'docs', 'plans', 'demo.md')));

  const port = await freePort();
  const first = spawnConsole(VIEWER_DIR, port, ['--root', box.root], { sandbox: box });
  t.after(() => { first.child.kill('SIGKILL'); box.cleanup(); });
  if (!await up(port)) assert.fail('the first console did not come up');

  // A second console told to take the same port. It must say WHOSE console is
  // there — "a console may already be running" was true and useless.
  const second = spawnConsole(VIEWER_DIR, port, ['--root', beta], { sandbox: box, stdio: 'pipe' });
  t.after(() => second.child.kill('SIGKILL'));

  let stderr = '';
  second.child.stderr?.setEncoding('utf8');
  second.child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  await new Promise((resolve) => second.child.once('exit', resolve));

  assert.match(stderr, /already in use/);
  assert.ok(stderr.includes(box.root), `the message must name the project on that port:\n${stderr}`);
  assert.match(stderr, /--port <n>/, 'and say how to move');
});

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

type ApiState = {
  root?: { path?: string };
  instance?: { id: string; name: string; pinned: boolean };
};

/** A disposable directory for one test, cleaned up with it. */
function sandboxDir(t: { after(fn: () => void): void }): string {
  const dir = join(INSTANCE_STATE_DIR, 'fixtures', String(process.hrtime.bigint()));
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
