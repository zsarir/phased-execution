/**
 * The runner: does it advance a plan, and — more importantly — does it refuse
 * to advance one that did not actually work?
 *
 * The loop runs against a real temporary repo with real (stub) shell scripts,
 * because the parts most likely to break are the seams: exit codes, board
 * parsing, lock claims. Only the `claude` child is faked, since spending money
 * on a model is not a unit test. The stub board is driven by a `done` file that
 * the fake session appends to, which is precisely what a real session does when
 * it writes a handoff — so "the session claimed success but wrote nothing" is
 * expressible here, and it is the case that matters most.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR is resolved when config.ts loads, so the redirect has to happen
// before any module that reaches it is imported.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-runner-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { extractCommands, verifyPhase } = await import('../server/runner/verify.ts');
const { buildArgv, sanitize, lineReader, userMessage } = await import('../server/runner/spawn.ts');
const { nextModel, fallbackChain } = await import('../server/runner/errors.ts');
const { listRuns, loadRun, newRun, saveRun } = await import('../server/runner/state.ts');
const { Journal } = await import('../server/runner/journal.ts');
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

/* ------------------------------------------------------------------ *
 * A repo with stub scripts
 * ------------------------------------------------------------------ */

type Repo = {
  root: string;
  scripts: string;
  state: string;
  markDone: (phase: number) => void;
  doneList: () => number[];
  setGate: (phase: number, text: string) => void;
  setLockRefused: (yes: boolean) => void;
  setLintFail: (yes: boolean) => void;
  /** Make the board read slow, so a control can be pressed while it is in flight. */
  setSlowBoard: (yes: boolean) => void;
  cleanup: () => void;
};

const PHASES = [1, 2, 3];

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-runner-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');

  // A linear 3-phase graph: phase N is ready once every earlier phase is done.
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    # The real board is a subprocess taking a noticeable moment. Stretching it
    # on demand is what makes the gap between "the loop checked for a pause" and
    # "the loop started a phase" long enough to press a button inside.
    [ -f "$S/slow-board" ] && sleep 1
    d=""; r=""; w=""; found=0
    for p in ${PHASES.join(' ')}; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif [ "$found" -eq 0 ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status)
    if [ -f "$S/gate-$arg" ]; then cat "$S/gate-$arg"; exit 1; fi
    echo "clear (no gate)"
    ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);

  // Mirrors the real script's shape: `status` is informational and always
  // exits 0, so the holder has to be read out of its output.
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
echo "$*" >> "$S/locks"
if [ "\${2:-}" = "status" ]; then
  if [ -f "$S/lock-refused" ]; then echo "phase \${3:-?}: held by someone/else since now, lease until later"
  else echo "phase \${3:-?}: free"; fi
  exit 0
fi
exit 0
`);

  write(join(scripts, 'validate.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
if [ -f "$S/lint-fail" ]; then echo "VALIDATE FAIL stub"; exit 1; fi
echo "VALIDATE OK"
`);

  return {
    root, scripts, state,
    markDone: (phase) => writeFileSync(join(state, 'done'),
      `${readFileSync(join(state, 'done'), 'utf8')}${phase}\n`),
    doneList: () => readFileSync(join(state, 'done'), 'utf8').split('\n').filter(Boolean).map(Number),
    setGate: (phase, text) => writeFileSync(join(state, `gate-${phase}`), `${text}\n`),
    setLockRefused: (yes) => yes ? writeFileSync(join(state, 'lock-refused'), '') : rmSync(join(state, 'lock-refused'), { force: true }),
    setLintFail: (yes) => yes ? writeFileSync(join(state, 'lint-fail'), '') : rmSync(join(state, 'lint-fail'), { force: true }),
    setSlowBoard: (yes) => yes ? writeFileSync(join(state, 'slow-board'), '') : rmSync(join(state, 'slow-board'), { force: true }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0.02, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

/** A session that does what it was asked: marks its phase done, then exits. */
function workingSession(r: Repo, seen: number[] = []): SpawnFn {
  return async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    seen.push(phase);
    r.markDone(phase);
    return ok();
  };
}

function runner(
  r: Repo,
  spawn: SpawnFn,
  verification: string | undefined = '`true`',
  phaseDefaults?: (slug: string, phase: number) => { model?: string; effort?: string } | undefined,
) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => verification,
    phaseDefaults,
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { instance, events };
}

/** Records what each phase was actually asked to run as. */
function recordingSession(r: Repo, seen: { phase: number; model?: string; effort?: string; tools?: string[] }[]): SpawnFn {
  return async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push({ phase, model: request.model, effort: request.effort, tools: request.tools });
    r.markDone(phase);
    return ok();
  };
}

/* ------------------------------------------------------------------ *
 * Extracting commands from real plan prose
 * ------------------------------------------------------------------ */

test('a continuation fragment is reported, never executed', () => {
  // Straight out of a real plan. Running `…` is nonsense,
  // and guessing what it continues would be worse than admitting we cannot.
  const text = 'targeted pytest + full safe set `… -m "not slow and not soak" -q` + `task audit:schema`.';
  const { commands, notRun } = extractCommands(text);
  assert.deepEqual(commands, ['task audit:schema']);
  assert.equal(notRun.length, 1);
  assert.match(notRun[0].reason, /continuation fragment/);
});

test('prose with no command at all is reported, not treated as nothing to do', () => {
  const { commands, notRun } = extractCommands('targeted pytest + safe set; both green.');
  assert.equal(commands.length, 0);
  assert.equal(notRun.length, 1, 'a requirement stated in English is still a requirement');
  assert.match(notRun[0].reason, /no command/);
});

test('paths and prose spans are not mistaken for commands', () => {
  const { commands, notRun } = extractCommands('see `docs/plans/demo.md` and `**Verification:**`');
  assert.deepEqual(commands, []);
  assert.equal(notRun.length, 2);
});

test('a mutating command is refused even when it is well-formed', () => {
  for (const text of ['`task infra:update`', '`git push origin main`', '`rm -rf build`', '`terraform apply`']) {
    const { commands, notRun } = extractCommands(text);
    assert.deepEqual(commands, [], text);
    assert.match(notRun[0].reason, /mutates|not a recognised/, text);
  }
});

test('a command that reaches outside the tree must be shown read-only, not merely innocent', () => {
  // The hole this closes: MUTATION_DENY is a denylist, and every one of these
  // sails straight past it while being a perfectly ordinary thing to write in
  // a Verification bullet. The runner then executes it, unattended.
  const dangerous = [
    '`curl -X POST https://api.example.com/deploy`',
    '`curl -d "release=1" https://api.example.com/hooks`',
    "`ssh box 'systemctl restart api'`",
    '`ssh box "rm -rf /srv/cache"`',
    `\`psql -c 'DELETE FROM orders WHERE id > 0'\``,
    '`docker compose up -d`',
    '`kubectl rollout restart deploy/api`',
    '`redis-cli flushall`',
  ];
  for (const text of dangerous) {
    const { commands, notRun } = extractCommands(text);
    assert.deepEqual(commands, [], text);
    assert.equal(notRun.length, 1, text);
    assert.match(notRun[0].reason, /person should run this|mutates/, text);
  }
});

test('the read-only shapes of those same verbs still run', () => {
  const safe = [
    'curl -sS https://example.com/health',
    'curl -X GET https://example.com/health',
    "psql -c 'SELECT count(*) FROM orders'",
    'docker ps',
    'docker logs api',
    'kubectl get pods',
    'ssh box',
    "ssh box 'systemctl is-active api'",
    'redis-cli ping',
  ];
  for (const command of safe) {
    const { commands } = extractCommands(`\`${command}\``);
    assert.deepEqual(commands, [command], `${command} is read-only and should still be run`);
  }
});

test('fenced blocks contribute every command line, comments excluded', () => {
  const { commands } = extractCommands('```bash\n# check it\nnpm test\n$ task lint\n```');
  assert.deepEqual(commands, ['npm test', 'task lint']);
});

/* ------------------------------------------------------------------ *
 * Running them
 * ------------------------------------------------------------------ */

test('verification runs the commands and reports them green', async () => {
  const summary = await verifyPhase('`true` and `echo hello`', { cwd: process.cwd() });
  assert.equal(summary.ok, true);
  assert.equal(summary.ran.length, 2);
});

test('verification stops at the first red and says which one', async () => {
  const summary = await verifyPhase('`true` then `false` then `echo never`', { cwd: process.cwd() });
  assert.equal(summary.ok, false);
  assert.equal(summary.ran.length, 2, 'stops rather than cascading');
  assert.match(summary.reason, /`false` exited 1/);
  assert.equal(summary.notRun.at(-1)?.reason, 'skipped after an earlier command failed');
});

test('a phase with no verification text is not silently verified', async () => {
  const summary = await verifyPhase(undefined, { cwd: process.cwd() });
  assert.equal(summary.ok, false);
  assert.match(summary.reason, /no verification/);
});

