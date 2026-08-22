/**
 * The convergence loop — "converge, classify, climb" with nobody looking.
 *
 * Everything the console can decide about a STOPPED run, it decides here, on
 * a clock as well as on events: at boot, when the docs change, every
 * `convergeEveryMs`, a minute after a halt, and on the operator's Recover &
 * continue press. One orchestration, through the runner — this loop never
 * spawns a session itself; it releases what is dead, hints boardings, writes
 * errands, and hands the run back to `startRun`, which is the only thing that
 * drives phases. Before it existed the same work ran only on live ticks, on
 * HTTP reads, or sixty seconds after a halt: a plan nobody looked at healed
 * nobody, and a lane the console's own restart killed stayed dead until a
 * person pressed Continue.
 *
 * Three parts, kept apart so each can be tested without the others:
 *
 *   `planConvergence(facts)` — PURE. Reads the plan's runs, their records,
 *   the locks and the board, and returns typed actions with the reason for
 *   each — including the reasons for doing NOTHING (a run the operator
 *   stopped, a resolved run, a live run), because "the loop looked and left it
 *   alone" is an answer the Pulse must be able to show.
 *
 *   `executeConvergence(plan, deps)` — the executor: releases debris locks,
 *   relaunches the run with re-board hints, writes errands, and runs the
 *   healer (`Service.maybeAutoRecover`: classify + ladder + drive, which
 *   predates this loop and is now its rung-climbing step).
 *
 *   `ConvergeScheduler` — the clock: per-plan debounce for docs changes, the
 *   quiet minute after a halt, the periodic sweep, single-flight per plan.
 *   Timers come from an injectable clock so a test can drive five minutes in
 *   five milliseconds.
 *
 * Two promises the code is built around. **An operator's stop is respected**:
 * a run paused or stopped by a person (`stoppedBy: 'operator'`), or one a
 * person dismissed (`resolved`), is pinned — the loop reads it and leaves it,
 * and only the operator's own press overrides that. **Every act is journalled
 * and bounded**: debris releases and boot resumes each carry a journal line on
 * the run they touch, a boot resume is capped per phase, and the ladder's own
 * caps (count and dollars) bound everything the healer launches.
 */

import { LOCK_CAP_PARK_NOTE, type ReboardRequest } from './runner/runner.ts';
import { autopilotRunId, debrisLocks, type LockView } from './runner/scheduler.ts';
import {
  CONSOLE_STOPPED_NOTE, IN_FLIGHT, childrenOf, resetForRetry, pidAlive as realPidAlive,
  type Errand, type PhaseRecord, type RunState,
} from './runner/state.ts';
import { log } from './log.ts';

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

export type ConvergeTrigger = 'boot' | 'change' | 'timer' | 'halt' | 'button';

/** Trailing debounce for a docs change: a handoff commit lands as a burst of writes. */
export const CHANGE_DEBOUNCE_MS = 2_000;
/**
 * The quiet minute after a halt. The halt event fires while lanes are still
 * draining and the operator may be watching and about to act; a console that
 * launches something the same second something breaks is a console nobody
 * can get ahead of. (The value `scheduleAutoRecover` always used.)
 */
export const HALT_DELAY_MS = 60_000;
/** The periodic sweep's floor — a preference below it is read as this. */
export const MIN_SWEEP_MS = 30_000;
/** The periodic sweep's default, when the preference says nothing. */
export const DEFAULT_SWEEP_MS = 300_000;
/**
 * How many times one phase's own session is resumed after console restarts
 * killed its lane. A lane killed by three restarts in a row is a console
 * problem a person should hear about — not a loop to run for ever.
 */
export const MAX_BOOT_RESUMES = 3;

const DEFAULT_DELAY: Record<ConvergeTrigger, number> = {
  boot: 0, button: 0, timer: 0, change: CHANGE_DEBOUNCE_MS, halt: HALT_DELAY_MS,
};

/** What the planner reads. Everything is a value; nothing here talks to a disk or a process. */
export type ConvergeFacts = {
  slug: string;
  /** Epoch ms. */
  now: number;
  trigger: ConvergeTrigger;
  /** The engine's board states for the plan, or null when it could not be read. */
  board: Record<number, string> | null;
  /** Every run of the plan, newest first, as loaded (already reconciled). */
  runs: readonly RunState[];
  /** Ids of runs this console is driving right now. */
  live: ReadonlySet<string>;
  /** Locks on disk for this plan, any phase. */
  locks: readonly LockView[];
  prefs: { resumeAtBoot?: boolean };
  /** Is a recorded child pid still alive? Injectable so a fixture can say. */
  pidAlive?: (pid: number) => boolean;
  /**
   * The session registry's word on the session a lock names (Phase 5):
   * `ended` — its SessionEnd arrived or its process is gone, so the lock is
   * debris NOW whatever the lease says; `live` — a person is in it; `unknown`
   * — nothing reports it and lease rules decide. Absent: every lock `unknown`.
   */
  presence?: (lock: LockView) => 'live' | 'ended' | 'unknown';
  /**
   * The plan's gate decisions, as a cheap stamp (`gate-status.md`'s mtime and
   * size). It is in the FACTS because it is in the fingerprint: approving a
   * manual gate changes neither the run, its records, nor the board word — the
   * phase reads `ready` before and after — so without this the healer's "found
   * nothing to climb" latches forever and the person who did exactly what the
   * errand asked is never answered. Null when the file does not exist yet.
   */
  gateStamp?: string | null;
  /**
   * The QA verdicts the board reported (`--memory-block`'s `blocked:` line),
   * keyed by the phase whose verdict holds others. In the FACTS because it is
   * in the fingerprint, for exactly the reason `gateStamp` is: recording a
   * verdict changes neither the run, its records, nor the blocking phase's
   * board word.
   */
  qa?: Record<number, string> | null;
  /**
   * The fingerprint of the latest run's open records at the last pass that
   * healed nothing. The same evidence yields the same answer, so the healer —
   * and its journal lines — are not run again until something changes.
   * Ignored on the operator's press, which always asks afresh.
   */
  lastNoop?: string | null;
};

