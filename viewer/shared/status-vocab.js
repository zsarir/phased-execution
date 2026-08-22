/**
 * The status vocabulary — every word the console can show, mapped to exactly
 * one of EIGHT UI states, each with a label, a hue, a tone and an icon.
 *
 * Four vocabularies exist by necessity and used to be painted by five tone
 * tables that agreed with each other only by luck: a RUN's status (what the
 * autopilot is doing), a PHASE RECORD's status (what happened to a phase in a
 * run), the BOARD's state (what is true of a phase on disk), and a SITUATION
 * (why a stopped phase is stopped, `situation-model.js`). This module is the
 * one place each of those words becomes a colour and an icon. Hue and icon are
 * then READ in exactly two places — `StatusBadge` and the `.state-<ui>` CSS
 * classes — so a chip, a row, a strip and a map station cannot disagree.
 *
 * Dependency-free ESM: the client imports it through `lib/status-vocab.ts`,
 * the node suite imports it directly, and `test/status-vocab.test.ts` holds
 * them identical by import identity and the tables total.
 *
 * @typedef {'needs-you'|'failed'|'running'|'verifying'|'waiting'|'queued'|'skipped'|'done'} UiState
 * @typedef {{ label: string, hue: UiState, tone: 'accent'|'bad'|'live'|'wait'|'neutral'|'ok', icon: string }} StateMeta
 */

// The actor table is IMPORTED, never copied: `situation-model.js` owns who a
// situation is for, beside the classifier that decides it.
import { SITUATION_ACTOR } from './situation-model.js';

/**
 * The eight, WORST FIRST. The order is the sort order of every list that
 * groups by state and the precedence `worstOf`/`uiState` decide with: a thing
 * that is several states at once is the one that needs a person soonest.
 * @type {readonly UiState[]}
 */
export const UI_STATES = Object.freeze(
  /** @type {const} */ ([
    'needs-you',
    'failed',
    'running',
    'verifying',
    'waiting',
    'queued',
    'skipped',
    'done',
  ]),
);

/**
 * What each state is called, which hue token paints it (`--status-<hue>`),
 * which tone family it belongs to, and its icon (a lucide name; `StatusBadge`
 * resolves it — this file stays dependency-free).
 *
 * `running` is the only state that may pulse; `verifying` is its family, told
 * apart by a dashed line-style on a map or strip and by its own icon here.
 * @type {Readonly<Record<UiState, StateMeta>>}
 */
export const STATE_META = Object.freeze({
  'needs-you': { label: 'Needs you', hue: 'needs-you', tone: 'accent', icon: 'hand' },
  failed: { label: 'Failed', hue: 'failed', tone: 'bad', icon: 'circle-x' },
  running: { label: 'Running', hue: 'running', tone: 'live', icon: 'circle-play' },
  verifying: { label: 'Verifying', hue: 'verifying', tone: 'live', icon: 'search-check' },
  waiting: { label: 'Waiting', hue: 'waiting', tone: 'wait', icon: 'hourglass' },
  queued: { label: 'Queued', hue: 'queued', tone: 'neutral', icon: 'circle-dashed' },
  skipped: { label: 'Skipped', hue: 'skipped', tone: 'neutral', icon: 'circle-slash' },
  done: { label: 'Done', hue: 'done', tone: 'ok', icon: 'circle-check' },
});

/**
 * The word an unrecognised status paints as. Never amber (it cannot be
 * mistaken for something to act on) and never green (it cannot be mistaken
 * for finished): "waiting" is the honest "we do not know that this can move".
 * @type {UiState}
 */
export const UNKNOWN_STATE = 'waiting';

/**
 * A RUN's status (`server/runner/state.ts` `RunStatus`, twelve words) → UI
 * state. A halt, a park and an interruption all need a person; a pause, a
 * freeze, a usage-window sleep and a stop-in-progress are all waits.
 * @type {Readonly<Record<'running'|'halting'|'halted'|'parked'|'interrupted'|'waiting'|'paused'|'pausing'|'frozen'|'stopping'|'queued'|'finished', UiState>>}
 */
export const RUN_STATUS_UI = Object.freeze({
  running: 'running',
  halting: 'needs-you',
  halted: 'needs-you',
  parked: 'needs-you',
  interrupted: 'needs-you',
  waiting: 'waiting',
  paused: 'waiting',
  pausing: 'waiting',
  frozen: 'waiting',
  stopping: 'waiting',
  queued: 'queued',
  finished: 'done',
});

