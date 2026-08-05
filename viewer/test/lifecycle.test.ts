/**
 * The lifecycle verbs, once there is more than one console to aim them at.
 *
 * `start`, `stop`, `list`, `open` and `status` used to have exactly one
 * possible target, so "which console" was never a question and every verb
 * hardcoded the answer: one launchd label, one systemd unit, one port. This
 * file is about the question itself — the selector chain that turns a word (or
 * silence) into an instance, the unit names generated from it, and the
 * `key=value` contract `deploy/agent.sh` reads because bash cannot be trusted
 * with JSON.
 *
 * The integration test at the bottom drives `bin/phase-console.mjs` for real
 * across two scratch projects, because the supervised paths (launchd, systemd)
 * cannot be exercised in a test and everything around them can: registration,
 * port derivation, `list`, and stopping a console that has no supervisor at all.
 *
 * ⚠️ `state-sandbox.ts` first, before anything reaches `server/` — `config.ts`
 * resolves its directories at module load.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

import {
  getInstance, instanceId, listInstances, registerInstance, registryPath, runCli,
  selectInstance, selectRoot, selectionError, unitName, unitPath,
} from '../shared/instances.mjs';
import { LEGACY_UNIT, SKILL_DIR, VIEWER_DIR } from '../server/config.ts';
import { sandbox } from './spawn-console.ts';

const PHASE_CONSOLE = join(SKILL_DIR, 'bin', 'phase-console.mjs');

/** Neutral fixture roots — never a real path or a real slug (the scrub rule). */
const ALPHA = '/tmp/lifecycle-alpha';
const BETA = '/tmp/lifecycle-beta';

/** The registry is process-wide state; each test that writes it starts clean. */
function clearRegistry(): void {
  rmSync(registryPath(), { force: true });
  rmSync(`${registryPath()}.lock`, { force: true });
}

/* ------------------------------------------------------------------ *
 * Which console does this word mean?
 * ------------------------------------------------------------------ */

test('a selector matches an id, then a name, then a project directory name', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  registerInstance(ALPHA, { name: 'first' });
  registerInstance(BETA, { name: 'second' });

  assert.equal(selectInstance(instanceId(ALPHA), '/').id, instanceId(ALPHA), 'by id');
  assert.equal(selectInstance('second', '/').id, instanceId(BETA), 'by name');
  // Nobody is called `lifecycle-alpha` — but that IS the directory, which is
  // what someone types when they forget they renamed the instance.
  assert.equal(selectInstance('lifecycle-alpha', '/').id, instanceId(ALPHA), 'by root basename');
});

test('an ambiguous selector refuses and names every candidate', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  registerInstance(ALPHA, { name: 'twin' });
  registerInstance(BETA, { name: 'twin' });

  const found = selectInstance('twin', '/');
  assert.equal(found.kind, 'ambiguous');
  // The refusal has to carry the way out of it. Listing the ids is that way:
  // an id is the one selector that cannot be ambiguous.
  const message = selectionError(found);
  assert.match(message, /twin/);
  assert.match(message, new RegExp(instanceId(ALPHA)));
  assert.match(message, new RegExp(instanceId(BETA)));
});

test('with no selector, the console that claims where you are standing wins — longest root first', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  const outer = '/tmp/lifecycle-outer';
  const inner = '/tmp/lifecycle-outer/nested';
  registerInstance(outer, { name: 'outer' });
  registerInstance(inner, { name: 'inner' });

  assert.equal(selectInstance(undefined, join(inner, 'src', 'deep')).id, instanceId(inner),
    'the nearest enclosing project, not the outermost');
  assert.equal(selectInstance(undefined, join(outer, 'src')).id, instanceId(outer));
});

test('a machine with exactly one console needs no selector — but a project directory still outranks it', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  registerInstance(ALPHA, { name: 'only' });

  // Standing nowhere near a project: "the console" is unambiguous.
  assert.equal(selectInstance(undefined, '/').id, instanceId(ALPHA));

  // Standing in an UNREGISTERED project, it is not. `cd project && start` must
  // mean this project — starting somebody else's console would be worse than
  // any error message.
  const box = sandbox('select');
  t.after(box.cleanup);
  const found = selectInstance(undefined, box.root);
  assert.equal(found.kind, 'candidate');
  assert.equal(found.id, instanceId(box.root));
});