test('verification with only unrunnable fragments is not success', async () => {
  const summary = await verifyPhase('`… -q` only', { cwd: process.cwd() });
  assert.equal(summary.ok, false, 'zero commands run must never read as verified');
  assert.equal(summary.ran.length, 0);
});

/* ------------------------------------------------------------------ *
 * The child invocation
 * ------------------------------------------------------------------ */

test('the argv never carries a flag that removes the guard rails', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', model: 'sonnet', budgetUsd: 2 });
  assert.ok(!argv.includes('--bare'), '--bare skips settings, and with them the repo hooks');
  assert.ok(!argv.includes('--safe-mode'), '--safe-mode disables hooks, skills and plugins wholesale');
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
  assert.deepEqual(sanitize(['--bare', '-p', 'x', '--dangerously-skip-permissions']), ['-p', 'x']);
  assert.deepEqual(sanitize(['--allow-dangerously-skip-permissions', '--verbose']), ['--verbose']);
});

test('the CLI silently refusing bypass is detected, not left to look like a broken phase', async () => {
  // Measured against the CLI: `bypassPermissions` needs a disclaimer that can
  // only be accepted interactively, once, per machine. Without it Claude Code
  // does not error and does not honour the flag — it downgrades to `default`,
  // which in `-p` mode prompts a terminal that is not there and so refuses
  // every edit. A Bypass run on such a machine does LESS than a Guarded one,
  // and this line on stderr is the only signal that says why.
  const { isBypassDowngrade } = await import('../server/runner/spawn.ts');

  assert.equal(isBypassDowngrade(
    'Permission mode downgraded to default — bypass requires accepting the disclaimer interactively first',
  ), true);
  assert.equal(isBypassDowngrade('permission mode downgraded to default'), true, 'case is not a contract');
  assert.equal(isBypassDowngrade('everything is fine'), false);
  assert.equal(isBypassDowngrade(''), false);

  // The flag really is handed over — being refused downstream is exactly why
  // it has to be watched for rather than assumed to have taken effect.
  assert.deepEqual(
    sanitize(['--permission-mode', 'bypassPermissions'], { allowBypass: true }),
    ['--permission-mode', 'bypassPermissions'],
  );
});

test('a forbidden flag takes its value with it', () => {
  // Dropping the flag alone left `user` loose in argv, where the CLI reads a
  // bare word as a positional prompt — so a stripped flag became a new task.
  assert.deepEqual(
    sanitize(['--setting-sources', 'user', '--verbose']),
    ['--verbose'],
  );
});

test('a forbidden permission mode is corrected, not removed', () => {
  // Removing `--permission-mode` entirely falls back to the interactive
  // default, which headless is a silent refusal of every edit: a fix that
  // quietly breaks every run is not a fix.
  assert.deepEqual(
    sanitize(['--permission-mode', 'bypassPermissions', '--verbose']),
    ['--permission-mode', 'acceptEdits', '--verbose'],
  );
  assert.deepEqual(sanitize(['--permission-mode', 'plan']), ['--permission-mode', 'plan']);
});

test('the argv asks for a streamed, budgeted, single-session run', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', model: 'opus', budgetUsd: 3, sessionId: 'abc' });
  // The prompt is NOT in argv: in streaming-input mode a positional prompt is
  // silently ignored, so passing it there would look right and run nothing.
  assert.ok(!argv.includes('hi'), 'the prompt goes down stdin, not argv');
  assert.ok(argv.includes('--print'));
  assert.ok(argv.includes('--verbose'), 'stream-json in print mode requires it');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(argv.includes('--replay-user-messages'), 'the only confirmation a message landed');
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'abc');
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '3');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('effort reaches the argv, and a bad one never does', () => {
  const good = buildArgv({ prompt: 'hi', cwd: '/tmp', effort: 'xhigh' });
  assert.equal(good[good.indexOf('--effort') + 1], 'xhigh');

  // The CLI only warns on an unknown value and carries on at its default, so
  // an unchecked typo runs a whole plan at the wrong effort and says nothing.
  const bad = buildArgv({ prompt: 'hi', cwd: '/tmp', effort: 'maximum' });
  assert.ok(!bad.includes('--effort'), 'a value the CLI would ignore is not sent at all');
});

test('the fallback chain is handed over so a limited model fails over in place', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', model: 'opus', fallbackModels: ['sonnet', 'haiku'] });
  assert.equal(argv[argv.indexOf('--fallback-model') + 1], 'sonnet,haiku');
});

test('the model chain demotes strongest-first and knows fable', () => {
  assert.equal(nextModel('fable'), 'opus');
  assert.equal(nextModel('opus'), 'sonnet');
  assert.equal(nextModel('haiku'), null, 'nothing below the cheapest');
  // A full model id must resolve too — that is what the CLI reports back.
  assert.equal(nextModel('claude-fable-5'), 'opus');
  assert.deepEqual(fallbackChain('opus'), ['sonnet', 'haiku']);
  assert.deepEqual(fallbackChain('haiku'), []);
  assert.deepEqual(fallbackChain('something-else'), [], 'an unknown model gets no guesses');
});

test('a user message is the NDJSON shape the CLI reads', () => {
  const parsed = JSON.parse(userMessage('hello'));
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.message.role, 'user');
  assert.deepEqual(parsed.message.content, [{ type: 'text', text: 'hello' }]);
  assert.ok(userMessage('hello').endsWith('\n'), 'NDJSON needs the newline to be read at all');
});

test('resuming replaces the new-session id rather than sending both', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', resume: 'old-session' });
  assert.equal(argv[argv.indexOf('--resume') + 1], 'old-session');
  assert.ok(!argv.includes('--session-id'), 'a session cannot be both new and resumed');
});

test('NDJSON split across arbitrary chunk boundaries still parses', () => {
  const lines: string[] = [];
  const reader = lineReader((line) => lines.push(line));
  const payload = '{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n';
  for (const char of payload) reader.push(char); // the worst case: one byte at a time
  reader.flush();
  assert.deepEqual(lines.map((l) => JSON.parse(l).subtype), ['init', 'success']);
});

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

test('a fresh plan runs every phase, each in its own process', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.deepEqual(seen, [1, 2, 3], 'one session per phase, in dependency order');
  assert.equal(state.status, 'finished');
  assert.deepEqual(Object.values(state.phases).map((p) => p.status), ['done', 'done', 'done']);
  assert.ok(state.spentUsd > 0, 'cost is accumulated across phases');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Permission profiles
 * ------------------------------------------------------------------ */

test('the profile a run starts under reaches every one of its children', async () => {
  const r = repo();
  const profiles: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    profiles.push(request.permissionProfile);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy);
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', permissionProfile: 'trusted',
  });
  await instance.wait();

  assert.deepEqual(profiles, ['trusted', 'trusted', 'trusted']);
  assert.equal(instance.current()!.permissionProfile, 'trusted');
  r.cleanup();
});

test('a run with no profile is trusted, and writes that out', async () => {
  const r = repo();
  const profiles: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    profiles.push(request.permissionProfile);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.deepEqual(profiles, ['trusted', 'trusted', 'trusted']);
  // Written explicitly, unlike `guarded` below — the record must say what it is
  // rather than leave a reader to apply whatever the default happens to be now.
  assert.equal(instance.current()!.permissionProfile, 'trusted');
  r.cleanup();
});

test('`guarded` is the one profile written as an omission', async () => {
  // The compatibility rule the default flip must not break: absent means
  // guarded. A run file written before profiles existed has no field, and it has
  // to keep reading as the careful option however the default moves.
  const r = repo();
  const profiles: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    profiles.push(request.permissionProfile);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy);
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', permissionProfile: 'guarded',
  });
  await instance.wait();

  assert.deepEqual(profiles, ['guarded', 'guarded', 'guarded']);
  assert.equal(instance.current()!.permissionProfile, undefined);
  r.cleanup();
});

test('switching profile mid-run is journaled, and the next phase runs under it', async () => {
  const r = repo();
  const profiles: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    profiles.push(request.permissionProfile);
    // Widen it from underneath the run, the way an operator does when the
    // third `git commit` card of the night arrives.
    if (phase === 1) instance.configure({ permissionProfile: 'trusted' }, 'someone@desk');
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spy);
  // Started `guarded` explicitly: the widening is the thing under test, so the
  // run has to begin somewhere narrower than the default now is.
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', permissionProfile: 'guarded',
  });
  await instance.wait();

  assert.deepEqual(profiles, ['guarded', 'trusted', 'trusted'], 'it applies from the next phase');

  // "Who widened this run, and when" has to be answerable later without
  // reading a diff of the whole settings patch.
  const journal = new Journal(r.root, 'demo', instance.current()!.id).read(200);
  const switched = journal.find((line) => line.event === 'run.permission-profile');
  assert.ok(switched, 'the switch has its own journal line');
  assert.equal(switched!.data.from, 'guarded');
  assert.equal(switched!.data.to, 'trusted');
  assert.equal(switched!.data.by, 'someone@desk');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Parking
 * ------------------------------------------------------------------ */