/**
 * A PHASE RECORD's status (`PhaseStatus`, twelve words) → UI state. `pending`
 * is queued (the loop has not reached it); `gated`, `parked`, `interrupted`
 * and `awaiting-verification` all wait on a person.
 * @type {Readonly<Record<'running'|'verifying'|'done'|'failed'|'skipped'|'queued'|'pending'|'waiting'|'gated'|'parked'|'awaiting-verification'|'interrupted', UiState>>}
 */
export const PHASE_STATUS_UI = Object.freeze({
  running: 'running',
  verifying: 'verifying',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  queued: 'queued',
  pending: 'queued',
  waiting: 'waiting',
  gated: 'needs-you',
  parked: 'needs-you',
  'awaiting-verification': 'needs-you',
  interrupted: 'needs-you',
});

/**
 * The BOARD's state (`phase-graph.sh`, seven words) → UI state. `ready` is
 * "next up" — in line, not asking for anything — and every flavour of stopped
 * (gated, blocked, stuck) needs a person.
 * @type {Readonly<Record<'done'|'in-progress'|'ready'|'waiting'|'gated'|'blocked'|'stuck', UiState>>}
 */
export const BOARD_STATE_UI = Object.freeze({
  done: 'done',
  'in-progress': 'running',
  ready: 'queued',
  waiting: 'waiting',
  gated: 'needs-you',
  blocked: 'needs-you',
  stuck: 'needs-you',
});

/**
 * The one board word that reads differently from its UI state's label: a
 * ready phase is not merely "queued", it is what happens next.
 * @type {Readonly<Record<string, string>>}
 */
export const BOARD_LABELS = Object.freeze({ ready: 'Next up' });

/**
 * Who a situation is for → UI state. Imported, never copied: the actor table
 * lives in `situation-model.js` beside the classifier that writes it.
 * @type {Readonly<Record<'machine'|'person'|'wait'|'none', UiState>>}
 */
export const ACTOR_UI = Object.freeze({
  person: 'needs-you',
  machine: 'running',
  wait: 'waiting',
  none: 'done',
});

/** @param {unknown} value @returns {value is UiState} */
export function isUiState(value) {
  return typeof value === 'string' && UI_STATES.includes(/** @type {UiState} */ (value));
}

/** The UI state of a run status word; unknown words read as `UNKNOWN_STATE`. @param {string|null|undefined} status @returns {UiState} */
export function runUiState(status) {
  return (
    /** @type {UiState|undefined} */ (
      RUN_STATUS_UI[/** @type {keyof typeof RUN_STATUS_UI} */ (status ?? '')]
    ) ?? UNKNOWN_STATE
  );
}

/**
 * The run statuses that have a LOOP behind them — the client's notion of live.
 *
 * Deliberately not the server's `IN_FLIGHT`, and the difference is `queued`: a
 * queued run holds no child and no lock, which is exactly why the server keeps
 * it out of its own list, but a loop IS behind it sitting in `admit()`. Left
 * out, a queued run falls through the status mapping's tail and the fleet calls
 * it *interrupted* while its plan offers a Start button the server 409s.
 *
 * One definition because three surfaces ask the question — the fleet row's
 * pulse, Now's lanes, and the plan pulse — and they had a copy each. Three lists
 * that agree today are three lists that disagree the day a status word is added,
 * and the disagreement shows up as a finished run painted as running on one page
 * and settled on another.
 * @type {readonly string[]}
 */
export const LIVE_RUN_STATUSES = Object.freeze([
  'running',
  'waiting',
  'pausing',
  'stopping',
  'frozen',
  'queued',
  'halting',
]);

/** Is a loop behind this run status? @param {string|null|undefined} status @returns {boolean} */
export function isLiveStatus(status) {
  return LIVE_RUN_STATUSES.includes(status ?? '');
}

/** The UI state of a phase record status word. @param {string|null|undefined} status @returns {UiState} */
export function phaseUiState(status) {
  return (
    /** @type {UiState|undefined} */ (
      PHASE_STATUS_UI[/** @type {keyof typeof PHASE_STATUS_UI} */ (status ?? '')]
    ) ?? UNKNOWN_STATE
  );
}

/** The UI state of a board state word. @param {string|null|undefined} state @returns {UiState} */
export function boardUiState(state) {
  return (
    /** @type {UiState|undefined} */ (
      BOARD_STATE_UI[/** @type {keyof typeof BOARD_STATE_UI} */ (state ?? '')]
    ) ?? UNKNOWN_STATE
  );
}

