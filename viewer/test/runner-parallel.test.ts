/**
 * Lanes: does one run genuinely drive several phases at once, and does it
 * refuse to when their scopes overlap?
 *
 * The hard part of testing concurrency is that "it looked concurrent" is not
 * evidence — two sessions that happened to be quick can finish in the order a
 * serial loop would have produced. So the fake session **blocks on a barrier
 * that only opens once N sessions are inside it**. Genuine overlap is the only
 * way the barrier opens; a serial loop deadlocks against it and falls out on a
 * timeout with a peak of one. The assertion is therefore about something that
 * cannot happen by luck.
 *
 * Same stub-repo shape as `runner.test.ts` — real shell scripts, a real board
 * driven by a `done` file, only the `claude` child faked — but with a board
 * where several phases are ready at once, which is what lanes are for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-lanes-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { loadRun } = await import('../server/runner/state.ts');
import type { SpawnFn, SpawnOutcome } from '../server/runner/spawn.ts';

const PHASES = [1, 2, 3];

type Repo = { root: string; scripts: string; state: string; doneList: () => number[]; cleanup: () => void };

/**
 * A repo whose board reports EVERY unfinished phase as ready at once.
 *
 * The linear stub in `runner.test.ts` is the right shape for testing the loop;
 * it is the wrong shape here, because a graph that only ever offers one
 * candidate cannot tell a lane table from a `while` loop.
 */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-lanes-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');

  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in ${PHASES.join(' ')}; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);

  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
echo "$*" >> "${state}/locks"
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);

  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');

  return {
    root, scripts, state,
    doneList: () => readFileSync(join(state, 'done'), 'utf8').split('\n').filter(Boolean).map(Number),
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
    sessionId: 'sess-0001', costUsd: 0, turns: 1, resultText: 'done',
    durationMs: 1, argv: ['-p', '<prompt>'], ...partial,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * A fake session that will not finish until `want` of them are running.
 *
 * This is the whole method: overlap is not observed after the fact, it is
 * *required* for the test to make progress. A serial loop never opens the
 * barrier and every session leaves on the fallback timeout instead, recording
 * a peak of one.
 */
function barrierSpawn(r: Repo, want: number, fallbackMs = 750) {
  const gate = deferred<void>();
  const order: string[] = [];
  let live = 0;
  let peak = 0;

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    live += 1;
    peak = Math.max(peak, live);
    order.push(`start ${phase}`);
    if (live >= want) gate.resolve();
    await Promise.race([gate.promise, sleep(fallbackMs)]);
    live -= 1;
    order.push(`end ${phase}`);
    // What a real session does when it writes its handoff. APPEND, never
    // read-modify-write: two lanes finishing in the same millisecond both read
    // the old file and one overwrites the other, the board never sees a phase
    // that did complete, and the run halts on a failure the harness invented.
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  return { spawn, order, peak: () => peak, scopes: [] as string[] };
}

function runnerOn(
  r: Repo, spawn: SpawnFn, scope: (phase: number) => string[], maxParallel = 3,
): { instance: InstanceType<typeof Runner>; scheduler: InstanceType<typeof Scheduler> } {
  const scheduler = new Scheduler({ max: maxParallel, locks: () => [] });
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    scheduler,
    maxParallel,
    // A verification that passes. Without one, `confirm` halts every phase on
    // "the plan states no verification" — which halted the run after the first
    // lane and made a lane-cap test look like a lane-cap bug.
    verificationText: () => '`true`',
    phaseScope: (_slug, phase) => scope(phase),
  });
  return { instance, scheduler };
}

/* ------------------------------------------------------------------ *
 * Overlap
 * ------------------------------------------------------------------ */

test('two phases in different repos run at the same time, proven by a barrier only concurrency opens', async () => {
  const r = repo();
  // Three ready phases, three disjoint repos. Two have to be inside the
  // barrier together before either can leave it.
  const held = barrierSpawn(r, 2);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.ok(held.peak() >= 2, `expected overlapping sessions, peak was ${held.peak()}`);
  assert.deepEqual(r.doneList().sort(), PHASES, 'and all three phases still completed');
  scheduler.close();
  r.cleanup();
});