test('an unanswered approval parks the run rather than failing it', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  // What the timeout path does: the hook was told no — silence would fail open
  // — and the run is parked so the phase is not treated as having gone wrong.
  const parked = instance.park('an approval went unanswered: Bash — git commit -m x', 2);
  assert.equal(parked, true);

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.match(state.halt!.reason, /unanswered/);
  assert.equal(state.halt!.phase, 2);
  assert.equal(state.consecutiveFailures, 0, 'nobody being awake is not the work failing');

  const journal = new Journal(r.root, 'demo', state.id).read(200);
  assert.ok(journal.some((line) => line.event === 'run.parked'));
  r.cleanup();
});

test('every session runs under the run\'s own lock identity', async () => {
  // PE_OWNER is how a lock the session claims gets attributed to this run, so
  // the runner can release it afterwards and a second console can see who is
  // working the phase.
  const r = repo();
  const envs: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    envs.push(request.env?.PE_OWNER);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const owner = `autopilot/${instance.current()!.id}`;
  assert.deepEqual(envs, [owner, owner, owner], 'every session runs as the lock holder');

  // And the runner releases under that same identity.
  const calls = readFileSync(join(r.state, 'locks'), 'utf8');
  assert.ok(calls.includes(`release 1 --owner ${owner}`), `released as someone else:\n${calls}`);
  r.cleanup();
});

test('a half-finished plan resumes at the phase that is left', async () => {
  const r = repo();
  r.markDone(1);
  r.markDone(2);
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.deepEqual(seen, [3], 'the done-set decides; there is no cursor to get wrong');
  assert.equal(instance.current()!.status, 'finished');
  r.cleanup();
});

test('a session that claims success but writes nothing halts the run', async () => {
  const r = repo();
  // The failure this whole design exists to catch: the process exits 0, the
  // result says "done", and the board still says the phase is not done.
  const liar: SpawnFn = async () => ok({ resultText: 'Phase complete!' });
  const { instance } = runner(r, liar);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.match(state.halt!.reason, /the board still reads/);
  assert.equal(r.doneList().length, 0, 'nothing was advanced on the session\'s word');
  r.cleanup();
});

test('a red verification halts before the board is even consulted', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r), '`false`');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.match(state.halt!.reason, /did not verify/);
  assert.equal(state.phases['1'].status, 'failed');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Where the verification commands run
 * ------------------------------------------------------------------ */

/** A runner that also knows the plan's `**Verify in:**` for every phase. */
function verifyInRunner(r: Repo, spawn: SpawnFn, verification: string, verifyIn: string | undefined) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => verification,
    verifyIn: () => verifyIn,
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { instance, events };
}

/** The payloads of every journal line with this name — `emit` nests them one deep. */
const journalled = (
  events: { event: string; data: Record<string, unknown> }[], name: string,
) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

test('verification runs where the plan says, and the run records where that was', async () => {
  // It ran with cwd = the root the console was opened on. In a monorepo that is
  // the superproject, so one real plan's `docker compose run … -v "$PWD:/app"`
  // mounted the WHOLE monorepo into the container and hung there. The plan knew
  // which directory it meant; it had no way to say so.
  const r = repo();
  mkdirSync(join(r.root, 'services', 'api'), { recursive: true });

  const { instance } = verifyInRunner(r, workingSession(r), '`pwd`', 'services/api');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const record = instance.current()!.phases['1'];
  assert.equal(record.verifiedIn, 'services/api', 'the run says where it verified');
  assert.match(record.verification!.ran[0].output!, /services\/api$/,
    'and the command really ran there — this is `pwd` reporting for itself');
  r.cleanup();
});

test('a Verify in: that escapes the root is refused, and the refusal is journalled', async () => {
  // The plan file is editable by anyone who can open the repo, so this is a
  // boundary rather than a typo check: `../../etc` is not a directory this
  // console gets to run commands in, whatever a plan says.
  const r = repo();
  const { instance, events } = verifyInRunner(r, workingSession(r), '`pwd`', '../../etc');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const record = instance.current()!.phases['1'];
  assert.equal(record.verifiedIn, '.', 'it fell back to the root rather than failing the phase');
  const refusals = journalled(events, 'phase.verify-in-missing');
  assert.ok(refusals.length >= 1, 'a verification that ran somewhere else must never be silent');
  assert.match(String(refusals[0].reason), /outside the repository root/);
  r.cleanup();
});

test('a Verify in: naming a directory that is not there falls back, loudly', async () => {
  // The worst case for silence: a path that named a directory when the plan was
  // written and does not now. bash would inherit the parent's cwd and nobody
  // would be told which tree had actually been verified.
  const r = repo();
  const { instance, events } = verifyInRunner(r, workingSession(r), '`pwd`', 'services/api');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(instance.current()!.phases['1'].verifiedIn, '.');
  assert.match(
    String(journalled(events, 'phase.verify-in-missing')[0].reason),
    /no such directory/,
  );
  r.cleanup();
});

/** A runner that knows both the plan's `Verify in:` and its Repos column. */
function hintRunner(r: Repo, repos: string[] | undefined, verifyIn?: string) {
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: workingSession(r),
    verificationText: () => '`false`',
    verifyIn: () => verifyIn,
    phaseRepos: () => repos,
  });
  return instance;
}

test('a failed verification suggests the Repos column\'s directory — as a hint, never a cwd', async () => {
  // A silently-chosen directory that happens to be wrong verifies the wrong tree
  // and reports GREEN, which is worse than the failure it papers over. So the
  // console says what it noticed and a person writes it into the plan.
  const r = repo();
  mkdirSync(join(r.root, 'packages', 'cart-api'), { recursive: true });

  const instance = hintRunner(r, ['cart-api']);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const reason = instance.current()!.halt!.reason;
  assert.match(reason, /did not verify/, 'it is still a failure, not a suggestion');
  assert.match(reason, /Repos column names `cart-api`/);
  assert.match(reason, /- \*\*Verify in:\*\* packages\/cart-api/, 'names the bullet to add, and where');
  assert.equal(instance.current()!.phases['1'].verifiedIn, '.',
    'and it still ran at the root — the hint changed nothing about this run');
  r.cleanup();
});

test('no hint when the plan already says where to verify', async () => {
  const r = repo();
  mkdirSync(join(r.root, 'packages', 'cart-api'), { recursive: true });
  const instance = hintRunner(r, ['cart-api'], 'packages/cart-api');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.doesNotMatch(instance.current()!.halt!.reason, /Repos column/,
    'the plan has answered — repeating the question would be contradicting it');
  r.cleanup();
});

test('no hint when the answer would be a guess', async () => {
  // Two repos: the plan must choose. Two matching directories: so must a person.
  // A repo named in the plan with no directory at all: nothing to suggest.
  for (const [repos, dirs] of [
    [['cart-api', 'cart-web'], [['packages', 'cart-api'], ['packages', 'cart-web']]],
    [['api'], [['services', 'api'], ['vendor', 'api']]],
    [['api'], []],
    [undefined, [['services', 'api']]],
  ] as [string[] | undefined, string[][]][]) {
    const r = repo();
    for (const parts of dirs) mkdirSync(join(r.root, ...parts), { recursive: true });

    const instance = hintRunner(r, repos);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();

    assert.doesNotMatch(
      instance.current()!.halt!.reason,
      /Repos column/,
      `guessed for repos=${JSON.stringify(repos)} dirs=${JSON.stringify(dirs)}`,
    );
    r.cleanup();
  }
});

test('verification commands get half an hour, stated rather than defaulted', async () => {
  // At `verify.ts`'s 15-minute default a slow-but-green suite came back red and
  // halted a phase that had done nothing wrong. A phase's verification is a full
  // suite, often a build, sometimes a container — but still bounded, because a
  // wedged command has to end.
  const r = repo();
  const seen: (number | undefined)[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: workingSession(r),
    verificationText: () => '`true`',
    verify: async (_text, opts) => {
      seen.push(opts.timeoutMs);
      return { ok: true, reason: '1 command green', ran: [], notRun: [] };
    },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.ok(seen.length > 0, 'verification ran');
  for (const ms of seen) assert.equal(ms, 30 * 60_000);
  r.cleanup();
});

test('a plan that says nothing verifies at the root, and says so', async () => {
  const r = repo();
  const { instance, events } = verifyInRunner(r, workingSession(r), '`true`', undefined);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(instance.current()!.phases['1'].verifiedIn, '.');
  assert.equal(journalled(events, 'phase.verify-in-missing').length, 0,
    'saying nothing is not a mistake — only a path that cannot be honoured is');
  assert.equal(String(journalled(events, 'phase.verify')[0].cwd), '.',
    'the journal line carries the effective cwd either way');
  r.cleanup();
});

test('a plan left failing validate.sh halts even when the phase verified', async () => {
  const r = repo();
  r.setLintFail(true);
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.match(instance.current()!.halt!.reason, /validate\.sh/);
  r.cleanup();
});

test('a closed gate parks that phase and stops rather than forcing it', async () => {
  const r = repo();
  r.setGate(1, 'manual: the operator must approve the deploy');
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'parked');
  assert.equal(state.status, 'parked', 'nothing else is ready, so the run parks');
  assert.match(state.phases['1'].note!, /the operator must approve/);
  assert.equal(r.doneList().length, 0);
  r.cleanup();
});