/**
 * What a board state is called on a badge — the UI state's label, except
 * `ready`, which is "Next up".
 * @param {string|null|undefined} state @returns {string}
 */
export function boardLabel(state) {
  return BOARD_LABELS[state ?? ''] ?? STATE_META[boardUiState(state)].label;
}

/**
 * The UI state of a situation: its actor, with one refinement — a machine's
 * situation that has produced an errand is no longer the machine's problem.
 * @param {string|null|undefined} actor one of `situation-model.js` `SITUATION_ACTOR`'s values
 * @param {{ errand?: unknown }} [opts]
 * @returns {UiState}
 */
export function actorUiState(actor, opts = {}) {
  if (actor === 'machine' && opts.errand) return 'needs-you';
  return (
    /** @type {UiState|undefined} */ (ACTOR_UI[/** @type {keyof typeof ACTOR_UI} */ (actor ?? '')]) ??
    UNKNOWN_STATE
  );
}

/**
 * The UI state of a SITUATION id (`situation-model.js` `SITUATIONS`) — its
 * actor's state, refined by whether an errand has been written for it.
 * @param {string|null|undefined} id
 * @param {{ errand?: unknown }} [opts]
 * @returns {UiState}
 */
export function situationUiState(id, opts = {}) {
  const actor = SITUATION_ACTOR[/** @type {keyof typeof SITUATION_ACTOR} */ (id ?? '')];
  return actorUiState(actor, opts);
}

/**
 * The worst of several UI states, by the order of `UI_STATES`.
 * @param {readonly (UiState|null|undefined)[]} states @returns {UiState}
 */
export function worstOf(states) {
  for (const state of UI_STATES) if (states.includes(state)) return state;
  return UNKNOWN_STATE;
}

/**
 * One UI state for a thing that several vocabularies describe at once.
 *
 * Precedence is "worst first" across whatever the caller knows — with one
 * rule above it: the BOARD saying `done` wins, because the board is the one
 * source of truth for done (a run record the board has overtaken is history,
 * never a state). Open approvals or an errand are a person's, whatever else
 * is true. Nothing known reads as `UNKNOWN_STATE`.
 *
 * @param {{
 *   run?: string|null,
 *   record?: string|null,
 *   board?: string|null,
 *   situation?: { id?: string|null, actor?: string|null }|string|null,
 *   errand?: unknown,
 *   approvals?: number|boolean|null,
 * }} [facts]
 * @returns {UiState}
 */
export function uiState(facts = {}) {
  const { run, record, board, situation, errand, approvals } = facts;
  if (board != null && BOARD_STATE_UI[/** @type {keyof typeof BOARD_STATE_UI} */ (board)] === 'done')
    return 'done';
  /** @type {UiState[]} */
  const states = [];
  if (approvals) states.push('needs-you');
  if (errand) states.push('needs-you');
  if (situation != null) {
    if (typeof situation === 'string') {
      // A situation id, or a bare actor word — ids win, actors are the fallback.
      states.push(
        situation in SITUATION_ACTOR
          ? situationUiState(situation, { errand })
          : actorUiState(situation, { errand }),
      );
    } else if (situation.actor != null) {
      states.push(actorUiState(situation.actor, { errand }));
    } else if (situation.id != null) {
      states.push(situationUiState(situation.id, { errand }));
    }
  }
  if (record != null) states.push(phaseUiState(record));
  if (board != null) states.push(boardUiState(board));
  if (run != null) states.push(runUiState(run));
  return states.length ? worstOf(states) : UNKNOWN_STATE;
}

/**
 * The UI state a bare status WORD would paint as, whichever vocabulary it
 * belongs to — for the Guide's glossary, where the words are inline code in
 * markdown. A UI state's own name answers as itself; an unknown word answers
 * null, never a guess.
 * @param {string} word @returns {UiState|null}
 */
export function wordUiState(word) {
  if (isUiState(word)) return word;
  if (word in RUN_STATUS_UI) return RUN_STATUS_UI[/** @type {keyof typeof RUN_STATUS_UI} */ (word)];
  if (word in PHASE_STATUS_UI) return PHASE_STATUS_UI[/** @type {keyof typeof PHASE_STATUS_UI} */ (word)];
  if (word in BOARD_STATE_UI) return BOARD_STATE_UI[/** @type {keyof typeof BOARD_STATE_UI} */ (word)];
  return null;
}

/** The label for a UI state. @param {UiState|string} state @returns {string} */
export function uiLabel(state) {
  return (STATE_META[/** @type {UiState} */ (state)] ?? STATE_META[UNKNOWN_STATE]).label;
}