test('phases that share a repo serialise, however many lanes are allowed', async () => {
  const r = repo();
  // Same three ready phases, same three lanes — but one scope between them.
  const held = barrierSpawn(r, 2, 400);
  const { instance, scheduler } = runnerOn(r, held.spawn, () => ['one-repo']);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(held.peak(), 1, 'two agents in one working tree is the failure this prevents');
  // Every start is closed by its OWN end before the next start — which is what
  // serialisation means. Deliberately not asserted as `1,2,3`: the lanes are
  // created in one tick and each runs a `--gate-status` subprocess before it
  // reaches admission, so which of three racing subprocesses returns first is
  // genuinely undetermined. The queue is FIFO by arrival, and pinning an
  // arrival order would be pinning the scheduler of the operating system.
  assert.equal(held.order.length, 6);
  for (let i = 0; i < held.order.length; i += 2) {
    const phase = held.order[i].split(' ')[1];
    assert.equal(held.order[i], `start ${phase}`);
    assert.equal(held.order[i + 1], `end ${phase}`, `phase ${phase} was interleaved with another`);
  }
  assert.deepEqual(r.doneList().sort(), PHASES);
  scheduler.close();
  r.cleanup();
});

test('the lane cap holds even when every scope is disjoint', async () => {
  const r = repo();
  // Three disjoint phases but only two lanes: the third waits for a free one.
  const held = barrierSpawn(r, 3, 400);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`], 2);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(held.peak(), 2, 'the cap is about the machine, not about the scopes');
  assert.deepEqual(r.doneList().sort(), PHASES);
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * What the checkpoint says while several lanes are open
 * ------------------------------------------------------------------ */

test('every live lane is in `children`, and `child` mirrors one of them', async () => {
  const r = repo();
  const gate = deferred<void>();
  let live = 0;
  const seen: { children: number; child: number | null }[] = [];

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    request.onPid?.(process.pid);
    live += 1;
    if (live >= 2) {
      // Both lanes are open: read the checkpoint from DISK, not from memory,
      // because a restarted console only ever gets the disk. The write sits on
      // the other side of an async boundary, so under a loaded suite the first
      // read can land before the second lane's persist — poll briefly rather
      // than race it (the property under test is "the disk says it", not
      // "the disk says it within one scheduler tick").
      for (let tries = 0; ; tries += 1) {
        const state = loadRun(r.root, 'demo', runId!, runId);
        const snap = {
          children: Object.keys(state?.children ?? {}).length,
          child: state?.child?.phase ?? null,
        };
        if ((snap.children >= 2 && snap.child !== null) || tries >= 24) { seen.push(snap); break; }
        await sleep(25);
      }
      gate.resolve();
    }
    // 3s, not 750ms: the fallback exists so a SERIAL loop fails fast, and under
    // a fully parallel suite the shorter window let a loaded box leave the
    // barrier before both lanes were inside.
    await Promise.race([gate.promise, sleep(3_000)]);
    live -= 1;
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const { instance, scheduler } = runnerOn(r, spawn, (phase) => [`repo-${phase}`]);
  const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  const runId: string | undefined = started.id;
  await instance.wait();

  assert.ok(seen.length, 'two lanes were never open at once');
  assert.ok(seen[0].children >= 2, `expected every lane in children, saw ${seen[0].children}`);
  assert.ok(seen[0].child !== null, 'the single-lane mirror must still be written — old consoles read it');

  // …and nothing is left claiming to be alive afterwards.
  const after = loadRun(r.root, 'demo', runId, runId);
  assert.equal(after?.child, null);
  assert.equal(after?.children, undefined);
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Stopping, with several lanes open
 * ------------------------------------------------------------------ */

test('a stop reaches every open lane, not just the one being mirrored', async () => {
  const r = repo();
  const started = deferred<void>();
  let live = 0;
  const aborted: number[] = [];

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    live += 1;
    if (live >= 2) started.resolve();
    // Ends only when the run's abort signal fires — so a lane the stop failed
    // to reach would hang this test rather than quietly passing it.
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) { resolve(); return; }
      request.signal?.addEventListener('abort', () => resolve(), { once: true });
      setTimeout(resolve, 5_000).unref?.();
    });
    aborted.push(phase);
    live -= 1;
    return ok({ signal: { subtype: 'error', code: 143, text: 'terminated' } });
  };

  const { instance, scheduler } = runnerOn(r, spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await started.promise;
  await instance.stop();

  assert.ok(aborted.length >= 2, `a stop must end every lane, ended ${aborted.length}`);
  assert.equal(instance.current()?.status, 'paused');
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Admission against the world outside this console
 * ------------------------------------------------------------------ */

test("a stranger's live lock holds a phase back, and releasing it lets the phase through", async () => {
  const r = repo();
  let locks = [{ slug: 'other', phase: 9, owner: 'someone/else', expired: false, scope: ['repo-1'] }];
  const scheduler = new Scheduler({ max: 3, locks: () => locks });

  const order: string[] = [];
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    order.push(`start ${phase}`);
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    scheduler,
    maxParallel: 3,
    // A verification that passes. Without one, `confirm` halts every phase on
    // "the plan states no verification" — which halted the run after the first
    // lane and made a lane-cap test look like a lane-cap bug.
    verificationText: () => '`true`',
    phaseScope: (_slug, phase) => [`repo-${phase}`],
  });

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  // Phases 2 and 3 are disjoint from the stranger and go straight through;
  // phase 1 shares `repo-1` with it and waits.
  await sleep(400);
  assert.ok(!order.includes('start 1'), `phase 1 must wait for the lock, order was ${order.join(', ')}`);
  assert.ok(order.includes('start 2'), 'and a disjoint phase must not be held up by it');

  locks = [];
  scheduler.poll();
  await instance.wait();

  assert.ok(order.includes('start 1'), 'and it runs once the lock is gone');
  assert.deepEqual(r.doneList().sort(), PHASES);
  scheduler.close();
  r.cleanup();
});

test('a phase blocked at admission reads `queued`, and says what it is waiting on', async () => {
  const r = repo();
  const locks = [{ slug: 'other', phase: 9, owner: 'someone/else', expired: false, scope: ['all'] }];
  const scheduler = new Scheduler({ max: 3, locks: () => locks });

  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: async () => ok(),
    scheduler,
    maxParallel: 1,
    // A verification that passes. Without one, `confirm` halts every phase on
    // "the plan states no verification" — which halted the run after the first
    // lane and made a lane-cap test look like a lane-cap bug.
    verificationText: () => '`true`',
    phaseScope: () => ['repo-1'],
    onEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
  });

  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await sleep(300);

  assert.equal(state.phases['1']?.status, 'queued', 'the phase says it is waiting');
  // Not in IN_FLIGHT on purpose: a queued run has done nothing, so a restart
  // may re-adopt it rather than reconciling it into `interrupted`.
  assert.equal(state.status, 'queued', 'and so does the run');

  const queued = events.find((e) => e.event === 'run:phase' && e.data.status === 'queued');
  assert.ok(queued, 'the console is told, rather than left watching a phase that never starts');
  const waitingOn = queued.data.waitingOn as { owner: string }[];
  assert.equal(waitingOn[0].owner, 'someone/else', 'and told WHO it is waiting on');

  await instance.stop();
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * A halt in one lane, honestly, while others are live
 * ------------------------------------------------------------------ */

test('a halt in one lane stops admitting, drains the rest, and reads halting on the way', async () => {
  const r = repo();
  const gate = deferred<void>();
  let live = 0;
  const seen: number[] = [];
  const midDrain: string[] = [];
  let instance!: InstanceType<typeof Runner>;

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    live += 1;
    if (live >= 2) gate.resolve();
    await Promise.race([gate.promise, sleep(750)]);
    if (phase === 1) {
      // The liar: exits clean, writes nothing. confirm() halts the run while
      // phase 2 is still inside this function — the drain case.
      return ok({ sessionId: 'sess-liar' });
    }
    // Linger long enough for lane 1's halt to land, then record what the run
    // claimed while this lane was still live, then finish honestly.
    await sleep(400);
    midDrain.push(instance.current()!.status);
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const made = runnerOn(r, spawn, (phase) => [`repo-${phase}`], 2);
  instance = made.instance;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted', 'the final word, once nothing is running');
  assert.ok(state.halt, 'the halt survived the drain');
  assert.ok(midDrain.includes('halting'),
    `a live lane saw the run read 'halting', not 'running'-with-a-halt (saw: ${midDrain.join(', ')})`);
  assert.ok(!seen.includes(3), 'no new phase boarded after the halt');
  r.cleanup();
});

test('a lane sleeping on a retry backoff stands down when another lane halts', async () => {
  const r = repo();
  const gate = deferred<void>();
  let live = 0;
  const spawnsPerPhase = new Map<number, number>();

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    spawnsPerPhase.set(phase, (spawnsPerPhase.get(phase) ?? 0) + 1);
    live += 1;
    if (live >= 2) gate.resolve();
    await Promise.race([gate.promise, sleep(750)]);
    if (phase === 1) return ok({ sessionId: 'sess-liar' }); // halts the run
    // Phase 2 reports a retryable failure: a 30-second backoff sleep begins —
    // which the halt must cut short, and which must NOT be followed by a
    // second attempt on a run that has stopped.
    await sleep(120);
    return ok({ signal: { subtype: 'crash', code: 137, text: '' }, sessionId: 'sess-2' });
  };

  const { instance } = runnerOn(r, spawn, (phase) => [`repo-${phase}`], 2);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.equal(spawnsPerPhase.get(2), 1, 'no attempt N+1 on a halted run');
  assert.equal(state.phases['2'].status, 'interrupted');
  assert.match(state.phases['2'].note ?? '', /waited to retry/);
  r.cleanup();
});

test('a lane sleeping on a usage window stands down when another lane halts', async () => {
  const r = repo();
  const gate = deferred<void>();
  let live = 0;
  const spawnsPerPhase = new Map<number, number>();

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    spawnsPerPhase.set(phase, (spawnsPerPhase.get(phase) ?? 0) + 1);
    live += 1;
    if (live >= 2) gate.resolve();
    await Promise.race([gate.promise, sleep(750)]);
    if (phase === 1) return ok({ sessionId: 'sess-liar' }); // halts the run
    await sleep(120);
    // "usage limit reached" with no parseable reset → wait-until now+1h. The
    // halt wakes the sleeper; waking into a halted run must not spawn again.
    return ok({ signal: { subtype: 'limit', code: 1, text: 'usage limit reached' }, sessionId: 'sess-2' });
  };

  const { instance } = runnerOn(r, spawn, (phase) => [`repo-${phase}`], 2);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.equal(spawnsPerPhase.get(2), 1, 'no attempt N+1 on a halted run');
  assert.equal(state.phases['2'].status, 'interrupted');
  assert.match(state.phases['2'].note ?? '', /usage window/);
  assert.equal(state.waitUntil, null, 'the window sleep did not outlive the run');
  r.cleanup();
});

test('a pause armed while a phase waits for its scope abandons it back to pending', async () => {
  const r = repo();
  let locks: { slug: string; phase: number; owner: string; expired: boolean; scope: string[] }[] =
    [{ slug: 'other', phase: 9, owner: 'someone/else', expired: false, scope: ['blocked-repo'] }];
  const scheduler = new Scheduler({ max: 3, locks: () => locks });
  const seen: number[] = [];
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok();
  };
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, scheduler, maxParallel: 3,
    verificationText: () => '`true`',
    phaseScope: () => ['blocked-repo'],
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await sleep(250); // phase 1 is now queued behind the foreign lock
  assert.equal(instance.current()!.phases['1']?.status, 'queued');
  assert.equal(instance.pause('test'), true);

  locks = [];        // the blocker releases…
  scheduler.poll();  // …and the scheduler notices — the grant arrives into an armed pause

  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'paused');
  assert.deepEqual(seen, [], 'admission arrived into an armed pause — nothing spawned');
  assert.equal(state.phases['1'].status, 'pending', 'restored so the phase stays startable');
  r.cleanup();
});

test('a queued second lane does not repaint a run that is still driving its first', async () => {
  const r = repo();
  const gate = deferred<void>();
  let sampled: { run?: string; p2?: string } = {};
  let instance!: InstanceType<typeof Runner>;
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      await sleep(400); // let phase 2 reach admission and queue behind this scope
      const state = instance.current()!;
      sampled = { run: state.status, p2: state.phases['2']?.status };
      gate.resolve();
    }
    await Promise.race([gate.promise, sleep(3_000)]);
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };
  const made = runnerOn(r, spawn, () => ['shared-repo'], 2);
  instance = made.instance;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  // Seen live: phase 4 driving with a real child while the RUN read `queued`,
  // because phases 5–6 sat behind its scope. The lane's own record is where
  // "queued" belongs; the run is running for as long as anything drives.
  assert.equal(sampled.run, 'running', "queued is the lane's word, not a driving run's");
  assert.equal(sampled.p2, 'queued', 'the waiting lane itself says so');
  assert.equal(instance.current()!.status, 'finished');
  r.cleanup();
});

/* ---------------- per-lane freeze and stop, across lanes ---------------- */

/** What `ps` says about a process: `T` is stopped, `S`/`R` are running. */
function procState(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim().slice(0, 1);
  } catch { return ''; }
}

/**
 * Every lane gets a REAL sleeper child, so freeze/stop assertions are the
 * kernel's answer rather than ours. A lane's spawn resolves when the test
 * releases everyone — or when its child dies, which is exactly what a
 * SIGTERM'd session does.
 */
function sleeperLanes(r: Repo) {
  const pids = new Map<number, number>();
  const watchers: (() => void)[] = [];
  let released: () => void = () => {};
  const gate = new Promise<void>((resolve) => { released = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    const child = spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    pids.set(phase, child.pid!);
    request.onPid?.(child.pid!);
    request.onEvent?.({ kind: 'init', sessionId: `sess-${phase}`, model: 'stub', tools: 0 });
    for (const notify of watchers) notify();
    const exited = new Promise<'died'>((resolve) => { child.on('exit', () => resolve('died')); });
    const wayOut = await Promise.race([gate.then(() => 'released' as const), exited]);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    if (wayOut === 'released') appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const lanesUp = (want: number) => (pids.size >= want
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      watchers.push(() => { if (pids.size >= want) resolve(); });
    }));

  return { spawn, pids, lanesUp, release: () => released() };
}

test('freeze with no phase freezes EVERY lane, and thaw with none frees them all', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(3);

  assert.equal(instance.freeze('test'), true);
  const frozen = instance.current()!;
  assert.equal(frozen.status, 'frozen', 'nothing is left running, so the run itself is frozen');
  for (const [phase, pid] of held.pids) {
    assert.equal(procState(pid), 'T', `phase ${phase}'s session is stopped`);
    assert.ok(frozen.children?.[String(phase)]?.frozen, `the checkpoint records phase ${phase}'s freeze`);
  }
  assert.ok(frozen.freeze, 'the single-slot mirror is set for pre-lanes readers');

  assert.equal(instance.thaw(), true);
  const thawed = instance.current()!;
  assert.equal(thawed.status, 'running');
  assert.equal(thawed.freeze, null);
  for (const [phase, pid] of held.pids) {
    assert.notEqual(procState(pid), 'T', `phase ${phase} is scheduled again`);
    assert.equal(thawed.children?.[String(phase)]?.frozen, undefined);
  }

  held.release();
  await instance.wait();
  scheduler.close();
  r.cleanup();
});

