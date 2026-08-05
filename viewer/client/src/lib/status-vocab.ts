/**
 * Every status word this console shows, explained — what it MEANS and what to
 * DO about it — in one place.
 *
 * Three vocabularies coexist by design and used to be explained nowhere:
 * a RUN's status ("what is the autopilot doing"), a PHASE RECORD's status
 * ("what happened to this phase in this run"), and the BOARD's state ("what
 * is true of the phase on disk", the departures words). An operator staring
 * at `parked` next to `Held` next to `interrupted` was expected to already
 * know all three — which is exactly the burden this console exists to remove.
 *
 * `Record<Status, …>` on the closed unions makes forgetting a new status a
 * type error here, not a silent empty tooltip. Chips read these as their
 * default `title`; the Guide's Reference section renders the same objects as
 * tables — one source, so the hover and the page can never disagree.
 */

// Type-only, and straight from the module rather than the barrel: chip.tsx
// imports this file's functions at runtime, so the runtime graph must stay
// one-directional (chip → vocab); a type edge the compiler erases is fine.
import type { PhaseStatus, RunStatus } from '@/lib/api';
import type { PhaseState } from '@/components/ui/chip';

export type StatusHelp = {
  /** What the word means, in one sentence. */
  means: string;
  /** What, if anything, the operator should do about it. */
  then: string;
};

/** The RUN's own status — what the autopilot is doing with the whole plan. */
export const RUN_STATUS_HELP: Record<RunStatus, StatusHelp> = {
  running: {
    means: 'The autopilot is driving: sessions spawn, verify and hand off by themselves.',
    then: 'Nothing to do — watch the phase tabs. Pause, Freeze and Stop all apply.',
  },
  pausing: {
    means: 'A pause is armed: whatever is running finishes, and nothing new boards.',
    then: 'Wait for the boundary, or Cancel pause to keep going.',
  },
  paused: {
    means: 'Stopped between phases at your request; nothing is running.',
    then: 'Press Continue when ready — it picks up exactly where it left off.',
  },
  waiting: {
    means: "Sleeping until the account's usage window reopens, then resumes itself.",
    then: 'Nothing to do.',
  },
  frozen: {
    means: 'The session is stopped where it stands (mid-token), warm and losing nothing.',
    then: 'Continue the frozen session to resume instantly, or Stop it.',
  },
  parked: {
    means: 'Every remaining phase needs a person first — a gate, an approval, a decision.',
    then: 'Read "Why this is stopped": each blocker is named with its remedy.',
  },
  queued: {
    means: 'In line behind another plan holding the same repos; starts itself when the scope frees.',
    then: 'Nothing to do — the holder is named on the queued chip.',
  },
  halting: {
    means: 'A halt was recorded; live sessions are finishing before the run fully stops.',
    then: 'Read the halt card. The run reads halted once the last session settles.',
  },
  halted: {
    means: 'Stopped on something that must not be automated past — usually a red verification.',
    then: 'Use Fix with AI on the halt card, or fix the cause yourself and Retry the phase.',
  },
  stopping: {
    means: 'A stop was requested; sessions are being wound down.',
    then: 'Wait a moment.',
  },
  finished: {
    means: 'Nothing left to run on this plan.',
    then: 'Nothing to do.',
  },
  interrupted: {
    means: 'Nothing is driving it and nothing recorded why — a console or session died mid-flight.',
    then: 'Resume with AI, or press Continue — work already on disk is kept.',
  },
};

/** A PHASE RECORD's status — what happened to that phase in THIS run. */
export const PHASE_STATUS_HELP: Record<PhaseStatus, StatusHelp> = {
  pending: {
    means: 'This run has not started the phase yet.',
    then: 'Nothing to do — the loop reaches it when its dependencies are done.',
  },
  gated: {
    means: "Parked at the plan's gate — a condition the plan reserves for a person.",
    then: 'Confirm the condition (the note quotes it), then Retry re-checks the gate.',
  },
  running: {
    means: 'A session is working this phase right now.',
    then: 'Watch its tab; Ask reaches the session mid-flight.',
  },
  verifying: {
    means: "The session finished; the console is running the plan's §Verification commands itself.",
    then: 'Nothing to do — green marks it done, red halts with the evidence.',
  },
  'awaiting-verification': {
    means: 'The machine checks passed; steps only a person can confirm remain.',
    then: 'Answer the verification card — it lists exactly what needs your eyes.',
  },
  done: {
    means: 'Finished and independently verified in this run.',
    then: 'Nothing to do.',
  },
  failed: {
    means: 'The attempt failed — a red verification, or a session that produced nothing.',
    then: 'Why? shows the evidence; Fix with AI repairs it, or Retry restarts the run here.',
  },
  interrupted: {
    means: 'The session or console died mid-phase; the working tree is wherever it stopped.',
    then: 'Resume with AI — uncommitted work is preserved, never redone blindly.',
  },
  skipped: {
    means: 'Taken off this run’s list by the operator.',
    then: 'Retry it later if it should still happen.',
  },
  parked: {
    means: 'Needs a person before the loop will touch it again — the note says exactly why.',
    then: 'Read the note (gate, foreign lock, decision), act on it, then Retry.',
  },
  queued: {
    means: 'Waiting for repos another phase or plan is holding; starts itself when they free.',
    then: 'Nothing to do — the queued chip names what it waits on.',
  },
};

