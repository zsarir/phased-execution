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
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { extractCommands, verifyPhase } = await import('../server/runner/verify.ts');
const { buildArgv, sanitize, lineReader, userMessage } = await import('../server/runner/spawn.ts');
const { nextModel, fallbackChain } = await import('../server/runner/errors.ts');
const { listRuns, loadRun, newRun, saveRun, journalFile, phaseRecord } = await import('../server/runner/state.ts');
const { Journal } = await import('../server/runner/journal.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
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
  setStuck: (phase: number) => void;
  /** A handoff exists for the phase and reads in-progress (the board lists it so). */
  setInProgress: (phase: number) => void;
  /** Every not-done phase is ready at once — a graph with no edges. */
  setParallel: (yes: boolean) => void;
  setLockRefused: (yes: boolean) => void;
  /** The same, for ONE phase — the others read free. */
  setLockRefusedFor: (phase: number, yes: boolean) => void;
  setLockLapsed: (yes: boolean) => void;
  /** Make `claim` refuse as a foreign takeover — the keepalive's lock-lost case. */
  setClaimRefuse: (yes: boolean) => void;
  setLintFail: (yes: boolean) => void;
  /** Make the board read slow, so a control can be pressed while it is in flight. */
  setSlowBoard: (yes: boolean) => void;
  /** Same, for the gate subprocess — the first await of boarding a phase. */
  setSlowGate: (yes: boolean) => void;
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
    d=""; r=""; w=""; s=""; i=""; found=0
    for p in ${PHASES.join(' ')}; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif grep -qx "$p" "$S/stuck" 2>/dev/null; then s="$s$p,"
      elif grep -qx "$p" "$S/inprog" 2>/dev/null; then i="$i$p,"; found=1
      elif [ "$found" -eq 0 ] || [ -f "$S/parallel" ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: \${i%,}"; echo "stuck: \${s%,}"
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status)
    # Stretched on demand, like the board: the gate is the FIRST subprocess of
    # boarding, and the pause-during-boarding tests need a window to press in.
    [ -f "$S/slow-gate" ] && sleep 1
    # Echoes whether the caller opted into cmd-gate execution — pins that the
    # runner really passes PHASE_EXEC_GATES=1 (it claimed to for months and did not).
    [ -f "$S/gate-echo-env" ] && { echo "manual: exec=\${PHASE_EXEC_GATES:-0}"; exit 1; }
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
if [ "\${2:-}" = "claim" ] && [ -f "$S/claim-refuse" ]; then
  echo "phase \${3:-?} is being worked by someone/else"; exit 1
fi
if [ "\${2:-}" = "status" ]; then
  # The real script prints the holder for a LAPSED claim too, and appends the
  # marker. Both halves are the fake's job, because reading only the first is
  # the bug the runner had.
  if [ -f "$S/lock-lapsed" ]; then echo "phase \${3:-?}: held by someone/else since now, lease until then (EXPIRED — free to take over)"
  elif [ -f "$S/lock-refused" ]; then echo "phase \${3:-?}: held by someone/else since now, lease until later"
  elif [ -f "$S/lock-refused-\${3:-}" ]; then echo "phase \${3:-?}: held by someone/else since now, lease until later"
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
    setStuck: (phase) => writeFileSync(join(state, 'stuck'), `${phase}\n`),
    setInProgress: (phase) => writeFileSync(join(state, 'inprog'), `${phase}\n`),
    setParallel: (yes) => yes ? writeFileSync(join(state, 'parallel'), '') : rmSync(join(state, 'parallel'), { force: true }),
    setLockRefused: (yes) => yes ? writeFileSync(join(state, 'lock-refused'), '') : rmSync(join(state, 'lock-refused'), { force: true }),
    setLockRefusedFor: (phase, yes) => yes
      ? writeFileSync(join(state, `lock-refused-${phase}`), '')
      : rmSync(join(state, `lock-refused-${phase}`), { force: true }),
    setLockLapsed: (yes) => yes ? writeFileSync(join(state, 'lock-lapsed'), '') : rmSync(join(state, 'lock-lapsed'), { force: true }),
    setClaimRefuse: (yes) => yes ? writeFileSync(join(state, 'claim-refuse'), '') : rmSync(join(state, 'claim-refuse'), { force: true }),
    setLintFail: (yes) => yes ? writeFileSync(join(state, 'lint-fail'), '') : rmSync(join(state, 'lint-fail'), { force: true }),
    setSlowBoard: (yes) => yes ? writeFileSync(join(state, 'slow-board'), '') : rmSync(join(state, 'slow-board'), { force: true }),
    setSlowGate: (yes) => yes ? writeFileSync(join(state, 'slow-gate'), '') : rmSync(join(state, 'slow-gate'), { force: true }),
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
  extra: Partial<ConstructorParameters<typeof Runner>[0]> = {},
) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => verification,
    phaseDefaults,
    onEvent: (event, data) => events.push({ event, data }),
    ...extra,
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

test('a closed human gate holds that phase as gated and stops rather than forcing it', async () => {
  const r = repo();
  r.setGate(1, 'manual: the operator must approve the deploy');
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'gated');
  assert.equal(state.status, 'parked', 'nothing else is ready, so the run parks');
  assert.match(state.phases['1'].note!, /the operator must approve/);
  assert.equal(r.doneList().length, 0);
  r.cleanup();
});

test('an ai-clearable gate does not park — the session is booted to clear it', async () => {
  const r = repo();
  r.setGate(1, 'ai: verify staging deploy and smoke tests');
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'done',
    "the unclear ai gate is the session's first task, not a wall");
  assert.equal(state.phases['1'].gate?.kind, 'ai');
  assert.ok(r.doneList().includes(1));
  r.cleanup();
});

