/**
 * The attention model: ONE vocabulary for "something needs a person right
 * now", and the two rules every surface that shows one must agree on — what
 * makes two asks the SAME ask, and what order they are read in.
 *
 * Before the unified inbox, eight places each decided in their own words that
 * something was waiting on a person: the dashboard's `demands()`, the push
 * catalogue's `needs-you` category, the ladder's errands, the approval cards,
 * the accounts page's signed-out banner, the MCP status chips, the per-plan
 * health issues and the lock table. Nothing could count them, because nothing
 * could say whether a halted-run card, the errand under it and the push that
 * announced it were three asks or one; and nothing could be dismissed, because
 * an ask had no name to dismiss. `GET /api/inbox` answers that list once. This
 * file is the part of the answer that cannot live in one layer: the kinds, the
 * severities, the identity an acknowledgement is keyed on, and the order.
 *
 * Read by (import identity, never a copy):
 *
 *   - `viewer/server/inbox.ts` — gathers the facts and builds the items; it
 *     mints every `InboxItem.id` with `inboxItemId` and returns
 *     `sortInbox(items)`. It owns WHICH facts raise an item; this file owns
 *     what those items are called, what they are worth and who they are;
 *   - `viewer/server/api/routes.ts` — `GET /api/inbox`, `POST /api/inbox/ack`,
 *     `DELETE /api/inbox/ack`. The acks file is keyed by the id minted here,
 *     so the id IS the ack key and the stability rules below are load-bearing;
 *   - `viewer/client/src/lib/api/inbox.ts` — the wire TYPES, agreed in Phase 3
 *     (`InboxKind`, `InboxSeverity`, `InboxAction`, `InboxItem`, `InboxView`).
 *     TypeScript types erase at runtime, so that file cannot carry the values
 *     and this one cannot carry the types; `viewer/test/attention-model.test.ts`
 *     reads that file's unions and holds the two identical, word for word and
 *     in the same order, so the pair can never drift;
 *   - the client surfaces that group, filter and count the inbox import the
 *     vocabulary as `@shared/attention-model.js` — the alias `vite.config.ts`
 *     and `client/tsconfig.json` already resolve to this directory.
 *
 * Dependency-free ESM (`.js` + JSDoc), the `situation-model.js` /
 * `ladder-model.js` precedent: the only import allowed is another `shared/`
 * module, so the node tests, the server and the browser all get THE SAME
 * objects rather than three equal copies that pass `deepEqual` today.
 *
 * ------------------------------------------------------------------
 * The two rules
 * ------------------------------------------------------------------
 *
 * **1. Identity is WHAT is asking, never WHEN it asked.** `inboxItemId` is
 * built from `kind`, `slug`, `phase`, `runId` and a per-kind `subject`, and
 * from nothing else — no timestamp, no attempt counter, no hash of the prose,
 * no array index. Two reasons, both measured:
 *
 *   - an ack is stored under this id in a file that outlives the process, so
 *     an id that moves silently un-acks the item and the operator is asked the
 *     same question again after a restart. The console's existing dedupe maps
 *     (`notifiedRun` / `notifiedPhase`, `server/service.ts`) are in-memory
 *     only and re-announce after a restart on purpose — an inbox may not,
 *     because an inbox accumulates;
 *   - an id that moves on every poll makes the ack useless entirely and grows
 *     a line per sweep. That is the shape of the failure the notification
 *     suite already pins ("that is how an inbox reaches 182 unread
 *     notifications"). `Approvals.request` mints its ids from `Date.now()`,
 *     which is exactly right for a card raised once and answered once, and
 *     exactly wrong here: the same wall, re-detected a minute later, would be
 *     a second id, a second ack and a second row.
 *
 * **2. Identity is injective.** Every component is escaped and the join has
 * fixed arity, so two genuinely different asks can never share an id — a
 * collision would let acknowledging one silence the other, which is worse than
 * a duplicate row. The only collapses are the deliberate ones documented on
 * `inboxItemId`: absent ≡ empty ≡ blank, and a non-positive phase ≡ no phase
 * (the ladder writes `phase: 0` on a run-level errand to mean exactly that).
 *
 * Two items that ARE the same ask must therefore collapse to one row by
 * construction: the builder raises one item per subject, and the id is what
 * makes that a property a test can check rather than a habit.
 */

/* ------------------------------------------------------------------ *
 * Kinds
 * ------------------------------------------------------------------ */

/**
 * @typedef {'errand'|'approval'|'gate'|'sign-in'|'mcp-auth'|'qa'|'lock'
 *   |'health'|'stall'|'ruling'} InboxKind
 */

