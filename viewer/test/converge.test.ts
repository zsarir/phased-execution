/**
 * The convergence loop — converge, classify, climb, with nobody looking.
 *
 * Three layers, each pinned on its own:
 *
 *  - the PLANNER (`planConvergence`), pure over fixtures: the specimens (a
 *    parked run over an interrupted never-started record; a console restart's
 *    killed lanes; a shutdown between phases; an orphaned session), debris
 *    locks, the lock-cap re-arm, and every pin — the operator's stop, a
 *    resolved run, a live run, a run on its own clock, unchanged evidence;
 *  - the EXECUTOR (`executeConvergence`) with stub deps: what is journalled,
 *    what is written on the run, that the run is started ONCE;
 *  - the CLOCK (`ConvergeScheduler`) with a fake clock: change is a trailing
 *    debounce, the halt's quiet minute is not shortened by a change, the sweep
 *    runs every interval, the button is now, and a pass in flight queues one
 *    re-run;
 *  - and the SERVICE end to end: with no reads and no runner events a stopped
 *    run is re-boarded within one sweep (fake clock), killed lanes resume at
 *    boot (and wait with an errand when the preference is off), debris of a
 *    dead run is released at boot while a person's claim stays, and a halt
 *    event arms the minute.
 *
 * Nothing here spawns `claude`: the run starts are stubbed where they are
 * asserted, and everything up to them is real.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const {
  planConvergence, executeConvergence, ConvergeScheduler, stoppedByOperator, runIsDead, evidenceFingerprint,
  CHANGE_DEBOUNCE_MS, HALT_DELAY_MS, MAX_BOOT_RESUMES, MIN_SWEEP_MS,
} = await import('../server/converge.ts');
const { newRun, phaseRecord, saveRun, loadRun, journalFile, consoleStoppedNote } = await import('../server/runner/state.ts');
const { lockPath, readLock } = await import('../server/store.ts');
type RunState = import('../server/runner/state.ts').RunState;
type PhaseRecord = import('../server/runner/state.ts').PhaseRecord;
type ConvergeFacts = import('../server/converge.ts').ConvergeFacts;
type ConvergeDeps = import('../server/converge.ts').ConvergeDeps;
type ConvergeReport = import('../server/converge.ts').ConvergeReport;
type ConvergeTrigger = import('../server/converge.ts').ConvergeTrigger;
type LockView = import('../server/runner/scheduler.ts').LockView;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const NOW = Date.parse('2026-08-21T10:00:00Z');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function run(over: Partial<RunState> = {}, phases: (Partial<PhaseRecord> & { phase: number })[] = []): RunState {
  const state = newRun({ slug: 'alpha', root: '/tmp/alpha' });
  Object.assign(state, over);
  for (const p of phases) Object.assign(phaseRecord(state, p.phase), p);
  return state;
}

function facts(over: Partial<ConvergeFacts> = {}): ConvergeFacts {
  return {
    slug: 'alpha', now: NOW, trigger: 'timer',
    board: { 1: 'done', 2: 'ready', 3: 'waiting' },
    runs: [], live: new Set(), locks: [], prefs: {}, pidAlive: () => false,
    ...over,
  };
}

const kinds = (plan: { actions: { kind: string }[] }) => plan.actions.map((a) => a.kind);
const skipWhy = (plan: { actions: ({ kind: string } & { why?: string })[] }) =>
  plan.actions.filter((a) => a.kind === 'skip').map((a) => a.why ?? '').join(' | ');

/* ------------------------------------------------------------------ *
 * Reading a run
 * ------------------------------------------------------------------ */

test('stoppedByOperator: the field decides; old records fall back on the operator verbs\' shapes only', () => {
  assert.equal(stoppedByOperator(run({ status: 'paused', stoppedBy: 'operator' })), true);
  assert.equal(stoppedByOperator(run({ status: 'paused', stoppedBy: 'system' })), false, 'a console shutdown is not the operator');
  assert.equal(stoppedByOperator(run({ status: 'paused' })), true, 'before the field, a pause was always somebody\'s');
  assert.equal(stoppedByOperator(run({ status: 'halted' })), false, 'a halt the loop wrote is the system\'s');
  assert.equal(stoppedByOperator(run({ status: 'interrupted', halt: { at: '', reason: 'stopped by the operator' } })), true);
  assert.equal(stoppedByOperator(run({ status: 'interrupted', halt: { at: '', reason: 'nothing has been driving this run since …' } })), false);
  assert.equal(stoppedByOperator(run({ status: 'parked' })), false);
});

test('runIsDead: live, in flight, queued and orphan-alive runs are not dead; the rest are', () => {
  const alive = run({ status: 'halted' });
  assert.equal(runIsDead(alive, new Set([alive.id]), () => false), false, 'driven here');
  assert.equal(runIsDead(run({ status: 'running' }), new Set(), () => false), false, 'in flight under someone');
  assert.equal(runIsDead(run({ status: 'queued' }), new Set(), () => false), false);
  const orphan = run({ status: 'parked', children: { 2: { pid: 4242, phase: 2, startedAt: '' } } });
  assert.equal(runIsDead(orphan, new Set(), () => true), false, 'a session still writing');
  assert.equal(runIsDead(orphan, new Set(), () => false), true, '…until it is gone');
  assert.equal(runIsDead(run({ status: 'halted' }), new Set(), () => false), true);
  assert.equal(runIsDead(run({ status: 'finished' }), new Set(), () => false), true);
});

