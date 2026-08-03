/**
 * Run state: the checkpoint that survives a crash.
 *
 * A run is a long-lived thing — hours, many child processes, possibly a
 * console restart in the middle. Everything needed to pick it back up lives in
 * one JSON file per run, written after every transition and outside the repo
 * (`~/.local/state/phase-console/runs/…`), so a supervised plan never leaves
 * uncommitted machine state in someone's working tree.
 *
 * Writes are atomic: a half-written checkpoint read after a power cut is worse
 * than no checkpoint at all, because it looks valid.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { STATE_DIR } from '../config.ts';
import type { PermissionProfile } from './approvals.ts';

export type RunStatus =
  /** The loop is driving phases. */
  | 'running'
  /** Asked to stop after the current phase. */
  | 'pausing'
  /** Stopped between phases; `start` picks up where it left off. */
  | 'paused'
  /** Sleeping until a usage window reopens (`waitUntil`). */
  | 'waiting'
  /**
   * The session is stopped where it stood (`SIGSTOP`), mid-phase.
   *
   * Distinct from `paused` in the one way that matters operationally: there is
   * a live child holding a warm session, so this is reversible at no cost — and
   * it is also the only status where the run's own clock is not running.
   */
  | 'frozen'
  /** Every remaining phase needs a human — a gate, an approval, a decision. */
  | 'parked'
  /** Stopped on a condition that must not be automated past. */
  | 'halted'
  /** Nothing left to do on this plan. */
  | 'finished'
  /** A stop was requested; the child is being wound down. */
  | 'stopping'
  /** Nothing is driving this run any more, and nothing recorded why. */
  | 'interrupted';

export type PhaseStatus =
  | 'pending' | 'gated' | 'running' | 'verifying' | 'done'
  | 'failed' | 'interrupted' | 'skipped' | 'parked'
  /** Verified as far as a machine can; the rest is a question for a person. */
  | 'awaiting-verification';

/** Terminal for this run: the loop will not pick these up again by itself. */
export const SETTLED: readonly PhaseStatus[] = ['done', 'skipped', 'failed', 'parked', 'interrupted'];

/**
 * Statuses that assert work is in flight — each one a claim made by a process
 * that can be killed between writing it and acting on it.
 */
export const IN_FLIGHT: readonly RunStatus[] = ['running', 'pausing', 'stopping', 'waiting', 'frozen'];

/** The same, per phase. A phase in one of these had a live loop behind it. */
const PHASE_IN_FLIGHT: readonly PhaseStatus[] = ['running', 'verifying', 'awaiting-verification'];

export type VerifyRun = {
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  /** Tail only — a full test-suite log does not belong in a checkpoint. */
  output: string;
};

export type VerifySummary = {
  ok: boolean;
  reason: string;
  ran: VerifyRun[];
  /** Commands present in the plan that the runner would not execute, and why. */
  notRun: { text: string; reason: string }[];
};

export type PhaseRecord = {
  phase: number;
  status: PhaseStatus;
  attempts: number;
  costUsd: number;
  /** Turns and wall-clock across every attempt, so a phase can be read at a glance. */
  turns?: number;
  durationMs?: number;
  /**
   * Wall-clock this phase spent stopped by the operator, already subtracted
   * from `durationMs`. Kept rather than merely deducted so "it took two hours"
   * and "it worked for twenty minutes and waited for me for the rest" can be
   * told apart — the second is not a slow phase.
   */
  frozenMs?: number;
  /**
   * A session to hand to `--resume` when this phase next runs, left behind by a
   * freeze that was checkpointed. Cleared as soon as it is used: a session id
   * offered twice is the "Session ID … is already in use" refusal that killed
   * two real retries.
   */
  resumeSessionId?: string;
  model?: string;
  /** The reasoning effort this phase ran at. */
  effort?: string;
  /** What the session's own `init` message said it was running on. */
  actualModel?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  note?: string;
  gate?: { clear: boolean; kind: string; detail: string };
  verification?: VerifySummary;
  lint?: { ok: boolean; summary: string };
  /**
   * The one continuation this phase is allowed when its session exits without
   * writing a handoff — recorded so a second attempt cannot happen by accident,
   * and so the panel can say a closeout was tried and what came of it.
   */
  closeout?: { at: string; ok: boolean; sessionId?: string; note?: string };
  /**
   * The session's own closing words. When a phase exits clean and changes
   * nothing this is the only account of why, and it used to live solely in the
   * journal — so the halt said "no handoff was written" and the reason it was
   * not written took a manual dig through NDJSON to recover.
   */
  said?: string;
};