test('a lock held elsewhere parks the phase instead of racing for it', async () => {
  const r = repo();
  r.setLockRefused(true);
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(instance.current()!.phases['1'].status, 'parked');
  assert.match(instance.current()!.phases['1'].note!, /locked by someone\/else/);
  r.cleanup();
});

test('the runner looks at the lock but does not take it', async () => {
  // Claiming it first is what deadlocked two real runs: the session then reads
  // a lock owned by a stranger and stops. Only the worker claims.
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const calls = readFileSync(join(r.state, 'locks'), 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.some((c) => c.includes(' status ')), 'it must check');
  assert.ok(!calls.some((c) => c.includes(' claim ')), `it must not claim:\n${calls.join('\n')}`);
  r.cleanup();
});

test('an expired login stops the run instead of failing every phase the same way', async () => {
  const r = repo();
  const loggedOut: SpawnFn = async () => ok({
    signal: { subtype: 'error_during_execution', code: 1, text: 'Please run /login' },
    costUsd: 0,
  });
  const { instance } = runner(r, loggedOut);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.match(state.halt!.reason, /authentication/);
  assert.equal(state.phases['1'].attempts, 1, 'no point retrying a wall');
  r.cleanup();
});

test('a model-only limit moves down the ladder and carries on', async () => {
  const r = repo();
  const models: string[] = [];
  const limited: SpawnFn = async (request) => {
    models.push(request.model!);
    if (request.model === 'opus') {
      return ok({ signal: { subtype: 'error_during_execution', code: 1, text: "You've hit your Opus limit · resets 3:45pm", model: 'opus' } });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, limited);
  await instance.start({ slug: 'demo', root: r.root, model: 'opus', autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(models[0], 'opus');
  assert.equal(models[1], 'sonnet', 'switched rather than slept');
  assert.equal(instance.current()!.status, 'finished');
  r.cleanup();
});

test('a budget cap resumes the same session rather than restarting the phase', async () => {
  const r = repo();
  const resumes: (string | undefined)[] = [];
  const capped: SpawnFn = async (request) => {
    resumes.push(request.resume);
    if (resumes.length === 1) {
      return ok({ signal: { subtype: 'error_max_budget_usd', code: 1, text: '' }, sessionId: 'sess-abc' });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-abc' });
  };
  const { instance } = runner(r, capped, '`true`');
  await instance.start({ slug: 'demo', root: r.root, phaseBudgetUsd: 2, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(resumes[0], undefined, 'the first attempt is a fresh session');
  assert.equal(resumes[1], 'sess-abc', 'the second continues it, keeping the work already done');
  r.cleanup();
});

test('an incomplete verification stops the cautious run and not the eager one', async () => {
  const text = '`true` plus `… -q`'; // one runnable, one fragment
  for (const [autonomy, expected] of [['halt-on-everything', 'halted'], ['keep-going', 'finished']] as const) {
    const r = repo();
    const { instance } = runner(r, workingSession(r), text);
    await instance.start({ slug: 'demo', root: r.root, autonomy });
    await instance.wait();
    assert.equal(instance.current()!.status, expected, autonomy);
    if (autonomy === 'halt-on-everything') {
      // This used to mark the phase `done` and halt with "N steps need a
      // person" — a dead end, because nothing on the page could then tell the
      // runner that a person had looked. The fragment now becomes a question,
      // and a question with nobody to ask is a halt that says so. This harness
      // deliberately has no approval broker; the answered path lives in
      // verify-signoff.test.ts.
      assert.equal(instance.current()!.phases['1'].status, 'awaiting-verification',
        'the phase is waiting on a person, which is neither done nor failed');
      assert.match(instance.current()!.halt!.reason, /no way to ask/);
    }
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Surviving a console restart
 * ------------------------------------------------------------------ */

test('a run interrupted mid-phase parks instead of re-running a half-done phase', async () => {
  const r = repo();
  // A checkpoint left behind by a console that died: a child that is now gone.
  const stale = newRun({ slug: 'demo', root: r.root });
  stale.child = { pid: 999_999, phase: 1, sessionId: 'sess-x', startedAt: new Date().toISOString() };
  stale.phases['1'] = { phase: 1, status: 'running', attempts: 1, costUsd: 0.5 };
  saveRun(stale);

  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'interrupted');
  assert.match(state.phases['1'].note!, /console stopped/);
  assert.equal(state.status, 'parked', 'a phase that may have half-committed needs a person');
  r.cleanup();
});

test('a child that outlived the console blocks the run rather than doubling up', async () => {
  const r = repo();
  const stale = newRun({ slug: 'demo', root: r.root });
  // Our own pid: alive, guaranteed, and nothing to clean up afterwards.
  stale.child = { pid: process.pid, phase: 1, sessionId: 'sess-y', startedAt: new Date().toISOString() };
  saveRun(stale);

  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.match(state.halt!.reason, /still running \(pid/);
  assert.equal(r.doneList().length, 0, 'two agents must never edit one tree');
  r.cleanup();
});

test('the checkpoint is on disk and readable after the run', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const id = instance.current()!.id;
  const reloaded = loadRun(r.root, 'demo', id);
  assert.ok(reloaded, 'a crash must be able to find this');
  assert.equal(reloaded.status, 'finished');
  assert.equal(listRuns(r.root, 'demo').length, 1);
  r.cleanup();
});

test('the journal records the sequence a person would ask about', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const entries = new Journal(r.root, 'demo', instance.current()!.id).read();
  const events = entries.map((e) => e.event);
  for (const expected of ['run.start', 'phase.start', 'phase.session', 'phase.verify', 'phase.done', 'run.finished']) {
    assert.ok(events.includes(expected), `journal is missing ${expected}`);
  }
  assert.ok(entries.every((e, i) => e.seq === i + 1), 'the sequence has no gaps');
  r.cleanup();
});

test('a second run on the same plan is refused while one is in flight', async () => {
  const r = repo();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let held = false;
  const slow: SpawnFn = async (request) => {
    // Only the first phase blocks — the rest must be free to finish, or the
    // test deadlocks on phase 2 rather than on the thing it is checking.
    if (!held) {
      held = true;
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, slow);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  // start() returns as soon as the loop is driving, which is before the first
  // child exists. Releasing a session that has not begun would deadlock.
  await inSession;

  await assert.rejects(
    () => instance.start({ slug: 'demo', root: r.root }),
    /already in progress/,
    'two loops in one working tree is a merge conflict with extra steps',
  );

  release();
  await instance.wait();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Pausing
 * ------------------------------------------------------------------ */

/**
 * A session that blocks on its first phase until it is released, so a test can
 * act on a run while a phase is genuinely in flight.
 */
function heldSession(r: Repo, seen: number[] = []) {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let held = false;
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    if (!held) {
      held = true;
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };
  return { spawn, inSession, release: () => release(), seen };
}

test('an armed pause names the phase it is waiting for, and stops at the boundary', async () => {
  const r = repo();
  const held = heldSession(r);
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.pause('tester'), true, 'a live run can be paused');
  const armed = instance.current()!;
  assert.equal(armed.status, 'pausing');
  assert.equal(armed.pause?.afterPhase, 1, 'the operator is told which phase has to finish first');
  assert.equal(armed.pause?.by, 'tester');

  held.release();
  await instance.wait();

  const after = instance.current()!;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause, null, 'a pause that has arrived is no longer pending');
  assert.equal(after.phases['1'].status, 'done', 'the phase in flight was finished, not cut off');
  assert.deepEqual(held.seen, [1], 'and phase 2 was never started');
  r.cleanup();
});

test('a cancelled pause lets the run carry on', async () => {
  const r = repo();
  const held = heldSession(r);
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  instance.pause();
  assert.equal(instance.resumePause(), true);
  assert.equal(instance.current()!.status, 'running');
  assert.equal(instance.current()!.pause, null);

  held.release();
  await instance.wait();
  assert.equal(instance.current()!.status, 'finished', 'the cancelled pause did not stop it');
  assert.deepEqual(held.seen, [1, 2, 3]);
  r.cleanup();
});

test('a pause armed while the board is being read starts no phase at all', async () => {
  // The reported defect, reproduced at its actual cause. `drive` read the pause
  // flag once at the top of the loop and then awaited `board()` — a
  // `phase-graph.sh` subprocess — before spawning. A Pause pressed inside that
  // gap was set a few hundred milliseconds after the only line that read it, so
  // the next phase started anyway and the operator watched the thing they had
  // just stopped begin new work.
  const r = repo();
  const seen: number[] = [];
  r.setSlowBoard(true);
  const { instance } = runner(r, workingSession(r, seen));

  // `start` returns as soon as the loop is driving; the first board read is
  // still in flight, which is exactly the window this is about.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(seen, [], 'the board read has not finished, so nothing has started yet');

  assert.equal(instance.pause('tester'), true);
  await instance.wait();

  assert.deepEqual(seen, [], 'no phase was spawned after the pause was armed');
  assert.equal(instance.current()!.status, 'paused');
  assert.equal(instance.current()!.pause, null, 'a pause that has arrived is no longer pending');
  r.cleanup();
});

test('thawing a frozen session does not take back a pause that was already armed', async () => {
  // Pause, then Freeze, then Continue. `thaw` wrote `running` unconditionally,
  // which silently discarded a request the operator had already made and never
  // took back — Cancel pause is the control for that, and they did not press it.
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.pause('tester'), true);
  assert.equal(instance.freeze('tester'), true, 'freezing a run that is already pausing still works');
  assert.equal(instance.current()!.pause?.by, 'tester', 'the pause request outlives the freeze');

  assert.equal(instance.thaw(), true);
  assert.equal(instance.current()!.status, 'pausing', 'still pausing — thaw is not Cancel pause');
  assert.notEqual(procState(pid), 'T', 'and the child is scheduled again');

  held.release();
  await instance.wait();
  assert.equal(instance.current()!.status, 'paused');
  r.cleanup();
});

test('pausing a run nothing is driving reports that it did nothing', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  // The exact condition that made the Pause button answer 200 and do nothing:
  // no loop behind the run. The runner now says so instead of returning
  // silently, which is what lets the service fall through to the checkpoint.
  assert.equal(instance.pause(), false, 'no loop is driving anything to pause');
  assert.equal(instance.resumePause(), false);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();
  assert.equal(instance.pause(), false, 'and a finished run has nothing to pause either');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Asking a running phase something
 * ------------------------------------------------------------------ */

test('a question reaches the session that is running, framed so it cannot redirect it', async () => {
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({
        pid: 1,
        open: () => true,
        send: (text: string) => { sent.push(text); return true; },
      });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };

  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;

  const asked = instance.ask('why did you skip the cache?');
  assert.equal(asked.ok, true);
  // The tag is what correlates this write with the CLI's echo of it and with
  // the session's eventual reply. Without one the console can only guess which
  // sentence in an hour of output was the answer.
  assert.match(asked.mark!, /^ask:[0-9a-f]{8}$/);
  assert.equal(sent.length, 1);
  // The frame is what keeps a question a question. Dropped in bare, text from
  // the operator outranks almost everything in a phase's context and reads as
  // a change of direction.
  assert.match(sent[0], /out-of-band question/i);
  assert.match(sent[0], /continue exactly where you left off/i);
  assert.match(sent[0], /Question: why did you skip the cache\?$/);
  assert.ok(sent[0].includes(`[[${asked.mark}]]`), 'the tag travels with the question');

  release();
  await instance.wait();
  r.cleanup();
});

test('the same idempotency key is one write, however many times it is posted', async () => {
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({ pid: 1, open: () => true, send: (t: string) => { sent.push(t); return true; } });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };

  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;

  // A double click, a retried fetch, a phone that reconnected mid-request —
  // the server cannot tell any of those from two real questions unless told.
  const first = instance.ask('is the cache warm?', 'console', 'dup-key-0001');
  const again = instance.ask('is the cache warm?', 'console', 'dup-key-0001');
  assert.equal(first.ok, true);
  assert.equal(again.ok, true, 'a repeat is a success — the caller did nothing wrong');
  assert.equal(again.repeated, true, 'and it says so');
  assert.equal(again.mark, first.mark, 'the same message, so the same correlation');
  assert.equal(sent.length, 1, 'exactly one write reached stdin');

  // A different key is a different question and does get through.
  assert.equal(instance.ask('and the second one?', 'console', 'dup-key-0002').ok, true);
  assert.equal(sent.length, 2);

  release();
  await instance.wait();
  r.cleanup();
});

test('Steer is an instruction, and the journal records it as one', async () => {
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({ pid: 1, open: () => true, send: (t: string) => { sent.push(t); return true; } });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };

  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;
  const runId = instance.current()!.id;

  const steered = instance.steer('use the existing helper rather than a new one');
  assert.equal(steered.ok, true);
  assert.match(steered.mark!, /^steer:[0-9a-f]{8}$/);
  assert.equal(sent.length, 1);
  // The opposite framing to Ask, and it has to be: a message that opens "this
  // is NOT a change to the phase" is useless for telling a phase to change.
  assert.match(sent[0], /course correction/i);
  assert.match(sent[0], /this IS an instruction/i);
  // And the honest part — steering does not talk a phase past its gate.
  assert.match(sent[0], /verification commands still decide/i);
  assert.match(sent[0], /Instruction: use the existing helper rather than a new one$/);

  release();
  await instance.wait();

  // Two event names, so a journal can explain a phase that changed direction.
  const events = new Journal(r.root, 'demo', runId).read().map((e) => e.event);
  assert.ok(events.includes('phase.steered'), 'steering has its own event name');
  assert.ok(!events.includes('phase.asked'), 'and is not recorded as a question');
  r.cleanup();
});

test('an empty or oversized question is refused before it is sent anywhere', async () => {
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({ pid: 1, open: () => true, send: (t: string) => { sent.push(t); return true; } });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;

  assert.equal(instance.ask('   ').ok, false);
  assert.equal(instance.ask('x'.repeat(9_000)).ok, false);
  assert.equal(sent.length, 0);

  release();
  await instance.wait();
  r.cleanup();
});

test('asking when nothing is running says so rather than swallowing it', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  const before = instance.ask('anyone there?');
  assert.equal(before.ok, false);
  assert.match(before.reason!, /nothing is running/);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const after = instance.ask('and now?');
  assert.equal(after.ok, false, 'a finished run has no session to ask');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Freezing the phase itself
 * ------------------------------------------------------------------ *
 *
 * Signals against a real process, because the claim being tested is an
 * operating-system one: is the child actually stopped? A fake that records
 * "freeze was called" would pass while the session carried on writing files,
 * which is the exact failure this control exists to prevent.
 */

/**
 * A session whose child is a real, long-lived process we can signal.
 *
 * `finishes` is what separates the two scenarios: a thawed session goes on to
 * write its handoff, and a checkpointed one was stopped before it could — so
 * the second must NOT mark its phase done, or Continue finds nothing to resume
 * and quietly runs the next phase instead.
 */
function realChildSession(r: Repo, onPid: (pid: number) => void, finishes = true): {
  spawn: SpawnFn; inSession: Promise<void>; release: () => void; pid: () => number;
} {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  let child: ReturnType<typeof spawnProcess> | null = null;
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      child = spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
      onPid(child.pid!);
      request.onPid?.(child.pid!);
      request.onHandle?.({ pid: child.pid!, open: () => true, send: () => true });
      // A real session announces its id in the first message it sends, which is
      // the only reason anything can act on a live session at all.
      request.onEvent?.({ kind: 'init', sessionId: 'session-to-resume-0001', model: 'stub-1', tools: 0 });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      if (!finishes) return { ...ok(), sessionId: 'session-to-resume-0001' };
    }
    r.markDone(phase);
    return { ...ok(), sessionId: 'session-to-resume-0001' };
  };

  return { spawn, inSession, release: () => release(), pid: () => child?.pid ?? 0 };
}

/** What `ps` says about a process: `T` is stopped, `S`/`R` are running. */
function procState(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim().slice(0, 1);
  } catch { return ''; }
}

test('freezing stops the child where it stands, and thawing lets it carry on', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.notEqual(procState(pid), 'T', 'the child is running before anything is asked of it');

  assert.equal(instance.freeze('test'), true);
  assert.equal(instance.current()!.status, 'frozen');
  assert.equal(instance.current()!.freeze!.pid, pid);
  assert.equal(instance.current()!.freeze!.phase, 1);
  // The claim that matters, made by the kernel rather than by us.
  assert.equal(procState(pid), 'T', 'the session is stopped, not killed and not asked to wrap up');

  assert.equal(instance.thaw(), true);
  assert.equal(instance.current()!.status, 'running');
  assert.equal(instance.current()!.freeze, null);
  assert.notEqual(procState(pid), 'T', 'and it is scheduled again');
  // Time spent stopped is not time spent working, and a throughput figure built
  // on the difference would be wrong.
  assert.ok((instance.current()!.phases['1'].frozenMs ?? 0) >= 0);

  held.release();
  await instance.wait();
  r.cleanup();
});

test('a freeze held too long checkpoints, and Continue resumes that session', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; }, false);
  const { instance } = runner(r, held.spawn);
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.freeze('test'), true);
  // The escalation is a timer in production; driven directly here, because a
  // test that waits fifteen real minutes is a test nobody runs.
  (instance as unknown as { escalateFreeze(): void }).escalateFreeze();

  const record = instance.current()!.phases['1'];
  // Pending rather than interrupted: this phase is meant to be picked up again,
  // and a settled status is one the loop will not look at.
  assert.equal(record.status, 'pending');
  assert.equal(record.resumeSessionId, 'session-to-resume-0001');
  assert.equal(instance.current()!.freeze, null);
  assert.equal(instance.current()!.status, 'paused');
  assert.notEqual(procState(pid), 'T', 'SIGCONT before SIGTERM, or the child never sees it');

  held.release();
  await instance.wait();

  // Continue: the phase runs again, and the session id goes to `--resume`
  // rather than to `--session-id`, which would be refused as already in use.
  const resumed: (string | undefined)[] = [];
  const second = runner(r, async (request) => {
    resumed.push(request.resume);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  });
  await second.instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, autonomy: 'keep-going' });
  await second.instance.wait();

  assert.equal(resumed[0], 'session-to-resume-0001', 'the checkpointed session was picked up');
  assert.equal(resumed[1], undefined, 'and offered exactly once — a reused id is refused by the CLI');
  r.cleanup();
});