test('the runner opts into cmd-gate execution (PHASE_EXEC_GATES=1)', async () => {
  const r = repo();
  writeFileSync(join(r.state, 'gate-echo-env'), '');
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'gated');
  assert.match(state.phases['1'].note ?? '', /exec=1/,
    'the gate evaluation must see the opt-in the engine documents');
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

test('a LAPSED claim does not park the phase — it just runs', async () => {
  // `phase-lock.sh status` prints `held by X` for an expired claim too and
  // appends `(EXPIRED — free to take over)`. The runner used to read only the
  // first half, so a session that died without releasing parked its phase for
  // the whole lease — and then forever after, since nothing renews a dead
  // claim. A lease running out is exactly the event that means "go".
  const r = repo();
  r.setLockLapsed(true);
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.notEqual(instance.current()!.phases['1'].status, 'parked');
  assert.ok(r.doneList().length > 0, 'the phase actually ran');
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

/* ---------------- accounts at the usage wall ---------------- */

const PLAN_LIMIT_TEXT = "You've hit your session limit · resets 3:45pm";

test('policy `switch`: a plan limit moves to the other account and continues WITHOUT sleeping', async () => {
  const r = repo();
  const spawns: { env?: NodeJS.ProcessEnv; resume?: string }[] = [];
  const limited: SpawnFn = async (request) => {
    spawns.push({ env: request.env, resume: request.resume });
    if (spawns.length === 1) {
      // A reset an hour out: the wait path would sleep on it, so the ONLY way
      // this test finishes promptly is the switch path continuing immediately.
      const epoch = Math.floor(Date.now() / 1000) + 3600;
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${epoch}` },
        sessionId: 'sess-lim',
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-lim' });
  };
  const marked: { accountId?: string; window: string }[] = [];
  const { instance } = runner(r, limited, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    pickAccount: () => 'spare',
    portTranscript: () => true,
    onAccountLimited: (accountId, window) => { marked.push({ ...(accountId ? { accountId } : {}), window }); },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });

  const outcome = await Promise.race([
    instance.wait().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
  ]);
  if (outcome === 'slept') await instance.stop();
  assert.equal(outcome, 'finished', 'the switch path must not sit out the old account’s window');

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.equal(state.accountId, 'spare', 'the run now names the account that paid');
  assert.equal(spawns[1].env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok-spare', 'the very next spawn runs as it');
  assert.equal(spawns[1].resume, 'sess-lim', 'the ported transcript is resumed, not restarted');
  assert.deepEqual(marked, [{ window: 'five_hour' }], 'the wall is remembered against the account that hit it');
  r.cleanup();
});

test('policy `switch` without a transcript port starts fresh instead of resuming into nothing', async () => {
  const r = repo();
  const resumes: (string | undefined)[] = [];
  const limited: SpawnFn = async (request) => {
    resumes.push(request.resume);
    if (resumes.length === 1) {
      const epoch = Math.floor(Date.now() / 1000) + 3600;
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${epoch}` },
        sessionId: 'sess-lost',
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, limited, '`true`', undefined, {
    pickAccount: () => 'spare',
    portTranscript: () => false,
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  const outcome = await Promise.race([
    instance.wait().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
  ]);
  if (outcome === 'slept') await instance.stop();
  assert.equal(outcome, 'finished');
  assert.equal(resumes[1], undefined, 'no port means a fresh boot prompt, never --resume into a missing file');
  r.cleanup();
});

test('policy `pause`: a plan limit checkpoints the phase and stops for a person', async () => {
  const r = repo();
  let calls = 0;
  const limited: SpawnFn = async () => {
    calls++;
    return ok({
      signal: { subtype: 'error_during_execution', code: 1, text: PLAN_LIMIT_TEXT },
      sessionId: 'sess-paused',
    });
  };
  const { instance } = runner(r, limited, '`true`', undefined, {
    pickAccount: () => 'spare',   // available, and deliberately not taken
    // Pinned before 3:45pm: against the real clock this test flipped at
    // 3:45pm local, when "resets 3:45pm" starts meaning TOMORROW — more than
    // 12h away, which classify() parks for a person instead of pausing.
    now: () => new Date('2026-01-01T13:00:00'),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'pause' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(calls, 1, 'nothing is retried past the wall');
  assert.equal(state.status, 'paused');
  assert.ok(state.waitUntil, 'the reset time stays visible for the banner and the re-arm');
  assert.match(state.finishedReason ?? '', /usage limit/i);
  const record = state.phases['1'];
  assert.equal(record.status, 'pending');
  assert.equal(record.resumeSessionId, 'sess-paused', 'Continue resumes the checkpointed session');
  r.cleanup();
});

test('the run’s account env reaches every spawn', async () => {
  const r = repo();
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const watching: SpawnFn = async (request) => {
    envs.push(request.env);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, watching, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'work'
      ? { CLAUDE_CONFIG_DIR: '/tmp/work-profile' } : null),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  await instance.wait();

  assert.ok(envs.length >= 1);
  for (const env of envs) {
    assert.equal(env?.CLAUDE_CONFIG_DIR, '/tmp/work-profile');
    assert.ok(env?.PE_OWNER, 'the run-specific facts still ride on top');
  }
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
    verificationPreflight: async () => ['phase 3 has no §Verification — it will park at boarding'],
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
  const { status, payload, started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true,
    headers: { 'x-phase-console': '1', origin: 'http://127.0.0.1:4123' },
    body: { model: 'sonnet', effort: 'high', autonomy: 'keep-going', phaseBudgetUsd: 4 },
  });
  assert.equal(status, 200);
  // The start response carries the verification advisory so the operator hears
  // about a would-park phase at Start, not at boarding.
  assert.match(((payload as { preflight?: string[] }).preflight ?? []).join('\n'), /park at boarding/);
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

/* ------------------------------------------------------------------ *
 * The stop's paperwork: `resolved` / `reopenedAt` across lives of a run
 * ------------------------------------------------------------------ */

test('continuing a resolved run clears the resolution, so a second halt raises a card', async () => {
  const r = repo();
  // First life: the session claims success and writes nothing — halt #1.
  const liar: SpawnFn = async () => ok({ resultText: 'Phase complete!' });
  const first = runner(r, liar);
  await first.instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await first.instance.wait();
  const stopped = first.instance.current()!;
  assert.equal(stopped.status, 'halted');

  // The stop gets annotated — as the board resolver or an operator would —
  // and the phase is reset the way Retry resets it.
  const edited = loadRun(r.root, 'demo', stopped.id, null)!;
  edited.resolved = { at: new Date().toISOString(), auto: true, reason: 'superseded — test annotation' };
  edited.phases['1'].status = 'pending';
  edited.phases['1'].note = undefined;
  saveRun(edited);

  // Second life: Continue. The session still writes nothing — halt #2 must
  // surface, which it cannot if the first stop's annotation survived.
  const second = runner(r, liar);
  await second.instance.start({ slug: 'demo', root: r.root, resumeRunId: stopped.id, autonomy: 'keep-going' });
  await second.instance.wait();

  const state = second.instance.current()!;
  assert.equal(state.status, 'halted');
  assert.equal(state.resolved, null, 'the old annotation cannot dismiss the new stop');
  assert.equal(state.reopenedAt, null, 'the old veto was about a stop that no longer exists');
  r.cleanup();
});

test("a new halt clears a stale resolution but keeps a person's reopen-veto", async () => {
  const r = repo();
  // The annotation appears while the run is live — the one path `start` and
  // `recover` cannot have cleaned up — and then the halt fires.
  let handle: InstanceType<typeof Runner> | null = null;
  const spy: SpawnFn = async () => {
    const state = handle!.current()!;
    state.resolved = { at: new Date().toISOString(), auto: true, reason: 'stale annotation from an earlier stop' };
    state.reopenedAt = '2026-08-04T00:00:00.000Z';
    return ok({ resultText: 'wrote nothing' });
  };
  const { instance } = runner(r, spy);
  handle = instance;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.equal(state.resolved, null, 'a new halt is a new fact — the stale annotation goes');
  assert.equal(state.reopenedAt, '2026-08-04T00:00:00.000Z',
    "a person's veto on auto-resolution is never re-inferred away");
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Boarding is not starting: the pause window and the pointer
 * ------------------------------------------------------------------ */

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a pause armed while the gate is checked starts nothing and queues nothing', async () => {
  const r = repo();
  r.setSlowGate(true);
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await sleepMs(300); // inside the 1s gate subprocess for phase 1
  assert.equal(instance.pause('test'), true);
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'paused');
  assert.deepEqual(seen, [], 'no session spawned');
  const journal = events.filter((e) => e.event === 'run:journal')
    .map((e) => e.data as { event: string; data?: { reason?: string } });
  assert.ok(journal.some((j) => j.event === 'phase.not-started' && /gate was checked/.test(j.data?.reason ?? '')),
    'the abandonment wrote itself down');
  assert.ok(!journal.some((j) => j.event === 'phase.queued'), 'the phase never visibly queued');
  assert.ok(!journal.some((j) => j.event === 'phase.start'), 'the phase never started');
  r.cleanup();
});

test('the run does not claim a phase until it genuinely starts', async () => {
  const r = repo();
  r.setSlowGate(true);
  const during: (number | null | undefined)[] = [];
  let instance!: InstanceType<typeof Runner>;
  const spawn: SpawnFn = async () => {
    during.push(instance.current()!.activePhase); // sampled at spawn time
    r.markDone(1);
    return ok();
  };
  const made = runner(r, spawn);
  instance = made.instance;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await sleepMs(300); // mid-gate: boarding, not started
  const midBoarding = instance.current()!.activePhase;
  await instance.wait();

  assert.equal(midBoarding, null, 'boarding must not move the pointer');
  assert.deepEqual(during, [1], 'the pointer lands exactly at spawn');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Retry acts: a stopped run's Retry resets the phase AND continues the run
 * ------------------------------------------------------------------ */

test('retry on a stopped run resets the phase and starts the run again', async () => {
  const r = repo();
  const { Service } = await import('../server/service.ts');
  const { phaseRecord: recordOf } = await import('../server/runner/state.ts');
  const service = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: r.scripts, logFile: null,
  } as never);
  try {
    assert.equal(service.open(r.root).ok, true);

    // A halted, SCOPED run with a failed phase and a sticky skills list — the
    // two fields a careless resume silently loses.
    const stopped = newRun({ slug: 'demo', root: r.root, model: 'opus', onlyPhases: [1], skills: ['alpha-skill'] });
    stopped.status = 'halted';
    stopped.halt = { at: new Date().toISOString(), reason: 'phase 1 did not verify: stub', phase: 1 };
    stopped.consecutiveFailures = 1;
    const record = recordOf(stopped, 1);
    record.status = 'failed';
    record.note = 'stub failure';
    record.endedAt = new Date().toISOString();
    saveRun(stopped);

    const calls: { slug: string; options: Record<string, unknown> }[] = [];
    (service as unknown as { startRun: unknown }).startRun =
      async (slug: string, options: Record<string, unknown>) => { calls.push({ slug, options }); return null; };

    await service.retryPhase('demo', 1);

    assert.equal(calls.length, 1, 'retry on a dead run STARTS the run — resetting the record alone was the old lie');
    assert.equal(calls[0].options.resumeRunId, stopped.id);
    assert.deepEqual(calls[0].options.onlyPhases, [1], 'a scoped run keeps its scope across the retry');
    assert.deepEqual(calls[0].options.skills, ['alpha-skill'], 'the sticky skills survive; machine defaults must not replace them');

    const onDisk = loadRun(r.root, 'demo', stopped.id, null)!;
    assert.equal(onDisk.phases['1'].status, 'pending');
    assert.equal(onDisk.halt, null);
    assert.equal(onDisk.consecutiveFailures, 0);
  } finally {
    service.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Verification preflight: read the plan before paying for a session
 * ------------------------------------------------------------------ */

test('a verification with nothing runnable parks the phase BEFORE a session is spent', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen),
    'targeted pytest + full safe set; both green.');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  const state = instance.current()!;
  assert.deepEqual(seen, [], 'no session was spawned for a phase that could never verify');
  assert.equal(state.phases['1'].status, 'parked');
  assert.match(state.phases['1'].note ?? '', /nothing the runner can execute/);
  assert.match(state.phases['1'].note ?? '', /then Retry/);
  const journal = events.filter((e) => e.event === 'run:journal')
    .map((e) => e.data as { event: string });
  assert.ok(journal.some((j) => j.event === 'phase.verify-preflight-parked'));
  r.cleanup();
});

test('a plan with no verification at all parks the same way, saying so', async () => {
  const r = repo();
  const seen: number[] = [];
  // '' rather than undefined: the helper's parameter default would silently
  // substitute '`true`' for undefined — the exact defaulted-parameter trap
  // this repo's own history warns about.
  const { instance } = runner(r, workingSession(r, seen), '');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, [], 'no session for a phase nothing would prove');
  assert.match(instance.current()!.phases['1'].note ?? '', /states no verification/);
  r.cleanup();
});

test('a declared-but-unreadable verification blames the shape, not the plan', async () => {
  const r = repo();
  const seen: number[] = [];
  // The parser handed over '' but the raw block DOES declare the bullet — the
  // real ai-builder shape. "The plan states no verification" here once sent an
  // operator hunting a bug in a plan that had none.
  const { instance } = runner(r, workingSession(r, seen), '', undefined, {
    verificationDeclared: () => true,
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, []);
  const note = instance.current()!.phases['1'].note ?? '';
  assert.match(note, /exists in the plan but the console could not read/);
  assert.match(note, /plan-format\.md/);
  assert.doesNotMatch(note, /states no verification/,
    'the omission message is reserved for plans that actually omit it');
  r.cleanup();
});

test('preflight warnings are journalled without blocking the phase', async () => {
  const r = repo();
  const seen: number[] = [];
  // One runnable command, one continuation fragment: the fragment becomes a
  // person-check later, and the preflight says so up front — but the phase runs.
  const { instance, events } = runner(r, workingSession(r, seen),
    '`true` plus the safe set `… -m "not slow" -q`');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, [1], 'a warning must not cost the phase');
  assert.equal(instance.current()!.phases['1'].status, 'done');
  const preflights = events.filter((e) => e.event === 'run:journal')
    .map((e) => e.data as { event: string; data?: { warnings?: string[] } })
    .filter((j) => j.event === 'phase.verify-preflight');
  assert.equal(preflights.length, 1);
  assert.match(preflights[0].data?.warnings?.join('\n') ?? '', /a person will be asked/);
  // On the record too — the journal is rendered by nothing, and the operator's
  // first sight of these used to be the verification failing after the spend.
  assert.match(instance.current()!.phases['1'].preflight?.join('\n') ?? '', /a person will be asked/);
  r.cleanup();
});

test('an all-verification park halts with a machine-readable kind and an anchor phase', async () => {
  const r = repo();
  const seen: number[] = [];
  // Unscoped: phase 1 parks at preflight, later phases stay waiting, so the
  // loop runs out of candidates with work outstanding — the real run's shape.
  const { instance } = runner(r, workingSession(r, seen), '');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.equal(state.halt?.kind, 'verification-preflight',
    'auto-recovery keys on this — a kindless halt is invisible to it');
  assert.equal(state.halt?.phase, 1, 'recovery needs a phase to anchor on');
  assert.match(state.halt?.reason ?? '', /unrunnable §Verification takes a plan edit or Repair with AI/);
  assert.doesNotMatch(state.halt?.reason ?? '', /Gates need your confirmation/,
    'no gate exists here — the old fixed tail advertised one anyway');
  assert.doesNotMatch(state.halt?.reason ?? '', /blocked handoff/,
    'no handoff is blocked either');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * A parked run explains itself: every blocker in its own words
 * ------------------------------------------------------------------ */

test('a parked run names a gated phase with the gate note, and says what to do', async () => {
  const r = repo();
  r.setGate(1, 'manual: confirm the rollout window');
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.match(state.halt?.reason ?? '', /phase 1 is gated \(gate not clear/,
    'the gate itself is quoted, not summarised into "waiting on a gate"');
  assert.match(state.halt?.reason ?? '', /Gates need your confirmation/);
  assert.doesNotMatch(state.halt?.reason ?? '', /Repair with AI/,
    'no blocked handoff and no verification park — the tail names only doors that exist');
  assert.equal(state.halt?.kind, undefined, 'a gate needs a person, never auto-recovery');
  r.cleanup();
});

test('a stuck phase is named as blocked-by-its-handoff, never "waiting on a gate"', async () => {
  const r = repo();
  r.setStuck(1);
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.match(state.halt?.reason ?? '', /phase 1's handoff is marked blocked/);
  assert.match(state.halt?.reason ?? '', /Repair with AI/);
  assert.doesNotMatch(state.halt?.reason ?? '', /Gates need your confirmation/,
    'nothing here is gated — the tail names only doors that exist');
  assert.equal(state.halt?.kind, undefined, 'a blocked handoff is not the verification kind');
  r.cleanup();
});

/* ---------------- per-lane stop, the streak, and the account preflight ---------------- */

test('continuing a run resets the failure streak, and says so in the journal', async () => {
  const r = repo();
  const held = heldSession(r);
  const { instance } = runner(r, held.spawn);
  const stored = newRun({ slug: 'demo', root: r.root });
  stored.status = 'halted';
  stored.consecutiveFailures = 2;
  stored.halt = { at: new Date().toISOString(), reason: 'two failed in a row' };
  saveRun(stored);

  await instance.start({ slug: 'demo', root: r.root, resumeRunId: stored.id, autonomy: 'keep-going' });
  await held.inSession;
  // Asserted while a phase is STILL in flight: a success would reset the
  // streak anyway, and this test is about the press of Continue, not the win.
  assert.equal(instance.current()!.consecutiveFailures, 0,
    'the operator pressing Continue restores the failure budget');
  held.release();
  await instance.wait();

  const journal = readFileSync(journalFile(r.root, 'demo', stored.id), 'utf8');
  assert.match(journal, /run\.failure-streak-reset/);
  assert.match(journal, /"was":2/, 'the audit trail keeps what the counter loses');
  r.cleanup();
});

test('a frozen lane can be stopped: woken first, credited, session id kept, streak untouched', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; }, false);
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.freeze('test', 1), true);
  assert.equal(procState(pid), 'T');

  assert.deepEqual(instance.stopPhase(1, 'tester'), { ok: true });
  // SIGCONT before SIGTERM — a stopped process never sees a bare SIGTERM. The
  // sleeper dying of it is the observable proof the wake-up happened.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.notEqual(procState(pid), 'T', 'never left stopped behind a stop');

  held.release();
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'interrupted');
  assert.match(state.phases['1'].note ?? '', /stopped by tester/);
  assert.equal(state.phases['1'].resumeSessionId, 'session-to-resume-0001',
    'Retry can resume rather than restart');
  assert.equal(state.consecutiveFailures, 0, 'an operator stop is neither a failure nor a win');
  assert.equal(state.freeze, null);
  r.cleanup();
});

test('a per-phase stop carries phase and by through the service, and a refusal answers 409', async () => {
  const { status, calls } = await call('/api/run/demo/stop', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' }, body: { phase: 9, by: 'tester' },
  });
  assert.equal(status, 200);
  assert.deepEqual(calls, [{ method: 'stopRun', args: ['demo', 9, 'tester'] }]);

  const refused = await callWith(
    { stopRun: async () => { throw new Error('phase 9 is not one of the ones running — phases 1, 2 are'); } },
    '/api/run/demo/stop', { phase: 9 },
  );
  assert.equal(refused.status, 409);
  assert.match(String((refused.payload as { error: string }).error), /phase 9/);
});

test('a per-model limit files its wall against the account, and the run continues on the next model', async () => {
  const r = repo();
  const marked: { window: string; accountId?: string }[] = [];
  let spawns = 0;
  const limited: SpawnFn = async (request) => {
    spawns++;
    if (spawns === 1) {
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: "You've hit your Opus limit · resets 3:45pm" },
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, limited, '`true`', undefined, {
    // Pinned before 3:45pm for the same reason the pause-policy test pins it.
    now: () => new Date('2026-01-01T13:00:00'),
    onAccountLimited: (accountId, window) => { marked.push({ ...(accountId ? { accountId } : {}), window }); },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', model: 'opus' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.deepEqual(marked, [{ window: 'seven_day_opus' }],
    'a model wall files under its per-model bucket, never the shared weekly');
  assert.equal(state.phases['1'].model, 'sonnet', 'and the phase moved down the ladder');
  r.cleanup();
});

test('the preflight probes the RUN’s account, and a refusal parks before any spawn', async () => {
  const r = repo();
  const probed: (string | undefined)[] = [];
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen), '`true`', undefined, {
    accountEnv: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
    checkAuth: async (accountId) => { probed.push(accountId); return { loggedIn: true, checkedAt: '' }; },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  await instance.wait();
  assert.deepEqual(probed, ['work'], 'the probe asks about the account that will pay');
  assert.ok(seen.length > 0, 'a healthy probe lets the run proceed');
  r.cleanup();

  const r2 = repo();
  const seen2: number[] = [];
  const second = runner(r2, workingSession(r2, seen2), '`true`', undefined, {
    checkAuth: async () => ({
      loggedIn: false, checkedAt: '',
      detail: 'the run is set to pay as work and that login is expired',
    }),
  });
  const parked = await second.instance.start({
    slug: 'demo', root: r2.root, autonomy: 'keep-going', accountId: 'work',
  });
  assert.equal(parked.status, 'parked');
  assert.match(parked.halt?.reason ?? '', /pay as work/,
    'the refusal names the account, not the workspace');
  assert.equal(seen2.length, 0, 'nothing spawned behind the refusal');
  r2.cleanup();
});

/* ------------------------------------------------------------------ *
 * The outcome protocol: declared waits, parks, and session-API resumes
 *
 * The incident these replay: delivery-overhaul phase 8. A session did 47
 * minutes of real work, ended its turn "waiting on the image build (34–65
 * min)" in free prose, and the runner — with no vocabulary for that — read
 * the clean exit as completion, found no handoff, nudged once (answered in
 * the same holding pattern), and halted the run. The outcome file is the
 * vocabulary; these pin what the runner does with it.
 * ------------------------------------------------------------------ */

function fileOutcome(request: SpawnRequest, body: Record<string, unknown>): void {
  const path = request.env?.PE_OUTCOME_FILE;
  assert.ok(typeof path === 'string' && path, 'the runner must inject PE_OUTCOME_FILE');
  writeFileSync(path as string, JSON.stringify({
    version: 1, slug: 'demo', written_at: new Date().toISOString(), watch: [], ...body,
  }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a declared waiting-external parks the phase — no halt, no closeout nudge — and the resume continues the SAME session', async () => {
  const r = repo();
  try {
    const resumes: (string | undefined)[] = [];
    let calls = 0;
    const spawn: SpawnFn = async (request) => {
      calls++;
      if (calls === 1) {
        fileOutcome(request, {
          phase: 1, status: 'waiting-external',
          reason: 'image build 6a94a514',
          // Comfortably past the loop's own tick latency under full-suite
          // load: a window that lapses before the next board read makes the
          // loop resume IN-RUN (correct, but a different script than this
          // test narrates — the two-act version needs the run to park).
          resume_after: new Date(Date.now() + 2_000).toISOString(),
          watch: ['gh:hub#run/1234'],
        });
        return ok({ resultText: 'holding pattern' });
      }
      resumes.push(request.resume);
      assert.match(request.prompt, /wait window you declared/, 'a resume gets the elapsed-window prompt, not a fresh boot');
      r.markDone(1);
      return ok({ sessionId: 'sess-0001' });
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, { waitFloorMs: 20 });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    let state = instance.current()!;
    assert.equal(state.status, 'waiting', 'the run waits with the phase — it is not halted');
    assert.equal(state.halt, null);
    assert.equal(state.phases['1'].status, 'waiting');
    assert.equal(state.phases['1'].parkReason, 'image build 6a94a514');
    assert.deepEqual(state.phases['1'].watch, ['gh:hub#run/1234']);
    assert.equal(state.phases['1'].waits, 1);
    assert.ok(state.waitUntil, 'the run carries the soonest park clock');
    assert.ok(journalled(events, 'phase.waiting').length, 'the park is journalled');
    assert.equal(journalled(events, 'phase.closeout').length, 0, 'no closeout nudge for a declared wait');

    // The window elapses; the service restarts the run (exactly what the boot
    // re-arm does). The loop routes the expired wait as a resume. Derived
    // from the recorded clock, not a fixed sleep — under full-suite load the
    // park lands later than this test scheduled it.
    await sleep(Math.max(0, Date.parse(state.waitUntil ?? '') - Date.now()) + 40);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, onlyPhases: [1] });
    await instance.wait();

    state = instance.current()!;
    assert.deepEqual(resumes, ['sess-0001'], 'the resume continued the phase\'s own session');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.status, 'finished');
  } finally { r.cleanup(); }
});

test('the wait budget is finite: a phase that keeps re-filing the same wait halts honestly', async () => {
  const r = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      fileOutcome(request, {
        phase: 1, status: 'waiting-external', reason: 'a build that never lands',
        resume_after: new Date(Date.now() + 15).toISOString(),
      });
      return ok();
    };
    const { instance } = runner(r, spawn, undefined, undefined, { waitFloorMs: 10 });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    let state = instance.current()!;
    for (let round = 0; round < 6 && state.status === 'waiting'; round++) {
      await sleep(30);
      await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, onlyPhases: [1] });
      await instance.wait();
      state = instance.current()!;
    }

    assert.equal(state.status, 'halted', 'the fourth re-file spends the budget');
    assert.equal(state.halt?.kind, 'waiting-external-timeout');
    assert.match(state.halt?.reason ?? '', /wait budget is spent/);
    assert.equal(state.phases['1'].status, 'failed');
  } finally { r.cleanup(); }
});