export type Autonomy = 'halt-on-everything' | 'keep-going';

/**
 * What the operator chose for one phase, before it runs.
 *
 * Every field is optional and an absent field means "inherit". Three sources
 * are consulted in order — this, then the plan's own `**Model:**` /
 * `**Effort:**` bullets for that phase, then the run's defaults — so a plan
 * that already says a phase wants Opus gets Opus without anyone re-typing it,
 * and an operator who disagrees can say so for one run without editing a
 * versioned file.
 */
export type PhaseOptions = {
  model?: string;
  effort?: string;
  /** Restrict the built-in tool set for this phase. Empty means every tool. */
  tools?: string[];
  permissionMode?: string;
  /** Skills to invoke on top of the plan's own, for this phase. */
  skills?: string[];
};

export type RunState = {
  id: string;
  slug: string;
  root: string;
  status: RunStatus;
  autonomy: Autonomy;
  /** The model each phase starts on; a limited model falls back from here. */
  model: string;
  /** The reasoning effort each phase starts at, unless the phase overrides it. */
  effort?: string;
  /**
   * The account's usage window as the CLI last reported it mid-session. Not a
   * decision the runner makes — a fact worth showing before someone starts a
   * twelve-phase run against a window that is nearly spent.
   */
  limits?: { status: string; window?: string; utilization?: number; resetsAt?: number; at: string };
  phaseBudgetUsd: number | null;
  runBudgetUsd: number | null;
  spentUsd: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  activePhase: number | null;
  /** Set while a child is alive, so a restarted console can tell what it interrupted. */
  child: { pid: number; phase: number; sessionId: string; startedAt: string } | null;
  waitUntil: string | null;
  halt: { at: string; reason: string; phase?: number } | null;
  /**
   * A pause that has been asked for but not yet reached.
   *
   * `status: "pausing"` on its own tells an operator almost nothing — not when
   * they asked, not what it is waiting for, and not whether the request even
   * landed. It landed silently for so long that pressing Pause looked like a
   * no-op. This records the request the moment it is made, names the phase that
   * has to finish first, and is cleared either by the pause taking effect or by
   * the operator cancelling it.
   */
  pause: { requestedAt: string; afterPhase: number | null; by: string } | null;
  /**
   * A session stopped where it stands, and when that stops being the cheap
   * option. Null whenever nothing is frozen — including immediately after a
   * `thaw()` or an escalation, so a stale block can never make a live run look
   * held.
   */
  freeze: { at: string; phase: number | null; pid: number; by: string; escalateAt: string } | null;
  /**
   * Why the loop stopped, in the words the operator needs.
   *
   * `status` says *that* a run ended and `halt` says why it was halted, but the
   * ordinary endings — the plan is finished, the phases this run was asked for
   * are all settled, the budget is spent — went to the journal and nowhere the
   * console could show them. A run that stops after one phase because it was
   * scoped to one phase looks broken without this.
   */
  finishedReason?: string;
  /**
   * Run only these phases, in the usual ready order, then stop. Empty or absent
   * means "every phase that becomes ready", which is the normal run.
   */
  onlyPhases?: number[];
  /** Per-phase choices, keyed by phase number. See `PhaseOptions`. */
  phaseOptions?: Record<string, PhaseOptions>;
  /** Skills every phase of this run invokes, on top of the plan's own. */
  skills?: string[];
  /**
   * How much this run may do without stopping to ask — `guarded` (the default
   * and what every run did before profiles existed), `trusted`, or `bypass`.
   *
   * On the state rather than only in the settings file because it is the thing
   * an operator most needs to see in the header: a run quietly on `bypass` and
   * a run on `guarded` look identical otherwise, and only one of them is
   * committing without asking.
   */
  permissionProfile?: PermissionProfile;
  phases: Record<string, PhaseRecord>;
};

