/**
 * The ladder's vocabulary: every vehicle a rung may name, the rung table per
 * situation (climb order, labels, blurbs, whether a rung spends), and the
 * caps' shipped defaults — ONE table, read by three layers by import identity:
 *
 *   - `server/runner/ladder.ts` climbs it (`nextRung`, the caps, the errand
 *     word-book — the logic stays there; this file is the data);
 *   - `client/src/lib/ladder.ts` re-exports it so Ways forward can say what was
 *     tried and what the machine tries next in the SAME words the journal and
 *     the server's errand carry;
 *   - the node tests hold the two identical (`test/ladder.test.ts`).
 *
 * Dependency-free ESM (`.js` + JSDoc), the `situation-model.js` precedent:
 * the client imports it relatively (node resolves no Vite alias in the test
 * suite), the server as `../../shared/ladder-model.js`.
 */

import { parseSituationKey } from './situation-model.js';

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

/**
 * Every vehicle a rung may name. The vocabulary is the design's, not the
 * console's current ability: a vehicle the console cannot drive yet is simply
 * never `available`, and the ladder skips it — so the tables below can state
 * the full ladder while the vehicles land one by one.
 */
export const RUNG_VEHICLES = Object.freeze(
  /** @type {const} */ ([
    /** Reset the record and board the phase fresh from the engine's boot prompt (`retryPhase`). */
    'reboard-fresh',
    /** `claude -p --resume` the phase's own session through the runner, with an instruction. */
    'resume-own-session',
    /** Board fresh with a runner-appended resume brief (SKILL.md Mode 2 "RESUMING" + evidence). */
    'reboard-resume-brief',
    /** One bounded session explicitly allowed to do the work that unblocks a declared blocker. */
    'unblock-session',
    /** The phase's own session, asked only to verify, commit and write the handoff. */
    'closeout-own-session',
    /** A fresh briefed agent writing the handoff the phase never wrote. */
    'closeout-agent',
    /** A fresh briefed agent at a stronger model/effort fixing the failing verification. */
    'fix-agent',
    /** `scripts/repair-artefacts.sh` — deterministic plan/handoff/INDEX/lock-debris repair. */
    'plan-repair-script',
    /** The plan-repair agent (exists). */
    'plan-repair-agent',
    /** Continue under another registered account with headroom (`trySwitchAccount`). */
    'switch-account',
    /** Continue on the next model in the fallback chain. */
    'switch-model',
    /** Sleep until the usage window (or the first model's window) reopens. */
    'wait-window',
    /** Raise the phase/run budget once, within the policy cap. */
    'raise-budget',
    /** Take over an expired foreign claim (`stale-claim-takeover` agent class). */
    'stale-claim-takeover',
    /** Re-board and let the scheduler queue behind the lock holder. */
    'queue',
    /** Park and poll machine-checkable watch refs (`gh run`, PR state). */
    'poll-park',
    /** Park for a bounded time, then re-evaluate. */
    'timed-park',
    /** Re-check the declared watch refs after a wait elapsed. */
    'recheck-watch',
    /** Wait a bounded time for an MCP server to heal. */
    'wait-heal',
    /** Set the run's MCP policy to continue and re-board the parked phases (exists). */
    'mcp-continue',
  ]),
);

/** @typedef {(typeof RUNG_VEHICLES)[number]} RungVehicle */

/**
 * @typedef {Object} Rung
 * @property {RungVehicle} vehicle
 * @property {Record<string, string|number|boolean>} [params]  What distinguishes two rungs on the same vehicle (an escalation step, a mode).
 * @property {string} label   What the rung is called on a card and in the journal.
 * @property {string} blurb   The promise: what starts, on what, roughly what it costs.
 * @property {boolean} spends Whether climbing it spends a session (counts against the USD caps' intent).
 */

/**
 * @param {RungVehicle} vehicle
 * @param {string} label
 * @param {string} blurb
 * @param {boolean} spends
 * @param {Rung['params']} [params]
 * @returns {Rung}
 */
const R = (vehicle, label, blurb, spends, params) =>
  Object.freeze({ vehicle, label, blurb, spends, ...(params ? { params: Object.freeze(params) } : {}) });

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

/**
 * The ladder, per situation (or `situation:sub`). Order is the climb order.
 * An empty list means the situation has no automatic rung: the errand is
 * written at once (a person's), or nothing is done (a wait's).
 * @type {Readonly<Record<string, readonly Rung[]>>}
 */