test('retry and skip say so the moment they act, not at the next thing that happens', async () => {
  // Both edited the run record and then emitted only `run:journal`, which is
  // marked stream-only and invalidates no query. The row went on showing the
  // old status — a retried phase still read `failed`, under a halt banner that
  // had already been cleared — until something unrelated happened to emit. The
  // only way to see the truth was to reload the page.
  const r = repo();
  const { instance, events } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const from = events.length;
  instance.retry(1);
  const afterRetry = events.slice(from).map((e) => e.event);
  assert.ok(afterRetry.includes('run:run'), `retry must emit run:run, got ${afterRetry.join(', ')}`);
  assert.equal(instance.current()!.phases['1'].status, 'pending', 'and the state it emitted is the new one');

  const beforeSkip = events.length;
  instance.skip(2);
  assert.ok(
    events.slice(beforeSkip).map((e) => e.event).includes('run:run'),
    'skip must emit run:run too',
  );
  r.cleanup();
});

test('freezing a run nothing is driving reports that it did nothing', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  assert.equal(instance.freeze(), false, 'no loop, no child, nothing to stop');
  assert.equal(instance.thaw(), false);
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * What a phase runs as
 * ------------------------------------------------------------------ */

test('the operator wins over the plan, the plan wins over the run default', async () => {
  const r = repo();
  const seen: { phase: number; model?: string; effort?: string }[] = [];
  // The plan asks for opus/high on phase 2, and says nothing about 1 or 3.
  const { instance } = runner(r, recordingSession(r, seen), '`true`',
    (_slug, phase) => (phase === 2 ? { model: 'opus', effort: 'high' } : undefined));

  await instance.start({
    slug: 'demo', root: r.root, model: 'sonnet', effort: 'medium', autonomy: 'keep-going',
    // …and the operator overrules the plan on 2, and the default on 3.
    phaseOptions: { 2: { model: 'haiku' }, 3: { effort: 'max' } },
  });
  await instance.wait();

  assert.deepEqual(seen, [
    { phase: 1, model: 'sonnet', effort: 'medium', tools: undefined },
    // Model from the operator, effort still from the plan: an override is per
    // field, not per phase — saying "run this on haiku" must not silently
    // discard the effort the plan asked for.
    { phase: 2, model: 'haiku', effort: 'high', tools: undefined },
    { phase: 3, model: 'sonnet', effort: 'max', tools: undefined },
  ]);
  r.cleanup();
});

test('the journal says where each choice came from', async () => {
  const r = repo();
  const { instance, events } = runner(r, workingSession(r), '`true`',
    (_slug, phase) => (phase === 1 ? { model: 'opus' } : undefined));
  await instance.start({ slug: 'demo', root: r.root, effort: 'low', autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  const start = events.find((e) => e.event === 'run:journal' && e.data.event === 'phase.start');
  assert.ok(start, 'a phase that started must say so in the journal');
  assert.deepEqual((start.data.data as { source: unknown }).source, { model: 'plan', effort: 'default' });
  r.cleanup();
});

test('a restricted tool set reaches the session', async () => {
  const r = repo();
  const seen: { phase: number; tools?: string[] }[] = [];
  const { instance } = runner(r, recordingSession(r, seen));
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1],
    phaseOptions: { 1: { tools: ['Read', 'Grep'] } },
  });
  await instance.wait();
  assert.deepEqual(seen[0].tools, ['Read', 'Grep']);
  r.cleanup();
});