export type ConvergeAction =
  /**
   * A lock held by a run nothing is driving, or by a session the registry
   * shows ENDED: released through the runner's own owner. `runId` is the dead
   * run's for the first shape and null for a session's claim (a person's, or
   * another console's) — the journal line then goes on the plan's latest run.
   */
  | { kind: 'release-debris'; runId: string | null; phase: number; owner: string; why: string; session?: string }
  /**
   * Start the run again under normal admission: killed lanes re-board with a
   * hint (their own session where one exists), lock-cap parks whose lock is
   * gone are reset, and a run the console's own shutdown stopped simply
   * continues. ONE launch per run, whatever the reasons.
   */
  | { kind: 'relaunch'; runId: string; reboard: ReboardRequest[]; rearm: number[]; why: string[] }
  /** A person is asked, once, with what is needed and how to give it. `phase` null = run level. */
  | { kind: 'errand'; runId: string; phase: number | null; errand: Errand; why: string }
  /** Classify the open phases and climb the ladder — the healer. */
  | { kind: 'heal'; runId: string; fingerprint: string; why: string }
  /** Looked, and left it alone — with the reason. */
  | { kind: 'skip'; runId: string | null; why: string };

export type ConvergePlan = {
  slug: string;
  trigger: ConvergeTrigger;
  at: string;
  actions: ConvergeAction[];
};

/* ------------------------------------------------------------------ *
 * Reading a run
 * ------------------------------------------------------------------ */

/**
 * Was this run's last stop the operator's? `stoppedBy` answers when it is
 * there. Records written before the field existed fall back on the shapes the
 * operator's verbs have always written — a pause, a stop in flight, the
 * stored-run "stopped by the operator" halt — and on nothing else: a halt or
 * a park the loop wrote itself is the system's.
 */
export function stoppedByOperator(run: RunState): boolean {
  if (run.stoppedBy) return run.stoppedBy === 'operator';
  if (run.status === 'paused' || run.status === 'pausing' || run.status === 'stopping') return true;
  if (run.pause) return true;
  if (run.halt?.reason === 'stopped by the operator') return true;
  return false;
}

/**
 * Nothing is driving this run and nothing will: not this console, not a
 * process still claiming it in flight, not an orphaned session still writing.
 * Its lanes are gone and its locks are debris.
 */
export function runIsDead(
  run: RunState, live: ReadonlySet<string>, pidAlive: (pid: number) => boolean = realPidAlive,
): boolean {
  if (live.has(run.id)) return false;
  if (IN_FLIGHT.includes(run.status) || run.status === 'queued') return false;
  if (childrenOf(run).some((child) => pidAlive(child.pid))) return false;
  return true;
}

/** The run a plan is "on" — the same answer `latestRun` gives: the one still open, else the newest. */
export function latestOf(runs: readonly RunState[]): RunState | null {
  return runs.find((run) => run.status !== 'finished') ?? runs[0] ?? null;
}

/** The killed-lane records: interrupted by a console that went away, and not done since. */
export function killedLanes(run: RunState, board: Record<number, string>): PhaseRecord[] {
  return Object.values(run.phases)
    .filter((record) => record.status === 'interrupted' && CONSOLE_STOPPED_NOTE.test(record.note ?? ''))
    .filter((record) => board[record.phase] !== 'done')
    .sort((a, b) => a.phase - b.phase);
}

/** Is the phase's lock held, unexpired — and not by a session that has ended — by anyone but this run? */
function heldByAnother(
  locks: readonly LockView[], phase: number, runId: string, now: number,
  presence?: (lock: LockView) => 'live' | 'ended' | 'unknown',
): boolean {
  return locks.some((lock) => lock.phase === phase
    && autopilotRunId(lock.owner) !== runId
    && !lock.expired
    && (lock.leaseUntil == null || lock.leaseUntil > now)
    && presenceOfLock(lock, presence) !== 'ended');
}

function presenceOfLock(lock: LockView, presence?: (lock: LockView) => 'live' | 'ended' | 'unknown'): 'live' | 'ended' | 'unknown' {
  if (!lock.session || !presence) return 'unknown';
  try { return presence(lock); } catch { return 'unknown'; }
}

/**
 * Locks whose SESSION the registry shows ended — a person's claim, another
 * console's, an autopilot lane's whose run is still on disk as live elsewhere
 * — minus this console's own live runs' claims (their runners release their
 * own). Only a lock that NAMES its session can be debris this way: matching a
 * session to a lock by owner and time is display, never release.
 */
export function endedSessionLocks(
  locks: readonly LockView[], live: ReadonlySet<string>,
  presence?: (lock: LockView) => 'live' | 'ended' | 'unknown',
): LockView[] {
  return locks.filter((lock) => {
    if (!lock.session) return false;
    const runId = autopilotRunId(lock.owner);
    if (runId && live.has(runId)) return false;
    return presenceOfLock(lock, presence) === 'ended';
  });
}