test('a miss explains itself with what there is', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  assert.match(selectionError(selectInstance('nope', '/')), /none are registered/);

  registerInstance(ALPHA, { name: 'first' });
  assert.match(selectionError(selectInstance('nope', '/')), /this machine has: first/);
});

test('naming a path is exact — it never resolves to a registered parent', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  const outer = '/tmp/lifecycle-outer';
  registerInstance(outer, { name: 'outer' });

  const nested = join(outer, 'packages', 'child');
  // The cwd walk would (correctly) hand back the parent…
  assert.equal(selectInstance(undefined, nested).id, instanceId(outer));
  // …but `--root` is a statement about one directory, so install cannot write
  // the parent's unit under the child's name.
  assert.equal(selectRoot(nested).id, instanceId(nested));
  assert.equal(selectRoot(nested).kind, 'candidate');
});

/* ------------------------------------------------------------------ *
 * Unit names
 * ------------------------------------------------------------------ */

test('the default instance keeps the bare pre-1.3.0 unit names on both platforms', () => {
  const id = instanceId(ALPHA);
  assert.equal(unitName({ id, default: true }, 'darwin'), 'com.phase-console');
  assert.equal(unitName({ id, default: true }, 'linux'), 'phase-console.service');
  // The operator upgrading has a loaded agent under exactly this label right
  // now. Renaming it would leave the old job loaded beside the new one, both
  // bound for the same port.
  assert.equal(LEGACY_UNIT, unitName({ id: 'default', default: true }));
});

test('every other instance gets a unit named after it', () => {
  const id = instanceId(BETA);
  assert.equal(unitName({ id, default: false }, 'darwin'), `com.phase-console.${id}`);
  assert.equal(unitName({ id, default: false }, 'linux'), `phase-console-${id}.service`);
  assert.match(unitPath(`com.phase-console.${id}`, 'darwin'), /Library\/LaunchAgents\/com\.phase-console\..*\.plist$/);
  assert.match(unitPath(`phase-console-${id}.service`, 'linux'), /systemd\/user\/phase-console-.*\.service$/);
});

/* ------------------------------------------------------------------ *
 * The key=value contract deploy/agent.sh reads
 * ------------------------------------------------------------------ */

test('`shell` answers in lines a shell can read, and every key agent.sh needs is there', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  registerInstance(ALPHA, { name: 'first', port: 4131, default: true });

  const { out, code } = runCli(['shell', 'first']);
  assert.equal(code, 0);
  const pairs = Object.fromEntries(String(out).split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  // agent.sh reads exactly these; dropping one turns a verb into a no-op that
  // still prints success.
  for (const key of ['kind', 'id', 'name', 'root', 'port', 'url', 'default', 'unit', 'generated_unit', 'unit_file', 'state_dir']) {
    assert.ok(key in pairs, `shell must emit ${key}`);
  }
  assert.equal(pairs.id, instanceId(ALPHA));
  assert.equal(pairs.port, '4131');
  assert.equal(pairs.default, '1');
  assert.equal(pairs.generated_unit, unitName({ id: pairs.id, default: true }));
  // The default's state directory is the FLAT legacy one — the migration
  // promise, restated where agent.sh will read it to place the unit's logs.
  assert.ok(!pairs.state_dir.includes('/instances/'), 'the default keeps the flat state directory');
});

test('a name from a committed project file cannot add a line to what agent.sh reads', (t) => {
  clearRegistry();
  const box = sandbox('inject');
  t.after(() => { box.cleanup(); clearRegistry(); });

  // `.phase-console.json` arrives with a clone. A name carrying a newline
  // would otherwise become a second `key=value` line in `shell`'s output, and
  // cloning a repository would decide what runs on your machine.
  writeFileSync(
    join(box.root, '.phase-console.json'),
    JSON.stringify({ name: 'ok\nunit_file=/tmp/evil.plist\nstate_dir=/tmp/evil' }),
    'utf8',
  );
  const { out } = runCli(['shell', '--root', box.root]);
  const lines = String(out).split('\n');
  // The text is still in there — as the NAME, harmlessly. What must not happen
  // is a second line agent.sh would read a variable out of.
  assert.equal(lines.filter((line) => line.startsWith('unit_file=')).length, 1,
    'exactly one unit_file line, whatever the project file says');
  assert.ok(!lines.some((line) => line === 'unit_file=/tmp/evil.plist' || line === 'state_dir=/tmp/evil'),
    'the injected values never became lines of their own');
  assert.match(String(out), /^name=ok unit_file=.*state_dir=.*$/m,
    'the newlines became spaces, so nothing is silently joined either');
});