test('a run asked for one phase runs that phase and stops', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, [1], 'the loop did not carry on into the rest of the plan');
  assert.equal(instance.current()!.status, 'finished');
  // The most-reported "it doesn't advance to the next phase" is this, and it
  // used to be invisible: the run was scoped from a per-row control, did what
  // it was asked, and said nothing about why it stopped one phase in.
  assert.match(instance.current()!.finishedReason!, /scoped to phase 1/);
  assert.match(instance.current()!.finishedReason!, /scope cleared/i);
  r.cleanup();
});

test('a run that finishes a whole plan says that is why it stopped', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();
  assert.equal(instance.current()!.status, 'finished');
  assert.match(instance.current()!.finishedReason!, /every phase of demo is done/);
  r.cleanup();
});

test('settings changed mid-run apply from the next phase', async () => {
  const r = repo();
  const seen: number[] = [];
  const held = heldSession(r, seen);
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, model: 'opus', autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.configure({ model: 'haiku', runBudgetUsd: 12 }), true);
  assert.equal(instance.current()!.model, 'haiku');
  assert.equal(instance.current()!.runBudgetUsd, 12);
  // The phase already running keeps the model it was started with — its argv
  // was fixed before the change, and claiming otherwise would be a lie.
  assert.equal(instance.current()!.phases['1'].model, 'opus');

  held.release();
  await instance.wait();
  assert.equal(instance.current()!.phases['2'].model, 'haiku', 'the next phase took the new one');
  r.cleanup();
});