/**
 * The evidence the healer would read, as a string: the same evidence gives the
 * same verdict, and a verdict of "nothing to climb" need not be re-derived —
 * and re-journalled — every five minutes. Locks are part of it (a holder
 * releasing IS a change); the clock is not.
 *
 * `gateStamp` is part of it for the same reason locks are, and it is the one
 * that was missing: clearing a manual gate changes nothing else this function
 * reads — not the run, not its records, not the board word — so the healer kept
 * skipping with "nothing has changed" against a gate a person had just
 * approved.
 */
export function evidenceFingerprint(
  run: RunState, board: Record<number, string>, locks: readonly LockView[], gateStamp?: string | null,
  qa?: Record<number, string> | null,
): string {
  const phases = Object.values(run.phases)
    .sort((a, b) => a.phase - b.phase)
    .map((r) => [r.phase, r.status, r.attempts, r.endedAt ?? '', (r.note ?? '').slice(0, 120), board[r.phase] ?? '']);
  const held = locks
    .map((l) => [l.phase, l.owner, l.expired ? 1 : 0, l.leaseUntil ?? 0])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  // The WHOLE board, not just the phases this run happens to hold a record for.
  // `phases` above samples `board[r.phase]`, so a phase that was never boarded
  // going `waiting` -> `ready` — which is precisely the event meaning "this run
  // can move again" — did not register at all, and the loop that exists to
  // notice it skipped with "nothing has changed".
  const words = Object.keys(board)
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    .map((p) => [p, board[p]]);
  // And the QA verdicts, for the same reason the gate stamp is here: recording
  // pass or waived for the phase whose verdict wedged the plan moves neither
  // the run, nor its records, nor that phase's board word — it reads `done`
  // before and after. Without this the healer's "found nothing to climb"
  // latches for ever against a plan a person has just repaired.
  const verdicts = Object.keys(qa ?? {})
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    .map((p) => [p, qa![p]]);
  return JSON.stringify([run.id, run.status, run.halt?.at ?? '', run.halt?.reason ?? '', run.resolved?.at ?? '', phases, held, gateStamp ?? '', words, verdicts]);
}

function resumeErrand(phase: number, at: string, why: 'off' | 'capped', sessionId?: string): Errand {
  const session = sessionId ? `session ${sessionId}` : 'its session';
  return {
    phase,
    situation: 'work-in-progress',
    tried: why === 'capped' ? [`resume-at-boot ×${MAX_BOOT_RESUMES}`] : [],
    need: why === 'off'
      ? `Someone to continue phase ${phase} — its lane was cut off by a console restart, and resuming `
        + 'killed lanes at boot is switched off on this console.'
      : `A look at phase ${phase} before it is resumed again — the console has resumed ${session} after `
        + `${MAX_BOOT_RESUMES} restarts in a row and the phase still has not landed.`,
    how: why === 'off'
      ? 'Press Continue on the run (it resumes the session), or turn Settings ▸ Automation ▸ Resume at boot on '
        + 'and the console does it by itself next time.'
      : 'Open the phase (Why is this not done?), then Continue or Retry — or stop the run if it should not go on.',
    at,
  };
}

/* ------------------------------------------------------------------ *
 * The planner
 * ------------------------------------------------------------------ */