test('a closeout session that files waiting-external parks the phase instead of halting no-handoff', async () => {
  // The exact phase-8 shape: the first session ends without paperwork, the
  // nudge resumes it, and the honest answer is still "the external clock has
  // not landed" — which used to become the halt. Now it becomes the park.
  const r = repo();
  try {
    execFileSync('git', ['init', '-q'], { cwd: r.root });
    writeFileSync(join(r.root, 'half-finished.txt'), 'work in flight\n');
    let closeoutResume: string | undefined;
    let calls = 0;
    const spawn: SpawnFn = async (request) => {
      calls++;
      if (calls === 1) return ok({ resultText: 'ended without paperwork' });
      closeoutResume = request.resume;
      fileOutcome(request, {
        phase: 1, status: 'waiting-external', reason: 'deploys blocked on the image build',
        resume_after: new Date(Date.now() + 60_000).toISOString(),
      });
      return ok({ sessionId: 'sess-0001' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(calls, 2, 'the closeout nudge ran');
    assert.equal(closeoutResume, 'sess-0001', 'the nudge resumed the same session');
    assert.equal(state.halt, null, 'no no-handoff halt');
    assert.equal(state.status, 'waiting');
    assert.equal(state.phases['1'].status, 'waiting');
    assert.ok(journalled(events, 'phase.closeout').length, 'the closeout is on the record');
    assert.ok(journalled(events, 'phase.waiting').length);
  } finally { r.cleanup(); }
});

test('a session with no outcome and no work still halts no-handoff — the legacy pin', async () => {
  const r = repo();
  try {
    const { instance } = runner(r, async () => ok({ resultText: 'Phase complete!' }));
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.status, 'halted');
    assert.equal(state.halt?.kind, 'no-handoff');
    assert.match(state.halt?.reason ?? '', /the board still reads/);
  } finally { r.cleanup(); }
});

test('a stale outcome file from a previous attempt is ignored and the legacy path stands', async () => {
  const r = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      // Written BEFORE the attempt started — a leftover from a crashed try.
      fileOutcome(request, {
        phase: 1, status: 'waiting-external', reason: 'ancient history',
        written_at: '2020-01-01T00:00:00Z',
      });
      return ok({ resultText: 'Phase complete!' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.halt?.kind, 'no-handoff', 'the stale declaration must not park anything');
    assert.equal(journalled(events, 'phase.outcome').length, 0, 'a rejected file is never journalled as an outcome');
    assert.equal(journalled(events, 'phase.waiting').length, 0);
  } finally { r.cleanup(); }
});

test('outcome blocked on a lock re-queues the phase without a halt; needs-human parks the run for a person', async () => {
  const r = repo();
  try {
    let calls = 0;
    const spawn: SpawnFn = async (request) => {
      calls++;
      if (calls === 1) {
        fileOutcome(request, {
          phase: 1, status: 'blocked', reason: 'lock held by mobinzarekar@laptop',
          watch: ['lock:demo/1'],
        });
        return ok();
      }
      r.markDone(1);
      return ok();
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'done', 'the re-queued phase boarded again and finished');
    assert.equal(state.status, 'finished');
    assert.ok(journalled(events, 'phase.outcome-lock-blocked').length);
    assert.equal(journalled(events, 'run.halt').length, 0, 'a refused lock is not a defect');
  } finally { r.cleanup(); }

  const r2 = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      fileOutcome(request, { phase: 1, status: 'needs-human', reason: 'the staging gate needs an operator' });
      return ok();
    };
    const { instance } = runner(r2, spawn);
    await instance.start({ slug: 'demo', root: r2.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.status, 'parked', 'a person is needed — the approvals-park vocabulary');
    assert.match(state.halt?.reason ?? '', /needs a person: the staging gate/);
    assert.equal(state.phases['1'].status, 'parked');
    assert.equal(state.consecutiveFailures, 0, 'nobody being available is not the phase failing');
  } finally { r2.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Board freshness: the reconcile pass and the docs-watcher wake
 * ------------------------------------------------------------------ */

test('a failed record the board has overtaken is closed as "outside this run", never re-run', async () => {
  // The live shape: a run halts with a phase reading `failed`, somebody
  // finishes that phase by hand, the run is continued — and the stale record
  // used to stand forever ("Departed" board chip over a red row) while the
  // loop, with `failed` in SETTLED, wouldn't touch the phase either.
  const r = repo();
  try {
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'halted';
    stale.halt = { at: new Date().toISOString(), reason: 'no handoff', phase: 1, kind: 'no-handoff' };
    phaseRecord(stale, 1).status = 'failed';
    saveRun(stale);
    r.markDone(1); // …then somebody finished phase 1 by hand

    const seen: number[] = [];
    const { instance } = runner(r, workingSession(r, seen));
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', resumeRunId: stale.id });
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(seen, [2, 3], 'no session was spent on the phase somebody already did');
    assert.equal(state.phases['1'].status, 'done');
    assert.match(state.phases['1'].note ?? '', /closed outside this run/);
    assert.equal(state.status, 'finished');
  } finally { r.cleanup(); }
});

test('the docs watcher wakes a mid-flight loop: a newly-ready phase boards before any lane settles', async () => {
  const r = repo();
  try {
    const seen: number[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      seen.push(phase);
      if (phase === 1) {
        await held; // phase 1's session runs "for hours"
        r.markDone(1);
        return ok();
      }
      r.markDone(phase);
      return ok();
    };
    const { instance } = runner(r, spawn, undefined, undefined, { maxParallel: 2 });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', maxParallel: 2 });

    // Wait until phase 1's lane is live, then finish phase 1 OUTSIDE the run
    // (a manual session writing the handoff) and poke, exactly as the
    // service's onChange does.
    for (let i = 0; i < 100 && !seen.includes(1); i++) await sleep(10);
    r.markDone(1);
    instance.noteDocsChanged();

    // Phase 2 must board while lane 1 is still hanging.
    for (let i = 0; i < 200 && !seen.includes(2); i++) await sleep(10);
    assert.ok(seen.includes(2), 'the wake re-read the board mid-lane and admitted phase 2');

    releaseFirst();
    await instance.wait();
    assert.equal(instance.current()!.status, 'finished');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Cross-actor locks: queue-behind, wait cap, and the lease keepalive
 * ------------------------------------------------------------------ */

test('a foreign lock at boarding queues the phase behind the holder, and boards when it frees', async () => {
  const r = repo();
  try {
    r.setLockRefused(true);
    const seen: number[] = [];
    const scheduler = new Scheduler({ locks: () => [] });
    const { instance, events } = runner(r, workingSession(r, seen), undefined, undefined, { scheduler });
    const started = instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });

    // Free the lock after the belt-check has seen it at least once.
    setTimeout(() => r.setLockRefused(false), 1_500);
    await started;
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.deepEqual(seen, [1], 'the phase boarded once the holder released');
    assert.equal(state.phases['1'].status, 'done');
    assert.ok(journalled(events, 'phase.lock-race').length, 'the wait was journalled, not parked');
    assert.equal(journalled(events, 'phase.lock-refused').length, 0, 'the terminal park is gone');
  } finally { r.cleanup(); }
});

test('a lock wait that outlives the cap parks honestly, naming the holder and the wait', async () => {
  const r = repo();
  try {
    r.setLockRefused(true);
    // A run whose record says it has already queued behind this lock for
    // three hours — the cap is two.
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    const record = phaseRecord(stale, 1);
    record.lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(stale);

    const scheduler = new Scheduler({ locks: () => [] });
    const { instance, events } = runner(r, workingSession(r), undefined, undefined, { scheduler });
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'parked');
    assert.match(state.phases['1'].note ?? '', /locked by someone\/else and has waited/);
    assert.ok(journalled(events, 'phase.lock-wait-capped').length);
    // The clock stops with the wait. It used to survive the park — it is only
    // cleared after a SUCCESSFUL claim — so the next Retry measured from the
    // original timestamp, found itself still over the two-hour cap, and parked
    // again without waiting a second. Retry has to mean the wait starts over.
    assert.equal(state.phases['1'].lockWaitSince, undefined);
    // And the halt says so, rather than naming the holder and stopping.
    assert.match(state.halt?.reason ?? '', /waited out another plan's lock takes Retry/);
  } finally { r.cleanup(); }
});

test('the lease keepalive refreshes the lock under the shared owner, and stands down on a foreign takeover', async () => {
  const claims = (r: Repo): string[] => {
    const path = join(r.state, 'locks');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter((line) => /\bclaim\b/.test(line));
  };

  const r = repo();
  try {
    // The session holds its turn until the supervisor's keepalive has fired —
    // exactly the long-phase shape the keepalive exists for.
    const spawn: SpawnFn = async () => {
      for (let i = 0; i < 300 && !claims(r).length; i++) await sleep(10);
      r.markDone(1);
      return ok();
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, { leaseRefreshMs: 40 });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const refreshes = claims(r);
    assert.ok(refreshes.length >= 1, 'the keepalive fired while the session worked');
    assert.match(refreshes[0], /claim 1 --owner autopilot\/\S+ --scope /,
      'the refresh claims under the shared owner WITH the scope');
    assert.ok(journalled(events, 'phase.lock-refreshed').length, 'the refresh is on the record');
  } finally { r.cleanup(); }

  const r2 = repo();
  try {
    r2.setClaimRefuse(true); // every claim answers "held by someone else"
    const spawn: SpawnFn = async () => {
      for (let i = 0; i < 300 && !claims(r2).length; i++) await sleep(10);
      await sleep(120); // long enough for a would-be second fire
      r2.markDone(1);
      return ok();
    };
    const { instance, events } = runner(r2, spawn, undefined, undefined, { leaseRefreshMs: 40 });
    await instance.start({ slug: 'demo', root: r2.root, onlyPhases: [1] });
    await instance.wait();

    assert.equal(journalled(events, 'phase.lock-lost').length, 1,
      'the takeover is journalled once, and the keepalive stands down instead of fighting');
    assert.equal(claims(r2).length, 1, 'no second claim was attempted');
  } finally { r2.cleanup(); }
});

test('sessions carry PE_MCP_SERVERS from the registry — and nothing when no registry is wired', async () => {
  // F15's MCP advisory was silently dead inside every unattended session:
  // sessions run validate.sh themselves, and launchd's env carries no
  // registry. Resolved per spawn; set-but-empty is a real answer.
  const r = repo();
  const envs: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    envs.push(request.env?.PE_MCP_SERVERS);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy, '`true`', undefined, {
    mcpIds: () => ['context7', 'sentry'],
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();
  assert.deepEqual(envs, ['context7 sentry', 'context7 sentry', 'context7 sentry']);
  r.cleanup();

  const bare = repo();
  const bareEnvs: (string | undefined)[] = [];
  const bareSpy: SpawnFn = async (request) => {
    bareEnvs.push(request.env?.PE_MCP_SERVERS);
    bare.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const plain = runner(bare, bareSpy);
  const hadEnv = process.env.PE_MCP_SERVERS;
  delete process.env.PE_MCP_SERVERS;
  try {
    await plain.instance.start({ slug: 'demo', root: bare.root, autonomy: 'keep-going' });
    await plain.instance.wait();
  } finally { if (hadEnv !== undefined) process.env.PE_MCP_SERVERS = hadEnv; }
  assert.deepEqual(bareEnvs, [undefined, undefined, undefined],
    'no registry wired means the advisory stays off — absent, not empty');
  bare.cleanup();
});

/* ------------------------------------------------------------------ *
 * The ladder in the loop: re-board by rung, brief by situation
 *
 * Phase 2 of console-zero-touch-autopilot. `interrupted` and `failed` records
 * stop being terminal: the loop classifies them (runner/situation.ts), climbs
 * one rung (runner/ladder.ts) through its own vehicles, and boards the phase
 * with the brief the rung names — fresh, resume, unblock, continue, closeout.
 * Every case here is one of the measured specimens or an exit criterion.
 * ------------------------------------------------------------------ */

/**
 * A git repository at the root, so the working tree can answer "clean". The
 * stub's own files (scripts, the done list, the plan) are ignored; `keep` names
 * paths that SHOULD show as work.
 */
function gitInit(root: string, keep: string[] = []): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), ['*', ...keep.map((path) => `!${path}`), ''].join('\n'));
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
}

/** A session that works whichever brief boarded it: fresh boot, RESUMING, UNBLOCK. */
function briefedSession(
  r: Repo, log: { phase: number; brief: string; resume?: string; prompt: string }[],
  behave: (phase: number, call: number) => 'done' | 'nothing' = () => 'done',
): SpawnFn {
  let calls = 0;
  return async (request: SpawnRequest) => {
    calls++;
    const m = /(BOOT|RESUMING|UNBLOCK) phase (\d+)/.exec(request.prompt);
    const phase = Number(m?.[2]);
    log.push({ phase, brief: m?.[1] ?? '?', resume: request.resume, prompt: request.prompt });
    if (behave(phase, calls) === 'done') r.markDone(phase);
    return ok({ sessionId: `sess-${phase}` });
  };
}

const journalOrder = (events: { event: string; data: Record<string, unknown> }[], names: string[]): number[] =>
  names.map((name) => events.findIndex((e) => e.event === 'run:journal' && e.data.event === name));

test('ladder: a resumed run whose only open record is interrupted with no work boards that phase fresh — no press', async () => {
  const r = repo();
  try {
    gitInit(r.root);
    // The P12 specimen: a session that died during bootstrap, the console
    // gone with it; `interrupted`, no handoff, a clean tree.
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'parked';
    stale.phases['1'] = {
      phase: 1, status: 'interrupted', attempts: 1, costUsd: 1.44,
      note: 'the console stopped while phase 1 was running (pid 999)',
    };
    saveRun(stale);

    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log));
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going' });
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(log.map((l) => l.phase), [1, 2, 3], 'phase 1 boarded on the first tick, then the rest');
    assert.equal(log[0].brief, 'BOOT', 'fresh = the engine prompt, nothing appended');
    assert.doesNotMatch(log[0].prompt, /RESUMING|What happened on the previous/, 'a never-started phase carries no history');
    assert.equal(log[0].resume, undefined, 'no dead session is resumed');
    assert.equal(state.status, 'finished');
    const situations = journalled(events, 'phase.situation');
    assert.equal(situations[0].situation, 'never-started');
    const rungs = journalled(events, 'phase.rung');
    assert.equal(rungs[0].rung, 'reboard-fresh');
    assert.equal(rungs[0].brief, 'fresh');
    const [sit, rung, start] = journalOrder(events, ['phase.situation', 'phase.rung', 'phase.start']);
    assert.ok(sit >= 0 && sit < rung && rung < start, 'journal: phase.situation → phase.rung → phase.start');
    assert.equal(journalled(events, 'phase.start')[0].brief, 'fresh');
    assert.equal(state.recoveries?.['1']?.rungs?.[0]?.rung, 'reboard-fresh', 'the climb is accounted on the run');
    assert.equal(journalled(events, 'phase.closeout').length, 0, 'nothing was spent finding out');
  } finally { r.cleanup(); }
});

test('ladder: interrupted over a tree git cannot read is work-in-progress — no session, so it boards with the RESUMING brief', async () => {
  const r = repo(); // not a git repository: the tree is unreadable
  try {
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'parked';
    stale.phases['1'] = { phase: 1, status: 'interrupted', attempts: 1, costUsd: 2, note: 'the console stopped' };
    saveRun(stale);

    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log));
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    assert.equal(journalled(events, 'phase.situation')[0].situation, 'work-in-progress');
    const rung = journalled(events, 'phase.rung')[0];
    assert.equal(rung.rung, 'reboard-resume-brief', 'the own session is gone; the next rung is the brief');
    assert.equal(rung.brief, 'resume');
    assert.equal(log[0].brief, 'BOOT', 'the engine prompt still leads');
    assert.match(log[0].prompt, /RESUMING phase 1/);
    assert.match(log[0].prompt, /Handoff: none has been written/);
    assert.match(log[0].prompt, /Working tree:.*could not be read/);
    assert.doesNotMatch(log[0].prompt, /do not start new work/i, 'that sentence belongs to the closeout, never to a resume');
    assert.equal(instance.current()!.status, 'finished');
  } finally { r.cleanup(); }
});