test('freezing one lane of three leaves the run running, with the mirror on the frozen one', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(3);

  assert.equal(instance.freeze('test', 2), true);
  const state = instance.current()!;
  assert.equal(state.status, 'running', 'two sessions are still editing — the run has not stopped');
  assert.ok(state.children?.['2']?.frozen);
  assert.equal(state.freeze?.phase, 2, 'the single-slot mirror names the frozen lane');
  assert.equal(procState(held.pids.get(2)!), 'T');
  assert.notEqual(procState(held.pids.get(1)!), 'T');
  assert.notEqual(procState(held.pids.get(3)!), 'T');

  assert.equal(instance.thaw(2), true);
  assert.equal(instance.current()!.status, 'running');
  assert.equal(instance.current()!.freeze, null);

  held.release();
  await instance.wait();
  scheduler.close();
  r.cleanup();
});

test('stopping one lane records interrupted, spares the streak, and the rest carries on', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(3);

  assert.deepEqual(instance.stopPhase(2, 'tester'), { ok: true });
  // The child got SIGCONT+SIGTERM; its death resolves the spawn, and the
  // consumption settles the record without touching the failure budget.
  await sleep(400);
  const mid = instance.current()!;
  assert.equal(mid.phases['2'].status, 'interrupted');
  assert.match(mid.phases['2'].note ?? '', /stopped by tester/);
  assert.match(mid.phases['2'].note ?? '', /carries on/);
  assert.equal(mid.consecutiveFailures, 0, 'an operator stop is not a failure');
  assert.equal(mid.status, 'running', 'the run did not stop with the lane');

  held.release();
  await instance.wait();
  const after = instance.current()!;
  assert.deepEqual(r.doneList().sort(), [1, 3], 'the other lanes finished their phases');
  assert.equal(after.phases['2'].status, 'interrupted');
  // Phase 2 never wrote a handoff, so the board still offers it; a settled
  // record is not a candidate, and the run parks naming what is left.
  assert.equal(after.status, 'parked');
  scheduler.close();
  r.cleanup();
});