/* ------------------------------------------------------------------ *
 * The planner — specimens and pins
 * ------------------------------------------------------------------ */

test('planner: the P12 specimen — a parked run over an interrupted never-started record goes to the healer', () => {
  // A:211 resumed → A:212 parked at once; the record's note is the EARLIER
  // operator stop, but the run's own last stop is the loop's park.
  const r = run({
    status: 'parked', activePhase: null,
    halt: { at: '', reason: 'nothing left to run on its own — phase 2 is interrupted (stopped by the operator)' },
  }, [{ phase: 2, status: 'interrupted', note: 'stopped by the operator', attempts: 1 }]);
  const plan = planConvergence(facts({ runs: [r] }));
  assert.deepEqual(kinds(plan), ['heal'], skipWhy(plan));
  const heal = plan.actions[0];
  assert.equal(heal.kind === 'heal' && heal.runId, r.id);
});

test('planner: a run the operator paused or stopped is pinned — and the operator\'s own press is not', () => {
  const paused = run({ status: 'paused', stoppedBy: 'operator' }, [{ phase: 2, status: 'interrupted', note: 'stopped by the operator' }]);
  assert.deepEqual(kinds(planConvergence(facts({ runs: [paused] }))), ['skip']);
  assert.match(skipWhy(planConvergence(facts({ runs: [paused] }))), /operator stopped it/);
  // Before the field: any pause is read as the operator's.
  const old = run({ status: 'paused' }, [{ phase: 2, status: 'interrupted' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [old] }))), /operator stopped it/);
  // The press IS the operator: the same run is healed.
  assert.deepEqual(kinds(planConvergence(facts({ runs: [paused], trigger: 'button' }))), ['heal']);
});

test('planner: a resolved run, a live run, a finished run, a queued run and a run on its own clock are left alone', () => {
  const resolved = run({ status: 'halted', resolved: { at: '', auto: false, reason: 'dismissed' } }, [{ phase: 2, status: 'failed' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [resolved] }))), /resolved/);
  const live = run({ status: 'halted' }, [{ phase: 2, status: 'failed' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [live], live: new Set([live.id]) }))), /live/);
  assert.match(skipWhy(planConvergence(facts({ runs: [run({ status: 'finished' })] }))), /finished/);
  assert.match(skipWhy(planConvergence(facts({ runs: [run({ status: 'queued' })] }))), /queued/);
  const waiting = run({ status: 'paused', stoppedBy: 'system', waitUntil: '2026-08-21T12:00:00Z' });
  assert.match(skipWhy(planConvergence(facts({ runs: [waiting] }))), /own clock/);
  assert.match(skipWhy(planConvergence(facts({ runs: [] }))), /no run/);
  // The board unreadable: nothing is decided on nothing.
  const halted = run({ status: 'halted' }, [{ phase: 2, status: 'failed' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [halted], board: null }))), /board could not be read/);
});