/* ------------------------------------------------------------------ *
 * Electing the default
 * ------------------------------------------------------------------ */

test('`auto` elects one default, and never writes itself into the file', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  const first = registerInstance(ALPHA, { name: 'first', default: 'auto' });
  const second = registerInstance(BETA, { name: 'second', default: 'auto' });
  assert.equal(first?.default, true);
  assert.equal(second?.default, false, 'the sentinel resolved to a value, not stored verbatim');
  assert.equal(listInstances().filter((entry) => entry.default === true).length, 1);

  // And re-registering the default does not demote it.
  assert.equal(registerInstance(ALPHA, { port: 4123, default: 'auto' })?.default, true);
});

test('four processes registering at once still elect exactly one default', (t) => {
  clearRegistry();
  t.after(clearRegistry);

  // Separate PROCESSES, because what this guards cannot happen in one. The
  // registry write is atomic but read-modify-write is not, and the lock used to
  // give up the moment it found a live holder — so four consoles registering at
  // once each read the file, each added themselves, and the last rename threw
  // the other three away.
  //
  // What it proves, precisely: with `LOCK_WAIT_MS` at 0 this fails every run
  // (registrations lost, and several instances left claiming `default`), and
  // with the wait it passes every run. It does NOT independently prove that
  // resolving `'auto'` inside the mutate beats resolving it just outside —
  // that window is microseconds wide and no honest test closes it; the reason
  // to keep it inside is that it costs nothing and the failure it prevents is
  // an instance silently inheriting another console's port and state directory.
  const box = sandbox('election');
  t.after(box.cleanup);
  const script = `
    import { registerInstance } from ${JSON.stringify(join(VIEWER_DIR, 'shared', 'instances.mjs'))};
    registerInstance(process.argv[2], { name: 'p' + process.argv[3], default: 'auto' });
  `;
  const scriptPath = join(box.root, 'elect.mjs');
  writeFileSync(scriptPath, script, 'utf8');

  const kids = [0, 1, 2, 3].map((n) => spawn(
    process.execPath,
    [scriptPath, join(box.root, `contender-${n}`), String(n)],
    { env: box.env, stdio: 'ignore' },
  ));
  return Promise.all(kids.map((kid) => new Promise((done) => { kid.on('exit', done); })))
    .then(() => {
      const defaults = listInstances(box.env).filter((entry) => entry.default === true);
      assert.equal(listInstances(box.env).length, 4, 'no registration was lost');
      assert.equal(defaults.length, 1, `exactly one default, got ${defaults.map((d) => d.name).join(', ')}`);
    });
});

/* ------------------------------------------------------------------ *
 * Two projects, two consoles, driven through the real CLI
 * ------------------------------------------------------------------ */

/** Ask a port whether a console is there. */
function probe(port: number, timeoutMs = 1500): Promise<{ root?: { path?: string } } | null> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/state', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

/**
 * Wait for the console serving `root` to answer, and report the port it took.
 *
 * The port is READ from the registry rather than predicted, and that is the
 * point: the derived slot is only where a console starts looking. If something
 * else on this machine holds it, the server probes upward and records what it
 * actually bound — so a test that computed the derived port would poll a port
 * nothing was ever going to answer on, and blame the console.
 */