export function planConvergence(facts: ConvergeFacts): ConvergePlan {
  const actions: ConvergeAction[] = [];
  const at = new Date(facts.now).toISOString();
  const plan: ConvergePlan = { slug: facts.slug, trigger: facts.trigger, at, actions };
  const pidAlive = facts.pidAlive ?? realPidAlive;
  const skip = (runId: string | null, why: string): ConvergePlan => { actions.push({ kind: 'skip', runId, why }); return plan; };

  /* Debris first, across EVERY run of the plan: a relaunch below would queue
   * behind its own dead claim otherwise. Only autopilot-shaped owners of runs
   * this console can see are dead; a person's claim is never debris to us. */
  const dead = new Set(facts.runs.filter((run) => runIsDead(run, facts.live, pidAlive)).map((run) => run.id));
  const released = new Set<string>();
  for (const lock of debrisLocks(facts.locks, dead)) {
    released.add(`${lock.phase}:${lock.owner}`);
    actions.push({
      kind: 'release-debris', runId: autopilotRunId(lock.owner)!, phase: lock.phase, owner: lock.owner,
      why: `${lock.expired ? 'an expired' : 'an unexpired'} claim of run ${autopilotRunId(lock.owner)}, which nothing is driving`,
    });
  }
  /* Then the claims of sessions the registry shows ENDED — the presence channel
   * (Phase 5): a person's session that wrote its lock and closed, a lane of a
   * run some other console drove. The lease would free them in half an hour;
   * the registry knows now. A session's own run id, when it has one, labels the
   * journal line; a person's claim goes on the latest run. */
  for (const lock of endedSessionLocks(facts.locks, facts.live, facts.presence)) {
    if (released.has(`${lock.phase}:${lock.owner}`)) continue;
    released.add(`${lock.phase}:${lock.owner}`);
    const runId = autopilotRunId(lock.owner);
    actions.push({
      kind: 'release-debris', runId: runId && dead.has(runId) ? runId : null, phase: lock.phase, owner: lock.owner,
      session: lock.session!,
      why: `${lock.expired ? 'an expired' : 'an unexpired'} claim of ${lock.owner}, whose session ${lock.session} has ended`,
    });
  }

  const run = latestOf(facts.runs);
  if (!run) return skip(null, 'no run of this plan exists');
  if (facts.live.has(run.id)) return skip(run.id, 'the run is live — its own loop owns it');
  if (run.status === 'finished') return skip(run.id, 'the run is finished');
  if (run.status === 'queued') return skip(run.id, 'the run is queued — admission owns it');
  if (IN_FLIGHT.includes(run.status)) return skip(run.id, `the run reads ${run.status} under another process — not ours to touch`);
  if (run.waitUntil && (run.status === 'paused' || run.status === 'waiting')) {
    return skip(run.id, 'the run is waiting on its own clock — the wait re-arms itself');
  }

  const pressed = facts.trigger === 'button';
  if (!pressed && run.resolved) return skip(run.id, `the stop is resolved (${run.resolved.auto ? 'the board settled it' : 'a person dismissed it'}) — pinned`);
  if (!pressed && stoppedByOperator(run)) return skip(run.id, 'the operator stopped it — pinned until they continue it');
  if (!facts.board) return skip(run.id, 'the board could not be read — nothing is decided on an empty board');
  const board = facts.board;

  /* An orphaned session — a child that outlived the console that started it —
   * is the one parked shape with something still writing. While its pid lives
   * the loop waits; once it is gone the run can be started again, and the
   * runner's `adopt` settles the records it left. */
  const orphan = run.status === 'parked' && run.halt?.kind === 'orphaned-session';
  if (orphan && childrenOf(run).some((child) => pidAlive(child.pid))) {
    return skip(run.id, 'a session from an earlier console is still running in it — waiting for it to end');
  }

  const asked = run.onlyPhases?.length ? new Set(run.onlyPhases) : null;
  const remaining = Object.entries(board)
    .filter(([phase, word]) => word !== 'done' && (!asked || asked.has(Number(phase))))
    .map(([phase]) => Number(phase));
  const killed = killedLanes(run, board).filter((record) => !asked || asked.has(record.phase));
  const systemStop = run.stoppedBy === 'system' && (run.status === 'paused' || run.status === 'interrupted');
  const rearm = Object.values(run.phases)
    .filter((record) => record.status === 'parked' && LOCK_CAP_PARK_NOTE.test(record.note ?? ''))
    .filter((record) => board[record.phase] !== 'done' && (!asked || asked.has(record.phase)))
    .filter((record) => !heldByAnother(facts.locks, record.phase, run.id, facts.now, facts.presence))
    .map((record) => record.phase)
    .sort((a, b) => a - b);

  /* The killed-lane and system-stop shapes: the console's own restart stopped
   * a run that was working. With `resumeAtBoot` on, the run starts again —
   * killed lanes hinted to resume their own sessions (the brief degrades to a
   * fresh boot with a resume block when the session is gone) — bounded per
   * phase by `MAX_BOOT_RESUMES`. With it off, the run is left for a person,
   * with one errand naming exactly that. */
  // A run the console's own restart stopped, with nothing left on the board
  // for it: there is nothing to continue INTO. Not the healer's either — a
  // finished scope is not a stop to climb out of.
  if (systemStop && !remaining.length && !killed.length && !rearm.length && !orphan) {
    return skip(run.id, 'nothing remains on the board for this run');
  }

  const reboard: ReboardRequest[] = [];
  const why: string[] = [];
  if (killed.length || orphan || (systemStop && remaining.length)) {
    if (facts.prefs.resumeAtBoot === false) {
      if (killed.length) {
        for (const record of killed) {
          actions.push({
            kind: 'errand', runId: run.id, phase: record.phase,
            errand: resumeErrand(record.phase, at, 'off', record.resumeSessionId ?? record.sessionId),
            why: 'resume at boot is switched off on this console',
          });
        }
      } else {
        const phase = remaining[0] ?? 0;
        actions.push({
          kind: 'errand', runId: run.id, phase: null, errand: resumeErrand(phase, at, 'off'),
          why: 'resume at boot is switched off on this console',
        });
      }
      return plan;
    }
    for (const record of killed) {
      const count = run.recoveries?.[String(record.phase)]?.bootResumes ?? 0;
      const sessionId = record.resumeSessionId ?? record.sessionId;
      if (count >= MAX_BOOT_RESUMES) {
        actions.push({
          kind: 'errand', runId: run.id, phase: record.phase,
          errand: resumeErrand(record.phase, at, 'capped', sessionId),
          why: `resumed ${count} times after console restarts`,
        });
        continue;
      }
      reboard.push({
        phase: record.phase, situation: 'work-in-progress', rung: 'resume-own-session',
        brief: sessionId ? 'continue' : 'resume',
        ...(sessionId ? { sessionId } : {}),
        by: 'converge',
      });
    }
    if (killed.length && !reboard.length && !rearm.length) return plan; // every killed lane is capped: the errands stand
    if (reboard.length) why.push(`${reboard.length === 1 ? 'a lane' : `${reboard.length} lanes`} a console restart killed resume${reboard.length === 1 ? 's' : ''}`);
    if (orphan) why.push('the session that outlived the earlier console has ended');
    if (systemStop && remaining.length && !reboard.length && !orphan) why.push('the console shut down while this run was working');
  }
  if (rearm.length) why.push(`the lock phase ${rearm.join(', ')} waited out is gone`);
  if (reboard.length || rearm.length || (systemStop && remaining.length) || orphan) {
    if (!remaining.length && !reboard.length && !rearm.length) return skip(run.id, 'nothing remains on the board for this run');
    actions.push({ kind: 'relaunch', runId: run.id, reboard, rearm, why });
    return plan;
  }

  /* The board opened up under a run that stopped because nothing was ready.
   *
   * Recovery is records-based: the healer classifies phases this run already
   * BOARDED. A phase that was never boarded has no record, so when a person
   * clears whatever was holding the plan — a QA verdict re-recorded, a gate
   * approved, a dependency finished elsewhere — the newly-ready phase is
   * invisible to every vehicle the healer owns, and the run sits parked with
   * work waiting in front of it. `systemStop` above does not cover this: it is
   * only paused/interrupted, and the runner's own "nothing is ready" park
   * writes `parked`.
   *
   * Bounded like the killed-lane relaunch: the operator's own stop is never
   * touched, and a run with nothing ready is left alone — relaunching that
   * would only re-park it, which is the oscillation this loop must not become. */
  if ((run.status === 'parked' || run.status === 'halted')
    && !stoppedByOperator(run) && !run.resolved) {
    const readyNow = remaining.filter((p) => board[p] === 'ready');
    const boarded = new Set(Object.keys(run.phases).map(Number));
    if (readyNow.length && readyNow.some((p) => !boarded.has(p))) {
      actions.push({
        kind: 'relaunch', runId: run.id, reboard: [], rearm: [],
        why: [`the board has ready work again (phase ${readyNow.join(', ')}) and this run never boarded it`],
      });
      return plan;
    }
  }

  /* Everything else the loop stopped on — a halt, a park, an interrupted run
   * from before `stoppedBy` existed — goes to the healer: classify the open
   * phases, climb one rung, drive it through the runner. Once per evidence. */
  if (run.status === 'halted' || run.status === 'interrupted' || run.status === 'parked' || run.status === 'paused') {
    const fingerprint = evidenceFingerprint(run, board, facts.locks, facts.gateStamp, facts.qa);
    if (!pressed && facts.lastNoop === fingerprint) {
      return skip(run.id, 'nothing has changed since the last pass found nothing to climb');
    }
    actions.push({ kind: 'heal', runId: run.id, fingerprint, why: `the run reads ${run.status}${run.halt ? ` — ${run.halt.reason.slice(0, 100)}` : ''}` });
    return plan;
  }
  return skip(run.id, `the run reads ${run.status} — nothing to converge`);
}

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

