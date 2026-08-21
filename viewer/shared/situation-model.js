/**
 * The situation model: ONE vocabulary for "why is this phase not done, and
 * who can do something about it".
 *
 * The autopilot used to choose its remedy from the HALT KIND assigned at the
 * halt site — a word about where the runner stopped, not about the phase. The
 * three measured dead ends (the 2026-08-19 design investigation) were all the
 * same mistake: a never-started phase read as "interrupted" and parked; an
 * in-progress handoff read as "missing paperwork" and closed out twice; a
 * declared blocker read as "no handoff" and re-confirmed for $68. A situation
 * is a claim about the PHASE, computed from evidence (board, handoff, record,
 * lock, working tree, declared outcome, gate, MCP, health) by
 * `server/runner/situation.ts` — this file is only the words.
 *
 * Dependency-free ESM (`.js` + JSDoc), the `recovery-model.js` precedent: the
 * client imports it as `@shared/situation-model.js`, the server as
 * `../../shared/situation-model.js`, and the node tests directly — so one
 * parity test can hold every layer to the same ids by import identity.
 *
 * The list is in PRECEDENCE ORDER: the classifier walks it top to bottom and
 * the first situation whose evidence holds wins. The order is a decision,
 * not an accident — a phase whose board reads done is superseded whatever
 * its record says; a foreign live session outranks everything that would
 * spend; a declared wait outranks a declared blocker; the plan being broken
 * outranks the phase being red, because the repair is cheaper and the red
 * may be its symptom.
 */

/**
 * @typedef {'superseded'|'qa-failed'|'qa-pending'|'foreign-live'|'foreign-stale'
 *   |'waiting-external'|'gated-manual'|'plan-broken'|'mcp-unavailable'|'resource-wall'
 *   |'blocked-declared'|'verify-red'|'done-unrecorded'|'work-in-progress'|'never-started'
 *   |'unknown'} SituationId
 */

/** Every situation, in classifier precedence. Frozen: it is a vocabulary. */
export const SITUATIONS = Object.freeze(
  /** @type {const} */ ([
    'superseded',
    'qa-failed',
    'qa-pending',
    'foreign-live',
    'foreign-stale',
    'waiting-external',
    'gated-manual',
    'plan-broken',
    'mcp-unavailable',
    'resource-wall',
    'blocked-declared',
    'verify-red',
    'done-unrecorded',
    'work-in-progress',
    'never-started',
    'unknown',
  ]),
);

/**
 * Sub-kinds for the situations that branch. `blocked-declared` and
 * `resource-wall` are closed lists (the ladder has a rung table per sub-kind);
 * `plan-broken` names the first issue kind and is open — a new health check
 * adds a word without editing this file.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SUB_KINDS = Object.freeze({
  'blocked-declared': Object.freeze(['lock', 'credential', 'gate', 'external', 'unknown']),
  'resource-wall': Object.freeze(['usage', 'auth', 'budget', 'model']),
  'plan-broken': Object.freeze(['lint', 'unreadable', 'verification', 'issue']),
});

/**
 * Who the situation is for — the thing the UI colours by and the ladder
 * decides with:
 *   - `machine`: the ladder has rungs; a person is asked only when they are
 *     exhausted (an Errand);
 *   - `person`: intrinsically human (a manual gate, a QA verdict, a credential
 *     the session named); the Errand is written at once, nothing spends;
 *   - `wait`: time or someone else settles it (a foreign live session, an
 *     external clock the park machinery already owns); nothing is launched;
 *   - `none`: nothing is wrong — the board already settled it.
 * @type {Readonly<Record<SituationId, 'machine'|'person'|'wait'|'none'>>}
 */
export const SITUATION_ACTOR = Object.freeze({
  superseded: 'none',
  'qa-failed': 'person',
  'qa-pending': 'person',
  'foreign-live': 'wait',
  'foreign-stale': 'machine',
  'waiting-external': 'wait',
  'gated-manual': 'person',
  'plan-broken': 'machine',
  'mcp-unavailable': 'machine',
  'resource-wall': 'machine',
  'blocked-declared': 'machine',
  'verify-red': 'machine',
  'done-unrecorded': 'machine',
  'work-in-progress': 'machine',
  'never-started': 'machine',
  unknown: 'person',
});

/**
 * What a card, a chip and a journal line call each situation — a short noun
 * phrase, never a sentence.
 * @type {Readonly<Record<SituationId, string>>}
 */