async function waitForRoot(
  root: string,
  env: NodeJS.ProcessEnv,
  tries = 60,
): Promise<{ port: number; state: { root?: { path?: string } } } | null> {
  for (let i = 0; i < tries; i++) {
    const port = getInstance(instanceId(root), env)?.port;
    if (typeof port === 'number') {
      // eslint-disable-next-line no-await-in-loop -- polling is a sequence
      const state = await probe(port, 500);
      if (state) return { port, state };
    }
    // eslint-disable-next-line no-await-in-loop -- ditto
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return null;
}

test('two projects get two consoles from one install, and each answers for its own root', async (t) => {
  const box = sandbox('lifecycle');
  const children: ChildProcess[] = [];
  t.after(() => {
    // Kill the SERVERS, by the pid each one recorded — not just the CLI
    // processes in `children`. `phase-console start` runs the server as a child
    // of itself, so killing the wrapper orphans a live console bound to a port,
    // and a test that fails halfway then leaves one behind on the operator's
    // machine every run. (Four of them were, before this line existed.)
    for (const entry of listInstances(box.env)) {
      if (typeof entry.pid === 'number') {
        try { process.kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    box.cleanup();
  });

  const env = { ...box.env, PHASE_CONSOLE_NO_OPEN: '1' };
  const roots = ['alpha', 'beta'].map((name) => {
    const dir = join(box.root, '..', `project-${name}`);
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    // ⚠️ realpath, and it is not cosmetic. `instanceId` resolves LEXICALLY on
    // purpose (a deliberate symlink stays its own instance), while the OS hands
    // a spawned child a cwd with every symlink already resolved. On macOS
    // `tmpdir()` is /var/folders → /private/var/folders, so a console started
    // by `cd`-ing here registers under the /private id while a test holding the
    // /var spelling polls a different one, forever.
    return { name, dir: realpathSync(dir) };
  });

  // A default instance already exists on any machine that has ever run a
  // console — seed one, so neither scratch project elects itself the default
  // and reaches for 4123. That port belongs to whoever is really running here.
  spawnSync(process.execPath, [
    join(VIEWER_DIR, 'shared', 'instances.mjs'),
    'register', box.root, '--name', 'seed', '--port', '4123', '--default',
  ], { env, encoding: 'utf8' });

  const cli = (args: string[], cwd?: string) =>
    spawnSync(process.execPath, [PHASE_CONSOLE, ...args], { env, cwd, encoding: 'utf8' });

  for (const { dir } of roots) {
    const child = spawn(process.execPath, [PHASE_CONSOLE, 'start'], { cwd: dir, env, stdio: 'ignore' });
    children.push(child);
  }

  const up = await Promise.all(roots.map(({ dir }) => waitForRoot(dir, env)));
  for (const [i, live] of up.entries()) {
    assert.ok(live, `${roots[i].name} came up`);
    assert.equal(live?.state.root?.path, roots[i].dir, `${roots[i].name} serves its OWN root`);
  }
  const ports = up.map((live) => live!.port);
  assert.notEqual(ports[0], ports[1], 'two projects land on two different ports');

  // `list` shows both, running, on their own ports.
  const listed = cli(['list']).stdout;
  for (const [i, { name }] of roots.entries()) {
    assert.match(listed, new RegExp(`project-${name}`), `list names ${name}`);
    assert.match(listed, new RegExp(String(ports[i])), `list shows ${name}'s port`);
  }
  assert.equal((listed.match(/running/g) ?? []).length, 2, 'both are running');

  // `open` refuses to guess: with the console up it answers with the URL for
  // THAT instance, not for whoever holds 4123.
  const opened = cli(['open'], roots[0].dir);
  assert.equal(opened.status, 0);
  assert.equal(opened.stdout.trim(), `http://127.0.0.1:${ports[0]}`);

  // Stopping with no selector, from inside the project: nothing supervises
  // these, so this is the registry-pid fallback doing the work.
  const stopped = cli(['stop'], roots[0].dir);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(await probe(ports[0]), null, 'alpha is down');
  assert.ok(await probe(ports[1]), 'and beta is untouched — they restart independently');

  // …and by name, from anywhere.
  const byName = cli(['stop', `project-${roots[1].name}`]);
  assert.equal(byName.status, 0, byName.stderr);
  assert.equal(await probe(ports[1]), null, 'beta is down');
});

test('stopping a console that is not running says so, and does not signal a recycled pid', (t) => {
  clearRegistry();
  t.after(clearRegistry);
  // A pid recorded by a console that has since exited belongs to whatever the
  // OS handed the number to next. The port is probed FIRST for exactly that
  // reason: nothing answering means nothing to stop, whatever the pid says.
  registerInstance(ALPHA, { name: 'first', port: 4199, pid: 999_999 });

  const run = spawnSync(process.execPath, [PHASE_CONSOLE, 'stop', 'first'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /is not running/);
});