/** What the healer answers — the slice of `Service.maybeAutoRecover`'s result this loop reads. */
export type HealResult = {
  launched: boolean;
  reason?: string;
  phase?: number;
  situation?: string;
  label?: string;
  rung?: string;
  vehicle?: string;
};

export type ConvergeDeps = {
  now?: () => number;
  /** Every run of the plan, newest first, board-resolved (the read path's `runsFor`). */
  runs: (slug: string) => Promise<RunState[]> | RunState[];
  live: () => ReadonlySet<string>;
  /** The board's states, or null when the engine could not read the plan. */
  board: (slug: string) => Promise<Record<number, string> | null>;
  locks: (slug: string) => LockView[];
  /** `gate-status.md`'s stamp for the plan — see `ConvergeFacts.gateStamp`. */
  gateStamp?: (slug: string) => string | null;
  /** The board's QA verdicts — see `ConvergeFacts.qa`. */
  qa?: (slug: string) => Promise<Record<number, string> | null> | Record<number, string> | null;
  prefs: () => { resumeAtBoot?: boolean };
  pidAlive?: (pid: number) => boolean;
  /** The session registry's presence for a lock's session — see `ConvergeFacts.presence`. */
  presence?: (lock: LockView) => 'live' | 'ended' | 'unknown';
  /** Classify + ladder + drive for the plan's latest run. */
  heal: (slug: string) => Promise<HealResult>;
  startRun: (slug: string, options: {
    resumeRunId: string; reboard?: ReboardRequest[]; onlyPhases?: number[]; skills?: string[];
  }) => Promise<unknown>;
  /** Edit a stored (not live) run and write it back. */
  editRun: (slug: string, runId: string, apply: (state: RunState) => void) => RunState | null;
  /** Release a lock as its recorded owner — the runner's own release, `--git` never passed. */
  releaseLock: (slug: string, phase: number, owner: string) => Promise<{ ok: boolean; detail?: string }>;
  journal: (slug: string, runId: string, event: string, data: Record<string, unknown>, phase?: number) => void;
  /**
   * Push the one ask a converged errand leaves behind.
   *
   * Optional, so a test that builds deps by hand keeps working, and because
   * converging is useful with no notifier at all. The service passes its own
   * `announceErrand`, which is the same dedupe the runner and the healer use —
   * three producers of errands, one notification per ask.
   */
  announceErrand?: (slug: string, runId: string, phase: number | null, errand: Errand) => void;
  /** Something changed under the locks — poke whoever waits on them. */
  locksChanged?: (slug: string) => void;
};

export type ConvergeOutcome = {
  action: ConvergeAction;
  ok: boolean;
  detail?: string;
  /** The healer's own answer, on a `heal`. */
  heal?: HealResult;
};

export type ConvergeReport = ConvergePlan & {
  outcomes: ConvergeOutcome[];
  /** Did this pass start a run (a relaunch, or a healer that launched)? */
  launched: boolean;
  /** The errands this pass wrote or found standing, for the recover verb's answer. */
  errands: Errand[];
  /** The fingerprint to remember when the healer found nothing; null clears it. */
  noop: string | null;
};