test('nothing was written inside the repo — run state lives outside it', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(existsSync(join(r.root, '.phase-console')), false);
  assert.ok(existsSync(join(STATE_HOME, 'phase-console', 'runs')), 'it went to XDG state instead');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * The API guard
 * ------------------------------------------------------------------ */

const { handleApi } = await import('../server/api/routes.ts');

function call(
  path: string,
  opts: {
    method?: string; headers?: Record<string, string>; allowRun?: boolean; body?: unknown;
    /** Replace a service method for one call — used to test a refusal path. */
    overrides?: Record<string, unknown>;
  } = {},
) {
  let status = 0;
  let payload: unknown;
  const started: unknown[] = [];
  /** Which service methods a route reached, in order — see the pause test. */
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return { id: 'r1', status: 'pausing' };
  };
  const service = {
    flags: { allowWrites: false, allowRun: opts.allowRun ?? false, scriptsDir: '/x' },
    store: { get: () => ({}), list: () => [] },
    // If a route reaches for the runner directly it gets a method that fails
    // the test rather than one that quietly does nothing — which is precisely
    // how Pause came to answer 200 and change nothing for so long.
    runner: {
      current: () => null,
      pause() { throw new Error('routes must go through the service, not the runner'); },
      resumePause() { throw new Error('routes must go through the service, not the runner'); },
      configure() { throw new Error('routes must go through the service, not the runner'); },
      stop: async () => {}, skip() {}, retry() {},
    },
    startRun: async (slug: string, options: unknown) => { started.push({ slug, options }); return { id: 'r1' }; },
    pauseRun: record('pauseRun'),
    resumePause: record('resumePause'),
    configureRun: record('configureRun'),
    askRun: (...args: unknown[]) => { calls.push({ method: 'askRun', args }); return { ok: true }; },
    stopRun: record('stopRun'),
    skipPhase: record('skipPhase'),
    retryPhase: record('retryPhase'),
    // Async since the board resolver joined the read path — a stopped run whose
    // phases the board has finished stops asking for a person (`state.ts`
    // `autoResolveRun`). `runIdFor` is the sync half, for the journal and
    // transcript routes, which address a run by id and do not need the board.
    runFor: async () => ({ id: 'r1', status: 'finished' }),
    runsFor: async () => [{ id: 'r1' }],
    runIdFor: () => 'r1',
    resolveRun: record('resolveRun'),
    unresolveRun: record('unresolveRun'),
    // Null is the ordinary answer: no phase of this plan has finished, so
    // there is nothing to estimate from.
    runEta: async () => null,
    // Sync, and given the run the route already read — the payload's three
    // figures have to be about one run, so the route reads it once.
    runPhaseEta: () => [],
    allRuns: async () => [{ id: 'r1' }],
    runJournal: () => [{ seq: 1, event: 'run.start' }],
    markNotificationsRead: (...args: unknown[]) => {
      calls.push({ method: 'markNotificationsRead', args });
      return { changed: 9, unread: 0 };
    },
    markNotificationsReadFor: (...args: unknown[]) => {
      calls.push({ method: 'markNotificationsReadFor', args });
      return { changed: 2, unread: 7 };
    },
    ...(opts.overrides ?? {}),
  };
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = text; } },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req = {
    method: opts.method ?? 'GET',
    headers: { host: '127.0.0.1:4123', ...(opts.headers ?? {}) },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield* chunks; },
  };
  return handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:4123${path}`))
    .then(() => ({ status, payload, started, calls }));
}

/** A console POST with one service method replaced. */
function callWith(overrides: Record<string, unknown>, path: string, body: unknown) {
  return call(path, {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' }, body, overrides,
  });
}

test('starting a run is refused unless the console was started with --allow-run', async () => {
  const { status, payload, started } = await call('/api/run/demo/start', {
    method: 'POST', headers: { 'x-phase-console': '1' }, body: {},
  });
  assert.equal(status, 403);
  assert.match(String((payload as { error: string }).error), /--allow-run/);
  assert.equal(started.length, 0, 'nothing may spawn behind a refusal');
});

test('--allow-run alone is not enough: the request must come from the console', async () => {
  const { status, started } = await call('/api/run/demo/start', { method: 'POST', allowRun: true, body: {} });
  assert.equal(status, 403, 'a missing console header means it did not come from this app');
  assert.equal(started.length, 0);
});

test('another origin cannot drive the autopilot', async () => {
  const { status, started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, body: {},
    headers: { 'x-phase-console': '1', origin: 'http://evil.example' },
  });
  assert.equal(status, 403);
  assert.equal(started.length, 0);
});

test('a proper start request reaches the service with its options', async () => {
  const { status, started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true,
    headers: { 'x-phase-console': '1', origin: 'http://127.0.0.1:4123' },
    body: { model: 'sonnet', effort: 'high', autonomy: 'keep-going', phaseBudgetUsd: 4 },
  });
  assert.equal(status, 200);
  assert.equal(started.length, 1);
  const { slug, options } = started[0] as { slug: string; options: Record<string, unknown> };
  assert.equal(slug, 'demo');
  // Asserted field by field rather than as one object: a deep-equal here fails
  // every time a new option is added, which teaches you to edit the expected
  // value without reading it — and then it is no longer checking anything.
  assert.equal(options.model, 'sonnet');
  assert.equal(options.effort, 'high');
  assert.equal(options.autonomy, 'keep-going');
  assert.equal(options.phaseBudgetUsd, 4);
  assert.equal(options.runBudgetUsd, null, 'an unsent budget is no budget, not zero');
  assert.equal(options.resumeRunId, undefined);
});

test('per-phase choices are checked against known values, never passed through', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: {
      phaseOptions: {
        1: { model: 'fable', effort: 'max' },
        2: { model: 'gpt-4', effort: 'ludicrous' },          // neither is ours
        3: { permissionMode: 'bypassPermissions' },          // never, from here
        4: { tools: ['Read', 'Bash(rm -rf /)', 'Edit'] },    // not a tool name
        '-1': { model: 'opus' },                             // not a phase
      },
      skills: ['systematic-debugging', 'plugin:test-first', '../../etc/passwd', 'ok-name'],
    },
  });
  const options = (started[0] as { options: Record<string, unknown> }).options;
  assert.deepEqual(options.phaseOptions, {
    1: { model: 'fable', effort: 'max' },
    4: { tools: ['Read', 'Edit'] },
  }, 'anything unrecognised is dropped, and a phase left with nothing is dropped with it');
  assert.deepEqual(options.skills, ['systematic-debugging', 'plugin:test-first', 'ok-name']);
});

test('a per-phase skills-off survives the door, and a false one leaves no trace', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: {
      phaseOptions: {
        1: { skillsOff: true },
        2: { skillsOff: false },        // the same as not saying it
        3: { skillsOff: 'yes' },        // a string is not a decision
        4: { skillsOff: true, skills: ['investigate'] },
      },
    },
  });
  const options = (started[0] as { options: Record<string, unknown> }).options;
  // Phases 2 and 3 are absent entirely: writing `skillsOff: false` would put a
  // key on a row where nothing was chosen, and the row would then read as an
  // override in the console's own "N overridden" count.
  assert.deepEqual(options.phaseOptions, {
    1: { skillsOff: true },
    4: { skills: ['investigate'], skillsOff: true },
  });
});

test('an effort the CLI would silently ignore is dropped at the door', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { effort: 'ludicrous' },
  });
  assert.equal((started[0] as { options: { effort?: string } }).options.effort, undefined);
});

test('a start request may name the only phases it wants, and they are sanitised', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    // Junk a browser could send: duplicates, a fraction, zero, a negative, a
    // numeric string, a word. Only whole positive phases survive.
    body: { onlyPhases: [3, 3, 2.5, 0, -1, '4', 'x'] },
  });
  assert.deepEqual((started[0] as { options: { onlyPhases: number[] } }).options.onlyPhases, [3, 4]);
});

test('an unknown autonomy value falls back to the run default', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { autonomy: 'yolo' },
  });
  assert.equal((started[0] as { options: { autonomy: string } }).options.autonomy, 'keep-going');
});

test('halting on everything is still reachable, and only by asking for it', async () => {
  // The flip moved the default, not the option. Unlike `permissionProfile` —
  // where an unrecognised value must land on the narrow choice, because getting
  // that one wrong grants trust — autonomy defaults to the wide one, so the
  // cautious side is the one worth proving still arrives when asked for.
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { autonomy: 'halt-on-everything' },
  });
  assert.equal(
    (started[0] as { options: { autonomy: string } }).options.autonomy,
    'halt-on-everything',
  );
});

test('every control verb goes through the service, so it works after a restart', async () => {
  // The regression this exists for: `pause` called `runner.pause()` from the
  // route, and that method returns silently when no loop is driving the run —
  // which is true of EVERY run after a console restart. The button stayed on
  // screen, the API answered 200, and nothing happened. Stop, Skip and Retry
  // were fixed for exactly this; Pause was left behind.
  for (const [verb, method] of [
    ['pause', 'pauseRun'], ['resume', 'resumePause'], ['stop', 'stopRun'],
    ['skip', 'skipPhase'], ['retry', 'retryPhase'], ['settings', 'configureRun'],
    ['ask', 'askRun'],
  ]) {
    const { status, calls } = await call(`/api/run/demo/${verb}`, {
      method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' }, body: { phase: 2 },
    });
    assert.equal(status, 200, verb);
    assert.deepEqual(calls.map((c) => c.method), [method], `${verb} must reach service.${method}`);
  }
});

test('a question that lands nowhere answers 409, not 200', async () => {
  // Well formed, nothing listening. A 200 here would tell the console the
  // question was delivered, and it would show it in the transcript as if a
  // session had heard it — which is exactly the lie this whole change is about.
  const { status } = await call('/api/run/demo/ask', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { question: 'anyone there?' },
  });
  assert.equal(status, 200, 'the stub service says it landed');

  const refused = await callWith(
    { askRun: () => ({ ok: false, reason: 'nothing is running' }) },
    '/api/run/demo/ask',
    { question: 'anyone there?' },
  );
  assert.equal(refused.status, 409);
  assert.match(String((refused.payload as { reason: string }).reason), /nothing is running/);
});

test('pause is refused without --allow-run, like every other control', async () => {
  for (const verb of ['pause', 'resume', 'settings', 'ask']) {
    const { status, calls } = await call(`/api/run/demo/${verb}`, {
      method: 'POST', headers: { 'x-phase-console': '1' }, body: {},
    });
    assert.equal(status, 403, verb);
    assert.equal(calls.length, 0, `${verb} must not touch the run behind a refusal`);
  }
});

test('a settings patch carries only the keys that were sent', async () => {
  const { calls } = await call('/api/run/demo/settings', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    // `status` and `spentUsd` are records of what happened, not choices — a
    // patch endpoint that accepted them would let a browser rewrite history.
    body: { model: 'fable', status: 'finished', spentUsd: 0, runBudgetUsd: 9 },
  });
  assert.deepEqual(calls[0].args[1], { model: 'fable', runBudgetUsd: 9 });
});

test('the policy can be tightened from the console and never widened', async () => {
  const seen: unknown[] = [];
  const service = {
    policy: () => ({ defaults: {}, extra: {}, effective: {}, file: '/x' }),
    addPolicy: (rules: unknown) => { seen.push(rules); return { ok: true }; },
  };

  const read = await call('/api/policy', { overrides: service });
  assert.equal(read.status, 200);

  // Adding to allow would widen what an unattended agent may do at 3am. That
  // is a deliberate file edit, not something a click can do.
  const widened = await call('/api/policy', {
    method: 'POST', headers: { 'x-phase-console': '1' }, body: { allow: ['Bash(rm:*)'] },
    overrides: { ...service, flags: { allowWrites: true, allowRun: true, scriptsDir: '/x' } },
  });
  assert.equal(widened.status, 400);
  assert.equal(seen.length, 0, 'nothing was written behind the refusal');

  const tightened = await call('/api/policy', {
    method: 'POST', headers: { 'x-phase-console': '1' }, body: { deny: ['Bash(task deploy:*)'], junk: 1 },
    overrides: { ...service, flags: { allowWrites: true, allowRun: true, scriptsDir: '/x' } },
  });
  assert.equal(tightened.status, 200);
  assert.deepEqual(seen, [{ deny: ['Bash(task deploy:*)'], ask: [] }]);
});

test('changing the policy needs --allow-writes, and reading it does not', async () => {
  const refused = await call('/api/policy', {
    method: 'POST', headers: { 'x-phase-console': '1' }, body: { deny: ['Bash(x:*)'] },
    overrides: { policy: () => ({}), addPolicy: () => { throw new Error('must not be reached'); } },
  });
  assert.equal(refused.status, 403);
  assert.match(String((refused.payload as { error: string }).error), /--allow-writes/);
});

test('the skills a session could invoke are readable without any flag', async () => {
  const listed = await call('/api/skills', {
    overrides: { skills: () => [{ id: 'investigate', name: 'investigate', description: 'x', source: 'personal' }] },
  });
  assert.equal(listed.status, 200);
  assert.equal((listed.payload as { id: string }[])[0].id, 'investigate');
});

test('reading a run needs no flag — only changing one does', async () => {
  const listed = await call('/api/runs');
  assert.equal(listed.status, 200);
  const one = await call('/api/run/demo');
  assert.equal(one.status, 200);
  assert.equal((one.payload as { run: { id: string } }).run.id, 'r1');
  // The estimate rides on this response rather than having an endpoint of its
  // own, so that it and the board it rests on are answered from one read.
  assert.ok('eta' in (one.payload as Record<string, unknown>));
  const journal = await call('/api/run/demo/journal');
  assert.equal(journal.status, 200);
});

test('dismissing a run card names the run, and refuses without one', async () => {
  const headers = { 'x-phase-console': '1' };

  // Run-class, like every other verb that edits a run record.
  const refused = await call('/api/run/demo/resolve', {
    method: 'POST', headers, body: { runId: 'r1' },
  });
  assert.equal(refused.status, 403);

  // A dismissal without a run id is a request to resolve "whichever run" —
  // which on a plan that has run since is not the one whose card was pressed.
  const vague = await call('/api/run/demo/resolve', {
    method: 'POST', headers, body: {}, allowRun: true,
  });
  assert.equal(vague.status, 400);

  const done = await call('/api/run/demo/resolve', {
    method: 'POST', headers, body: { runId: 'r1', note: 'handoff landed later' }, allowRun: true,
  });
  assert.equal(done.status, 200);
  assert.deepEqual(done.calls.map((c) => c.method), ['resolveRun']);
  assert.equal(done.calls[0].args[0], 'demo');
  assert.equal(done.calls[0].args[1], 'r1');
  assert.equal((done.calls[0].args[2] as { note: string }).note, 'handoff landed later');

  const back = await call('/api/run/demo/unresolve', {
    method: 'POST', headers, body: { runId: 'r1' }, allowRun: true,
  });
  assert.equal(back.status, 200);
  assert.deepEqual(back.calls.map((c) => c.method), ['unresolveRun']);
});

test('a scoped read never falls through to marking the whole inbox', async () => {
  const headers = { 'x-phase-console': '1' };
  const post = (body: unknown) => call('/api/notifications/read', { method: 'POST', headers, body });

  // A scope goes to the scoped verb, and only to it. If this fell through, the
  // page that fires it on load would clear an inbox it was scoped away from.
  const scoped = await post({ slug: 'alpha' });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.calls.map((c) => c.method), ['markNotificationsReadFor']);
  assert.deepEqual(scoped.calls[0].args[0], { slug: 'alpha' });

  const session = await post({ sessionId: '84c324dd3ef9', phase: 3 });
  assert.deepEqual(session.calls[0].args[0], { sessionId: '84c324dd3ef9', phase: 3 });

  // Blank strings are a route that has not parsed yet — and the branch is
  // chosen by the KEY being present, not by the value being usable. Reading
  // this as "no scope" sends it down the bulk path, where it clears the entire
  // inbox; a scratch console was observed doing exactly that. It reaches the
  // scoped verb with an empty scope instead, which matches nothing.
  const blank = await post({ slug: '', category: '' });
  assert.deepEqual(blank.calls.map((c) => c.method), ['markNotificationsReadFor']);
  assert.deepEqual(blank.calls[0].args[0], {}, 'a blank scope must clear nothing, not everything');

  // And the two long-standing shapes still mean exactly what they did.
  const all = await post({});
  assert.deepEqual(all.calls.map((c) => c.method), ['markNotificationsRead']);
  const ids = await post({ ids: ['a', 'b'] });
  assert.deepEqual(ids.calls[0].args[0], ['a', 'b']);
});

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

const { preflight } = await import('../server/runner/runner.ts');

test('an untrusted workspace no longer blocks a run', async () => {
  // This used to refuse, on the grounds that Claude Code ignores a repository's
  // own permissions and hooks until its trust prompt is accepted. Measured
  // against CLI v2.1.220 in a directory with no trust record at all: a repo
  // PreToolUse hook fired, and a repo `permissions.deny` rule blocked the
  // command. The premise had stopped being true, and the refusal was blocking
  // runs in every repo the operator had not opened interactively.
  const dir = mkdtempSync(join(tmpdir(), 'pc-trust-'));
  const config = join(dir, 'claude.json');
  writeFileSync(config, JSON.stringify({ projects: { '/repo': { hasTrustDialogAccepted: false } } }));
  assert.equal(preflight('/repo', config), null);
  assert.equal(preflight('/somewhere-else', config), null);
  assert.equal(preflight('/repo', join(dir, 'missing.json')), null);
  rmSync(dir, { recursive: true, force: true });

  // And end to end: a run in such a workspace actually runs.
  const r = repo();
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();
  assert.deepEqual(seen, [1], 'the phase ran rather than parking on a stale premise');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * The admission endpoints
 * ------------------------------------------------------------------ */

test('the queue is readable without a flag, and says what each entry is waiting on', async () => {
  const snapshot = {
    max: 3,
    live: 1,
    queued: 1,
    throttledUntil: null,
    grants: [{ id: 'g1', slug: 'alpha', phase: 1, runId: 'r1', scope: ['api'], at: 0 }],
    entries: [{
      id: 'e1', slug: 'beta', phase: 2, runId: 'r2', scope: ['api'], since: 0,
      bypassed: 0, reserving: false,
      waitingOn: [{
        kind: 'grant', slug: 'alpha', phase: 1, owner: 'autopilot/r1',
        scope: ['api'], overlaps: ['api'],
      }],
    }],
  };
  // No `--allow-run`, no console header: reading the queue changes nothing, and
  // a queue only the console can see is one nobody checks from a phone.
  const { status, payload } = await call('/api/queue', {
    overrides: { queueSnapshot: () => snapshot },
  });
  assert.equal(status, 200);
  const body = payload as typeof snapshot;
  assert.equal(body.max, 3);
  assert.equal(body.queued, 1);
  // The part that matters: "queued" alone is the same non-answer `pausing`
  // used to be — it names something that is not happening without naming what
  // would have to change for it to happen.
  assert.equal(body.entries[0].waitingOn[0].owner, 'autopilot/r1');
  assert.deepEqual(body.entries[0].waitingOn[0].overlaps, ['api']);
});

test("a plan's phase scopes are readable, with what each one would collide with", async () => {
  const scopes = [
    { phase: 1, scope: ['api'], conflicts: ['beta phase 3 (running)'] },
    { phase: 2, scope: ['docs'], conflicts: [] },
  ];
  const { status, payload } = await call('/api/run/demo/scopes', {
    overrides: { phaseScopes: (slug: string) => (slug === 'demo' ? scopes : []) },
  });
  assert.equal(status, 200);
  assert.deepEqual((payload as { scopes: unknown }).scopes, scopes);
});
