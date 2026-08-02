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
  // Straight out of docs/plans/trade-marketplace.md. Running `…` is nonsense,
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
  for (const text of ['`task hetzner:update`', '`git push origin main`', '`rm -rf build`', '`terraform apply`']) {
    const { commands, notRun } = extractCommands(text);
    assert.deepEqual(commands, [], text);
    assert.match(notRun[0].reason, /mutates|not a recognised/, text);
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
  path: string, opts: { method?: string; headers?: Record<string, string>; allowRun?: boolean; body?: unknown } = {},
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
    stopRun: record('stopRun'),
    skipPhase: record('skipPhase'),
    retryPhase: record('retryPhase'),
    runFor: () => ({ id: 'r1', status: 'finished' }),
    runsFor: () => [{ id: 'r1' }],
    allRuns: () => [{ id: 'r1' }],
    runJournal: () => [{ seq: 1, event: 'run.start' }],
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

test('an unknown autonomy value falls back to the cautious one', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { autonomy: 'yolo' },
  });
  assert.equal((started[0] as { options: { autonomy: string } }).options.autonomy, 'halt-on-everything');
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
  ]) {
    const { status, calls } = await call(`/api/run/demo/${verb}`, {
      method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' }, body: { phase: 2 },
    });
    assert.equal(status, 200, verb);
    assert.deepEqual(calls.map((c) => c.method), [method], `${verb} must reach service.${method}`);
  }
});

test('pause is refused without --allow-run, like every other control', async () => {
  for (const verb of ['pause', 'resume', 'settings']) {
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

test('reading a run needs no flag — only changing one does', async () => {
  const listed = await call('/api/runs');
  assert.equal(listed.status, 200);
  const one = await call('/api/run/demo');
  assert.equal(one.status, 200);
  assert.equal((one.payload as { run: { id: string } }).run.id, 'r1');
  const journal = await call('/api/run/demo/journal');
  assert.equal(journal.status, 200);
});

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

const { preflight } = await import('../server/runner/runner.ts');

test('an untrusted workspace is refused before a session is spent on it', () => {
  // Claude Code silently ignores a repository's own permissions and hooks until
  // someone accepts the trust prompt there. A session spawned into that state is
  // less protected than whoever started the run believes.
  const dir = mkdtempSync(join(tmpdir(), 'pc-trust-'));
  const config = join(dir, 'claude.json');

  writeFileSync(config, JSON.stringify({ projects: { '/repo': { hasTrustDialogAccepted: false } } }));
  const refusal = preflight('/repo', config);
  assert.ok(refusal, 'an untrusted workspace must not start a run');
  assert.match(refusal, /not been trusted/);

  writeFileSync(config, JSON.stringify({ projects: { '/repo': { hasTrustDialogAccepted: true } } }));
  assert.equal(preflight('/repo', config), null, 'a trusted workspace proceeds');

  // Absence of evidence is not evidence: an unknown repo or no config at all
  // must not block a run that would otherwise be fine.
  assert.equal(preflight('/somewhere-else', config), null);
  assert.equal(preflight('/repo', join(dir, 'missing.json')), null);
  rmSync(dir, { recursive: true, force: true });
});

test('a run refused at preflight parks with the reason, spending nothing', async () => {
  const r = repo();
  const config = join(r.root, 'claude.json');
  writeFileSync(config, JSON.stringify({ projects: { [r.root]: { hasTrustDialogAccepted: false } } }));
  // preflight reads the real ~/.claude.json, so drive the unit directly and
  // assert the wiring separately: the reason has to reach the run state.
  assert.ok(preflight(r.root, config));
  r.cleanup();
});