test('planner: killed lanes relaunch with the own-session hint; without a session the brief is a resume; capped per phase', () => {
  const killed = run({ status: 'interrupted', stoppedBy: 'system' }, [
    { phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2', resumeSessionId: 'sess-2' },
  ]);
  const plan = planConvergence(facts({ runs: [killed], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.deepEqual(kinds(plan), ['relaunch']);
  const relaunch = plan.actions[0];
  assert.ok(relaunch.kind === 'relaunch');
  assert.deepEqual(relaunch.reboard, [{
    phase: 2, situation: 'work-in-progress', rung: 'resume-own-session', brief: 'continue', sessionId: 'sess-2', by: 'converge',
  }]);
  assert.deepEqual(relaunch.rearm, []);
  assert.match(relaunch.why.join(' '), /restart killed/);

  // No session id survived: the brief is the resume block on a fresh boot.
  const sessionless = run({ status: 'interrupted', stoppedBy: 'system' }, [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2) }]);
  const p2 = planConvergence(facts({ runs: [sessionless], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.equal(p2.actions[0].kind === 'relaunch' && p2.actions[0].reboard[0].brief, 'resume');

  // Resumed MAX times already: an errand, not a fourth resume.
  const capped = run({ status: 'interrupted', stoppedBy: 'system', recoveries: { 2: { attempts: 0, lastAt: '', bootResumes: MAX_BOOT_RESUMES } } },
    [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2' }]);
  const p3 = planConvergence(facts({ runs: [capped], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.deepEqual(kinds(p3), ['errand']);
  const errand = p3.actions[0];
  assert.ok(errand.kind === 'errand' && errand.phase === 2 && /restarts in a row/.test(errand.errand.need));
  assert.deepEqual(errand.kind === 'errand' && errand.errand.tried, [`resume-at-boot ×${MAX_BOOT_RESUMES}`]);
});

test('planner: with resume-at-boot off, killed lanes wait for a person with one errand each — nothing is launched', () => {
  const killed = run({ status: 'interrupted', stoppedBy: 'system' }, [
    { phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2' },
    { phase: 3, status: 'interrupted', note: consoleStoppedNote(3) },
  ]);
  const plan = planConvergence(facts({ runs: [killed], prefs: { resumeAtBoot: false }, board: { 1: 'done', 2: 'in-progress', 3: 'in-progress' } }));
  assert.deepEqual(kinds(plan), ['errand', 'errand']);
  for (const action of plan.actions) {
    assert.ok(action.kind === 'errand' && /resuming killed lanes at boot is switched off/.test(action.errand.need), JSON.stringify(action));
    assert.ok(action.kind === 'errand' && /Resume at boot/.test(action.errand.how));
  }
});

test('planner: a shutdown between phases continues the run; the same stop by the operator does not; nothing left → nothing', () => {
  const shutdown = run({ status: 'paused', stoppedBy: 'system', finishedReason: 'the console shut down while this run was working' });
  const plan = planConvergence(facts({ runs: [shutdown] }));
  assert.deepEqual(kinds(plan), ['relaunch']);
  assert.ok(plan.actions[0].kind === 'relaunch' && plan.actions[0].reboard.length === 0);
  assert.match(plan.actions[0].kind === 'relaunch' ? plan.actions[0].why.join(' ') : '', /shut down/);
  // Scoped: the stop counts only the asked phases.
  const scoped = run({ status: 'paused', stoppedBy: 'system', onlyPhases: [1] });
  assert.match(skipWhy(planConvergence(facts({ runs: [scoped] }))), /nothing remains/);
  // An old interrupted run (no field) is NOT relaunched wholesale — it goes to the healer, which is bounded.
  const old = run({ status: 'interrupted', halt: { at: '', reason: 'nothing has been driving this run since …', phase: 2 } }, [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2) }]);
  const p2 = planConvergence(facts({ runs: [old], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.deepEqual(kinds(p2), ['relaunch'], 'a killed lane is a killed lane, whatever stamped the run');
  const oldNoLanes = run({ status: 'interrupted', halt: { at: '', reason: 'nothing has been driving this run since …' } });
  assert.deepEqual(kinds(planConvergence(facts({ runs: [oldNoLanes] }))), ['heal']);
});

test('planner: an orphaned session still alive is waited for; once it is gone the run relaunches and adopt settles it', () => {
  const orphan = run({
    status: 'parked', halt: { at: '', reason: 'a session from an earlier console is still running (pid 4242, phase 2)', kind: 'orphaned-session', phase: 2 },
    children: { 2: { pid: 4242, phase: 2, startedAt: '' } },
  }, [{ phase: 2, status: 'running', sessionId: 'sess-2' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [orphan], pidAlive: () => true }))), /still running/);
  const gone = planConvergence(facts({ runs: [orphan], pidAlive: () => false, board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.deepEqual(kinds(gone), ['relaunch']);
  assert.match(gone.actions[0].kind === 'relaunch' ? gone.actions[0].why.join(' ') : '', /outlived the earlier console has ended/);
});

test('planner: debris — an autopilot claim of a dead run is released; a live run\'s, an orphan-alive run\'s and a person\'s are kept', () => {
  const dead = run({ status: 'halted' }, [{ phase: 2, status: 'failed' }]);
  const live = run({ status: 'running' });
  const orphanAlive = run({ status: 'parked', halt: { at: '', reason: 'orphan', kind: 'orphaned-session' }, children: { 4: { pid: 99, phase: 4, startedAt: '' } } });
  const locks: LockView[] = [
    { slug: 'alpha', phase: 3, owner: `autopilot/${dead.id}`, expired: false, leaseUntil: NOW + 600_000 },
    { slug: 'alpha', phase: 5, owner: `autopilot/${dead.id}`, expired: true },
    { slug: 'alpha', phase: 4, owner: `autopilot/${live.id}`, expired: false },
    { slug: 'alpha', phase: 6, owner: `autopilot/${orphanAlive.id}`, expired: false },
    { slug: 'alpha', phase: 2, owner: 'sam@laptop/p2', expired: false, leaseUntil: NOW + 600_000 },
  ];
  const plan = planConvergence(facts({
    runs: [live, orphanAlive, dead], live: new Set([live.id]), locks,
    pidAlive: (pid) => pid === 99,
  }));
  const released = plan.actions.filter((a) => a.kind === 'release-debris');
  assert.deepEqual(released.map((a) => a.kind === 'release-debris' && [a.phase, a.owner]).sort(),
    [[3, `autopilot/${dead.id}`], [5, `autopilot/${dead.id}`]].sort(), 'expired or not, the dead run\'s own claims — nothing else');
  // The latest run is the live one: the rest of the plan is a skip.
  assert.match(skipWhy(plan), /live/);
});

test('planner: a lock-cap park re-arms when the lock it waited out is gone — and stays parked while it is held', () => {
  const parked = run({ status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing left to run on its own — phase 2 is parked' } }, [
    { phase: 2, status: 'parked', note: 'phase 2 is locked by sam@laptop/p2 and has waited 121 minutes for it — phase 2: held by sam@laptop/p2' },
  ]);
  const free = planConvergence(facts({ runs: [parked] }));
  assert.deepEqual(kinds(free), ['relaunch']);
  assert.ok(free.actions[0].kind === 'relaunch' && free.actions[0].rearm.length === 1 && free.actions[0].rearm[0] === 2);
  assert.match(free.actions[0].kind === 'relaunch' ? free.actions[0].why.join(' ') : '', /waited out is gone/);
  const held = planConvergence(facts({
    runs: [parked], locks: [{ slug: 'alpha', phase: 2, owner: 'sam@laptop/p2', expired: false, leaseUntil: NOW + 600_000 }],
  }));
  assert.ok(!kinds(held).includes('relaunch'), `still held: ${kinds(held).join(',')}`);
  // A lapsed lease is gone too.
  const lapsed = planConvergence(facts({
    runs: [parked], locks: [{ slug: 'alpha', phase: 2, owner: 'sam@laptop/p2', expired: false, leaseUntil: NOW - 1 }],
  }));
  assert.deepEqual(kinds(lapsed), ['relaunch']);
});

test('planner: the same evidence is not healed twice — until something changes, or the operator presses', () => {
  const halted = run({ status: 'halted', halt: { at: '', reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' } }, [{ phase: 2, status: 'failed' }]);
  const first = planConvergence(facts({ runs: [halted] }));
  assert.equal(first.actions[0].kind, 'heal');
  const fingerprint = first.actions[0].kind === 'heal' ? first.actions[0].fingerprint : '';
  assert.equal(fingerprint, evidenceFingerprint(halted, facts().board!, []));
  assert.match(skipWhy(planConvergence(facts({ runs: [halted], lastNoop: fingerprint }))), /nothing has changed/);
  // A lock appearing or a record moving is a change.
  const changed = planConvergence(facts({ runs: [halted], lastNoop: fingerprint, locks: [{ slug: 'alpha', phase: 2, owner: 'x/y', expired: false }] }));
  assert.equal(changed.actions[0].kind, 'heal');
  assert.equal(planConvergence(facts({ runs: [halted], lastNoop: fingerprint, trigger: 'button' })).actions[0].kind, 'heal');
});

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

function stubDeps(state: RunState, over: Partial<ConvergeDeps> = {}): ConvergeDeps & {
  started: unknown[]; journal: ConvergeDeps['journal']; lines: { runId: string; event: string; data: Record<string, unknown>; phase?: number }[];
  released: { phase: number; owner: string }[]; poked: string[];
} {
  const started: unknown[] = [];
  const lines: { runId: string; event: string; data: Record<string, unknown>; phase?: number }[] = [];
  const released: { phase: number; owner: string }[] = [];
  const poked: string[] = [];
  return {
    started, lines, released, poked,
    now: () => NOW,
    runs: () => [state],
    live: () => new Set(),
    board: async () => ({ 1: 'done', 2: 'in-progress', 3: 'waiting' }),
    locks: () => [],
    prefs: () => ({}),
    pidAlive: () => false,
    heal: async () => ({ launched: false, reason: 'nothing to climb' }),
    startRun: async (slug, options) => { started.push({ slug, ...options }); return null; },
    editRun: (_slug, _runId, apply) => { apply(state); return state; },
    releaseLock: async (_slug, phase, owner) => { released.push({ phase, owner }); return { ok: true, detail: 'released' }; },
    journal: (_slug, runId, event, data, phase) => { lines.push({ runId, event, data, ...(phase === undefined ? {} : { phase }) }); },
    locksChanged: (slug) => { poked.push(slug); },
    ...over,
  };
}

test('executor: a relaunch bumps bootResumes, journals phase.resume-at-boot + run.converge, and starts the run once', async () => {
  const state = run({ status: 'interrupted', stoppedBy: 'system', onlyPhases: [2, 3], skills: ['tdd'] }, [
    { phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2' },
  ]);
  const deps = stubDeps(state);
  const plan = planConvergence(facts({ runs: [state], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  const report = await executeConvergence(plan, deps);
  assert.equal(report.launched, true);
  assert.equal(deps.started.length, 1, 'one launch per run');
  const start = deps.started[0] as { resumeRunId: string; reboard: unknown[]; onlyPhases: number[]; skills: string[] };
  assert.equal(start.resumeRunId, state.id);
  assert.equal(start.reboard.length, 1);
  assert.deepEqual(start.onlyPhases, [2, 3], 'a scoped run keeps its scope through the relaunch');
  assert.deepEqual(start.skills, ['tdd'], 'and its skills');
  assert.equal(state.recoveries?.['2']?.bootResumes, 1, 'the resume is counted on the run');
  assert.ok(deps.lines.some((l) => l.event === 'phase.resume-at-boot' && l.phase === 2 && l.data.count === 1 && l.data.sessionId === 'sess-2'));
  assert.ok(deps.lines.some((l) => l.event === 'run.converge' && l.data.action === 'relaunch'));
});

test('executor: debris release journals run.lock-debris-released on the DEAD run and pokes the locks', async () => {
  const dead = run({ status: 'halted', resolved: { at: '', auto: true, reason: 'superseded' } });
  const deps = stubDeps(dead, { locks: () => [{ slug: 'alpha', phase: 3, owner: `autopilot/${dead.id}`, expired: false }] });
  const plan = planConvergence(facts({ runs: [dead], locks: deps.locks('alpha') }));
  assert.deepEqual(kinds(plan), ['release-debris', 'skip']);
  const report = await executeConvergence(plan, deps);
  assert.deepEqual(deps.released, [{ phase: 3, owner: `autopilot/${dead.id}` }]);
  assert.deepEqual(deps.poked, ['alpha']);
  const line = deps.lines.find((l) => l.event === 'run.lock-debris-released');
  assert.equal(line?.runId, dead.id);
  assert.equal(line?.phase, 3);
  assert.equal(line?.data.ok, true);
  assert.equal(report.launched, false);
});

test('executor: an errand lands on the record and in the journal; a heal that finds nothing sets the noop fingerprint', async () => {
  const off = run({ status: 'interrupted', stoppedBy: 'system' }, [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2) }]);
  const deps = stubDeps(off, { prefs: () => ({ resumeAtBoot: false }) });
  const report = await executeConvergence(planConvergence(facts({ runs: [off], prefs: { resumeAtBoot: false }, board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } })), deps);
  assert.equal(off.recoveries?.['2']?.errand?.situation, 'work-in-progress');
  assert.ok(deps.lines.some((l) => l.event === 'phase.errand' && l.phase === 2));
  assert.equal(report.errands.length, 1);
  assert.equal(deps.started.length, 0);

  const halted = run({ status: 'halted', halt: { at: '', reason: 'x', phase: 2 } }, [{ phase: 2, status: 'failed' }]);
  const d2 = stubDeps(halted);
  const plan = planConvergence(facts({ runs: [halted] }));
  const r2 = await executeConvergence(plan, d2);
  assert.equal(r2.noop, plan.actions[0].kind === 'heal' ? plan.actions[0].fingerprint : null, 'remembered so the same evidence is not re-read');
  assert.ok(d2.lines.some((l) => l.event === 'run.converge' && l.data.action === 'heal' && l.data.launched === false));
  const d3 = stubDeps(halted, { heal: async () => ({ launched: true, phase: 2, situation: 'verify-red', rung: 'resume-own-session', vehicle: 'session' }) });
  const r3 = await executeConvergence(plan, d3);
  assert.equal(r3.noop, null);
  assert.equal(r3.launched, true);
});

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

class FakeClock {
  time = NOW;
  now = (): number => this.time;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timers = this.timers.filter((t) => t.id !== handle); };
  /** Advance, firing every timer due on the way, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
    await new Promise((resolve) => setImmediate(resolve));
  }
  pendingCount(): number { return this.timers.length; }
}

function scheduler(opts: { everyMs?: number; slugs?: string[]; run?: (slug: string, trigger: ConvergeTrigger) => Promise<ConvergeReport | null> } = {}) {
  const clock = new FakeClock();
  const passes: { slug: string; trigger: ConvergeTrigger; at: number }[] = [];
  const s = new ConvergeScheduler({
    run: async (slug, trigger) => {
      passes.push({ slug, trigger, at: clock.time });
      return opts.run ? opts.run(slug, trigger) : null;
    },
    slugs: () => opts.slugs ?? ['alpha'],
    everyMs: () => opts.everyMs,
    clock,
  });
  return { s, clock, passes };
}

test('scheduler: change is a trailing debounce, the halt\'s quiet minute is not shortened by a change, the button is now', async () => {
  const { s, clock, passes } = scheduler();
  s.request('alpha', 'change');
  await clock.advance(500);
  s.request('alpha', 'change');
  await clock.advance(500);
  s.request('alpha', 'change');
  await clock.advance(CHANGE_DEBOUNCE_MS - 1);
  assert.equal(passes.length, 0, 'a burst of writes is one pass after the LAST of them');
  await clock.advance(1);
  await s.idle();
  assert.deepEqual(passes.map((p) => p.trigger), ['change']);
  assert.equal(passes[0].at, NOW + 1000 + CHANGE_DEBOUNCE_MS);

  s.request('beta', 'halt');
  await clock.advance(1000);
  s.request('beta', 'change');
  await clock.advance(CHANGE_DEBOUNCE_MS + 1000);
  assert.equal(passes.filter((p) => p.slug === 'beta').length, 0, 'the minute stands');
  await clock.advance(HALT_DELAY_MS);
  await s.idle();
  assert.deepEqual(passes.filter((p) => p.slug === 'beta').map((p) => p.trigger), ['halt']);

  s.request('gamma', 'halt');
  const report = await s.converge('gamma', 'button');
  assert.equal(report, null, 'the stub run answers null');
  assert.deepEqual(passes.filter((p) => p.slug === 'gamma').map((p) => p.trigger), ['button'], 'now, and the pending halt is folded into it');
  await clock.advance(HALT_DELAY_MS * 2);
  assert.equal(passes.filter((p) => p.slug === 'gamma').length, 1);
  s.close();
});

test('scheduler: the sweep visits every plan each interval (floored), re-armed after it completes; close stops it', async () => {
  const { s, clock, passes } = scheduler({ everyMs: 1_000, slugs: ['alpha', 'beta'] });
  s.start();
  await clock.advance(MIN_SWEEP_MS - 1);
  assert.equal(passes.length, 0, 'a preference below the floor is read as the floor');
  await clock.advance(1);
  await s.idle();
  assert.deepEqual(passes.map((p) => `${p.slug}:${p.trigger}`), ['alpha:timer', 'beta:timer']);
  await clock.advance(MIN_SWEEP_MS);
  await s.idle();
  assert.equal(passes.length, 4, 'and again next interval');
  s.close();
  await clock.advance(MIN_SWEEP_MS * 3);
  assert.equal(passes.length, 4, 'closed: nothing more');
});

test('scheduler: single-flight — requests during a pass queue ONE re-run; the boot pass is every plan now', async () => {
  let release: (() => void) | null = null;
  const { s, clock, passes } = scheduler({
    run: () => new Promise<ConvergeReport | null>((resolve) => { release = () => resolve(null); }),
  });
  s.request('alpha', 'boot');
  await clock.advance(0);
  assert.equal(passes.length, 1);
  s.request('alpha', 'change', 0);
  s.request('alpha', 'halt', 0);
  await clock.advance(10);
  assert.equal(passes.length, 1, 'nothing runs beside the pass in flight');
  release!();
  await clock.advance(0);
  await clock.advance(0);
  assert.equal(passes.length, 2, 'one re-run, not two');
  release!();
  await clock.advance(0);
  assert.equal(passes.length, 2);
  const booted = s.boot(['alpha', 'beta']);
  await clock.advance(0);
  assert.deepEqual(passes.slice(2).map((p) => `${p.slug}:${p.trigger}`), ['alpha:boot'], 'one plan at a time');
  release!();
  await clock.advance(0);
  await clock.advance(0);
  assert.deepEqual(passes.slice(2).map((p) => `${p.slug}:${p.trigger}`), ['alpha:boot', 'beta:boot']);
  release!();
  await booted;
  s.close();
});

/* ------------------------------------------------------------------ *
 * The service, end to end
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-converge-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function gitInit(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });
}

function handoff(root: string, phase: number, title: string, status: string): void {
  const pad = String(phase).padStart(2, '0');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', `phase-${pad}-${title}.md`), `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: ${status}
---
# Phase ${phase} — ${title}
`, 'utf8');
}

/** A lock exactly as `phase-lock.sh claim` writes it. */
function claim(root: string, slug: string, phase: number, owner: string, leaseFromNowS: number): string {
  const dir = join(root, 'docs', 'handoffs', slug, '.locks');
  mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const file = lockPath(join(root, 'docs', 'handoffs'), slug, phase);
  writeFileSync(file, [`slug=${slug}`, `phase=${phase}`, `owner=${owner}`, 'host=test', `claimed_at=${now - 60}`, `lease_until=${now + leaseFromNowS}`, ''].join('\n'), 'utf8');
  return file;
}

/** The converge-on flag set a console built from argv carries; a bare harness has it off. */
function service(root: string, flags: Record<string, unknown> = {}, before?: (svc: InstanceType<typeof Service>) => void) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: SCRIPTS, logFile: null, converge: true, ...flags,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  before?.(svc);
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** The boot work done — queued runs re-adopted, the boot pass over every plan complete. */
async function settle(svc: InstanceType<typeof Service>): Promise<void> {
  await svc.bootSettled;
  await svc.converger.idle();
}

function journalEvents(root: string, runId: string): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, 'alpha', runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; phase?: number; data: Record<string, unknown> });
}

test('service: with no reads and no runner events, a stopped run with a re-boardable record is re-boarded within one sweep (fake clock)', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const clock = new FakeClock();
    clock.time = Date.now();
    const retried: number[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.convergeEveryMs = MIN_SWEEP_MS;
      s.converger.setClock(clock);
      (s as never as { retryPhase: (slug: string, phase: number) => Promise<null> }).retryPhase =
        async (_slug: string, phase: number) => { retried.push(phase); return null; };
    });
    try {
      // Boot found nothing (no run yet). Now the P12 shape lands on disk with
      // nobody reading it: parked, one interrupted never-started record.
      await settle(svc);
      const state = newRun({ slug: 'alpha', root, autoRecover: true });
      state.status = 'parked';
      state.activePhase = null;
      state.halt = { at: new Date().toISOString(), reason: 'nothing left to run on its own — phase 1 is interrupted (stopped by the operator)' };
      const record = phaseRecord(state, 1);
      record.status = 'interrupted';
      record.note = 'stopped by the operator';
      record.startedAt = new Date(Date.now() + 5_000).toISOString();
      saveRun(state);

      await clock.advance(MIN_SWEEP_MS - 1);
      await svc.converger.idle();
      assert.deepEqual(retried, [], 'not before the interval');
      await clock.advance(1);
      await svc.converger.idle();
      assert.deepEqual(retried, [1], 'the healer re-boarded the never-started phase through the runner, unasked');
      const report = svc.convergeReports().find((r) => r.slug === 'alpha')!;
      assert.equal(report.trigger, 'timer');
      assert.equal(report.launched, true);
      assert.ok(report.actions.some((a) => a.kind === 'heal'));
      const events = journalEvents(root, state.id);
      assert.ok(events.some((e) => e.event === 'run.converge' && e.data.trigger === 'timer' && e.data.launched === true));
      assert.ok(events.some((e) => e.event === 'phase.rung' && e.data.rung === 'reboard-fresh'));
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('service: a stop event asks for a pass a minute out; without the converge flag nothing is armed', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    try {
      await settle(svc);
      const state = newRun({ slug: 'alpha', root, autoRecover: true });
      state.status = 'halted';
      state.halt = { at: new Date().toISOString(), reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' };
      (svc as never as { onRunnerEvent: (event: string, data: unknown) => void }).onRunnerEvent('run:run', { state });
      const snap = svc.converger.snapshot();
      assert.equal(snap.pending.length, 1);
      assert.equal(snap.pending[0].trigger, 'halt');
      assert.ok(snap.pending[0].dueAt - Date.now() > HALT_DELAY_MS - 2_000);
    } finally { svc.close(); }

    const bare = service(root, { converge: undefined });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const state = newRun({ slug: 'alpha', root, autoRecover: true });
      state.status = 'halted';
      state.halt = { at: new Date().toISOString(), reason: 'x', phase: 2, kind: 'verify-failed' };
      (bare as never as { onRunnerEvent: (event: string, data: unknown) => void }).onRunnerEvent('run:run', { state });
      assert.equal(bare.converger.snapshot().pending.length, 0, 'a harness that never asked for the loop does not get it');
      assert.deepEqual(bare.convergeSlugs(), []);
    } finally { bare.close(); }
  } finally { cleanup(); }
});

test('service: at boot, lanes a console restart killed resume their own session through the runner', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    handoff(root, 2, 'cart-api', 'in-progress');
    // The shutdown checkpoint's shape: paused by the system, phase 2's lane
    // interrupted with the killed-lane note and its session kept for --resume.
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'paused';
    state.stoppedBy = 'system';
    state.finishedReason = 'the console shut down while this run was working';
    const one = phaseRecord(state, 1); one.status = 'done';
    const two = phaseRecord(state, 2);
    two.status = 'interrupted';
    two.note = consoleStoppedNote(2);
    two.sessionId = 'sess-2';
    two.resumeSessionId = 'sess-2';
    saveRun(state);

    const started: { slug: string; options: Record<string, unknown> }[] = [];
    const svc = service(root, {}, (s) => {
      (s as never as { startRun: (slug: string, options: Record<string, unknown>) => Promise<unknown> }).startRun =
        async (slug: string, options: Record<string, unknown>) => { started.push({ slug, options }); return null; };
    });
    try {
      await settle(svc);
      assert.equal(started.length, 1, 'one launch at boot');
      assert.equal(started[0].options.resumeRunId, state.id);
      assert.deepEqual(started[0].options.reboard, [{
        phase: 2, situation: 'work-in-progress', rung: 'resume-own-session', brief: 'continue', sessionId: 'sess-2', by: 'converge',
      }]);
      const disk = loadRun(root, 'alpha', state.id, null)!;
      assert.equal(disk.recoveries?.['2']?.bootResumes, 1);
      const events = journalEvents(root, state.id);
      assert.ok(events.some((e) => e.event === 'phase.resume-at-boot' && e.phase === 2 && e.data.sessionId === 'sess-2'));
      assert.ok(events.some((e) => e.event === 'run.converge' && e.data.trigger === 'boot' && e.data.action === 'relaunch'));
      const report = svc.convergeReports().find((r) => r.slug === 'alpha')!;
      assert.equal(report.trigger, 'boot');
      assert.equal(report.launched, true);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('service: with resume-at-boot off, the killed lane waits for a person with an errand — nothing launched', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'interrupted';
    state.stoppedBy = 'system';
    const two = phaseRecord(state, 2);
    two.status = 'interrupted';
    two.note = consoleStoppedNote(2);
    two.sessionId = 'sess-2';
    saveRun(state);

    const started: unknown[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.resumeAtBoot = false;
      (s as never as { startRun: (slug: string, options: unknown) => Promise<unknown> }).startRun =
        async (_slug: string, options: unknown) => { started.push(options); return null; };
    });
    try {
      await settle(svc);
      assert.equal(started.length, 0);
      const disk = loadRun(root, 'alpha', state.id, null)!;
      const errand = disk.recoveries?.['2']?.errand;
      assert.ok(errand, 'the one ask is on the record');
      assert.match(errand!.need, /switched off/);
      assert.match(errand!.how, /Resume at boot/);
      assert.ok(journalEvents(root, state.id).some((e) => e.event === 'phase.errand' && e.phase === 2));
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('service: at boot, an autopilot claim of a dead run is released through phase-lock.sh and journalled; a person\'s live claim stays', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    // A dead run — halted and already resolved, so the only thing the pass
    // can do for it is free what it left behind.
    const dead = newRun({ slug: 'alpha', root });
    dead.status = 'halted';
    dead.halt = { at: new Date().toISOString(), reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' };
    dead.resolved = { at: new Date().toISOString(), auto: false, reason: 'dismissed', by: 'sam' };
    phaseRecord(dead, 2).status = 'failed';
    saveRun(dead);
    const ours = claim(root, 'alpha', 2, `autopilot/${dead.id}`, 1200);
    const theirs = claim(root, 'alpha', 3, 'sam@laptop/p3', 1200);

    const svc = service(root);
    try {
      await settle(svc);
      assert.equal(existsSync(ours), false, 'the dead run\'s unexpired claim is gone');
      assert.equal(existsSync(theirs), true, 'the person\'s claim is not ours to touch');
      assert.equal(readLock(join(root, 'docs', 'handoffs'), 'alpha', 3)?.owner, 'sam@laptop/p3');
      const line = journalEvents(root, dead.id).find((e) => e.event === 'run.lock-debris-released');
      assert.ok(line, 'journalled on the dead run');
      assert.equal(line!.phase, 2);
      assert.equal(line!.data.ok, true);
      assert.equal(line!.data.owner, `autopilot/${dead.id}`);
      const report = svc.convergeReports().find((r) => r.slug === 'alpha')!;
      assert.ok(report.actions.some((a) => a.kind === 'release-debris'));
      assert.ok(report.actions.some((a) => a.kind === 'skip' && /resolved/.test(a.why)), 'the resolved run itself is pinned');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('service: a lock-cap park on a stopped run re-arms and the run relaunches once the lock is gone', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'parked';
    state.stoppedBy = 'system';
    state.halt = { at: new Date().toISOString(), reason: 'nothing left to run on its own — phase 2 is parked (phase 2 is locked by sam@laptop/p2 and has waited 121 minutes for it)' };
    phaseRecord(state, 1).status = 'done';
    const two = phaseRecord(state, 2);
    two.status = 'parked';
    two.note = 'phase 2 is locked by sam@laptop/p2 and has waited 121 minutes for it — phase 2: held by sam@laptop/p2 since now';
    saveRun(state);
    claim(root, 'alpha', 2, 'sam@laptop/p2', 1200);

    const started: unknown[] = [];
    const svc = service(root, {}, (s) => {
      (s as never as { startRun: (slug: string, options: unknown) => Promise<unknown> }).startRun =
        async (_slug: string, options: unknown) => { started.push(options); return null; };
    });
    try {
      await settle(svc);
      assert.equal(started.length, 0, 'held: the park stands');
      // The holder releases — the docs watcher would see it; the press stands in for the change trigger here.
      rmSync(lockPath(join(root, 'docs', 'handoffs'), 'alpha', 2));
      svc.invalidateAll();
      const report = await svc.converger.converge('alpha', 'change');
      assert.ok(report?.actions.some((a) => a.kind === 'relaunch' && a.rearm.includes(2)), JSON.stringify(report?.actions));
      assert.equal(started.length, 1);
      const disk = loadRun(root, 'alpha', state.id, null)!;
      assert.equal(disk.phases['2'].status, 'pending', 'reset for the boarding, no Retry pressed');
      assert.ok(journalEvents(root, state.id).some((e) => e.event === 'phase.lock-cap-rearmed' && e.phase === 2));
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Presence (Phase 5): a session's claim is debris the moment its session ends
 * ------------------------------------------------------------------ */

const { endedSessionLocks } = await import('../server/converge.ts');

test('planner: a lock naming a session the registry shows ENDED is released — a person\'s or a foreign run\'s — and a live run\'s own claim is not', () => {
  const r = run({ status: 'halted', halt: { at: '', reason: 'x' } }, [{ phase: 2, status: 'failed' }]);
  const locks: LockView[] = [
    { slug: 'alpha', phase: 2, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000, session: 'ended-1' },
    { slug: 'alpha', phase: 3, owner: 'autopilot/deadbeef', expired: false, leaseUntil: NOW + 3_600_000, session: 'ended-2' },
    { slug: 'alpha', phase: 1, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000, session: 'live-1' },
    { slug: 'alpha', phase: 4, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000 },
  ];
  const presence = (lock: LockView) => (lock.session?.startsWith('ended') ? 'ended' : lock.session ? 'live' : 'unknown');
  assert.deepEqual(endedSessionLocks(locks, new Set(), presence).map((l) => l.phase), [2, 3]);
  assert.deepEqual(endedSessionLocks(locks, new Set(['deadbeef']), presence).map((l) => l.phase), [2], 'a live run\'s lane is its runner\'s to release');
  assert.deepEqual(endedSessionLocks(locks, new Set()).map((l) => l.phase), [], 'no registry, no verdict');
  const plan = planConvergence(facts({ runs: [r], locks, presence }));
  const debris = plan.actions.filter((a) => a.kind === 'release-debris');
  assert.deepEqual(debris.map((a) => a.kind === 'release-debris' && [a.phase, a.owner, a.runId, a.session]),
    [[2, 'sam@laptop', null, 'ended-1'], [3, 'autopilot/deadbeef', null, 'ended-2']]);
  assert.match((debris[0] as { why: string }).why, /session ended-1 has ended/);
  // The healer still runs for the run itself.
  assert.ok(kinds(plan).includes('heal'));
});

test('planner: a lock-cap park re-arms when the lock it waited on is held by an ENDED session', () => {
  const r = run({ status: 'halted', stoppedBy: 'system', halt: { at: '', reason: 'x' } }, [
    { phase: 2, status: 'parked', note: 'phase 2 is locked by sam@laptop and has waited 121 minutes for it — held' },
  ]);
  const locks: LockView[] = [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000, session: 'gone' }];
  const held = planConvergence(facts({ runs: [r], locks }));
  assert.ok(!kinds(held).includes('relaunch'), 'without the registry the unexpired lock still holds the park');
  const freed = planConvergence(facts({ runs: [r], locks, presence: () => 'ended' }));
  const relaunch = freed.actions.find((a) => a.kind === 'relaunch');
  assert.ok(relaunch && relaunch.kind === 'relaunch' && relaunch.rearm.includes(2), skipWhy(freed));
});

test('executor: a session\'s debris (runId null) is released as its owner and journalled on the plan\'s latest run', async () => {
  const state = run({ status: 'halted', halt: { at: '', reason: 'x' } }, [{ phase: 2, status: 'failed' }]);
  const deps = stubDeps(state);
  const plan = {
    slug: 'alpha', trigger: 'change' as const, at: new Date(NOW).toISOString(),
    actions: [
      { kind: 'release-debris' as const, runId: null, phase: 2, owner: 'sam@laptop', session: 'gone', why: 'an unexpired claim of sam@laptop, whose session gone has ended' },
      { kind: 'skip' as const, runId: state.id, why: 'the healer already ran' },
    ],
  };
  const report = await executeConvergence(plan, deps);
  assert.equal(report.outcomes[0].ok, true);
  assert.deepEqual(deps.released, [{ phase: 2, owner: 'sam@laptop' }]);
  const line = deps.lines.find((j) => j.event === 'run.lock-debris-released');
  assert.ok(line, 'journalled');
  assert.equal(line!.runId, state.id, 'on the latest run, since the claim has no run of its own');
  assert.equal(line!.data.session, 'gone');
});