/**
 * What kind of thing is asking. Frozen: it is a vocabulary, and the order is
 * the client contract's own union order — which `sortInbox` then reuses as its
 * third tie-break, so the list has a total order that does not depend on the
 * order the server happened to gather its facts in.
 *
 * `stall` and `ruling` are DECLARED HERE AND PRODUCED BY NOBODY YET: Phase 5
 * fills them (see the stall vocabulary at the foot of this file, and
 * `Approvals`' `remember: 'plan'|'global'` for a ruling — a decision that
 * should outlive the card that asked for it). They are in the list from the
 * first day so that the wire type, the labels, the filter chips and the ack
 * file never need a migration when the producer lands.
 *
 * @type {readonly InboxKind[]}
 */
export const INBOX_KINDS = Object.freeze(
  /** @type {const} */ ([
    /** The ladder is spent and left ONE ask: what is needed, how to give it, what was tried. */
    'errand',
    /** A permission card: a session is parked dead until someone answers it. */
    'approval',
    /** A manual gate on a phase the board would otherwise call ready. */
    'gate',
    /** The machine login or a console account is signed out; nothing runs under it. */
    'sign-in',
    /** An MCP server this work names is signed out or failing, and only a person can sign it in. */
    'mcp-auth',
    /** A QA verdict a person owes, or a QA failure recorded against a phase. */
    'qa',
    /** A phase lock nothing will release by itself — debris, or a claim in the way. */
    'lock',
    /** The console's own health: a broken watcher, a bad PATH, a degraded subsystem. */
    'health',
    /** Phase 5. Something nominally in flight that has not moved. */
    'stall',
    /** Phase 5. A decision worth remembering — a rule, not an answer. */
    'ruling',
  ]),
);

/**
 * What a card, a chip and a filter call each kind — a short noun phrase, never
 * a sentence. `SITUATION_LABELS` precedent: the words live once so a filter
 * chip, a group heading and a push title cannot disagree.
 * @type {Readonly<Record<InboxKind, string>>}
 */
export const INBOX_KIND_LABELS = Object.freeze({
  errand: 'Errand',
  approval: 'Permission',
  gate: 'Gate',
  'sign-in': 'Sign-in',
  'mcp-auth': 'MCP sign-in',
  qa: 'QA',
  lock: 'Lock',
  health: 'Health',
  stall: 'Stall',
  ruling: 'Ruling',
});

/* ------------------------------------------------------------------ *
 * Severities
 * ------------------------------------------------------------------ */

/**
 * @typedef {'urgent'|'needs-you'|'fyi'} InboxSeverity
 */

/**
 * How loudly, WORST FIRST — the `UI_STATES` convention, so index is rank and
 * `sortInbox` needs no second table:
 *
 *   - `urgent`   — something is stopped dead and costing: a session parked on
 *                  a permission card, a sign-out that blocks every run;
 *   - `needs-you`— waiting on a person, but nothing is burning while it waits;
 *   - `fyi`      — worth knowing, worth nobody's interruption.
 *
 * @type {readonly InboxSeverity[]}
 */
export const INBOX_SEVERITIES = Object.freeze(/** @type {const} */ (['urgent', 'needs-you', 'fyi']));

/**
 * Which UI state paints each severity.
 *
 * The console has ONE status vocabulary (`shared/status-vocab.js`): eight
 * states, each with its own hue token, read by `StatusBadge` and `.state-<ui>`
 * and by nothing else. Severity is a new word family, so it maps into that
 * vocabulary here rather than growing a ninth colour — and `needs-you` maps to
 * the state of the same name, which is not a coincidence but the point.
 *
 * The values are plain strings and `status-vocab.js` is deliberately NOT
 * imported: this file has no imports at all, and `test/attention-model.test.ts`
 * holds every value to a real `UI_STATES` member instead.
 * @type {Readonly<Record<InboxSeverity, string>>}
 */
export const SEVERITY_UI = Object.freeze({
  urgent: 'failed',
  'needs-you': 'needs-you',
  fyi: 'queued',
});

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * The identifying half of an item — what `inboxItemId` reads, and all it reads.
 *
 * `subject` is the discriminator WITHIN a (kind, slug, phase, runId): the
 * approval id, the MCP server id, the account id, the health issue kind, the
 * situation key of an errand, the stall kind. It is not on the wire — the id
 * it produces is — because a client that could re-derive an id would be a
 * second implementation of this rule.
 *
 * @typedef {Object} InboxSubject
 * @property {string} kind
 * @property {string} [slug]
 * @property {number|string|null} [phase]
 * @property {string} [runId]
 * @property {string} [subject]
 */