test('a queued phase can be taken out of the line, and never spawns on arrival', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  // One scope between three phases: one runs, the others queue behind it.
  const { instance, scheduler } = runnerOn(r, held.spawn, () => ['one-repo']);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(1);
  await sleep(200);

  const queued = Object.values(instance.current()!.phases)
    .filter((p) => p.status === 'queued')
    .map((p) => p.phase)
    .sort();
  assert.ok(queued.length >= 1, `something queues behind the scope (saw ${JSON.stringify(queued)})`);
  const target = queued[0];

  assert.deepEqual(instance.stopPhase(target, 'tester'), { ok: true });
  assert.equal(instance.current()!.phases[String(target)].status, 'interrupted');

  held.release();
  await instance.wait();
  assert.ok(!held.pids.has(target), 'the dequeued phase never spawned a session');
  assert.equal(instance.current()!.phases[String(target)].status, 'interrupted');
  scheduler.close();
  r.cleanup();
});

test('a phase skipped while queued does not spawn when its admission arrives', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, () => ['one-repo']);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(1);
  await sleep(200);

  const queued = Object.values(instance.current()!.phases)
    .filter((p) => p.status === 'queued')
    .map((p) => p.phase)
    .sort();
  assert.ok(queued.length >= 1);
  const target = queued[0];
  instance.skip(target);
  assert.equal(instance.current()!.phases[String(target)].status, 'skipped');

  held.release();
  await instance.wait();
  assert.ok(!held.pids.has(target),
    'a settled record is abandoned on arrival — the latent spawn was the bug');
  assert.equal(instance.current()!.phases[String(target)].status, 'skipped');
  scheduler.close();
  r.cleanup();
});

test('two frozen lanes escalate independently — one checkpoints, the others stay frozen', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(3);

  assert.equal(instance.freeze('test'), true);
  const internals = instance as unknown as {
    lanes: Map<number, unknown>;
    escalateFreeze(lane?: unknown): void;
  };
  // The timer names its lane in production; driven directly here, because a
  // test that waits fifteen real minutes is a test nobody runs.
  internals.escalateFreeze(internals.lanes.get(1));

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'pending');
  assert.equal(state.phases['1'].resumeSessionId, 'sess-1', 'Continue resumes the checkpointed session');
  assert.notEqual(state.status, 'paused', 'other sessions are live — the run must not read as stopped');
  assert.ok(state.children?.['2']?.frozen, 'the other freezes survive the escalation');
  assert.equal(state.freeze?.phase, 2, 'the mirror moved to the next frozen lane');
  assert.equal(procState(held.pids.get(2)!), 'T');

  assert.equal(instance.thaw(), true, 'thaw-all frees what is still frozen');
  held.release();
  await instance.wait();
  scheduler.close();
  r.cleanup();
});