export const RUNGS_BY_SITUATION = Object.freeze({
  superseded: Object.freeze([]),
  'qa-failed': Object.freeze([]),
  'qa-pending': Object.freeze([]),
  'foreign-live': Object.freeze([]),
  'foreign-stale': Object.freeze([
    R(
      'stale-claim-takeover',
      'Take over the stale claim',
      'Takes the expired claim and continues the unfinished work — then the work-in-progress ladder applies. Costs a session.',
      true,
    ),
  ]),
  'waiting-external': Object.freeze([
    R(
      'recheck-watch',
      'Re-check what it waits on',
      'Reads the declared watch refs again after the wait elapsed; resumes the own session when they have landed. Free.',
      false,
    ),
  ]),
  'gated-manual': Object.freeze([]),
  'plan-broken': Object.freeze([
    R(
      'plan-repair-script',
      'Deterministic repair',
      'Runs scripts/repair-artefacts.sh: depends_on from the graph, missing INDEX rows, dead-run lock debris. No session. Free.',
      false,
    ),
    R(
      'plan-repair-agent',
      'Repair the plan with a new agent',
      'Briefs a fresh agent with the lint/health findings and lets it edit the plan, handoffs or INDEX until validate.sh passes. Costs a session.',
      true,
    ),
  ]),
  'mcp-unavailable': Object.freeze([
    R(
      'wait-heal',
      'Wait for the server',
      'Holds the phase a bounded time for the unreachable MCP server to come back. Free.',
      false,
    ),
    R(
      'mcp-continue',
      'Continue without it',
      "Sets this run's MCP policy to continue and re-boards the parked phases without the server; the session is told and records an errand. Costs the phase's own session.",
      true,
    ),
  ]),
  'resource-wall:usage': Object.freeze([
    R(
      'switch-account',
      'Switch to an account with headroom',
      'Continues at once under the registered account whose usage window has the most room — same session when its transcript came along. Free to switch; the phase still costs.',
      false,
    ),
    R(
      'switch-model',
      'Switch model',
      'Continues on the next model in the fallback chain. Free to switch; the phase still costs.',
      false,
    ),
    R(
      'wait-window',
      'Wait for the window',
      'Sleeps until the usage window reopens, then continues. Free.',
      false,
    ),
  ]),
  'resource-wall:auth': Object.freeze([
    R(
      'switch-account',
      'Switch to a signed-in account',
      'Continues under a registered account that is signed in. Free to switch; the phase still costs.',
      false,
    ),
  ]),
  'resource-wall:budget': Object.freeze([
    R(
      'raise-budget',
      'Raise the budget once',
      'Raises the spent budget once, within the policy cap, and continues. The raise is the cost.',
      true,
    ),
  ]),
  'resource-wall:model': Object.freeze([
    R(
      'wait-window',
      "Wait for the first model's window",
      "Sleeps until the first model's own limit resets, then continues on it. Free.",
      false,
    ),
  ]),
  'blocked-declared:lock': Object.freeze([
    R(
      'queue',
      'Queue behind the lock',
      'Re-boards the phase and lets the scheduler wait for the holder — woken by the docs watcher, the lease expiry and the idle poll. Free until it boards.',
      false,
    ),
  ]),
  'blocked-declared:credential': Object.freeze([]),
  'blocked-declared:gate': Object.freeze([]),
  'blocked-declared:external': Object.freeze([
    R(
      'poll-park',
      'Park and poll the refs',
      'Parks the phase and polls its machine-checkable watch refs (a gh run, a PR); resumes the own session when they land. Free until then.',
      false,
    ),
    R('timed-park', 'Park for a while', 'Parks the phase for a bounded time and re-evaluates. Free.', false),
  ]),
  'blocked-declared:unknown': Object.freeze([
    R(
      'unblock-session',
      'One bounded unblock session',
      "Resumes the phase's own session (or boards fresh with an unblock brief) carrying the Outstanding text, explicitly allowed to do the work that unblocks it. One try; costs a session.",
      true,
    ),
  ]),
  'verify-red': Object.freeze([
    R(
      'resume-own-session',
      'Resume with the failure',
      "Resumes the phase's own session with the failing commands and their output, asking it to fix the cause and finish. Costs a session.",
      true,
      { mode: 'fix-verification' },
    ),
    R(
      'fix-agent',
      'Fix with a stronger new agent',
      'Briefs a fresh agent at a stronger model/effort with the evidence and lets it fix and finish the phase. Costs a full session.',
      true,
      { escalate: 'model' },
    ),
  ]),
  'done-unrecorded': Object.freeze([
    R(
      'closeout-own-session',
      'Finish in its own session',
      "Resumes the phase's own session and asks it to verify, commit and write the handoff — nothing else. Costs little; its context is intact.",
      true,
    ),
    R(
      'closeout-agent',
      'Close out with a new agent',
      'Briefs a fresh agent to check the phase against the repository and write the handoff it never wrote. Costs a full session.',
      true,
    ),
  ]),
  'work-in-progress': Object.freeze([
    R(
      'resume-own-session',
      'Continue in its own session',
      'Resumes the phase\'s own session: "you are RESUMING — read git status and git diff first, then carry the phase to its exit criteria". Costs a session.',
      true,
      { mode: 'continue' },
    ),
    R(
      'reboard-resume-brief',
      'Board fresh with a resume brief',
      "Boards a fresh session from the engine's boot prompt plus a runner-appended resume brief (the evidence, SKILL.md Mode 2 RESUMING). Costs a full session.",
      true,
    ),
    R(
      'reboard-resume-brief',
      'Board fresh, stronger',
      'The same resume brief at the next model/effort step. Costs a full session.',
      true,
      { escalate: 'model' },
    ),
  ]),
  'never-started': Object.freeze([
    R(
      'reboard-fresh',
      'Re-board fresh',
      'Resets the record to pending and boards the phase from its boot prompt under normal admission — no closeout, no agent, no person. Costs the phase itself.',
      true,
    ),
  ]),
  unknown: Object.freeze([]),
});