/**
 * Percent-escape the two characters that could forge another tuple's id: the
 * separator itself, and the escape. Every other byte is left readable, because
 * the ack file is a thing an operator may have to read: `errand:my-plan:4::verify-red`
 * says what it is, where a sha would say nothing.
 * @param {unknown} value
 */
const escapePart = (value) => String(value).replace(/%/g, '%25').replace(/:/g, '%3A');

/**
 * A text component, normalised: absent, `null`, empty and blank all mean "this
 * item is not about one of those" and collapse to the same empty slot.
 * @param {unknown} value
 */
function textPart(value) {
  if (value == null) return '';
  const text = String(value).trim();
  return text ? escapePart(text) : '';
}

/**
 * The phase component.
 *
 * A non-positive, non-integer or absent phase all collapse to "no phase" — the
 * ladder writes `phase: 0` on a RUN-level errand (a wall with no phase to hang
 * it on) and the dashboard already reads `0` as "no phase" when it decides
 * whether to say "phase 4 needs you". If `0` and `undefined` minted different
 * ids, the same run-level errand would be two rows depending on which of the
 * two producers wrote it.
 * @param {unknown} phase
 */
function phasePart(phase) {
  const n = Number(phase);
  return Number.isInteger(n) && n > 0 ? String(n) : '';
}

/**
 * The stable dedupe identity of an item — the ack key, and the only thing that
 * makes "the same ask" a checkable claim.
 *
 * Stable across restarts, because every component is read from a persisted
 * record (a plan slug, a phase number, a run id, an approval id, a server id),
 * never from process memory or a clock. Injective over
 * `(kind, slug, phase, runId, subject)`: fixed arity, and `:`/`%` escaped in
 * every component, so `{slug: 'a:b'}` and `{slug: 'a', phase: …}` cannot land
 * on the same string. The deliberate collapses — and only these — are:
 * absent ≡ `null` ≡ `''` ≡ blank, and phase `0`/negative/non-integer ≡ no
 * phase.
 *
 * A missing `kind` mints `unknown` rather than throwing: an inbox that 500s
 * because one builder branch forgot a field is worse than an inbox with one
 * oddly-named row, and the row is visible where an exception is not.
 *
 * Mint, do not re-derive: a finished `InboxItem` carries no `subject`, so
 * calling this on one fetched from the wire will NOT reproduce its id. Read
 * `item.id`.
 *
 * @param {InboxSubject} item
 * @returns {string}
 */
export function inboxItemId(item) {
  return [
    textPart(item?.kind) || 'unknown',
    textPart(item?.slug),
    phasePart(item?.phase),
    textPart(item?.runId),
    textPart(item?.subject),
  ].join(':');
}

/* ------------------------------------------------------------------ *
 * Order
 * ------------------------------------------------------------------ */

/** Index is rank: worst severity first, unknown last. */
const SEVERITY_RANK = new Map(INBOX_SEVERITIES.map((severity, i) => [severity, i]));

/** Index is rank: the contract's own kind order, unknown last. */
const KIND_RANK = new Map(INBOX_KINDS.map((kind, i) => [kind, i]));

/**
 * A word a newer console wrote and this one does not know sorts LAST in its
 * column, never first. An unrecognised severity that sorted worst-first would
 * let a future release put an item at the top of every operator's screen by
 * accident; sorting it last is the same failure mode as a category that is off.
 * @param {Map<string, number>} ranks
 * @param {unknown} word
 */
function rankOf(ranks, word) {
  const rank = ranks.get(String(word ?? ''));
  return rank === undefined ? ranks.size : rank;
}

/**
 * When it started asking, in ms. An unparseable or missing `since` sorts LAST
 * within its severity rather than first: a malformed clock is not the oldest
 * thing in the list, and treating it as one would pin a broken row to the top
 * of the inbox forever.
 * @param {{ since?: string }} item
 */
function sinceMs(item) {
  const at = Date.parse(item?.since ?? '');
  return Number.isFinite(at) ? at : Infinity;
}

/**
 * @typedef {Object} InboxItemLike
 * @property {string} [id]
 * @property {string} [kind]
 * @property {string} [severity]
 * @property {string} [since]
 */

