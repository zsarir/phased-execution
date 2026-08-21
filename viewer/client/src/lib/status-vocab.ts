/**
 * The client half of the status vocabulary.
 *
 * The MAPPING — every run, phase-record, board and situation word → one of
 * eight UI states, each with a label, a hue, a tone and an icon — lives in
 * `shared/status-vocab.js`, imported here by identity (the node suite's
 * `test/status-vocab.test.ts` holds the two the same object). Hue and icon
 * are read in exactly two places, `components/ui/status-badge.tsx` and the
 * `.state-<ui>` classes in `styles/theme.css`; nothing else names a colour
 * for a status.
 *
 * What is CLIENT-ONLY, and therefore here: the explanations — what each word
 * MEANS and what to DO about it, in one sentence each. Badges read them as
 * their default `title`; the Guide's Reference section renders the same
 * objects as tables — one source, so the hover and the page can never
 * disagree. `Record<Status, …>` over the closed unions makes forgetting a new
 * status a type error here, not a silent empty tooltip.
 */

// Relative, not `@shared/…`: the node test suite imports THIS file directly
// and node resolves no Vite alias.
export {
  ACTOR_UI,
  BOARD_LABELS,
  BOARD_STATE_UI,
  PHASE_STATUS_UI,
  RUN_STATUS_UI,
  STATE_META,
  UI_STATES,
  UNKNOWN_STATE,
  actorUiState,
  boardLabel,
  boardUiState,
  isUiState,
  phaseUiState,
  runUiState,
  situationUiState,
  uiLabel,
  uiState,
  wordUiState,
  worstOf,
} from '../../../shared/status-vocab.js';

// Type-only, and straight from the module rather than the barrel: the runtime
// graph must stay one-directional (component → vocab); a type edge the
// compiler erases is fine.
import type { PhaseStatus, RunStatus } from '@/lib/api';
import {
  BOARD_STATE_UI as _BOARD,
  PHASE_STATUS_UI as _PHASE,
  RUN_STATUS_UI as _RUN,
} from '../../../shared/status-vocab.js';

/** The eight UI states, worst first. */
export type UiState =
  'needs-you' | 'failed' | 'running' | 'verifying' | 'waiting' | 'queued' | 'skipped' | 'done';

/** What a UI state carries: how it is labelled and painted. */
export type StateMeta = {
  label: string;
  /** The hue token suffix: `--status-<hue>`. */
  hue: UiState;
  tone: 'accent' | 'bad' | 'live' | 'wait' | 'neutral' | 'ok';
  /** A lucide icon name; `StatusBadge` resolves it. */
  icon: string;
};

/** The BOARD's state words, as `phase-graph.sh` spells them. */
export type BoardState = keyof typeof _BOARD;
export const BOARD_STATES = Object.freeze(Object.keys(_BOARD) as BoardState[]);

/**
 * Totality, checked by the compiler: every `RunStatus` and `PhaseStatus` the
 * API types know must be a key of the shared table. A new status lands here
 * as a type error before it can land on a page as an unexplained grey badge.
 */
const _runTotal: Record<RunStatus, UiState> = _RUN;
const _phaseTotal: Record<PhaseStatus, UiState> = _PHASE;
void _runTotal;
void _phaseTotal;

export type StatusHelp = {
  /** What the word means, in one sentence. */
  means: string;
  /** What, if anything, the operator should do about it. */
  then: string;
};

/** What each UI STATE means — the eight-row table the Guide leads with. */
export const UI_STATE_HELP: Record<UiState, StatusHelp> = {
  'needs-you': {
    means:
      'Stopped until a person does something — an approval, a gate, a sign-in, a decision, or an errand the loop could not finish itself.',
    then: 'Read the row: it names what is needed and how. This is the only state painted amber.',
  },
  failed: {
    means: 'The attempt failed — a red verification, or a session that produced nothing the board accepts.',
    then: 'Open the evidence. Fix the cause yourself, or let a recovery session try; then Retry.',
  },
  running: {
    means: 'A session is working right now. The only state that may pulse.',
    then: 'Nothing to do — watch the lane. Ask or Steer reach the session mid-flight.',
  },
  verifying: {
    means: "The session finished and the console is running the plan's own §Verification commands.",
    then: 'Nothing to do — green marks it done, red fails it with the evidence.',
  },
  waiting: {
    means:
      'Asleep on something that settles by itself — a dependency, a usage window, an external clock, a pause you asked for.',
    then: 'Nothing to do. The row says what it waits on and when it wakes.',
  },
  queued: {
    means:
      'In line — next up, or behind something holding the same repos; it starts itself when its turn comes.',
    then: 'Nothing to do.',
  },
  skipped: {
    means: 'Taken off this run’s list by the operator. Not finished, not failed.',
    then: 'Retry it later if it should still happen.',
  },
  done: {
    means: 'Finished and recorded on the board.',
    then: 'Nothing to do.',
  },
};