export const SITUATION_LABELS = Object.freeze({
  superseded: 'Superseded',
  'qa-failed': 'QA failed',
  'qa-pending': 'QA pending',
  'foreign-live': 'Another session is in it',
  'foreign-stale': 'Stale foreign claim',
  'waiting-external': 'Waiting on the outside',
  'gated-manual': 'Gate needs a person',
  'plan-broken': 'Plan needs repair',
  'mcp-unavailable': 'MCP server unreachable',
  'resource-wall': 'Resource wall',
  'blocked-declared': 'Declared blocked',
  'verify-red': 'Verification red',
  'done-unrecorded': 'Done, unrecorded',
  'work-in-progress': 'Work in progress',
  'never-started': 'Never started',
  unknown: 'Unclassified',
});

/**
 * One line each: what the situation MEANS and what the autopilot does about
 * it. The tooltip contract, as for recovery actions — a reader should be able
 * to predict the next automatic act from the blurb alone.
 * @type {Readonly<Record<SituationId, string>>}
 */
export const SITUATION_BLURBS = Object.freeze({
  superseded:
    'The board already reads this phase done — the record is stale and closes itself. Nothing to run.',
  'qa-failed':
    'The handoff is complete but the recorded QA verdict is fail, so dependents are held. A person re-runs QA — the autopilot never spawns reviewers on its own.',
  'qa-pending':
    'The handoff is complete but the plan gates on QA and no verdict is recorded. A person runs QA; dependents wait.',
  'foreign-live':
    'A live session that is not this run holds the phase lock. The autopilot stands down and re-evaluates when the session ends.',
  'foreign-stale':
    'An expired claim from a session that is gone, over unfinished work. The claim is taken over and the work continued.',
  'waiting-external':
    'The session declared it is waiting on something outside (CI, a PR, a deploy window). The park re-checks and resumes its own session.',
  'gated-manual':
    "A manual gate only a person can clear stands before this phase. The errand is the gate's own numbered steps.",
  'plan-broken':
    'The plan, its handoffs or its §Verification fail a structural check. Deterministic repair first, a plan-repair agent second, then an errand.',
  'mcp-unavailable':
    'A server the phase requires under policy require cannot connect. The run waits for it to heal, then continues without it and records an errand.',
  'resource-wall':
    'A usage window, a sign-in, a budget or a model limit stopped the work. The ladder switches account or model, raises once, or waits for the window.',
  'blocked-declared':
    'The session itself said it was blocked — in its handoff or its declared outcome. The sub-kind decides: queue behind a lock, poll an external ref, one bounded unblock session, or an errand.',
  'verify-red':
    "The phase's own §Verification fails. Its session is resumed with the failure, then a stronger fresh agent, then an errand.",
  'done-unrecorded':
    'Verification is green and work landed, but no complete handoff exists. The own session is asked to close out; a fresh agent if it cannot.',
  'work-in-progress':
    'Real work exists and is unfinished — an in-progress handoff, commits, a dirty tree. The own session continues the work; else a fresh session boards with a resume brief.',
  'never-started':
    'No handoff, nothing on disk, a session that ended before it began. The phase re-boards fresh — no closeout, no person.',
  unknown: 'The evidence fits no named situation. A person reads it, and the classifier gains a case.',
});

/** @param {unknown} value */
export function isSituation(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (SITUATIONS).includes(value);
}

/**
 * The journal/record key for a situation with its sub-kind — `blocked-declared:unknown`.
 * @param {SituationId|string} id
 * @param {string} [sub]
 */
export function situationKey(id, sub) {
  return sub ? `${id}:${sub}` : String(id);
}

/**
 * The inverse of `situationKey`. An unknown id parses to `unknown`, never
 * throws — records written by a later version still read.
 * @param {string|null|undefined} key
 * @returns {{ id: SituationId, sub?: string }}
 */
export function parseSituationKey(key) {
  const [id, ...rest] = String(key ?? '').split(':');
  const sub = rest.join(':') || undefined;
  if (!isSituation(id)) return { id: 'unknown' };
  return sub ? { id: /** @type {SituationId} */ (id), sub } : { id: /** @type {SituationId} */ (id) };
}

/**
 * The human label with the sub-kind folded in — "Declared blocked · credential".
 * @param {SituationId|string} id
 * @param {string} [sub]
 */
export function situationLabel(id, sub) {
  const base = /** @type {Record<string, string>} */ (SITUATION_LABELS)[id] ?? SITUATION_LABELS.unknown;
  return sub ? `${base} · ${sub}` : base;
}