test('ladder: a failed record with an in-progress handoff and a session left boards as `continue` — --resume plus the continue instruction', async () => {
  const r = repo();
  try {
    r.setInProgress(1);
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'halted';
    stale.phases['1'] = { phase: 1, status: 'failed', attempts: 1, costUsd: 40, sessionId: 'sess-old', said: 'handed off in-progress deliberately' };
    saveRun(stale);

    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log));
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    assert.equal(journalled(events, 'phase.situation')[0].situation, 'work-in-progress');
    const rung = journalled(events, 'phase.rung')[0];
    assert.equal(rung.rung, 'resume-own-session');
    assert.equal(rung.brief, 'continue');
    assert.equal(rung.sessionId, 'sess-old');
    assert.equal(log[0].resume, 'sess-old', 'the phase\'s own session is continued');
    assert.equal(log[0].brief, 'RESUMING', 'no engine boot text — the session has it');
    assert.match(log[0].prompt, /a handoff exists for phase 1 and reads "in-progress"/);
    assert.match(log[0].prompt, /handed off in-progress deliberately/, 'the last words ride along');
    assert.doesNotMatch(log[0].prompt, /do not start new work/i);
    assert.equal(journalled(events, 'phase.start')[0].brief, 'continue');
    assert.equal(instance.current()!.status, 'finished');
  } finally { r.cleanup(); }
});