/** The RUN's own status — what the autopilot is doing with the whole plan. */
export const RUN_STATUS_HELP: Record<RunStatus, StatusHelp> = {
  running: {
    means: 'The autopilot is driving: sessions spawn, verify and hand off by themselves.',
    then: 'Nothing to do — watch the lanes. Pause, Freeze and Stop all apply.',
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
    then: 'Read "Ways forward": each blocker is named with its remedy.',
  },
  queued: {
    means: 'In line behind another plan holding the same repos; starts itself when the scope frees.',
    then: 'Nothing to do — the holder is named on the queued badge.',
  },
  halting: {
    means: 'A halt was recorded; live sessions are finishing before the run fully stops.',
    then: 'Read the halt card. The run reads halted once the last session settles.',
  },
  halted: {
    means: 'Stopped on something that must not be automated past — usually a red verification.',
    then: 'Use Ways forward on the run page, or fix the cause yourself and Retry the phase.',
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
    then: 'Recover & continue, or press Continue — work already on disk is kept.',
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
    then: 'Watch its lane; Ask reaches the session mid-flight.',
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
    then: 'Why? shows the evidence; a recovery session repairs it, or Retry restarts the run here.',
  },
  interrupted: {
    means: 'The session or console died mid-phase; the working tree is wherever it stopped.',
    then: 'Recover & continue — uncommitted work is preserved, never redone blindly.',
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
    then: 'Nothing to do — the queued badge names what it waits on.',
  },
  waiting: {
    means: 'Parked on an external clock the session declared — a CI build, a PR auto-merge, a deploy window.',
    then: "Nothing to do — the runner resumes the phase's own session when the window elapses.",
  },
};

/** The BOARD's state — what is true of the phase on disk. */
export const BOARD_STATE_HELP: Record<BoardState, StatusHelp> = {
  done: {
    means: 'The handoff is complete; the work is finished and verified.',
    then: 'Nothing to do.',
  },
  ready: {
    means: 'Next up — every dependency is met; this phase can start now.',
    then: 'Start it (or the autopilot will), or copy its boot prompt from the phase page.',
  },
  'in-progress': {
    means: 'A session is on this phase right now.',
    then: 'Watch its lane. The board catches up when the handoff lands.',
  },
  waiting: {
    means: 'An earlier phase it depends on is not done yet.',
    then: 'Nothing to do here; finish what it waits on.',
  },
  blocked: {
    means: 'Its handoff is marked blocked — the Outstanding section says exactly why.',
    then: 'Read the excerpt on the phase page, or use Ways forward on the run page.',
  },
  stuck: {
    means:
      'Its handoff is marked blocked or in-progress with nobody on it — the Outstanding section says why.',
    then: 'Read the excerpt on the phase page, or use Ways forward on the run page.',
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
 * A live claim means another session is working and the console refuses to
 * start a second one; a lapsed claim means nobody is, and the only thing left
 * to do is tidy up the file that says otherwise.
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

export function uiStateTitle(state: string | undefined): string | undefined {
  return line(UI_STATE_HELP[state as UiState]);
}

export function runStatusTitle(status: string | undefined): string | undefined {
  return line(RUN_STATUS_HELP[status as RunStatus]);
}

export function phaseStatusTitle(status: string | undefined): string | undefined {
  return line(PHASE_STATUS_HELP[status as PhaseStatus]);
}

export function boardStateTitle(state: string | undefined): string | undefined {
  return line(BOARD_STATE_HELP[state as BoardState]);
}

/**
 * The explanation for a bare status WORD, whichever vocabulary it belongs to
 * — the Guide's glossary decorator pairs it with `wordUiState`.
 */
export function wordTitle(word: string): string | undefined {
  return uiStateTitle(word) ?? runStatusTitle(word) ?? phaseStatusTitle(word) ?? boardStateTitle(word);
}

/* ------------------------------------------------------------------ *
 * QA verdicts
 * ------------------------------------------------------------------ */

export type QaResultWord = 'pass' | 'fail' | 'waived' | 'pending';

export const QA_RESULT_HELP: Record<QaResultWord, StatusHelp> = {
  pass: {
    means: 'A fresh-context QA session read the diff cold, ran the checks, and confirmed the phase.',
    then: 'Nothing to do.',
  },
  fail: {
    means: 'QA recorded a failure — a verdict, not bookkeeping: every dependent phase stays gated on it.',
    then: 'Repair with a new session re-runs QA properly; never hand-edit the verdict away.',
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

/**
 * A QA verdict → UI state. `pass` is done, `fail` is failed, `waived` is
 * skipped; `pending` is queued — a review asked for and not yet answered is
 * closer to "in line" than to a verdict.
 */
export const QA_RESULT_UI: Record<QaResultWord | 'unknown', UiState> = {
  pass: 'done',
  fail: 'failed',
  waived: 'skipped',
  pending: 'queued',
  unknown: 'queued',
};

export function qaUiState(result: string | undefined): UiState {
  return QA_RESULT_UI[(result ?? 'unknown') as QaResultWord | 'unknown'] ?? 'queued';
}

export function qaResultTitle(result: string | undefined): string | undefined {
  return line(QA_RESULT_HELP[result as QaResultWord]);
}