/**
 * Total, deterministic order: severity worst-first, then OLDEST FIRST within a
 * severity, then kind, then id.
 *
 * Oldest-first is the whole point of the second key — the ask that has been
 * waiting longest is the one most likely to have been scrolled past, and a
 * newest-first inbox buries exactly the item that needed the person most.
 *
 * The third and fourth keys are not decoration. `Array.prototype.sort` is
 * stable, so ties would otherwise keep the order the SERVER gathered its facts
 * in — which changes when a plan is added, a run finishes or a directory is
 * read in a different order — and the operator's list would reshuffle under
 * their cursor between two identical polls. Kind then id makes the order a
 * function of the items alone.
 *
 * Returns a NEW array: the caller's list may be a cached fact set, and an
 * in-place sort of one of those is a bug that only shows up on the second
 * request.
 *
 * @template {InboxItemLike} T
 * @param {readonly T[]} items
 * @returns {T[]}
 */
export function sortInbox(items) {
  return [...(items ?? [])].sort((a, b) => {
    const severity = rankOf(SEVERITY_RANK, a?.severity) - rankOf(SEVERITY_RANK, b?.severity);
    if (severity !== 0) return severity;

    // Comparison, not subtraction: two items with no usable clock are both
    // `Infinity`, and `Infinity - Infinity` is NaN — a NaN comparator makes
    // the whole sort implementation-defined.
    const at = sinceMs(a);
    const bt = sinceMs(b);
    if (at !== bt) return at < bt ? -1 : 1;

    const kind = rankOf(KIND_RANK, a?.kind) - rankOf(KIND_RANK, b?.kind);
    if (kind !== 0) return kind;

    const ai = String(a?.id ?? '');
    const bi = String(b?.id ?? '');
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ *
 * Stall — declared here, detected in Phase 5
 * ------------------------------------------------------------------ */

/**
 * @typedef {'session-silent'|'queued-behind-lock'|'park-overdue'|'plan-idle'
 *   |'verify-hanging'} StallKind
 */

/**
 * The five ways something can be nominally in flight and not moving.
 *
 * DECLARED, NOT DETECTED. Phase 5 writes the detector (it needs the run
 * records, the scheduler snapshot and the session registry, none of which
 * belong in a dependency-free module); this file is the words and the clocks,
 * for the same reason `sizing.env` is one file: a detector that fires at
 * twenty minutes while the card says "half an hour" is a bug report nobody can
 * reproduce.
 *
 * @type {readonly StallKind[]}
 */
export const STALL_KINDS = Object.freeze(
  /** @type {const} */ ([
    'session-silent',
    'queued-behind-lock',
    'park-overdue',
    'plan-idle',
    'verify-hanging',
  ]),
);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * What each stall IS, how long it has to be true before it is one, and how
 * loudly it asks.
 *
 * `afterMs` is a floor, not a promise: the detector may only ever be as
 * precise as the clock it reads (a stream's last byte, a lease, a park's
 * `parkedUntil`, a plan's last activity), and every one of those is a
 * timestamp on disk rather than a subscription.
 *
 * @type {Readonly<Record<StallKind, { label: string, blurb: string, afterMs: number, severity: InboxSeverity }>>}
 */
export const STALL_META = Object.freeze({
  'session-silent': Object.freeze({
    label: 'Session silent',
    blurb:
      'A run is in flight and its session has produced nothing for half an hour. It is still spending. Phase 5: exempt a phase whose record says it is inside a §Verification command — a build is silent and fine.',
    afterMs: 30 * MINUTE,
    severity: 'needs-you',
  }),
  'queued-behind-lock': Object.freeze({
    label: 'Queued behind a lock',
    blurb:
      "A lane has waited an hour on another owner's phase lock. Deliberately half of the runner's two-hour lock-wait cap: past the cap the wait becomes a halt with its own card, so this one has to arrive while it is still a queue.",
    afterMs: HOUR,
    severity: 'needs-you',
  }),
  'park-overdue': Object.freeze({
    label: 'Park overdue',
    blurb:
      'A phase parked on an external clock is ten minutes past the time it said it would come back, and nothing resumed it — the arming, not the waiting, is what failed.',
    afterMs: 10 * MINUTE,
    severity: 'needs-you',
  }),
  'plan-idle': Object.freeze({
    label: 'Plan idle',
    blurb:
      'A plan with ready phases that nothing has touched for a week. The same seven days `server/analysis/stats.ts` already filters its `stalled` list on — Phase 5 should read that computation rather than re-derive it, and if the two ever disagree, that one wins.',
    afterMs: 7 * DAY,
    severity: 'fyi',
  }),
  'verify-hanging': Object.freeze({
    label: 'Verification hanging',
    blurb:
      "A §Verification command still running after a quarter of an hour — the runtime half of lint F16, which warns at plan time about a check that waits on an external clock (`gh run watch`, a `--watch` flag, a long sleep). Runnable, unfinishable inside a session's turn.",
    afterMs: 15 * MINUTE,
    severity: 'needs-you',
  }),
});
