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
const { buildArgv, sanitize, lineReader } = await import('../server/runner/spawn.ts');
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

  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
if [ -f "$S/lock-refused" ]; then echo "held by other@host" >&2; exit 1; fi
echo "$*" >> "$S/locks"
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

function runner(r: Repo, spawn: SpawnFn, verification: string | undefined = '`true`') {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => verification,
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { instance, events };
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
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
  assert.deepEqual(sanitize(['--bare', '-p', 'x', '--dangerously-skip-permissions']), ['-p', 'x']);
});

test('the argv asks for a streamed, budgeted, single-session run', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', model: 'opus', budgetUsd: 3, sessionId: 'abc' });
  assert.deepEqual(argv.slice(0, 2), ['-p', 'hi']);
  assert.ok(argv.includes('--verbose'), 'stream-json in print mode requires it');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'abc');
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '3');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
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
  assert.match(instance.current()!.phases['1'].note!, /held by/);
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
      assert.equal(instance.current()!.phases['1'].status, 'done', 'the phase did pass what could be run');
      assert.match(instance.current()!.halt!.reason, /need a person/);
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
  const service = {
    flags: { allowWrites: false, allowRun: opts.allowRun ?? false, scriptsDir: '/x' },
    store: { get: () => ({}), list: () => [] },
    runner: { current: () => null, pause() {}, stop: async () => {}, skip() {}, retry() {} },
    startRun: async (slug: string, options: unknown) => { started.push({ slug, options }); return { id: 'r1' }; },
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
    .then(() => ({ status, payload, started }));
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
    body: { model: 'sonnet', autonomy: 'keep-going', phaseBudgetUsd: 4 },
  });
  assert.equal(status, 200);
  assert.deepEqual(started, [{
    slug: 'demo',
    options: { model: 'sonnet', autonomy: 'keep-going', phaseBudgetUsd: 4, runBudgetUsd: null, resumeRunId: undefined },
  }]);
});

test('an unknown autonomy value falls back to the cautious one', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { autonomy: 'yolo' },
  });
  assert.equal((started[0] as { options: { autonomy: string } }).options.autonomy, 'halt-on-everything');
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