export async function executeConvergence(plan: ConvergePlan, deps: ConvergeDeps): Promise<ConvergeReport> {
  const outcomes: ConvergeOutcome[] = [];
  const errands: Errand[] = [];
  let launched = false;
  let noop: string | null = null;
  const { slug, trigger } = plan;
  const touched = new Set<string>();

  const debris = plan.actions.filter((a): a is Extract<ConvergeAction, { kind: 'release-debris' }> => a.kind === 'release-debris');
  // A session's claim (runId null) is journalled on the plan's latest run, when there is one.
  const latestRunId = plan.actions.find((a): a is Extract<ConvergeAction, { kind: 'skip' | 'heal' | 'relaunch' | 'errand' }> =>
    a.kind !== 'release-debris' && a.runId != null)?.runId ?? null;
  for (const action of debris) {
    let result: { ok: boolean; detail?: string };
    try { result = await deps.releaseLock(slug, action.phase, action.owner); } catch (error) {
      result = { ok: false, detail: (error as Error)?.message ?? String(error) };
    }
    const journalRun = action.runId ?? latestRunId;
    if (journalRun) {
      deps.journal(slug, journalRun, 'run.lock-debris-released', {
        phase: action.phase, owner: action.owner, ok: result.ok, why: action.why, trigger, by: 'converge',
        ...(action.session ? { session: action.session } : {}),
        ...(result.detail ? { detail: result.detail.slice(0, 200) } : {}),
      }, action.phase);
    }
    outcomes.push({ action, ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) });
  }
  if (debris.length) { try { deps.locksChanged?.(slug); } catch { /* the poke is a courtesy */ } }

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'release-debris': case 'skip': break;

      case 'errand': {
        const edited = deps.editRun(slug, action.runId, (state) => {
          if (action.phase == null) { state.errand = action.errand; return; }
          const slot = ((state.recoveries ??= {})[String(action.phase)] ??= { attempts: 0, lastAt: action.errand.at });
          slot.errand = action.errand;
        });
        deps.journal(slug, action.runId, action.phase == null ? 'run.errand' : 'phase.errand',
          { ...action.errand, reason: action.why, by: 'converge', trigger }, action.phase ?? undefined);
        errands.push(action.errand);
        deps.announceErrand?.(slug, action.runId, action.phase ?? null, action.errand);
        touched.add(action.runId);
        outcomes.push({ action, ok: Boolean(edited) });
        break;
      }

      case 'relaunch': {
        const at = new Date(deps.now?.() ?? Date.now()).toISOString();
        const edited = deps.editRun(slug, action.runId, (state) => {
          for (const phase of action.rearm) {
            const record = state.phases[String(phase)];
            if (!record) continue;
            const was = record.note;
            resetForRetry(record);
            deps.journal(slug, action.runId, 'phase.lock-cap-rearmed',
              { was, note: 'the lock it waited on is gone — the wait starts over', by: 'converge', trigger }, phase);
          }
          for (const ask of action.reboard) {
            const slot = ((state.recoveries ??= {})[String(ask.phase)] ??= { attempts: 0, lastAt: at });
            slot.bootResumes = (slot.bootResumes ?? 0) + 1;
            slot.lastAt = at;
            delete slot.errand;
            deps.journal(slug, action.runId, 'phase.resume-at-boot',
              { sessionId: ask.sessionId ?? null, brief: ask.brief, count: slot.bootResumes, trigger, by: 'converge' }, ask.phase);
          }
          // The run-level errand was about the stop this launch ends.
          delete state.errand;
        });
        if (!edited) { outcomes.push({ action, ok: false, detail: 'the run could not be read back' }); break; }
        deps.journal(slug, action.runId, 'run.converge', {
          trigger, action: 'relaunch', why: action.why,
          reboard: action.reboard.map((ask) => ask.phase), rearm: action.rearm, by: 'converge',
        });
        try {
          await deps.startRun(slug, {
            resumeRunId: action.runId,
            ...(action.reboard.length ? { reboard: action.reboard } : {}),
            ...(edited.onlyPhases?.length ? { onlyPhases: edited.onlyPhases } : {}),
            skills: edited.skills ?? [],
          });
          launched = true;
          outcomes.push({ action, ok: true });
        } catch (error) {
          const detail = (error as Error)?.message ?? String(error);
          deps.journal(slug, action.runId, 'run.converge-failed', { trigger, action: 'relaunch', detail: detail.slice(0, 300), by: 'converge' });
          outcomes.push({ action, ok: false, detail });
        }
        break;
      }

      case 'heal': {
        let result: HealResult;
        try { result = await deps.heal(slug); } catch (error) {
          result = { launched: false, reason: (error as Error)?.message ?? String(error) };
        }
        if (result.launched) { launched = true; noop = null; } else noop = action.fingerprint;
        deps.journal(slug, action.runId, 'run.converge', {
          trigger, action: 'heal', why: action.why, launched: result.launched,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.phase != null ? { phase: result.phase } : {}),
          ...(result.situation ? { situation: result.situation } : {}),
          ...(result.rung ? { rung: result.rung } : {}),
          by: 'converge',
        });
        outcomes.push({ action, ok: result.launched, heal: result, ...(result.reason ? { detail: result.reason } : {}) });
        break;
      }
    }
  }
  return { ...plan, outcomes, launched, errands, noop };
}

/** Gather, plan, act — one pass for one plan. */
export async function convergePlan(
  deps: ConvergeDeps, slug: string, trigger: ConvergeTrigger, lastNoop: string | null = null,
): Promise<ConvergeReport> {
  const now = deps.now?.() ?? Date.now();
  const runs = await deps.runs(slug);
  // No runs: nothing to converge, and no board read spent finding that out.
  const board = runs.length ? await deps.board(slug) : null;
  const facts: ConvergeFacts = {
    slug, now, trigger, board, runs,
    live: deps.live(),
    locks: deps.locks(slug),
    gateStamp: deps.gateStamp?.(slug) ?? null,
    qa: (deps.qa ? await deps.qa(slug) : null) ?? null,
    prefs: deps.prefs(),
    ...(deps.pidAlive ? { pidAlive: deps.pidAlive } : {}),
    ...(deps.presence ? { presence: deps.presence } : {}),
    lastNoop,
  };
  const plan = planConvergence(facts);
  return executeConvergence(plan, deps);
}

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