/* ------------------------------------------------------------------ *
 * Where a run lives
 * ------------------------------------------------------------------ */

/**
 * One directory per (source directory, plan). The hash keeps two checkouts of
 * the same repo apart; the basename keeps the path readable for a human who
 * goes looking, which they will the first time a run halts.
 */
export function runDir(root: string, slug: string): string {
  const key = `${createHash('sha256').update(root).digest('hex').slice(0, 8)}-${basename(root) || 'root'}`;
  return join(STATE_DIR, 'runs', key, slug);
}

export function runFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.json`);
}

export function journalFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.jsonl`);
}

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

export type NewRunOptions = {
  slug: string;
  root: string;
  model?: string;
  effort?: string;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  maxConsecutiveFailures?: number;
  onlyPhases?: number[];
  phaseOptions?: Record<string, PhaseOptions>;
  skills?: string[];
  permissionProfile?: PermissionProfile;
};

export function newRun(opts: NewRunOptions): RunState {
  const now = new Date().toISOString();
  return {
    id: randomUUID().slice(0, 8),
    slug: opts.slug,
    root: opts.root,
    status: 'running',
    // Halting on everything is the default on purpose: the first runs of an
    // unattended system should stop and show their work, not press on.
    autonomy: opts.autonomy ?? 'halt-on-everything',
    model: opts.model ?? 'sonnet',
    ...(opts.effort ? { effort: opts.effort } : {}),
    phaseBudgetUsd: opts.phaseBudgetUsd ?? null,
    runBudgetUsd: opts.runBudgetUsd ?? null,
    spentUsd: 0,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 2,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    ...(opts.onlyPhases?.length ? { onlyPhases: [...opts.onlyPhases] } : {}),
    ...(opts.phaseOptions ? { phaseOptions: { ...opts.phaseOptions } } : {}),
    ...(opts.skills?.length ? { skills: [...opts.skills] } : {}),
    // Absent means `guarded`. Written only when it is something else, so an
    // older run file cannot read as anything but the careful default.
    ...(opts.permissionProfile && opts.permissionProfile !== 'guarded'
      ? { permissionProfile: opts.permissionProfile } : {}),
    phases: {},
  };
}

export function phaseRecord(state: RunState, phase: number): PhaseRecord {
  const key = String(phase);
  if (!state.phases[key]) {
    state.phases[key] = { phase, status: 'pending', attempts: 0, costUsd: 0 };
  }
  return state.phases[key];
}