/** The BOARD's state — what is true of the phase on disk, departures spelling. */
export const BOARD_STATE_HELP: Record<PhaseState, StatusHelp> = {
  done: {
    means: 'Departed — the handoff is complete; the work is finished and verified.',
    then: 'Nothing to do.',
  },
  ready: {
    means: 'Boarding — every dependency is met; this phase can start now.',
    then: 'Start it (or the autopilot will), or copy its boot prompt from the phase page.',
  },
  'in-progress': {
    means: 'On track — a session is on this phase right now.',
    then: 'Watch its tab. The board catches up when the handoff lands.',
  },
  waiting: {
    means: 'Held — an earlier phase it depends on is not done yet.',
    then: 'Nothing to do here; finish what it waits on.',
  },
  blocked: {
    means: 'Its handoff is marked blocked — the Outstanding section says exactly why.',
    then: 'Read the excerpt on the phase page, or use Repair with AI on the run page.',
  },
  stuck: {
    means: 'Its handoff is marked blocked or in-progress — the Outstanding section says why.',
    then: 'Read the excerpt on the phase page, or use Repair with AI on the run page.',
  },
  gated: {
    means: 'The plan reserves a decision for a person before this phase may run.',
    then: 'Confirm the gate condition (quoted on the phase page), then start or Retry.',
  },
};

/** Whether a claim on a phase still holds. */
export type LockState = 'live' | 'stale';

/**
 * The CLAIM — who holds a phase, and whether that still stops you.
 *
 * A fourth vocabulary, added when the lock started blocking runs rather than
 * merely decorating a row. The distinction it carries is the whole point: a
 * live claim means another session is working and the console refuses to start
 * a second one; a lapsed claim means nobody is, and the only thing left to do
 * is tidy up the file that says otherwise.
 */
export const LOCK_HELP: Record<LockState, StatusHelp> = {
  live: {
    means: 'Another session claimed this phase and its lease has not run out.',
    then: 'Let it finish. If that session is gone, release the claim — the button says who holds it.',
  },
  stale: {
    means: 'The claim lapsed: whoever took it stopped renewing, so nothing is working this phase.',
    then: 'Release it to tidy the board. It does not block a run.',
  },
};

export function lockTitle(state: LockState): string | undefined {
  return line(LOCK_HELP[state]);
}

/** One hover-sized line: the meaning, then the move. */
function line(help: StatusHelp | undefined): string | undefined {
  if (!help) return undefined;
  return `${help.means}\n\n→ ${help.then}`;
}

export function runStatusTitle(status: string | undefined): string | undefined {
  return line(RUN_STATUS_HELP[status as RunStatus]);
}

export function phaseStatusTitle(status: string | undefined): string | undefined {
  return line(PHASE_STATUS_HELP[status as PhaseStatus]);
}

export function boardStateTitle(state: string | undefined): string | undefined {
  return line(BOARD_STATE_HELP[state as PhaseState]);
}

/* ------------------------------------------------------------------ *
 * Tones — the colour each word paints, single-sourced with the words
 * ------------------------------------------------------------------ */

/** The chip palette. Mirrors `chipVariants`' tone axis in `ui/chip.tsx`. */
export type StatusTone = 'ok' | 'busy' | 'bad' | 'warn' | 'gate' | 'neutral' | undefined;

/**
 * `pausing` reads as a state the operator asked for and is waiting on. Neutral
 * grey made an armed pause look identical to an idle run, which is half the
 * reason pressing Pause felt like nothing had happened.
 */
export const RUN_STATUS_TONE: Record<RunStatus, StatusTone> = {
  running: 'busy',
  finished: 'ok',
  halted: 'bad',
  // The halt is already a fact while lanes drain — same colour as the ending
  // it becomes, not a softer one that would read as "still deciding".
  halting: 'bad',
  waiting: 'warn',
  // Not `bad`: parked is not a failure, it is a queue of questions. The run did
  // everything it could without someone.
  parked: 'warn',
  paused: undefined,
  pausing: 'warn',
  stopping: 'warn',
  interrupted: 'warn',
  frozen: 'warn',
  // Not `warn`: nothing is wrong and nobody is being asked for anything. The run
  // is in a line behind another plan's scope and will start itself.
  queued: 'busy',
};

export const PHASE_STATUS_TONE: Record<PhaseStatus, StatusTone> = {
  done: 'ok',
  running: 'busy',
  verifying: 'busy',
  failed: 'bad',
  parked: 'warn',
  interrupted: 'warn',
  gated: 'warn',
  'awaiting-verification': 'warn',
  // In a line behind another scope, not stuck and not asking for anything.
  queued: 'busy',
  skipped: undefined,
  pending: undefined,
};

/* ------------------------------------------------------------------ *
 * QA verdicts
 * ------------------------------------------------------------------ */

export const QA_RESULT_HELP: Record<'pass' | 'fail' | 'waived' | 'pending', StatusHelp> = {
  pass: {
    means: 'A fresh-context QA session read the diff cold, ran the checks, and confirmed the phase.',
    then: 'Nothing to do.',
  },
  fail: {
    means: 'QA recorded a failure — a verdict, not bookkeeping: every dependent phase stays gated on it.',
    then: 'Repair with AI re-runs QA properly; never hand-edit the verdict away.',
  },
  waived: {
    means: 'The gate was turned on after this phase finished, so its QA was deliberately skipped.',
    then: 'Nothing to do — QA it later if you want the confidence.',
  },
  pending: {
    means: 'QA gating is on and this phase has not been reviewed yet.',
    then: 'Run QA from the phase page when it is done.',
  },
};

export function qaResultTitle(result: string | undefined): string | undefined {
  return line(QA_RESULT_HELP[result as keyof typeof QA_RESULT_HELP]);
}