export type ConvergeClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const REAL_CLOCK: ConvergeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type ConvergeSchedulerDeps = {
  /** One pass for one plan; null when converging is not possible (no root, no --allow-run). */
  run: (slug: string, trigger: ConvergeTrigger, lastNoop: string | null) => Promise<ConvergeReport | null>;
  /** The plans the periodic sweep visits. */
  slugs: () => string[];
  /** The sweep interval preference; clamped to `MIN_SWEEP_MS`. */
  everyMs?: () => number | undefined;
  clock?: ConvergeClock;
  onReport?: (report: ConvergeReport) => void;
};

type Pending = { handle: unknown; dueAt: number; trigger: ConvergeTrigger };

/**
 * When the loop runs. Per plan: a trailing debounce for docs changes, the
 * quiet minute after a halt (a change inside it does not shorten it — the
 * halt's own pass sees the change), and single-flight with one re-run queued
 * behind an in-flight pass. Plan-wide: the periodic sweep, re-armed after each
 * sweep completes, so a slow pass never stacks sweeps.
 */
export class ConvergeScheduler {
  private deps: ConvergeSchedulerDeps;
  private clock: ConvergeClock;
  private pending = new Map<string, Pending>();
  private running = new Map<string, Promise<ConvergeReport | null>>();
  private again = new Map<string, ConvergeTrigger>();
  private sweepHandle: unknown = null;
  private closed = false;
  /** The last pass per plan, for the Pulse and for tests. */
  readonly reports = new Map<string, ConvergeReport>();
  /** Per plan: the evidence fingerprint at the last pass that healed nothing. */
  private noops = new Map<string, string>();

  constructor(deps: ConvergeSchedulerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? REAL_CLOCK;
  }

  /** A harness seam: swap the clock BEFORE `start()`. */
  setClock(clock: ConvergeClock): void { this.clock = clock; }

  /** Arm the periodic sweep (idempotent). */
  start(): void {
    if (this.closed) return;
    this.armSweep();
  }

  /**
   * The boot pass: every open plan with a run, now — one plan at a time (a
   * pass may read the board and launch a run, and a fleet of them at once is
   * how a console used to wedge), awaited, so a caller can know when the
   * console has finished picking up what its predecessor left.
   */
  async boot(slugs: string[]): Promise<void> {
    for (const slug of slugs) {
      if (this.closed) return;
      await this.converge(slug, 'boot');
    }
  }

  /**
   * Ask for a pass. `delayMs` overrides the trigger's default delay. A pending
   * request for the same plan keeps whichever is due sooner — except that a
   * docs change never shortens the quiet minute after a halt.
   */
  /**
   * Forget every remembered "nothing to climb" fingerprint.
   *
   * The latch compares EVIDENCE — the run, the board, the locks, the gate
   * stamp, the QA verdicts — and the healer also decides with things that are
   * none of those: the ladder caps, the unblock and takeover switches, gate
   * delegation. An operator who raises a spent budget or turns delegation on has
   * changed exactly the thing that would let the loop act, and the loop went on
   * skipping with "nothing has changed since the last pass found nothing to
   * climb". Clearing costs one redundant pass and is the honest answer to "the
   * rules just changed".
   */
  clearNoops(): void {
    this.noops.clear();
  }

  request(slug: string, trigger: ConvergeTrigger, delayMs?: number): void {
    if (this.closed) return;
    const delay = Math.max(0, delayMs ?? DEFAULT_DELAY[trigger]);
    const dueAt = this.clock.now() + delay;
    const current = this.pending.get(slug);
    if (current) {
      if (current.trigger === 'halt' && trigger === 'change') return;
      if (dueAt >= current.dueAt && trigger !== 'change') return;
      // A change is a TRAILING debounce: each write pushes the pass out again,
      // so a burst of handoff files lands as one pass after the last of them.
      if (trigger === 'change' && current.trigger !== 'change' && dueAt >= current.dueAt) return;
      this.clock.clearTimeout(current.handle);
    }
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(slug);
      void this.fire(slug, trigger);
    }, delay);
    this.pending.set(slug, { handle, dueAt, trigger });
  }

  /** The operator's press: now, awaited, and with the pins off inside the planner. */
  async converge(slug: string, trigger: ConvergeTrigger = 'button'): Promise<ConvergeReport | null> {
    const current = this.pending.get(slug);
    if (current) { this.clock.clearTimeout(current.handle); this.pending.delete(slug); }
    const inFlight = this.running.get(slug);
    if (inFlight) await inFlight.catch(() => null);
    return this.fire(slug, trigger);
  }

  /** Every pass in flight, settled — a harness seam. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((p) => p.catch(() => null)));
  }

  /** What the scheduler is holding, for the Pulse. */
  snapshot(): { pending: { slug: string; trigger: ConvergeTrigger; dueAt: number }[]; running: string[] } {
    return {
      pending: [...this.pending].map(([slug, p]) => ({ slug, trigger: p.trigger, dueAt: p.dueAt })),
      running: [...this.running.keys()],
    };
  }

  close(): void {
    this.closed = true;
    for (const { handle } of this.pending.values()) this.clock.clearTimeout(handle);
    this.pending.clear();
    if (this.sweepHandle != null) this.clock.clearTimeout(this.sweepHandle);
    this.sweepHandle = null;
    this.again.clear();
  }

  private fire(slug: string, trigger: ConvergeTrigger): Promise<ConvergeReport | null> {
    if (this.closed) return Promise.resolve(null);
    const inFlight = this.running.get(slug);
    if (inFlight) {
      // One re-run queued behind the pass in flight, whatever asked for it —
      // the re-run re-reads everything, so the trigger kept is the strongest.
      const queued = this.again.get(slug);
      if (!queued || trigger === 'button' || (trigger === 'boot' && queued !== 'button')) this.again.set(slug, trigger);
      return inFlight;
    }
    const pass = this.deps.run(slug, trigger, this.noops.get(slug) ?? null)
      .then((report) => {
        if (report) {
          // Only a pass that actually MOVED something invalidates the latch.
          // `noop` is assigned in the heal branch alone, so a pass whose single
          // action was a skip — the guard skip included — reported null here and
          // deleted the fingerprint it had just honoured. The next sweep then had
          // nothing to compare against and healed again: one board read, one
          // healer pass and one journal line every other sweep, for ever, on a
          // run nobody could move. Keeping a stale fingerprint is harmless (the
          // comparison is exact); forgetting one is a permanent spin.
          if (report.noop) this.noops.set(slug, report.noop);
          else if (report.launched) this.noops.delete(slug);
          this.reports.set(slug, report);
          try { this.deps.onReport?.(report); } catch { /* a listener must never break the loop */ }
        }
        return report;
      })
      .catch((error) => { log.warn('converge.failed', { slug, trigger, error }); return null; })
      .finally(() => {
        this.running.delete(slug);
        const next = this.again.get(slug);
        if (next && !this.closed) { this.again.delete(slug); this.request(slug, next, 0); }
      });
    this.running.set(slug, pass);
    return pass;
  }

  private armSweep(): void {
    if (this.sweepHandle != null) this.clock.clearTimeout(this.sweepHandle);
    const every = Math.max(MIN_SWEEP_MS, this.deps.everyMs?.() ?? DEFAULT_SWEEP_MS);
    this.sweepHandle = this.clock.setTimeout(() => { void this.sweep(); }, every);
  }

  private async sweep(): Promise<void> {
    this.sweepHandle = null;
    if (this.closed) return;
    let slugs: string[] = [];
    try { slugs = this.deps.slugs(); } catch { slugs = []; }
    // One plan at a time: every pass may read the board (a subprocess) and
    // launch a run, and a fleet of them at once is how a console used to wedge.
    for (const slug of slugs) {
      if (this.closed) return;
      try { await this.fire(slug, 'timer'); } catch { /* logged in fire */ }
    }
    if (!this.closed) this.armSweep();
  }
}