/** Write the checkpoint atomically — rename is the only step a reader can see. */
export function saveRun(state: RunState): void {
  state.updatedAt = new Date().toISOString();
  const target = runFile(state.root, state.slug, state.id);
  mkdirSync(runDir(state.root, state.slug), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

/* ------------------------------------------------------------------ *
 * Reclaiming a run whose writer died
 * ------------------------------------------------------------------ */

/**
 * Make a loaded run tell the truth about whether anything is driving it.
 *
 * `status: "running"` is not an observation, it is a claim — written by a
 * process that can be killed in the next microsecond, and then never corrected,
 * because correcting it was that process's job. A console that reads the claim
 * back and believes it shows a run as live forever, offers a Stop button whose
 * handler has nothing to stop, and hides the one fact the operator needs: that
 * this run ended some time ago and nobody wrote down why.
 *
 * This is the ordinary stale-lease problem, and it takes the ordinary fix:
 * liveness is *derived* at read time from evidence that cannot be faked — is
 * this the run the in-process loop is actually driving, and is the recorded
 * child pid still alive — rather than trusted from a field.
 *
 * `liveRunId` is the id the current `Runner` is driving, and it is the only
 * thing that licenses an in-flight status. Everything else gets reclaimed.
 * Returns whether anything changed, so callers only write when there is
 * something to write.
 */
export function reconcileRun(state: RunState, liveRunId?: string | null): boolean {
  if (state.id === liveRunId) return false;
  if (!IN_FLIGHT.includes(state.status)) return false;

  const at = new Date().toISOString();

  // The dangerous case: the console went away but its child did not. That
  // session is still editing the working tree, unobserved. Say so precisely —
  // with the pid — rather than reclaiming a run something is still writing.
  if (state.child && pidAlive(state.child.pid)) {
    const frozen = state.freeze?.pid === state.child.pid;
    state.status = 'parked';
    state.halt ??= {
      at,
      // A frozen orphan is the one case where "let it finish" is wrong advice:
      // nothing is scheduling it, so it will sit stopped forever waiting for a
      // console that is not coming back.
      reason: frozen
        ? `phase ${state.child.phase} was frozen by the operator (pid ${state.child.pid}) and the `
          + 'console that stopped it is gone, so nothing will start it again. Continue it with '
          + `\`kill -CONT ${state.child.pid}\`, or stop it with \`kill ${state.child.pid}\` and run the phase again.`
        : `a session from an earlier console is still running (pid ${state.child.pid}, `
          + `phase ${state.child.phase}). Let it finish or stop it, then continue this run.`,
      phase: state.child.phase,
    };
    return true;
  }

  const phase = state.child?.phase ?? state.activePhase ?? undefined;
  state.halt ??= {
    at,
    reason: phase === undefined
      ? `nothing has been driving this run since ${state.updatedAt} — the console that started it stopped without recording why.`
      : `nothing has been driving this run since ${state.updatedAt} — the console stopped while phase ${phase} was in flight, without recording why.`,
    phase,
  };
  state.status = 'interrupted';
  state.child = null;
  // A pause waiting for a phase that is no longer running will never arrive.
  state.pause = null;
  // Same for a freeze whose child is already gone: the block would otherwise
  // make a dead run look held, and offer a Continue that resumes nothing.
  state.freeze = null;

  // A phase left mid-flight may have half-finished something, so it is marked
  // interrupted rather than failed: continuing asks about it instead of
  // silently running it a second time.
  for (const record of Object.values(state.phases)) {
    if (!PHASE_IN_FLIGHT.includes(record.status)) continue;
    const was = record.status;
    record.status = 'interrupted';
    record.note ??= `the console stopped while phase ${record.phase} was `
      + (was === 'awaiting-verification' ? 'waiting to be verified' : 'running');
    record.endedAt ??= at;
    // The session survives the console that was watching it. Keeping its id
    // here is what makes the difference between offering to CONTINUE this phase
    // and offering only to start it over: an interrupted phase may be twenty
    // minutes of work from done, and a restart throws all of it away.
    record.resumeSessionId ??= record.sessionId;
  }
  return true;
}

/** Reclaim on read, and make the correction stick so it is done once. */
function settle(state: RunState, liveRunId?: string | null): RunState {
  if (!reconcileRun(state, liveRunId)) return state;
  try { saveRun(state); } catch { /* a read must not fail because the disk did */ }
  return state;
}

export function loadRun(root: string, slug: string, id: string, liveRunId?: string | null): RunState | null {
  try {
    return settle(JSON.parse(readFileSync(runFile(root, slug, id), 'utf8')) as RunState, liveRunId);
  } catch {
    return null;
  }
}

/** Every run recorded for a plan, newest first. */
export function listRuns(root: string, slug: string, liveRunId?: string | null): RunState[] {
  const dir = runDir(root, slug);
  if (!existsSync(dir)) return [];
  const runs: RunState[] = [];
  for (const name of readdirSync(dir)) {
    const id = /^run-([0-9a-f]{8})\.json$/.exec(name)?.[1];
    if (!id) continue;
    const state = loadRun(root, slug, id, liveRunId);
    if (state) runs.push(state);
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The run to offer when someone opens a plan: the one still in flight, else the
 * most recent. A finished run is still worth showing — it is the record of what
 * happened — but it must never be silently resumed.
 */
export function latestRun(root: string, slug: string, liveRunId?: string | null): RunState | null {
  const runs = listRuns(root, slug, liveRunId);
  return runs.find((r) => r.status !== 'finished') ?? runs[0] ?? null;
}

/** Is a process with this pid still alive? Used to reconcile after a restart. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