test('ladder: a stuck board with an unknown blocker gets ONE unblock brief; the second time the phase parks with an errand and the run keeps driving', async () => {
  const r = repo();
  try {
    r.setParallel(true);
    r.setStuck(1);
    const outstanding = 'The migration renames a column and the two callers disagree about the new name; nobody decided.';
    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    // Phase 1's unblock session does not unblock; 2 and 3 do their work.
    const spawn = briefedSession(r, log, (phase) => (phase === 1 ? 'nothing' : 'done'));
    const { instance, events } = runner(r, spawn, undefined, undefined, {
      handoffFor: (_slug, phase) => phase === 1 ? { exists: true, status: 'blocked', outstanding } : { exists: false },
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    const state = instance.current()!;
    const unblocks = log.filter((l) => l.phase === 1);
    assert.equal(unblocks.length, 1, 'exactly one unblock session, never a loop');
    assert.equal(unblocks[0].brief, 'BOOT', 'the engine prompt leads, the brief follows');
    assert.match(unblocks[0].prompt, /UNBLOCK phase 1/);
    assert.match(unblocks[0].prompt, /nobody decided/, 'the Outstanding text is in the brief');
    assert.match(unblocks[0].prompt, /needs-human --reason/, 'the errand escape hatch is named');
    assert.doesNotMatch(unblocks[0].prompt, /do not start new work/i);
    const rungs = journalled(events, 'phase.rung').filter((entry) => entry.rung === 'unblock-session');
    assert.equal(rungs.length, 1);
    assert.equal(rungs[0].brief, 'unblock');
    const situations = journalled(events, 'phase.situation').map((entry) => entry.situation);
    assert.ok(situations.every((key) => key === 'blocked-declared:unknown'), `classified as blocked-declared:unknown (${situations.join(', ')})`);
    const errands = journalled(events, 'phase.errand');
    assert.equal(errands.length, 1, 'the second exhaustion writes ONE errand');
    assert.equal(errands[0].situation, 'blocked-declared:unknown');
    assert.equal(state.phases['1'].status, 'parked');
    assert.ok(state.recoveries?.['1']?.errand, 'the errand is on the run, for the one card');
    assert.equal(state.phases['2'].status, 'done');
    assert.equal(state.phases['3'].status, 'done');
    assert.equal(journalled(events, 'run.halt').filter((h) => h.kind === 'phase-blocked').length, 0, 'no immediate phase-blocked halt');
    assert.equal(state.consecutiveFailures, 0, 'a phase parked for a person did not fail twice');
    assert.match(state.halt?.reason ?? '', /phase 1 needs you/);
  } finally { r.cleanup(); }
});

test('ladder: a credential blocker parks with an errand at once — no session spent; a lock blocker goes back to the queue', async () => {
  const r = repo();
  try {
    r.setParallel(true);
    r.setStuck(1);
    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log), undefined, undefined, {
      handoffFor: (_slug, phase) => phase === 1
        ? { exists: true, status: 'blocked', outstanding: 'Needs a credential nobody on this machine holds: the registry token for the CI mirror.' }
        : { exists: false },
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(log.filter((l) => l.phase === 1).length, 0, 'no session was spent on a blocker only a person can settle');
    assert.equal(journalled(events, 'phase.situation')[0].situation, 'blocked-declared:credential');
    assert.equal(journalled(events, 'phase.errand')[0].situation, 'blocked-declared:credential');
    assert.equal(state.phases['1'].status, 'parked');
    assert.equal(state.phases['2'].status, 'done');
  } finally { r.cleanup(); }

  const r2 = repo();
  try {
    r2.setStuck(1);
    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    // The unblock session for a LOCK blocker is the queue: the phase re-boards
    // and admission waits on the holder. Here the lock is free, so it boards.
    const { instance, events } = runner(r2, briefedSession(r2, log), undefined, undefined, {
      handoffFor: (_slug, phase) => phase === 1
        ? { exists: true, status: 'blocked', outstanding: 'Phase lock held by mobin@laptop — the tree is theirs until they release it.' }
        : { exists: false },
    });
    await instance.start({ slug: 'demo', root: r2.root, onlyPhases: [1], autoRecover: true });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(journalled(events, 'phase.situation')[0].situation, 'blocked-declared:lock');
    assert.equal(journalled(events, 'phase.rung')[0].rung, 'queue');
    assert.equal(journalled(events, 'phase.errand').length, 0, 'a lock is not a person\'s errand');
    assert.equal(log.filter((l) => l.phase === 1).length, 1, 'it boarded once the lock was free');
    assert.equal(state.phases['1'].status, 'done');
  } finally { r2.cleanup(); }
});

test('ladder: a `partial` outcome is work-in-progress at once — the phase re-boards as `continue` of its own session', async () => {
  const r = repo();
  try {
    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    let calls = 0;
    const spawn: SpawnFn = async (request) => {
      calls++;
      const m = /(BOOT|RESUMING) phase (\d+)/.exec(request.prompt);
      log.push({ phase: Number(m?.[2]), brief: m?.[1] ?? '?', resume: request.resume, prompt: request.prompt });
      if (calls === 1) {
        // "I did real work and my budget is nearly spent — resume me."
        fileOutcome(request, { phase: 1, status: 'partial', reason: 'budget' });
        return ok({ sessionId: 'sess-p', resultText: 'handing off in-progress, resume me' });
      }
      r.markDone(1);
      return ok({ sessionId: 'sess-p' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autoRecover: true });
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(journalled(events, 'phase.outcome').map((o) => o.status), ['partial']);
    assert.deepEqual(journalled(events, 'phase.outcome-partial'), [{ reason: 'budget', climbed: true }]);
    assert.equal(journalled(events, 'phase.situation')[0].situation, 'work-in-progress');
    const rung = journalled(events, 'phase.rung')[0];
    assert.equal(rung.rung, 'resume-own-session');
    assert.equal(rung.brief, 'continue');
    assert.equal(log.length, 2);
    assert.equal(log[1].resume, 'sess-p', 'the same session continues');
    assert.match(log[1].prompt, /RESUMING phase 1/);
    assert.equal(journalled(events, 'phase.closeout').length, 0, 'no closeout nudge for a declared partial');
    assert.equal(journalled(events, 'run.halt').length, 0);
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.status, 'finished');
  } finally { r.cleanup(); }
});

test('ladder: start({reboard}) boards the named brief and journals the request', async () => {
  const r = repo();
  try {
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'halted';
    stale.phases['1'] = { phase: 1, status: 'failed', attempts: 2, costUsd: 3, sessionId: 'sess-r' };
    saveRun(stale);

    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log));
    await instance.start({
      slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1],
      reboard: [{ phase: 1, situation: 'work-in-progress', rung: 'resume-own-session', sessionId: 'sess-r', by: 'converge' }],
    });
    await instance.wait();

    const asked = journalled(events, 'phase.reboard-requested')[0];
    assert.equal(asked.brief, 'continue', 'the default brief for the rung, given a session');
    assert.equal(asked.by, 'converge');
    assert.equal(log[0].resume, 'sess-r');
    assert.match(log[0].prompt, /RESUMING phase 1/);
    assert.equal(journalled(events, 'phase.rung').length, 0, 'the caller accounts the rung; the runner only boards');
    assert.equal(instance.current()!.phases['1'].status, 'done');
  } finally { r.cleanup(); }
});