/* ------------------------------------------------------------------ *
 * The view a reader gets (`GET /api/converge`, SSE `run:converge`)
 * ------------------------------------------------------------------ */

/** One action of a pass, flattened for a card: what it did, to which phase, why. */
export type ConvergeActionView = {
  kind: ConvergeAction['kind'];
  /** The phase the action is about; null for a run-level errand; absent when it has none. */
  phase?: number | null;
  situation?: string;
  rung?: string;
  vehicle?: string;
  owner?: string;
  session?: string;
  /** A relaunch's re-boards: each phase with the situation and rung it boards for. */
  reboard?: { phase: number; situation: string; rung: string; brief?: string }[];
  /** A relaunch's re-armed lock-cap parks. */
  rearm?: number[];
  /** An errand's ask. */
  need?: string;
  /** A heal's answer: did it launch anything? */
  launched?: boolean;
  ok: boolean;
  why: string;
};

export type ConvergeView = {
  slug: string;
  trigger: ConvergeTrigger;
  at: string;
  launched: boolean;
  /** The pass found nothing to do (the healer's fingerprint was remembered). */
  noop: boolean;
  actions: ConvergeActionView[];
  /** How many errands the pass wrote or found standing. */
  errands: number;
};

/**
 * A report, flattened for the Pulse's convergence line and the event stream:
 * every action with its outcome (by identity — the executor appends one
 * outcome per action), the relaunch's re-boards named phase by phase, the
 * healer's own answer on a heal. Pure; `test/converge.test.ts` pins it.
 */
export function convergeView(report: ConvergeReport): ConvergeView {
  const actions = report.actions.map((action): ConvergeActionView => {
    const outcome = report.outcomes.find((o) => o.action === action);
    const ok = outcome ? outcome.ok : true;
    switch (action.kind) {
      case 'release-debris':
        return {
          kind: action.kind, phase: action.phase, owner: action.owner, ok, why: action.why,
          ...(action.session ? { session: action.session } : {}),
        };
      case 'relaunch':
        return {
          kind: action.kind, ok, why: action.why.join('; '),
          reboard: action.reboard.map((r) => ({
            phase: r.phase, situation: r.situation, rung: r.rung, ...(r.brief ? { brief: r.brief } : {}),
          })),
          rearm: [...action.rearm],
        };
      case 'errand':
        return {
          kind: action.kind, phase: action.phase, situation: action.errand.situation,
          need: action.errand.need, ok, why: action.why,
        };
      case 'heal': {
        const heal = outcome?.heal;
        return {
          kind: action.kind, ok, why: heal?.reason ?? outcome?.detail ?? action.why,
          ...(heal?.phase != null ? { phase: heal.phase } : {}),
          ...(heal?.situation ? { situation: heal.situation } : {}),
          ...(heal?.rung ? { rung: heal.rung } : {}),
          ...(heal?.vehicle ? { vehicle: heal.vehicle } : {}),
          launched: Boolean(heal?.launched),
        };
      }
      case 'skip':
      default:
        return { kind: action.kind, ok, why: action.why };
    }
  });
  return {
    slug: report.slug,
    trigger: report.trigger,
    at: report.at,
    launched: report.launched,
    noop: report.noop != null && !report.launched && actions.every((a) => a.kind === 'skip' || (a.kind === 'heal' && !a.launched)),
    actions,
    errands: report.errands.length,
  };
}