/**
 * The rung list for a situation, by `id:sub` first and then by `id`.
 * @param {string} situationKeyOrId
 * @returns {readonly Rung[]}
 */
export function rungsFor(situationKeyOrId) {
  if (situationKeyOrId in RUNGS_BY_SITUATION) return RUNGS_BY_SITUATION[situationKeyOrId];
  const { id } = parseSituationKey(situationKeyOrId);
  return RUNGS_BY_SITUATION[id] ?? [];
}

/**
 * The identity a "same rung" is judged by: situation key + vehicle + params.
 * @param {string} situation
 * @param {{ vehicle: string, params?: Rung['params'] }} rung
 */
export function rungKey(situation, rung) {
  const params = rung.params
    ? Object.entries(rung.params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  return `${situation}|${rung.vehicle}${params ? `|${params}` : ''}`;
}

/**
 * @typedef {Object} RungRecordLike
 * @property {string} situation
 * @property {string} rung
 * @property {Rung['params']} [params]
 * @property {string} [outcome]
 */

/**
 * The rungs of a situation's table not yet climbed on a phase, in climb order
 * — the first is what the autopilot tries next, caps and availability
 * permitting (those are the server's to judge; `server/runner/ladder.ts`
 * `nextRung`). A display helper: a card says "next: …" from this.
 * @param {string} situationKeyOrId
 * @param {readonly RungRecordLike[]} history  Every rung already climbed on the phase, any situation.
 * @returns {readonly Rung[]}
 */
export function untriedRungs(situationKeyOrId, history) {
  const key =
    situationKeyOrId in RUNGS_BY_SITUATION ? situationKeyOrId : parseSituationKey(situationKeyOrId).id;
  const tried = new Set(history.map((r) => rungKey(r.situation, { vehicle: r.rung, params: r.params })));
  return rungsFor(key).filter((rung) => !tried.has(rungKey(key, rung)));
}

/* ------------------------------------------------------------------ *
 * Words for a rung that has already been climbed
 * ------------------------------------------------------------------ */

/**
 * A readable name for a vehicle when no table row matches (a rung written by
 * a newer console, a vehicle the table lists in no situation): the id with
 * its dashes opened up.
 * @param {string} vehicle
 */
const humanised = (vehicle) => vehicle.replace(/-/g, ' ');

/**
 * The label a climbed rung is called by — the table row's own label when the
 * vehicle and params match one (in ANY situation's table, the situation the
 * record carries first), else the vehicle's name opened up.
 * @param {string} vehicle
 * @param {Rung['params']} [params]
 * @param {string} [situation]  The situation the rung was climbed for, when known.
 */
export function rungLabel(vehicle, params, situation) {
  const same = (/** @type {Rung} */ rung) =>
    rung.vehicle === vehicle && rungKey('x', { vehicle, params }) === rungKey('x', rung);
  const tables = situation
    ? [rungsFor(situation), ...Object.values(RUNGS_BY_SITUATION)]
    : Object.values(RUNGS_BY_SITUATION);
  for (const table of tables) {
    const row = table.find(same);
    if (row) return row.label;
  }
  // A looser match — same vehicle, whatever the params — still beats the raw id.
  for (const table of tables) {
    const row = table.find((rung) => rung.vehicle === vehicle);
    if (row) return row.label;
  }
  return humanised(vehicle);
}

/**
 * How a rung ended, in a word a card can show beside its label.
 * @type {Readonly<Record<string, string>>}
 */
export const RUNG_OUTCOME_LABELS = Object.freeze({
  running: 'running',
  fixed: 'fixed it',
  'no-defect': 'found nothing wrong',
  superseded: 'overtaken by the board',
  failed: 'did not hold',
});

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

/**
 * The shipped caps — 3 rungs & $100 per phase · 10 & $400 per run · $600 per
 * day per console. Every one is a preference (`ladder*` keys, Settings ▸
 * Automation); these are what an unset preference means.
 */
export const DEFAULT_LADDER_CAPS = Object.freeze({
  perPhaseRungs: 3,
  perPhaseUsd: 100,
  perRunRungs: 10,
  perRunUsd: 400,
  perDayUsd: 600,
});

/** The preference key behind each cap, for a Settings card and its docs. */
export const LADDER_CAP_PREFS = Object.freeze({
  perPhaseRungs: 'ladderPerPhaseRungs',
  perPhaseUsd: 'ladderPerPhaseUsd',
  perRunRungs: 'ladderPerRunRungs',
  perRunUsd: 'ladderPerRunUsd',
  perDayUsd: 'ladderPerDayUsd',
});