/* ---------------- the defect list ---------------- */

test('defects: an expired wait on a stuck board is no livelock — the run does not re-enter waiting on a past clock, the phase resumes', async () => {
  const r = repo();
  try {
    r.setStuck(1);
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    stale.phases['1'] = {
      phase: 1, status: 'waiting', attempts: 1, costUsd: 1, sessionId: 'sess-w',
      parkedUntil: new Date(Date.now() - 60_000).toISOString(), parkReason: 'the image build', waits: 1,
    };
    saveRun(stale);

    const resumes: (string | undefined)[] = [];
    const spawn: SpawnFn = async (request) => {
      resumes.push(request.resume);
      assert.match(request.prompt, /wait window you declared/, 'the elapsed-window prompt, in the same session');
      r.markDone(1);
      return ok({ sessionId: 'sess-w' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(resumes, ['sess-w'], 'the expired wait boarded — stuck is no longer invisible to the candidate set');
    assert.equal(journalled(events, 'run.waiting-external').length, 0, 'the run never re-entered waiting on a clock that had passed');
    assert.notEqual(state.status, 'waiting');
    assert.equal(state.phases['1'].status, 'done');
  } finally { r.cleanup(); }
});

test('defects: a verification card that goes unanswered parks the phase and the run — the streak is untouched', async () => {
  const r = repo();
  try {
    const { Approvals } = await import('../server/runner/approvals.ts');
    const notRun = { ok: false, reason: 'nothing runnable (1 fragment left for a human)', ran: [], notRun: [{ text: 'look at the dashboard', reason: 'prose' }] };
    const { instance, events } = runner(r, workingSession(r), undefined, undefined, {
      approvals: new Approvals(), verify: async () => notRun, verifyAnswerMs: 60, origin: 'http://127.0.0.1:4123',
    });
    // The card's timer is unref'd (a pending approval must never keep the
    // console alive); in a test nothing else holds the loop open, so hold it.
    const keepAlive = setInterval(() => {}, 500);
    try {
      await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going' });
      await instance.wait();
    } finally { clearInterval(keepAlive); }

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'parked', 'parked, not failed');
    assert.match(state.phases['1'].note ?? '', /went unanswered/);
    assert.equal(state.consecutiveFailures, 0, 'nobody answering is not the phase failing');
    assert.equal(state.status, 'parked');
    assert.match(state.halt?.reason ?? '', /verification card went unanswered/);
    assert.equal(journalled(events, 'phase.verify-unanswered').length, 1);
    assert.equal(journalled(events, 'run.halt').filter((h) => h.kind === 'needs-human').length, 0, 'no needs-human halt, no streak');
  } finally { r.cleanup(); }
});

test('defects: every verification lead missing at verify time parks exactly as boarding would — no card, no verify-failed halt', async () => {
  const r = repo();
  try {
    const skipped = [{ command: 'rg -n TODO', lead: 'rg', reason: '`rg` is not installed on the verification PATH' }];
    const unrunnable = {
      ok: false, reason: 'all 1 command(s) are unrunnable here — leads not on the verification PATH: rg',
      ran: [], notRun: skipped.map((s) => ({ text: s.command, reason: s.reason })), skipped,
    };
    const { instance, events } = runner(r, workingSession(r), undefined, undefined, { verify: async () => unrunnable });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'halt-on-everything' });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'parked');
    assert.match(state.phases['1'].note ?? '', /§Verification cannot run on this machine/);
    assert.equal(journalled(events, 'phase.verify-unrunnable').length, 1);
    assert.notEqual(state.phases['1'].status, 'awaiting-verification', 'no card was raised');
    assert.equal(journalled(events, 'run.halt').filter((h) => h.kind === 'verify-failed').length, 0);
    // The run parks with the same sentence — the board already reads done, so
    // a parked record in a driving loop would have been reconciled to done on
    // the next tick, and an unverified phase would have passed in silence.
    assert.equal(state.status, 'parked');
    assert.match(state.halt?.reason ?? '', /§Verification cannot run on this machine/);
    assert.equal(state.consecutiveFailures, 0);
  } finally { r.cleanup(); }
});

test('defects: the belt-check backs off against a stale store — at most a handful of re-boards in five seconds, doubling', async () => {
  const r = repo();
  try {
    r.setLockRefused(true);
    const seen: number[] = [];
    const scheduler = new Scheduler({ locks: () => [] }); // a store that never learns of the lock
    const { instance, events } = runner(r, workingSession(r, seen), undefined, undefined, { scheduler });
    // Every timer in the runner and the scheduler is unref'd; hold the loop open
    // for the seven seconds this takes.
    const keepAlive = setInterval(() => {}, 500);
    try {
      const started = instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
      setTimeout(() => r.setLockRefused(false), 5_500);
      await started;
      await instance.wait();
    } finally { clearInterval(keepAlive); scheduler.close(); }

    const races = journalled(events, 'phase.lock-race');
    assert.ok(races.length >= 2 && races.length <= 4, `a backoff, not a spin: ${races.length} re-boards`);
    assert.deepEqual(races.slice(0, 3).map((race) => race.backoffMs), [1000, 2000, 4000].slice(0, races.length));
    assert.deepEqual(seen, [1], 'and the phase boarded once the holder released');
    assert.equal(instance.current()!.phases['1'].lockBackoffMs, undefined, 'the backoff resets on a successful claim');
  } finally { r.cleanup(); }
});

test('defects: the no-handoff halt quotes the PHASE session, not the closeout that failed after it', async () => {
  const r = repo();
  try {
    gitInit(r.root, ['scratch.txt']);
    writeFileSync(join(r.root, 'scratch.txt'), 'work the session did');
    let calls = 0;
    const spawn: SpawnFn = async () => {
      calls++;
      return ok({ resultText: calls === 1 ? 'Phase complete! (no handoff though)' : 'I could not write the handoff either' });
    };
    const { instance } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going' });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(calls, 2, 'the phase, then one closeout');
    assert.equal(state.halt?.kind, 'no-handoff');
    assert.match(state.halt?.reason ?? '', /Phase complete!/, 'the words that explain the missing handoff');
    assert.doesNotMatch(state.halt?.reason ?? '', /I could not write/);
    assert.match(state.phases['1'].said ?? '', /Phase complete!/);
    assert.match(state.phases['1'].closeout?.said ?? '', /I could not write/, 'the closeout\'s words are kept, separately');
  } finally { r.cleanup(); }
});

test('defects: a freeze escalation with another lane still open leaves the halt that lane wrote alone', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; }, false);
  let releaseTwo: () => void = () => {};
  const twoHeld = new Promise<void>((resolve) => { releaseTwo = resolve; });
  r.setParallel(true);
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) return held.spawn(request);
    // A second lane with NO pid — between admission and a session that
    // never reports one — held open while phase 1 is frozen.
    await twoHeld;
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spawn, undefined, undefined, { maxParallel: 2 });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', maxParallel: 2 });
    await held.inSession;
    await sleepMs(150); // let lane 2 board too

    assert.equal(instance.freeze('test', 1), true);
    assert.ok(pid, 'the frozen lane has a real child');
    const state = instance.current()!;
    state.halt = { at: new Date().toISOString(), reason: 'another lane stopped the run', phase: 2 };
    (instance as unknown as { escalateFreeze(): void }).escalateFreeze();

    assert.equal(instance.current()!.halt?.reason, 'another lane stopped the run', 'the other lane\'s halt stands');
    assert.notEqual(instance.current()!.status, 'paused', 'a run with an open lane is not paused');
    assert.equal(instance.current()!.phases['1'].status, 'pending', 'the frozen phase itself is checkpointed');
  } finally {
    held.release();
    releaseTwo();
    await instance.wait();
    r.cleanup();
  }
});

/* ---------------- the lock-cap re-arm ---------------- */

test('a lock-cap park re-arms by itself when the lock it waited out is gone — no Retry', async () => {
  const r = repo();
  try {
    r.setParallel(true);
    r.setLockRefusedFor(1, true);
    // Phase 1 has already queued three hours behind its lock — the cap is two —
    // so its first boarding parks it honestly. Phase 2's session then releases
    // the lock (standing in for the holder finishing), and the NEXT tick has
    // to pick phase 1 back up on its own: the park used to be terminal, and
    // the only remedy a person's Retry after the holder had long released.
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    phaseRecord(stale, 1).lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(stale);

    const boarded: number[] = [];
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
      boarded.push(phase);
      if (phase === 2) r.setLockRefusedFor(1, false);
      r.markDone(phase);
      return ok();
    };
    const scheduler = new Scheduler({ locks: () => [] });
    const { instance, events } = runner(r, spawn, undefined, undefined, { scheduler });
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id });
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.ok(journalled(events, 'phase.lock-wait-capped').length, 'the cap park happened first');
    assert.ok(journalled(events, 'phase.lock-cap-rearmed').length, 'then the re-arm, by itself');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.status, 'finished');
    assert.ok(boarded.includes(1) && boarded.indexOf(1) > boarded.indexOf(2), `phase 1 boarded after phase 2 released the lock: ${boarded.join(',')}`);
  } finally { r.cleanup(); }
});

test('a console shutdown stamps the run as the system\'s stop and writes the killed-lane note; an operator stop stays theirs', async () => {
  const r = repo();
  try {
    // A session that hangs until its signal is cut: the shutdown path aborts
    // it, the operator-stop path aborts it the same way — only the bookkeeping
    // must differ.
    const hang: SpawnFn = (request) => new Promise((resolve) => {
      request.signal?.addEventListener('abort', () => resolve(ok({ sessionId: 'sess-hang', signal: { subtype: 'error_during_execution', code: 143, text: 'terminated' } })), { once: true });
    });
    const { instance } = runner(r, hang);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await (instance as never as { checkpointForShutdown: () => Promise<void> }).checkpointForShutdown();
    await instance.wait();
    const shut = instance.current()!;
    assert.equal(shut.status, 'paused');
    assert.equal(shut.stoppedBy, 'system', 'the console going away is not the operator');
    assert.match(shut.phases['1'].note ?? '', /^the console stopped while phase 1 was running/);
    assert.equal(shut.phases['1'].resumeSessionId, 'sess-hang', 'kept for the --resume at boot');
    assert.match(shut.finishedReason ?? '', /console shut down/);

    const second = runner(r, hang);
    await second.instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await second.instance.stop();
    await second.instance.wait();
    const stopped = second.instance.current()!;
    assert.equal(stopped.status, 'paused');
    assert.equal(stopped.stoppedBy, 'operator');
    assert.equal(stopped.phases['1'].note, 'stopped by the operator');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The resource ladder — walls the run climbs by itself before anyone hears
 *
 * Auth, usage past the 12h ceiling, an exhausted model chain, a spent run
 * budget, two leaves finishing together on a work branch. Each used to stop
 * the run for a person; each climbs its first rung here, and the errand is
 * written only when the rung does not hold.
 * ------------------------------------------------------------------ */

const ladderJournal = (events: { event: string; data: Record<string, unknown> }[], name: string) =>
  events
    .filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

test('auth wall: a run pinned to a signed-out account switches at preflight to one that signs in, and boards', async () => {
  const r = repo();
  const probed: (string | undefined)[] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const seen: number[] = [];
  const watching: SpawnFn = async (request) => {
    envs.push(request.env);
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    r.markDone(phase);
    return ok();
  };
  const { instance, events } = runner(r, watching, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    checkAuth: async (accountId) => {
      probed.push(accountId);
      return accountId === 'spare'
        ? { loggedIn: true, checkedAt: '' }
        : { loggedIn: false, checkedAt: '', detail: `the run is set to pay as ${accountId ?? 'default'} and that login is expired — sign it in` };
    },
    rankAccounts: (excluding) => ['stale', 'spare'].filter((id) => id !== excluding),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.deepEqual(probed.slice(0, 3), ['work', 'stale', 'spare'], 'the run\'s account first, then each candidate in rank order');
  assert.equal(state.accountId, 'spare', 'the run now pays as the account that signed in');
  assert.ok(seen.length > 0);
  assert.ok(envs.every((env) => env?.CLAUDE_CODE_OAUTH_TOKEN === 'tok-spare'), 'every spawn runs as it');
  const switched = ladderJournal(events, 'run.account-switched');
  assert.equal(switched.length, 1);
  assert.equal(switched[0].from, 'work');
  assert.equal(switched[0].to, 'spare');
  assert.deepEqual(switched[0].tried, ['switch-account → stale: not signed in']);
  assert.equal(state.errand, undefined, 'nobody is asked');
  r.cleanup();
});

test('auth wall: with no account that signs in, the run parks run-preflight with the errand naming the sign-in — and the switch is off under the preference', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen), '`true`', undefined, {
    checkAuth: async (accountId) => ({
      loggedIn: false, checkedAt: '',
      detail: `the run is set to pay as ${accountId ?? 'default'} and that login is expired or signed out — sign it in with claude auth login`,
    }),
    rankAccounts: () => ['spare'],
  });
  const parked = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  assert.equal(parked.status, 'parked');
  assert.equal(parked.halt?.kind, 'run-preflight');
  assert.equal(seen.length, 0, 'nothing spawned behind the refusal');
  assert.equal(parked.errand?.situation, 'resource-wall:auth');
  assert.match(parked.errand?.need ?? '', /pay as work/);
  assert.match(parked.errand?.how ?? '', /sign it in with claude auth login/);
  assert.deepEqual(parked.errand?.tried, ['switch-account → spare: not signed in']);
  assert.deepEqual(ladderJournal(events, 'run.preflight-refused')[0].tried, ['switch-account → spare: not signed in']);
  assert.equal(ladderJournal(events, 'run.errand').length, 1);
  r.cleanup();

  // The preference off: the candidate is never even probed.
  const r2 = repo();
  const probed: (string | undefined)[] = [];
  const second = runner(r2, workingSession(r2), '`true`', undefined, {
    checkAuth: async (accountId) => { probed.push(accountId); return { loggedIn: accountId === 'spare', checkedAt: '' }; },
    rankAccounts: () => ['spare'],
    autoAccountSwitch: () => false,
  });
  const stayed = await second.instance.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', accountId: 'work' });
  assert.equal(stayed.status, 'parked');
  assert.deepEqual(probed, ['work'], 'the operator asked to be asked');
  assert.equal(stayed.errand?.situation, 'resource-wall:auth');
  assert.deepEqual(stayed.errand?.tried, []);
  r2.cleanup();
});

test('usage wall past the 12h ceiling: under `wait`, the run moves to an account with headroom instead of stopping for a person', async () => {
  const r = repo();
  const spawns: { env?: NodeJS.ProcessEnv; resume?: string }[] = [];
  const far = Math.floor(Date.now() / 1000) + 20 * 3600;   // 20h out: past the auto-wait ceiling
  const limited: SpawnFn = async (request) => {
    spawns.push({ env: request.env, resume: request.resume });
    if (spawns.length === 1) {
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${far}` },
        sessionId: 'sess-far',
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-far' });
  };
  const { instance, events } = runner(r, limited, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    pickAccount: () => 'spare',
    portTranscript: () => true,
  });
  // No onLimit: the default `wait`, which cannot wait 20h — the preference
  // (on by default) upgrades it to a switch rather than a needs-human halt.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  const outcome = await Promise.race([
    instance.wait().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
  ]);
  if (outcome === 'slept') await instance.stop();
  assert.equal(outcome, 'finished', 'the switch path must not sit out a 20h window');

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.equal(state.accountId, 'spare');
  assert.equal(spawns[1].resume, 'sess-far', 'the ported transcript is resumed');
  assert.equal(ladderJournal(events, 'phase.account-switch').length, 1);
  assert.equal(ladderJournal(events, 'phase.needs-human').length, 0, 'nobody was asked');
  r.cleanup();
});

test('usage wall past the 12h ceiling with no account to pay: the run WAITS on the window — restart-safe, the errand says when — instead of halting needs-human', async () => {
  const r = repo();
  const far = Math.floor(Date.now() / 1000) + 20 * 3600;
  let spawns = 0;
  const limited: SpawnFn = async () => {
    spawns++;
    return ok({
      signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${far}` },
      sessionId: 'sess-far',
    });
  };
  const { instance, events } = runner(r, limited, '`true`', undefined, { pickAccount: () => null });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  // The lane is asleep on a 20h clock: observe the wait, then stop it.
  const deadline = Date.now() + 5_000;
  while (instance.current()?.status !== 'waiting' && Date.now() < deadline) await sleep(25);
  const waiting = instance.current()!;
  assert.equal(waiting.status, 'waiting');
  assert.ok(waiting.waitUntil && Date.parse(waiting.waitUntil) > Date.now() + 19 * 3_600_000, 'the clock is the reset itself');
  assert.equal(waiting.errand?.situation, 'resource-wall:usage');
  assert.match(waiting.errand?.how ?? '', /waits by itself until .*Settings ▸ Accounts/s);
  assert.deepEqual(waiting.errand?.tried, ['switch-account → no other account has headroom']);
  assert.equal(ladderJournal(events, 'phase.needs-human').length, 0);
  assert.equal(ladderJournal(events, 'run.waiting').length, 1);
  assert.equal(ladderJournal(events, 'run.errand').length, 1);
  assert.equal(spawns, 1, 'nothing retried into the wall');
  await instance.stop();
  await instance.wait();
  r.cleanup();
});

test('usage wall past the ceiling under `pause` keeps its word: checkpoint and stop for a person, with the errand on the run', async () => {
  const r = repo();
  const far = Math.floor(Date.now() / 1000) + 20 * 3600;
  const limited: SpawnFn = async () => ok({
    signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${far}` },
    sessionId: 'sess-far',
  });
  const { instance, events } = runner(r, limited, '`true`', undefined, {
    pickAccount: () => 'spare',   // available, and deliberately not taken
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'pause' });
  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'paused');
  assert.ok(state.waitUntil);
  assert.equal(state.phases['1'].status, 'pending');
  assert.equal(state.phases['1'].resumeSessionId, 'sess-far');
  assert.equal(state.errand?.situation, 'resource-wall:usage');
  assert.equal(ladderJournal(events, 'phase.account-switch').length, 0, 'pause means a person decides');
  assert.equal(ladderJournal(events, 'run.limit-paused').length, 1);
  r.cleanup();
});

test('models exhausted: the run waits for the FIRST model\'s window, then retries the same session on it', async () => {
  const r = repo();
  const T0 = Date.parse('2026-01-01T13:00:00Z');
  let clock = T0;
  const spawns: { model?: string; resume?: string }[] = [];
  const reset = Math.floor((T0 + 60_000) / 1000);   // opus reopens a minute after the start
  const limited: SpawnFn = async (request) => {
    spawns.push({ model: request.model, resume: request.resume });
    clock += 120_000;   // time passes between attempts; by the third the window is behind us
    if (spawns.length <= 3) {
      const model = request.model!;
      const named = `${model[0].toUpperCase()}${model.slice(1)}`;
      const text = spawns.length === 1
        ? `You've hit your ${named} limit · Claude AI usage limit reached|${reset}`
        : `You've hit your ${named} limit`;
      return ok({ signal: { subtype: 'error_during_execution', code: 1, text, model }, sessionId: `sess-${spawns.length}` });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-final' });
  };
  const { instance, events } = runner(r, limited, '`true`', undefined, { now: () => new Date(clock) });
  // Scoped to the one phase, so the spawn list is exactly this phase's story.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', model: 'opus', onlyPhases: [1] });
  const outcome = await Promise.race([
    instance.wait().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
  ]);
  if (outcome === 'slept') await instance.stop();
  assert.equal(outcome, 'finished');

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.deepEqual(spawns.map((s) => s.model), ['opus', 'sonnet', 'haiku', 'opus'], 'down the chain, then back to the first');
  assert.equal(spawns[3].resume, 'sess-3', 'the same session, not a fresh boot');
  assert.deepEqual(ladderJournal(events, 'phase.model-window-wait').map((d) => d.model), ['opus']);
  assert.equal(ladderJournal(events, 'phase.model-window-retry').length, 1);
  assert.equal(ladderJournal(events, 'run.halt').length, 0);
  assert.equal(state.phases['1'].model, 'opus');
  r.cleanup();
});

test('models exhausted with no reset on the first model halts as it always did', async () => {
  const r = repo();
  let spawns = 0;
  const limited: SpawnFn = async (request) => {
    spawns++;
    const model = request.model!;
    return ok({
      signal: { subtype: 'error_during_execution', code: 1, text: `You've hit your ${model[0].toUpperCase()}${model.slice(1)} limit`, model },
    });
  };
  const { instance, events } = runner(r, limited);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', model: 'opus' });
  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.equal(state.halt?.kind, 'models-exhausted');
  assert.equal(spawns, 3);
  assert.equal(ladderJournal(events, 'phase.model-window-wait').length, 0);
  r.cleanup();
});

test('budget wall: a spent run budget is raised once within the cap and journalled; the second exhaustion halts with the errand; a budget at the cap cannot be raised', async () => {
  // (1) $3, $1 a phase, three phases: the third spends it exactly, the raise
  // (25% → 3.75) carries the run to finished instead of a halt over nothing.
  const costly = (r: Repo, seen: number[]): SpawnFn => async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    r.markDone(phase);
    return ok({ costUsd: 1 });
  };
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, costly(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', runBudgetUsd: 3 });
  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(
    ladderJournal(events, 'run.budget-raised').map((d) => ({ from: d.from, to: d.to, pct: d.pct })),
    [{ from: 3, to: 3.75, pct: 25 }],
  );
  assert.equal(state.runBudgetUsd, 3.75);
  assert.equal(state.budgetRaise?.from, 3);
  assert.equal(state.errand, undefined);
  r.cleanup();

  // (2) $2: spent at phase 2 → raised to 2.5 → phase 3 runs → $3 ≥ 2.5: the
  // second exhaustion is the halt, with the errand saying the raise was tried.
  const r2 = repo();
  const seen2: number[] = [];
  const second = runner(r2, costly(r2, seen2));
  await second.instance.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', runBudgetUsd: 2 });
  await second.instance.wait();
  const halted = second.instance.current()!;
  assert.equal(halted.status, 'halted');
  assert.equal(halted.halt?.kind, 'budget');
  assert.match(halted.halt?.reason ?? '', /^the run budget of \$2\.5 is spent \(raised once from \$2\)/);
  assert.deepEqual(seen2, [1, 2, 3], 'the raise bought the third phase');
  assert.equal(ladderJournal(second.events, 'run.budget-raised').length, 1, 'raised ONCE');
  assert.equal(halted.errand?.situation, 'resource-wall:budget');
  assert.match(halted.errand?.tried[0] ?? '', /raised \$2 → \$2\.5 \(25%\), spent again/);
  assert.equal(ladderJournal(second.events, 'run.errand').length, 1);
  r2.cleanup();

  // (3) a budget already at the ladder's per-run USD cap has nowhere to go:
  // the halt comes at once, and the errand says why no raise happened.
  const r3 = repo();
  const seen3: number[] = [];
  const third = runner(r3, costly(r3, seen3), '`true`', undefined, { ladderCaps: () => ({ perRunUsd: 2 }) });
  await third.instance.start({ slug: 'demo', root: r3.root, autonomy: 'keep-going', runBudgetUsd: 2 });
  await third.instance.wait();
  const capped = third.instance.current()!;
  assert.equal(capped.status, 'halted');
  assert.equal(capped.halt?.kind, 'budget');
  assert.deepEqual(seen3, [1, 2]);
  assert.equal(ladderJournal(third.events, 'run.budget-raised').length, 0);
  assert.match(capped.errand?.tried[0] ?? '', /not possible within the \$2 per-run ladder cap/);
  r3.cleanup();
});

test('two DAG leaves finishing together on a work-branch run: the last leaf\'s session opens the PR — never a bare run.pr-pending ending', async () => {
  const r = repo();
  r.setParallel(true);
  const spawns: { prompt: string; resume?: string; name?: string }[] = [];
  const working: SpawnFn = async (request) => {
    spawns.push({ prompt: request.prompt, resume: request.resume, name: request.name });
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok({ resultText: 'pushed pe/demo and opened https://example.invalid/pr/7' });
  };
  const { instance, events } = runner(r, working, '`true`', undefined, { maxParallel: 3 });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'new-branch', openPr: true });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  const boots = spawns.filter((s) => /BOOT phase/.test(s.prompt));
  assert.equal(boots.length, 3);
  assert.ok(boots.every((s) => !/Opening the pull request/.test(s.prompt)), 'with three leaves live at once none reads as last');
  const pr = spawns.filter((s) => /Opening the pull request/.test(s.prompt));
  assert.equal(pr.length, 1, 'exactly one session is asked to open the PR');
  assert.match(pr[0].resume ?? '', /^sess-p\d$/, 'and it is a leaf\'s own resumed session');
  assert.match(pr[0].prompt, /pull request falls to you/);
  assert.match(pr[0].name ?? '', /pull request$/);
  assert.equal(ladderJournal(events, 'run.pr-pending').length, 0);
  assert.equal(ladderJournal(events, 'phase.pr-session-done').length, 1);
  assert.match(state.finishedReason ?? '', /asked to push pe\/demo and open the pull request/);
  r.cleanup();

  // When no session can be resumed for it, the honest ending stays: the
  // branch awaits its PR and the card asks.
  const r2 = repo();
  r2.setParallel(true);
  const failing: SpawnFn = async (request) => {
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r2.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    throw new Error('no transcript to resume');
  };
  const second = runner(r2, failing, '`true`', undefined, { maxParallel: 3 });
  await second.instance.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', gitMode: 'new-branch', openPr: true });
  await second.instance.wait();
  const pending = second.instance.current()!;
  assert.equal(pending.status, 'finished');
  assert.equal(ladderJournal(second.events, 'run.pr-pending').length, 1);
  assert.equal(ladderJournal(second.events, 'phase.pr-session-failed').length, 1);
  assert.match(pending.finishedReason ?? '', /still awaits its PR/);
  r2.cleanup();
});
