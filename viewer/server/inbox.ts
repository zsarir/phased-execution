/**
 * The unified inbox — the one list of everything that needs a person, decided
 * by a pure function from facts somebody else gathered.
 *
 * Before this file the console had eight separate answers to "is anything
 * waiting on me?": the dashboard's `demands()`, the push catalogue's
 * `needs-you` category, the ladder's errands, the approval cards, the accounts
 * page's signed-out banner, the MCP status chips, the per-plan health issues
 * and the lock table. Each was right about its own corner and none of them
 * could be counted, because nothing could say whether a halted-run card, the
 * errand under it and the push that announced it were three asks or one. A
 * badge cannot be built out of eight opinions, and an ask nobody can name is an
 * ask nobody can dismiss.
 *
 * So: one builder, one identity, one order.
 *
 * ------------------------------------------------------------------
 * Why this file is pure, and what that buys
 * ------------------------------------------------------------------
 *
 * `buildInbox(facts, now)` touches no filesystem, spawns no subprocess, reads
 * no clock of its own and imports no `Service`. Every fact it needs arrives in
 * the argument, already fetched. Three reasons, each a real cost avoided:
 *
 *   - **the engine may not be reached from here.** `gateStatus` and `qaMode`
 *     shell out to `scripts/phase-graph.sh`; layer 1 is authoritative and JS
 *     never recomputes it (CLAUDE.md). A builder that could reach the engine
 *     would put a `spawn` on the SSE path — one per gated phase, per poll;
 *   - **the whole inbox is testable with a hand-built object.** The pure/
 *     performer split is exactly `views/dashboard/now.tsx`: `demands()` decides
 *     WHICH remedies exist and why one is unavailable, `actions.tsx` performs
 *     them. That is what lets "a halted run offers Recover & continue and
 *     Dismiss, and Recover is flagged without --allow-run" be a fact a test
 *     asserts with no server, no fetch mock and no click;
 *   - **a snapshot stays a snapshot.** `lockPresence` arrives as a resolved map
 *     rather than a callback for the same reason `SchedulerDeps.locks` is
 *     synchronous: an answer that could change between two questions inside one
 *     build produces a list that contradicts itself.
 *
 * The acks half below is the one thing here that does touch disk, and it is
 * kept in this file rather than in `store.ts` because an acknowledgement is
 * meaningless without the identity that keys it.
 *
 * ------------------------------------------------------------------
 * The four rules this file is built around
 * ------------------------------------------------------------------
 *
 * **1. Identity comes from `shared/attention-model.js` and is never
 * re-derived.** `inboxItemId` and `sortInbox` are imported by identity, not
 * copied. An id minted a second way is an ack key that drifts, and a drifting
 * ack key asks the operator the same question again after a restart — the
 * failure the shared module's header sets out at length.
 *
 * **2. An ack older than the item's own `since` is not an ack.** The thing came
 * back. A wall that was signed in and fell over again, a QA row that went
 * pending → fail, a lock released and retaken: all of them keep their id (they
 * are the same ask, about the same thing) and move their clock, and the clock
 * is what says "this is new". Where a fact carries no stable start clock at all
 * (an account is signed out; a server needs auth; neither records WHEN) the
 * item's `since` is empty and the ack stands — un-acking those is `pruneAcks`'
 * job, called by the route with the ids the build produced, so an item that
 * goes away and comes back loses its ack by having been absent.
 *
 * **3. A capability flag never hides an item — it only disables the action, and
 * names the flag.** A console started without `--allow-run` still has to be
 * told its run is parked on a permission card; hiding the card because the
 * button would not work is the dead end these cards were built to end. So the
 * item is always raised, and `InboxAction.flag` is set on the actions that
 * cannot be taken. See `gatedBy` for the one place that decision lives.
 *
 * **4. Every `href` is built by a `shared/routes.js` helper or by `routeFor`,
 * never by concatenation.** `#/plan/<slug>/autopilot` was written by hand at
 * two call sites, the tab is registered as `run`, and an unknown tab is not an
 * error the router reports — it falls back silently. Every approval
 * notification for the life of that feature opened the wrong tab with nothing
 * saying so. `test/route-contract.test.ts` holds the server to the client's own
 * route table; `test/inbox.test.ts` holds this builder to the same assertion.
 *
 * ------------------------------------------------------------------
 * What is NOT here
 * ------------------------------------------------------------------
 *
 * `stall` and `ruling` are declared in the shared vocabulary and PRODUCED BY
 * NOBODY in Phase 4. A stall needs the run records' own clocks, the scheduler
 * snapshot and the session registry read together against `STALL_META`'s five
 * thresholds; a ruling needs the approvals' `remember: 'plan'|'global'` and the
 * policy-strike path. Both are Phase 5. They are in the kind list, the labels
 * and the ack file's key space from the first day precisely so that landing
 * their detector changes no type, no route and no stored ack.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RULING_KIND_LABELS, STALL_META, inboxItemId, sortInbox } from '../shared/attention-model.js';
import { phaseHref, planHref, toHash } from '../shared/routes.js';
import { parseSituationKey, situationLabel } from '../shared/situation-model.js';
import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';
import { routeFor } from './push/catalogue.ts';

/* ------------------------------------------------------------------ *
 * The wire shapes
 *
 * These mirror `client/src/lib/api/inbox.ts` field for field — that file was
 * agreed in Phase 3 and is already exported from the client's api barrel, so
 * it is the frozen contract and this is the implementation of it. TypeScript
 * types erase at runtime and cannot be imported across the client/server
 * boundary here, so the pair is held together by `test/inbox.test.ts` (every
 * kind and severity this file emits must be a member of the shared vocabulary,
 * which `test/attention-model.test.ts` in turn holds equal to the client's
 * unions, word for word and in order).
 * ------------------------------------------------------------------ */

export type InboxKind =
  | 'errand' | 'approval' | 'gate' | 'sign-in' | 'mcp-auth' | 'qa' | 'lock' | 'health'
  | 'stall' | 'ruling';

export type InboxSeverity = 'urgent' | 'needs-you' | 'fyi';

/** One thing a person can do about an item, as the server spells it. */
export type InboxAction = {
  verb: string;
  label: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /**
   * Set when — and only when — the capability that gates this action is OFF on
   * this console, so `flag` reads as "this cannot be pressed; restart with
   * `--allow-<flag>`". `InboxAction` has no `disabled` field, so this is the
   * only channel the reason has; making it present-only-when-off means a
   * client renders the disabled state from one fact rather than joining two,
   * which is where a second implementation of the rule would start.
   */
  flag?: string;
};

export type InboxAck = { at: string; by?: string };

export type InboxItem = {
  id: string;
  kind: InboxKind;
  severity: InboxSeverity;
  slug?: string;
  phase?: number;
  runId?: string;
  title: string;
  /** What is needed. */
  need: string;
  /** How to give it. */
  how: string;
  /** What was already tried, so nobody tries it again by hand. */
  tried?: string[];
  /**
   * ISO 8601 — since when it has been waiting. EMPTY when the fact carries no
   * stable start clock (see rule 2 in the header): an empty `since` sorts last
   * within its severity rather than first, and an ack on it never goes stale.
   * It is deliberately not "now" — a `since` that moved every poll would make
   * every ack stale on the next request, which is the same as having no acks.
   */
  since: string;
  actions: InboxAction[];
  /** Where in the console it lives. */
  href: string;
  /** Acknowledged — seen, not cleared. Absent when it is not. */
  ack?: InboxAck | null;
};

export type InboxView = {
  items: InboxItem[];
  generatedAt: string;
};

/* ------------------------------------------------------------------ *
 * The facts
 * ------------------------------------------------------------------ */

/** The ladder's one ask, as `runner/state.ts` writes it. */
export type InboxErrand = {
  /** `0` means "no phase" — a run-level wall with nothing to hang it on. */
  phase: number;
  situation: string;
  tried: readonly string[];
  need: string;
  how: string;
  at: string;
};

/**
 * A run, narrowed to what the inbox reads.
 *
 * Structural rather than an `import type { RunState }`: a real `RunState` is
 * assignable to this (every field here is a widening of the real one), and
 * declaring it locally means a test can hand-build one in six lines instead of
 * forty, which is the whole point of the pure/performer split.
 */
/**
 * One phase's run record, narrowed to what a stall row is decided from.
 *
 * Every clock here is a timestamp the runner already writes for its own
 * reasons — `liveness.lastOutputAt` from the stream, `lockWaitSince` from
 * admission, `parkedUntil` from the outcome protocol, `verifyingSince` from
 * the confirm pass. A stall is not a new fact; it is the observation that one
 * of those has stopped moving.
 */
export type InboxRunPhase = {
  phase: number;
  /** `PhaseStatus`. */
  status?: string;
  /** `runner/liveness.ts` `LaneLiveness`, narrowed. */
  liveness?: {
    lastOutputAt?: string;
    turnsSinceLastTool?: number;
    openTool?: { name?: string; since?: string };
  };
  /** The live signal, when the runner has one. */
  stall?: { signal?: string; since?: string; detail?: string };
  lockWaitSince?: string;
  parkedUntil?: string;
  parkReason?: string;
  verifyingSince?: string;
};

export type InboxRun = {
  id: string;
  slug: string;
  /** `RunStatus`. */
  status: string;
  updatedAt?: string;
  /** Keyed by phase number as a string, as `RunState.phases` is. */
  phases?: Readonly<Record<string, InboxRunPhase | undefined>>;
  activePhase?: number | null;
  /** `RunResolution | null` — truthy means someone (or the board) closed it. */
  resolved?: unknown;
  stoppedBy?: 'operator' | 'system';
  /** `{ attempts }` on a real record — read for truthiness only, never shape. */
  autoRecover?: unknown;
  halt?: { at?: string; reason?: string; phase?: number; kind?: string } | null;
  /** The run-level errand — a wall with no phase to hang it on. */
  errand?: InboxErrand | null;
  /** Keyed by phase number as a string; `plan` is a plan-wide repair slot. */
  recoveries?: Readonly<Record<string, { errand?: InboxErrand } | undefined>>;
};

/** A pending permission card, narrowed. `runner/approvals.ts` `Approval`. */
export type InboxApproval = {
  id: string;
  runId?: string;
  slug?: string;
  phase?: number | null;
  kind?: string;
  title?: string;
  detail?: string;
  createdAt?: string;
  status?: string;
};

/** One phase of a plan, as `Service.detail()` already projects it. */
export type InboxPhase = {
  phase: number;
  title?: string;
  /** The board word from the engine — `ctx.board.states[phase]`. */
  state?: string;
  gated?: boolean;
  gateCheck?: string;
  gateKind?: string;
  /**
   * `Service.gateStatus(slug, phase)`. Engine-authoritative and a subprocess
   * per call, so the caller fetches it ONLY for `gated && state !== 'done'`
   * phases and passes it in. Absent means "not asked", which raises nothing.
   */
  gate?: { clear: boolean; kind?: string; detail?: string } | null;
  /**
   * Declared and NOT read in Phase 4 — `locks` below is the lock source (it
   * spans plans and carries the lease), and the handoff is what the Phase 5
   * stall detector will want. Gather them if `detail()` already handed them to
   * you; omit them if not.
   */
  lock?: { owner: string; expired: boolean; leaseUntil?: number } | null;
  handoff?: { status?: string; outstanding?: string[] } | null;
};

export type InboxPlan = {
  slug: string;
  title?: string;
  /**
   * `PlanRecord.plan.closed`. A closed plan reports no PROGRESS but a live
   * process keeps its voice — exactly the split `push/catalogue.ts` already
   * draws with `PLAN_PROGRESS_CATEGORIES`, copied rather than reinvented: gate
   * and qa items are silenced on a closed plan, errands, approvals, locks and
   * health are not, because those are claims about a process, not a pulse.
   */
  closed?: boolean;
  /**
   * When the plan was last written. The `since` of a gate, a QA row or a plan
   * health issue, none of which carry a clock of their own: it is stable
   * between polls and it moves exactly when the plan does, which is the only
   * moment "this ask is new again" could be true.
   */
  updatedAt?: string;
  /** `Service.qaMode(slug)` — engine `--qa-mode`. */
  qaMode?: { mode: string; reason?: string };
  /** `PlanRecord.qa` — the rows of `## QA status` in `test-status.md`. */
  qa?: readonly { phase: number; result: string; report?: string }[];
  /** `healthIssues(ctx)` — already closure-filtered by the caller. */
  issues?: readonly { slug: string; severity: string; kind: string; message: string; phase?: number }[];
  phases?: readonly InboxPhase[];
};

/** `runner/scheduler.ts` `LockView`, narrowed. */
export type InboxLock = {
  slug: string;
  phase: number;
  owner: string;
  expired: boolean;
  /** `lease_until` as ms epoch — for an expired lock this is when it lapsed. */
  leaseUntil?: number;
  session?: string;
};

/** `Service.queueSnapshot()`, narrowed to what tells an item it is in the way. */
export type InboxQueue = {
  live?: number;
  queued?: number;
  entries?: readonly {
    slug?: string;
    phase?: number | null;
    since?: number;
    waitingOn?: readonly { kind?: string; slug?: string; phase?: number | null; owner?: string }[];
  }[];
};

/** `accounts/index.ts` `AccountView`, narrowed. */
export type InboxAccount = {
  id: string;
  name?: string;
  email?: string;
  kind?: string;
  /** True for the synthesized machine login — `auth` below is its real source. */
  builtIn?: boolean;
  signedIn?: boolean;
  /** `ok | expiring | expired | signed-out | unknown`. */
  authState?: string;
};

/** `mcp/index.ts` `McpServerView`, narrowed. */
export type InboxMcpServer = {
  id: string;
  label?: string;
  enabled?: boolean;
  /** `connected | needs-auth | pending | failed | unknown`. */
  status?: string;
  issue?: string;
  toolsChanged?: { added?: string[]; removed?: string[]; seenAt?: string };
  /** `${VAR}`s its own command still names and nothing supplies. */
  needsConfig?: string[];
};

/**
 * Everything "something needs a person" can be decided from.
 *
 * Every field is optional and every absent field means "nothing to say" — NOT
 * "unknown". That is deliberate: an inbox that throws because one gatherer
 * failed is strictly worse than an inbox missing one row, and the whole surface
 * is a diagnostic. Pass everything you have; the empty object is a legal call
 * and returns an empty view.
 */
export type InboxFacts = {
  /**
   * Every run across every plan. `Service.allRuns()` — async, and it resolves
   * records against the board (it can close one the board has overtaken), so
   * it is NOT `runStates()`. Carries `errand`, `recoveries[phase].errand`,
   * `resolved`, `stoppedBy`, `autoRecover`, `halt` and `status`.
   */
  runs?: readonly InboxRun[];
  /** `service.approvals.all()`; only `status === 'pending'` raises anything. */
  approvals?: readonly InboxApproval[];
  /** One entry per plan the store holds, assembled from `Service.detail()`. */
  plans?: readonly InboxPlan[];
  /** `Service.allLocks()` — private today; closed plans already excluded. */
  locks?: readonly InboxLock[];
  /**
   * `SessionRegistry.presenceOfLock`, resolved to a map keyed `${slug}:${phase}`
   * so the build stays synchronous and snapshot-consistent. Only `ended` makes
   * an UNEXPIRED lock debris; an owner/time match is display and releases
   * nothing.
   */
  lockPresence?: Readonly<Record<string, 'live' | 'ended' | 'unknown'>>;
  /** `Service.queueSnapshot()`. */
  queue?: InboxQueue;
  /** `Service.listAccounts()` — already redacted. */
  accounts?: readonly InboxAccount[];
  /**
   * `Service.authStatus()` — the MACHINE login, which no `AccountView` covers
   * and which every default-account run spends.
   */
  auth?: { loggedIn?: boolean; email?: string; checkedAt?: string; detail?: string };
  /** `Service.listMcp()`. */
  mcp?: readonly InboxMcpServer[];
  /** `state().environment.issues` — each carries its own `fix` sentence. */
  environment?: readonly { kind: string; detail: string; fix: string }[];
  /** `this.watcher.status()`. A deaf watcher looks fine from everywhere else. */
  watcher?: { healthy?: boolean; watching?: number; expected?: number; failures?: number };
  /** `degradedState()`. */
  degraded?: { healthy?: boolean; recent?: readonly { kind: string; message: string; at?: string }[] };
  /**
   * What a remedy costs. Absent means every capability is off, which is the
   * safe direction: an action is reported as flagged rather than pressable.
   */
  flags?: {
    allowWrites?: boolean;
    allowRun?: boolean;
    allowTerminal?: boolean;
    allowAgent?: boolean;
    allowAccounts?: boolean;
    allowMcp?: boolean;
  };
  /**
   * The plans `server/analysis/stats.ts` already calls stalled: open, with
   * ready phases, untouched for a week.
   *
   * Read rather than re-derived, deliberately. Two computations of "idle for
   * seven days" would disagree the first time one of them learned about a new
   * kind of activity, and the Insights page's list is the one an operator has
   * already seen.
   */
  stalledPlans?: readonly { slug: string; days: number; ready: readonly number[] }[];
  /**
   * The plans' ruling ledgers (`runner/rulings.ts`), any order. Only the
   * recent ones raise a row — see `rulingDrafts`.
   */
  rulings?: readonly {
    id: string; slug: string; phase: number; kind: string; what: string;
    why?: string; costIfWrong?: string; at: string;
  }[];
  /** The acks file, keyed by `InboxItem.id`. `readAcks()` below reads it. */
  acks?: Readonly<Record<string, InboxAck>>;
  /**
   * Live sessions, so a later phase can link an item to the recovery already
   * working on it instead of offering a second one. Declared, unread in Phase 4.
   */
  sessions?: readonly { id: string; kind?: string; exited?: unknown }[];
};

/** Request-shaped knobs, which are not facts about the world. */
export type InboxOptions = {
  /** Include acknowledged items. `GET /api/inbox?all=1`. */
  all?: boolean;
};

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

/**
 * Run statuses that mean "still going", copied from the client's `isLive`
 * (`views/run/defaults.ts`) rather than the runner's `IN_FLIGHT`, which omits
 * `queued`. The question here is "is this run stopped and waiting on a person",
 * and a queued lane is waiting on a lock, not on anybody.
 */
const LIVE_RUN_STATUSES = new Set(['running', 'waiting', 'pausing', 'stopping', 'frozen', 'queued', 'halting']);

const isLiveStatus = (status: string | undefined): boolean => LIVE_RUN_STATUSES.has(status ?? '');

/** A phase number that is really a phase. `0` is the ladder's "no phase". */
function positivePhase(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The first candidate that parses as a date, else `''`.
 *
 * Never falls back to "now": see the note on `InboxItem.since`. A `since` that
 * moved with the clock would make every acknowledgement stale on the next
 * request, and an inbox whose acks never hold is an inbox nobody acknowledges.
 */
function stableSince(...candidates: (string | number | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const at = typeof candidate === 'number' ? candidate : Date.parse(String(candidate));
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return '';
}

/**
 * The one place a capability decision is made.
 *
 * Returns `{ flag }` when the capability is OFF and `{}` when it is on, so an
 * action is spread with `...gatedBy('run', flags.allowRun)` and never carries
 * `flag: undefined`. Flipping the contract to "always name the gate" is a
 * one-line change here rather than eleven call sites.
 */
function gatedBy(flag: string, allowed: boolean | undefined): { flag?: string } {
  return allowed ? {} : { flag };
}

const runVerb = (slug: string, verb: string): string => `/api/run/${encodeURIComponent(slug)}/${verb}`;
const planVerb = (slug: string, ...rest: (string | number)[]): string =>
  [`/api/plans/${encodeURIComponent(slug)}`, ...rest.map((part) => encodeURIComponent(String(part)))].join('/');

/**
 * The draft an item is before it has an id: everything on the wire, plus the
 * `subject` that discriminates it within its (kind, slug, phase, runId) and
 * which deliberately never leaves the server.
 */
type Draft = Omit<InboxItem, 'id' | 'ack'> & { subject?: string };

function mint(draft: Draft): InboxItem {
  const { subject, ...wire } = draft;
  return {
    id: inboxItemId({
      kind: draft.kind,
      ...(draft.slug ? { slug: draft.slug } : {}),
      ...(draft.phase != null ? { phase: draft.phase } : {}),
      ...(draft.runId ? { runId: draft.runId } : {}),
      ...(subject ? { subject } : {}),
    }),
    ...wire,
  };
}

/**
 * The ack, if it is still one.
 *
 * An ack stamped BEFORE the item's own `since` is not an ack: the ask came
 * back. A QA row that went pending → fail keeps its slug and phase but changes
 * its clock; a lock released and retaken does the same. Where either clock is
 * unparseable the ack stands — "I could not compare" and "it is stale" are
 * different facts, and treating the first as the second would silently re-ask
 * every clockless item on every poll.
 */
function ackFor(
  acks: Readonly<Record<string, InboxAck>> | undefined,
  id: string,
  since: string,
): InboxAck | undefined {
  const ack = acks?.[id];
  if (!ack || typeof ack.at !== 'string') return undefined;
  const ackAt = Date.parse(ack.at);
  const sinceAt = Date.parse(since);
  if (Number.isFinite(ackAt) && Number.isFinite(sinceAt) && ackAt < sinceAt) return undefined;
  return ack.by ? { at: ack.at, by: ack.by } : { at: ack.at };
}

/* ------------------------------------------------------------------ *
 * errand
 * ------------------------------------------------------------------ */

/**
 * Every open errand of a run: the phase ones in phase order, then the run-level
 * one. This is `client/src/lib/ladder.ts` `errandsOf` reproduced server-side —
 * including the `/^\d+$/` key filter, without which the `plan` slot (a
 * plan-wide repair, not a phase) leaks in as `phase: NaN`.
 */
function errandsOf(run: InboxRun): InboxErrand[] {
  const phased = Object.entries(run.recoveries ?? {})
    .filter(([key, slot]) => slot?.errand && /^\d+$/.test(key))
    .map(([, slot]) => slot!.errand!)
    .sort((a, b) => a.phase - b.phase);
  return [...phased, ...(run.errand ? [run.errand] : [])];
}

/**
 * Runs that are stopped and not already dealt with.
 *
 * `resolved` is annotation, never deletion: the run keeps its record and its
 * place on the Runs page and simply stops being asked about here.
 */
function stoppedRuns(runs: readonly InboxRun[]): InboxRun[] {
  return runs.filter((run) => !run.resolved && !isLiveStatus(run.status) && run.status !== 'finished');
}

/** Dismiss — never flagged. A console that cannot even put a card down is the dead end. */
function dismissAction(run: InboxRun): InboxAction {
  return {
    verb: 'dismiss',
    label: 'Dismiss',
    endpoint: runVerb(run.slug, 'resolve'),
    method: 'POST',
    body: { runId: run.id },
  };
}

function errandDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};

  for (const run of stoppedRuns(facts.runs ?? [])) {
    const errands = errandsOf(run);
    const mcpParked = run.halt?.kind === 'mcp-preflight';

    for (const errand of errands) {
      const { id, sub } = parseSituationKey(errand.situation);
      const auth = id === 'resource-wall' && sub === 'auth';
      const mcp = id === 'mcp-unavailable' || mcpParked;
      const phase = positivePhase(errand.phase);

      out.push({
        kind: 'errand',
        severity: 'needs-you',
        subject: errand.situation,
        slug: run.slug,
        ...(phase != null ? { phase } : {}),
        runId: run.id,
        title: `${run.slug} — ${phase != null ? `phase ${phase} needs you` : 'needs you'}`,
        need: errand.need,
        how: errand.how,
        ...(errand.tried?.length ? { tried: [...errand.tried] } : {}),
        since: stableSince(errand.at, run.halt?.at, run.updatedAt),
        href: planHref(run.slug, 'run'),
        actions: [
          // Signing in first, because continuing before it is a session that
          // reports success, spends a turn and changes nothing.
          ...(auth
            ? [
                {
                  verb: 'login',
                  label: 'Open a sign-in terminal',
                  endpoint: '/api/auth/login',
                  method: 'POST' as const,
                  ...gatedBy('run', flags.allowRun),
                },
                {
                  verb: 'recheck',
                  label: 'Check again',
                  endpoint: '/api/accounts/refresh',
                  method: 'POST' as const,
                },
              ]
            : mcp
              ? [
                  {
                    verb: 'mcp-continue',
                    label: 'Continue without these servers',
                    endpoint: runVerb(run.slug, 'mcp-continue'),
                    method: 'POST' as const,
                    ...gatedBy('run', flags.allowRun),
                  },
                ]
              : [
                  // "I did what it asked — look again": it re-reads the board,
                  // stands down what the errand settled, and continues or
                  // climbs whatever is left.
                  {
                    verb: 'recover',
                    label: 'Recover & continue',
                    endpoint: runVerb(run.slug, 'recover'),
                    method: 'POST' as const,
                    ...gatedBy('run', flags.allowRun),
                  },
                ]),
          dismissAction(run),
        ],
      });
    }

    if (errands.length) continue;

    // The stop nothing automatic will touch. The ladder climbs only runs that
    // opted into auto-recovery, and only from a console that may run — a stop
    // outside that pair is waiting on a person with no errand to say so, and
    // this is the read-only-console case the dashboard has raised since 2.3.0.
    // `subject: 'unattended-stop'` is a word no situation key can be, so it can
    // never collide with a real errand's id.
    if (!(run.status === 'halted' || run.status === 'interrupted' || run.status === 'parked')) continue;
    if (run.stoppedBy === 'operator') continue;
    // Armed auto-recovery normally DOES own the stop, and saying so here too
    // would be asking twice — that is what this guard is for, and it stays.
    //
    // But it was a promise the ladder cannot always keep. `classifyOpenPhases`
    // skips every record the board reads `done`, so a run whose records ALL read
    // done has no candidate, climbs nothing, and writes no errand — while this
    // row, the one thing that would have told a person their run was waiting on
    // them, stayed suppressed against an errand that could not come. Measured on
    // a real run that sat parked for a day with six phases held behind a QA
    // verdict nobody was asked for.
    //
    // Narrow on purpose: only the shape the ladder provably cannot reach. A run
    // with no records yet, or with one still open, is still the ladder's.
    const records = Object.values(run.phases ?? {});
    const allSettled = records.length > 0
      && records.every((record) => record.status === 'done' || record.status === 'skipped');
    const engaged = Object.values(run.recoveries ?? {})
      .some((slot) => slot.rungs?.length || slot.errand || (slot.attempts ?? 0) > 0);
    if (flags.allowRun && run.autoRecover && !(allSettled && !engaged)) continue;

    const phase = positivePhase(run.halt?.phase ?? run.activePhase);
    out.push({
      kind: 'errand',
      severity: 'needs-you',
      subject: 'unattended-stop',
      slug: run.slug,
      ...(phase != null ? { phase } : {}),
      runId: run.id,
      title: `${run.slug} ${run.status}`,
      need: flags.allowRun
        ? 'Your decision — auto-recovery is off for this run, so nothing climbs this stop by itself.'
        : 'A console that may run — this one is read-only for runs, so nothing climbs this stop by itself.',
      how: flags.allowRun
        ? 'Press Recover & continue to let the ladder climb once, or Dismiss.'
        : 'Restart the console with --allow-run, then press Recover & continue.',
      since: stableSince(run.halt?.at, run.updatedAt),
      href: planHref(run.slug, 'run'),
      actions: [
        {
          verb: 'recover',
          label: 'Recover & continue',
          endpoint: runVerb(run.slug, 'recover'),
          method: 'POST',
          ...gatedBy('run', flags.allowRun),
        },
        dismissAction(run),
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * approval
 * ------------------------------------------------------------------ */

/**
 * `urgent`, always: a permission card is a session parked dead with a hook
 * open on the far end. It is the one kind where waiting costs money.
 */
function approvalDrafts(facts: InboxFacts): Draft[] {
  const flags = facts.flags ?? {};
  return (facts.approvals ?? [])
    .filter((approval) => approval.status === 'pending')
    .map((approval) => {
      const phase = positivePhase(approval.phase);
      const decide = (decision: 'allow' | 'deny', label: string): InboxAction => ({
        verb: decision,
        label,
        endpoint: `/api/approvals/${encodeURIComponent(approval.id)}`,
        method: 'POST',
        // `by` is deliberately absent: who pressed it is the browser's fact,
        // not the server's, and the route already defaults it to `console`.
        body: { decision },
        ...gatedBy('run', flags.allowRun),
      });
      return {
        kind: 'approval' as const,
        severity: 'urgent' as const,
        subject: approval.id,
        ...(approval.slug ? { slug: approval.slug } : {}),
        ...(phase != null ? { phase } : {}),
        ...(approval.runId ? { runId: approval.runId } : {}),
        title: approval.title || 'A session is waiting on a decision',
        need: approval.detail || 'A session is parked until you answer.',
        how: 'Allow it or deny it — the session is holding a hook open until you do.',
        since: stableSince(approval.createdAt),
        href: approval.slug ? planHref(approval.slug, 'run') : toHash(routeFor('approval')),
        actions: [decide('allow', 'Allow'), decide('deny', 'Deny')],
      };
    });
}

/* ------------------------------------------------------------------ *
 * gate · qa · plan health
 * ------------------------------------------------------------------ */

/**
 * Health issue kinds a DEDICATED inbox kind already owns.
 *
 * `analysis/stats.ts` turns a failing QA row into `HealthIssue{kind:'qa-fail'}`
 * and an expired lock into `HealthIssue{kind:'stale-lock'}` — the same two
 * facts the `qa` and `lock` kinds raise from their own sources. Without this
 * list one failing QA row is two rows in the inbox, with two ids and two acks,
 * and acknowledging either leaves the other. Dedupe by construction beats
 * dedupe by id, because the ids genuinely differ.
 */
const ISSUE_KINDS_OWNED_ELSEWHERE = new Set(['qa-fail', 'stale-lock']);

function planDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};

  for (const plan of facts.plans ?? []) {
    const phases = plan.phases ?? [];
    const planSince = stableSince(plan.updatedAt);
    const stateOf = new Map(phases.map((phase) => [phase.phase, phase.state ?? '']));

    /* ---- gate ---- */
    if (!plan.closed) {
      for (const phase of phases) {
        if (!phase.gated || phase.state === 'done') continue;
        if (!phase.gate || phase.gate.clear !== false) continue;
        out.push({
          kind: 'gate',
          severity: 'needs-you',
          // One gate per phase: the phase IS the subject, so there is nothing
          // left to discriminate on.
          slug: plan.slug,
          phase: phase.phase,
          title: `${plan.slug} phase ${phase.phase} — gate needs a person`,
          need: phase.gate.detail || `The gate on phase ${phase.phase} is not clear (${phase.gate.kind ?? 'none'}).`,
          how: phase.gateCheck
            ? `Do what the gate asks — \`${phase.gateCheck}\` — then approve it on the phase page.`
            : 'Do what the gate asks, then approve it on the phase page under Gate.',
          since: planSince,
          href: phaseHref(plan.slug, phase.phase),
          actions: [
            {
              verb: 'approve',
              label: 'Approve the gate',
              endpoint: planVerb(plan.slug, 'gate', phase.phase),
              method: 'POST',
              body: { approve: true, continueRun: true },
              ...gatedBy('writes', flags.allowWrites),
            },
          ],
        });
      }
    }

    /* ---- qa ---- */
    if (!plan.closed) {
      const mode = plan.qaMode?.mode ?? 'off';
      for (const row of plan.qa ?? []) {
        const failed = row.result === 'fail';
        // A pending verdict only asks anything when the plan says QA is
        // required AND the work it covers is finished — a pending row on a
        // phase nobody has started is the table's resting state, not an ask.
        const pending = row.result === 'pending' && mode === 'on' && stateOf.get(row.phase) === 'done';
        if (!failed && !pending) continue;
        out.push({
          kind: 'qa',
          // `subject` is the RESULT, so pending → fail re-raises with a new id:
          // the ask genuinely changed, from "give a verdict" to "a verdict was
          // given and it was red", and an ack on the first must not silence the
          // second.
          subject: row.result,
          // A recorded failure is a defect against work believed done; an owed
          // verdict is a chore the operator scheduled by turning QA on. Same
          // vocabulary, different loudness.
          severity: failed ? 'needs-you' : 'fyi',
          slug: plan.slug,
          phase: row.phase,
          title: failed
            ? `${plan.slug} phase ${row.phase} — QA failed`
            : `${plan.slug} phase ${row.phase} — QA verdict owed`,
          need: failed
            ? row.report || 'QA recorded a failure against this phase.'
            : 'A QA verdict — the phase is done and this plan runs QA on.',
          how: failed
            ? 'Read the report, fix what it found, then record the new verdict from the phase '
              + 'page (Record QA) — or turn the gate off for this plan with "**QA gate:** off" '
              + 'in its §Session budget if it should not gate on QA at all.'
            : 'Start a QA session for the phase, then record pass or waived from the phase page '
              + '(Record QA). Until a verdict exists, this phase holds every phase that depends on it.',
          since: planSince,
          href: phaseHref(plan.slug, row.phase),
          actions: [
            {
              verb: 'qa-session',
              label: 'Start a QA session',
              endpoint: '/api/terminal',
              method: 'POST',
              body: { intent: 'qa', slug: plan.slug, phase: row.phase },
              ...gatedBy('agent', flags.allowAgent),
            },
            // There is deliberately no one-press "Record a verdict" here. There
            // was, and it could not work: the body carried neither `result` nor
            // `report`, both of which `writes.ts` requires, so every press
            // answered with a WriteError — on the one row an operator reaches
            // for when a QA verdict has wedged their plan. It cannot be fixed by
            // filling the fields in either: pass, fail and waived are a
            // judgement, and a button that picks one for you is worse than no
            // button. The verdict form lives on the phase page, which is where
            // `href` points and what `how` now names.
            ...(mode === 'on'
              ? []
              : [
                  {
                    verb: 'qa-mode',
                    label: 'Turn QA on for this plan',
                    endpoint: planVerb(plan.slug, 'qa-mode'),
                    method: 'POST' as const,
                    body: { phase: row.phase },
                    ...gatedBy('writes', flags.allowWrites),
                  },
                ]),
          ],
        });
      }
    }

    /* ---- per-plan health ---- */
    for (const issue of plan.issues ?? []) {
      if (issue.severity !== 'error') continue;
      if (ISSUE_KINDS_OWNED_ELSEWHERE.has(issue.kind)) continue;
      const phase = positivePhase(issue.phase);
      out.push({
        kind: 'health',
        severity: 'needs-you',
        subject: issue.kind,
        slug: plan.slug,
        ...(phase != null ? { phase } : {}),
        title: `${plan.slug} — ${issue.kind}`,
        need: issue.message,
        how: 'Fix it in the plan or the handoff, then the board re-reads it on the next change.',
        since: planSince,
        href: phase != null ? phaseHref(plan.slug, phase) : planHref(plan.slug, 'route'),
        actions: [],
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * sign-in
 * ------------------------------------------------------------------ */

/**
 * The machine login, then each console account that is signed out.
 *
 * Never on `authState: 'unknown'` — that is the permanent and CORRECT state of
 * a setup-token account, which exposes no expiry and no refresh. Raising on it
 * would put a row in the inbox that nothing can ever clear.
 *
 * `builtIn` accounts are skipped: the built-in is the synthesized machine
 * login, which `auth` above already speaks for. Raising both is one fact with
 * two ids and two acks.
 */
function signInDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};
  const queue = facts.queue ?? {};
  const busy =
    (facts.runs ?? []).some((run) => isLiveStatus(run.status)) || (queue.live ?? 0) > 0 || (queue.queued ?? 0) > 0;

  if (facts.auth && facts.auth.loggedIn === false) {
    out.push({
      kind: 'sign-in',
      // Urgent only while something is actually trying to move: a signed-out
      // machine on an idle console is a chore, and the same wall with four
      // lanes queued behind it is a stoppage.
      severity: busy ? 'urgent' : 'needs-you',
      subject: 'machine',
      title: 'Claude is signed out on this machine',
      need: 'A signed-in machine login — nothing starts or resumes under the default account until there is one.',
      how: 'Open a sign-in terminal and run `claude auth login`, or sign a console profile in under Settings ▸ Accounts.',
      // `auth.checkedAt` is when the PROBE ran, not when the sign-out began; it
      // moves on every poll, so using it would make every ack stale at once.
      since: '',
      href: toHash(routeFor('limits')),
      actions: [
        {
          verb: 'login',
          label: 'Open a sign-in terminal',
          endpoint: '/api/auth/login',
          method: 'POST',
          ...gatedBy('run', flags.allowRun),
        },
        { verb: 'recheck', label: 'Check again', endpoint: '/api/accounts/refresh', method: 'POST' },
      ],
    });
  }

  for (const account of facts.accounts ?? []) {
    if (account.builtIn) continue;
    if (account.authState !== 'expired' && account.authState !== 'signed-out') continue;
    const name = account.name || account.email || account.id;
    out.push({
      kind: 'sign-in',
      severity: 'needs-you',
      subject: account.id,
      title: `${name} is ${account.authState === 'expired' ? 'expired' : 'signed out'}`,
      need: 'A signed-in account — a run pinned to this one cannot spawn a session.',
      how: 'Sign it in from Settings ▸ Accounts; the console opens the login in its own config directory.',
      since: '',
      href: toHash(routeFor('limits')),
      actions: [
        {
          verb: 'login',
          label: 'Sign this account in',
          endpoint: '/api/accounts/login',
          method: 'POST',
          body: { accountId: account.id },
          ...gatedBy('accounts', flags.allowAccounts),
        },
        {
          verb: 'recheck',
          label: 'Check again',
          endpoint: '/api/accounts/refresh',
          method: 'POST',
          body: { accountId: account.id },
        },
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * mcp-auth
 * ------------------------------------------------------------------ */

/**
 * `blocksBoarding` — `mcp/health.ts`'s own predicate, reproduced over the view's
 * `status` string.
 *
 * `pending` deliberately does not block: a remote server with a cached tool
 * list reports pending and connects on its first tool call. `unknown` means the
 * probe could not RUN, and "I could not check" is not "they are down" — a probe
 * that could not run must never degrade anything.
 */
const blocksBoarding = (status: string | undefined): boolean => status === 'needs-auth' || status === 'failed';

function mcpDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};
  // Runs stopped at the MCP preflight — they are what turns a signed-out server
  // from a chore into a stoppage, and they are where `mcp-continue` is offered.
  const parked = stoppedRuns(facts.runs ?? []).filter((run) => run.halt?.kind === 'mcp-preflight');

  for (const server of facts.mcp ?? []) {
    if (!server.enabled) continue;
    const unconfigured = Boolean(server.needsConfig?.length);
    if (!blocksBoarding(server.status) && !unconfigured) continue;
    const label = server.label || server.id;

    out.push({
      kind: 'mcp-auth',
      severity: parked.length ? 'urgent' : 'needs-you',
      subject: server.id,
      title: unconfigured
        ? `${label} is not finished being registered`
        : `${label} ${server.status === 'needs-auth' ? 'needs signing in' : 'is failing'}`,
      need: unconfigured
        ? `Values for ${server.needsConfig!.join(', ')} — until they are set this server can never connect.`
        : server.issue || 'A signed-in MCP server — a phase that names it boards without it, or parks.',
      how: unconfigured
        ? 'Finish the registration under MCP servers: supply the missing values, then re-check it.'
        : 'Sign it in from the MCP servers page, then re-check it. Or let the parked run continue without it.',
      since: '',
      href: toHash('mcp'),
      actions: [
        // No login action when it `needsConfig`: it can never connect, so a
        // sign-in button would be a button that cannot work. A third state, not
        // a variety of `needs-auth`.
        ...(unconfigured
          ? []
          : [
              {
                verb: 'login',
                label: 'Sign this server in',
                endpoint: `/api/mcp/${encodeURIComponent(server.id)}/login`,
                method: 'POST' as const,
                ...gatedBy('mcp', flags.allowMcp),
              },
            ]),
        { verb: 'refresh', label: 'Check again', endpoint: '/api/mcp/refresh', method: 'POST' },
        ...(server.toolsChanged
          ? [
              {
                verb: 'acknowledge',
                label: 'Acknowledge the tool change',
                endpoint: `/api/mcp/${encodeURIComponent(server.id)}/acknowledge`,
                method: 'POST' as const,
              },
            ]
          : []),
        ...parked.map((run) => ({
          verb: 'mcp-continue',
          label: `Continue ${run.slug} without these servers`,
          endpoint: runVerb(run.slug, 'mcp-continue'),
          method: 'POST' as const,
          ...gatedBy('run', flags.allowRun),
        })),
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * lock
 * ------------------------------------------------------------------ */

/**
 * Debris, and only debris.
 *
 * An expired lock is debris by the clock. An UNEXPIRED lock is debris only when
 * the session registry says its own `session=` has ENDED — presence is
 * three-valued and an owner/time match is display, releasing nothing. A foreign
 * unexpired lock whose session is live or unknown is a queue to wait in, and
 * the scheduler already owns that wait; putting it in the inbox would ask a
 * person to break something that is working.
 */
function lockDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};

  // Which locks something is actually queued behind — the difference between
  // "there is debris" and "there is debris and it is in the way".
  const inTheWay = new Set<string>();
  for (const entry of facts.queue?.entries ?? []) {
    for (const holder of entry.waitingOn ?? []) {
      if (holder.kind !== 'lock') continue;
      if (holder.slug && holder.phase != null) inTheWay.add(`${holder.slug}:${holder.phase}`);
    }
  }

  for (const lock of facts.locks ?? []) {
    const key = `${lock.slug}:${lock.phase}`;
    const ended = facts.lockPresence?.[key] === 'ended';
    if (!lock.expired && !ended) continue;
    const blocking = inTheWay.has(key);

    out.push({
      kind: 'lock',
      severity: blocking ? 'needs-you' : 'fyi',
      subject: lock.expired ? 'expired' : 'ended',
      slug: lock.slug,
      phase: lock.phase,
      title: `${lock.slug} phase ${lock.phase} — ${lock.expired ? 'expired lock' : 'lock with no session'}`,
      need: lock.expired
        ? `The lock ${lock.owner} took on this phase has outlived its lease.`
        : `${lock.owner} holds this phase and the session that took it has ended.`,
      how: blocking
        ? 'Release it — a lane is queued behind it and will board as soon as it goes.'
        : 'Release it when you are sure nothing is still working in that phase.',
      // For an expired lock the lease end IS the "waiting since": it is when
      // the claim stopped meaning anything, and it does not move.
      since: lock.expired ? stableSince(lock.leaseUntil) : '',
      href: phaseHref(lock.slug, lock.phase),
      actions: [
        {
          verb: 'release',
          label: 'Release the lock',
          endpoint: '/api/locks/release',
          method: 'POST',
          body: { slug: lock.slug, phase: lock.phase },
          ...gatedBy('writes', flags.allowWrites),
        },
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * stall — nominally in flight, and not moving
 * ------------------------------------------------------------------ */

/**
 * The three verbs that answer a session which has stopped being work.
 *
 * `steer` sends a canned nudge rather than opening a compose box: the row is
 * read on a phone at the top of an inbox, and the useful thing to say to a
 * session that has produced nothing for half an hour is the same sentence
 * every time. Anything more specific is a conversation, and the run page is
 * where conversations happen.
 */
function stallActions(slug: string, phase: number, allowRun: boolean | undefined): InboxAction[] {
  return [
    {
      verb: 'steer',
      label: 'Nudge the session',
      endpoint: runVerb(slug, 'steer'),
      method: 'POST',
      body: {
        phase,
        instruction:
          'You have produced nothing for a while. Say in one line what you are waiting on, then either '
          + 'continue or declare an outcome with scripts/phase-outcome.sh. If a tool call is hung, abandon '
          + 'it and take another route.',
      },
      ...gatedBy('run', allowRun),
    },
    {
      verb: 'freeze',
      label: 'Freeze it where it stands',
      endpoint: runVerb(slug, 'freeze'),
      method: 'POST',
      body: { phase },
      ...gatedBy('run', allowRun),
    },
    {
      verb: 'stop',
      label: `Stop phase ${phase}`,
      endpoint: runVerb(slug, 'stop'),
      method: 'POST',
      body: { phase },
      ...gatedBy('run', allowRun),
    },
  ];
}

/** Whole minutes or whole hours, whichever reads as a sentence. */
function agoText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 90) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * The five ways something is nominally in flight and not moving.
 *
 * The clocks are `STALL_META`'s and are longer than the runner's own detector
 * (`shared/attention-model.js` `STALL_DEFAULTS`), deliberately: the runner
 * notices at ten minutes and announces once, because a notification is cheap
 * and dismissable; the inbox is a list of things a person still owes an
 * answer to, and half an hour is where "it is thinking" stops being the likely
 * explanation.
 *
 * Four of the five have no live session at all — a lock nothing is releasing,
 * a park nothing resumed, a plan nobody has opened, a §Verification that will
 * not finish — so each carries the verb that actually answers IT rather than
 * the three that answer a running session.
 */
function stallDrafts(facts: InboxFacts, now: number): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};
  const after = (kind: keyof typeof STALL_META): number => STALL_META[kind].afterMs;
  const older = (at: string | undefined, ms: number): number | null => {
    if (!at) return null;
    const started = Date.parse(at);
    if (!Number.isFinite(started)) return null;
    return now - started >= ms ? started : null;
  };

  for (const run of facts.runs ?? []) {
    if (run.resolved || run.status === 'finished') continue;
    const live = isLiveStatus(run.status);
    for (const record of Object.values(run.phases ?? {})) {
      if (!record || !positivePhase(record.phase)) continue;
      const phase = record.phase;
      const common = { slug: run.slug, phase, runId: run.id, href: phaseHref(run.slug, phase) };

      // 1. Silent. The runner's own signal is the trigger and its `since` is
      //    the clock, so the row and the push cannot disagree about when the
      //    silence began; the longer floor is applied here.
      const silentSince = live && record.status === 'running'
        ? older(record.stall?.signal === 'silent' ? record.stall.since : record.liveness?.lastOutputAt,
          after('session-silent'))
        : null;
      if (silentSince !== null) {
        const open = record.liveness?.openTool?.name;
        out.push({
          kind: 'stall',
          severity: STALL_META['session-silent'].severity,
          subject: 'session-silent',
          ...common,
          title: `${run.slug} phase ${phase} — silent for ${agoText(now - silentSince)}`,
          need: `The session is still running and still spending, and it has produced nothing for ${agoText(now - silentSince)}.`
            + (open ? ` Its oldest open tool call is ${open}.` : ''),
          how: 'Nudge it, freeze it where it stands, or stop this lane. Nothing else is blocked on it — '
            + 'the rest of the run carries on either way.',
          since: new Date(silentSince).toISOString(),
          actions: stallActions(run.slug, phase, flags.allowRun),
        });
      }

      // 2. Queued behind somebody else's lock. Half the runner's own two-hour
      //    cap: past that the wait becomes a halt with a card of its own, so
      //    this one has to arrive while it is still a queue.
      const queuedSince = live ? older(record.lockWaitSince, after('queued-behind-lock')) : null;
      if (queuedSince !== null) {
        out.push({
          kind: 'stall',
          severity: STALL_META['queued-behind-lock'].severity,
          subject: 'queued-behind-lock',
          ...common,
          title: `${run.slug} phase ${phase} — queued behind a lock for ${agoText(now - queuedSince)}`,
          need: "This lane has been waiting on another owner's phase lock. It is not failing; it is in a queue.",
          how: 'Release the lock if the session that took it is gone, or stop this lane and let the run '
            + 'spend its parallelism somewhere else.',
          since: new Date(queuedSince).toISOString(),
          actions: [
            {
              verb: 'release',
              label: 'Release the lock',
              endpoint: '/api/locks/release',
              method: 'POST',
              body: { slug: run.slug, phase },
              ...gatedBy('writes', flags.allowWrites),
            },
            {
              verb: 'stop',
              label: `Stop phase ${phase}`,
              endpoint: runVerb(run.slug, 'stop'),
              method: 'POST',
              body: { phase },
              ...gatedBy('run', flags.allowRun),
            },
          ],
        });
      }

      // 3. A park whose resume never fired. The waiting was fine; the ARMING
      //    is what failed, which is why the remedy is Recover and not patience.
      const overdue = record.status === 'waiting'
        ? older(record.parkedUntil, after('park-overdue'))
        : null;
      if (overdue !== null) {
        out.push({
          kind: 'stall',
          severity: STALL_META['park-overdue'].severity,
          subject: 'park-overdue',
          ...common,
          title: `${run.slug} phase ${phase} — ${agoText(now - overdue)} past its own resume time`,
          need: `This phase parked until ${new Date(overdue).toLocaleString()} and nothing resumed it.`
            + (record.parkReason ? ` It said it was waiting on: ${record.parkReason}` : ''),
          how: 'Recover & continue re-reads the board and re-arms the resume. If the external work it '
            + 'was waiting on is genuinely still going, the phase re-files its wait by itself.',
          since: new Date(overdue).toISOString(),
          actions: [
            {
              verb: 'recover',
              label: 'Recover & continue',
              endpoint: runVerb(run.slug, 'recover'),
              method: 'POST',
              body: { runId: run.id },
              ...gatedBy('run', flags.allowRun),
            },
          ],
        });
      }

      // 5. A §Verification that will not finish — the runtime half of lint
      //    F16, which warns at plan time about a check waiting on a clock the
      //    session does not control. Runnable, unfinishable.
      // Gated on the RUN being live, like `silent` and `queued-behind-lock`
      // and unlike `park-overdue`: a halted run's record can still read
      // `verifying` — that is what it was doing when it stopped — and a card
      // saying a check has been running for three hours when nothing is
      // running is an ask nobody can answer. A park, by contrast, belongs to a
      // run that is legitimately not running.
      const hanging = live && record.status === 'verifying'
        ? older(record.verifyingSince, after('verify-hanging'))
        : null;
      if (hanging !== null) {
        out.push({
          kind: 'stall',
          severity: STALL_META['verify-hanging'].severity,
          subject: 'verify-hanging',
          ...common,
          title: `${run.slug} phase ${phase} — verifying for ${agoText(now - hanging)}`,
          need: 'A §Verification command has been running for longer than any check should take. '
            + 'Usually one that waits on an external clock — a `gh run watch`, a `--watch` flag, a long sleep.',
          how: 'Stop this lane, then split the wait out of §Verification behind a Gate-check so the phase '
            + 'can finish and the wait can be declared (F16 warns about this at plan time).',
          since: new Date(hanging).toISOString(),
          actions: [
            {
              verb: 'stop',
              label: `Stop phase ${phase}`,
              endpoint: runVerb(run.slug, 'stop'),
              method: 'POST',
              body: { phase },
              ...gatedBy('run', flags.allowRun),
            },
          ],
        });
      }
    }
  }

  // 4. A plan nobody has touched in a week that still has startable work.
  //    Taken whole from the Insights computation rather than re-derived: two
  //    definitions of "idle" would drift the first time one of them learned
  //    about a new kind of activity.
  const closed = new Set((facts.plans ?? []).filter((plan) => plan.closed).map((plan) => plan.slug));
  for (const idle of facts.stalledPlans ?? []) {
    if (closed.has(idle.slug)) continue;
    const plan = (facts.plans ?? []).find((p) => p.slug === idle.slug);
    out.push({
      kind: 'stall',
      severity: STALL_META['plan-idle'].severity,
      subject: 'plan-idle',
      slug: idle.slug,
      title: `${idle.slug} — ${idle.days} days idle with ${idle.ready.length} phase${idle.ready.length === 1 ? '' : 's'} ready`,
      need: `Nothing has touched this plan for ${idle.days} days, and phase`
        + `${idle.ready.length === 1 ? ` ${idle.ready[0]} is` : `s ${idle.ready.join(', ')} are`} startable.`,
      how: 'Start a run, pick the work up by hand, or close the plan if it is not happening — a plan that '
        + 'is not being worked reports no progress, which is the honest thing for it to say.',
      // The plan's own last write. Stable between polls and it moves exactly
      // when the plan does, which is the only moment this ask is new again.
      since: stableSince(plan?.updatedAt),
      href: planHref(idle.slug, 'route'),
      actions: [],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * ruling — a decision worth remembering
 * ------------------------------------------------------------------ */

/**
 * How far back a ruling is still worth a row.
 *
 * A ruling is never resolved and never goes away — the ledger is the record —
 * so without a window every decision a plan ever made would be a row forever.
 * Two weeks is the span over which "somebody should see this happened" is
 * still true; after that it is history, and history is read on the run page.
 */
const RULING_INBOX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** And at most this many per plan, newest first, so one busy plan cannot own the list. */
const RULING_INBOX_MAX_PER_PLAN = 20;

/**
 * One `fyi` row per recent ruling.
 *
 * `fyi` and not `needs-you`, because nothing is waiting: a ruling has already
 * been acted on by the session that recorded it. The row exists so the
 * decision is SEEN once — acknowledging it is the whole interaction, which is
 * why it carries no action of its own beyond the inbox's own ack.
 */
function rulingDrafts(facts: InboxFacts, now: number): Draft[] {
  const bySlug = new Map<string, Draft[]>();
  const closed = new Set((facts.plans ?? []).filter((plan) => plan.closed).map((plan) => plan.slug));

  for (const ruling of facts.rulings ?? []) {
    if (!ruling?.slug || closed.has(ruling.slug)) continue;
    const at = Date.parse(ruling.at);
    if (!Number.isFinite(at) || now - at > RULING_INBOX_WINDOW_MS) continue;
    const rows = bySlug.get(ruling.slug) ?? [];
    rows.push({
      kind: 'ruling',
      severity: 'fyi',
      // The ruling's own content-derived id. Stable across re-reads of an
      // append-only file, which is what makes the ack stick.
      subject: ruling.id,
      slug: ruling.slug,
      phase: ruling.phase,
      title: `${ruling.slug} phase ${ruling.phase} — ${RULING_KIND_LABELS[ruling.kind as keyof typeof RULING_KIND_LABELS] ?? 'Ruling'}`,
      need: ruling.what,
      how: ruling.why
        ? `Why: ${ruling.why}${ruling.costIfWrong ? ` · If it was wrong: ${ruling.costIfWrong}` : ''}`
        : ruling.costIfWrong
          ? `If it was wrong: ${ruling.costIfWrong}`
          : 'Nothing is waiting on you. Acknowledge it to take it off the list; it stays in the ledger either way.',
      since: new Date(at).toISOString(),
      href: phaseHref(ruling.slug, ruling.phase),
      actions: [],
    });
    bySlug.set(ruling.slug, rows);
  }

  return [...bySlug.values()].flatMap((rows) =>
    rows.sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0)).slice(0, RULING_INBOX_MAX_PER_PLAN));
}

/* ------------------------------------------------------------------ *
 * health — the console's own
 * ------------------------------------------------------------------ */

/** What an environment issue is called, in words that are not its enum member. */
const ENV_TITLES: Record<string, string> = {
  'path-missing-dir': 'The console PATH names a directory that is gone',
  'path-foreign-home': 'The console PATH points into another account’s home',
  'push-broken': 'Push notifications cannot be delivered',
};

function healthDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const settings = toHash(routeFor('health'));

  for (const issue of facts.environment ?? []) {
    out.push({
      kind: 'health',
      severity: 'needs-you',
      subject: issue.kind,
      title: ENV_TITLES[issue.kind] ?? issue.kind,
      need: issue.detail,
      // Every EnvIssue already carries its own errand sentence. Rewriting it
      // here would be a second copy of an instruction that is version-specific.
      how: issue.fix,
      since: '',
      href: settings,
      actions: [],
    });
  }

  if (facts.watcher && facts.watcher.healthy === false) {
    out.push({
      kind: 'health',
      severity: 'needs-you',
      subject: 'watcher',
      title: 'The console has stopped hearing file changes',
      need:
        `A working file watch — ${facts.watcher.watching ?? 0} of ${facts.watcher.expected ?? 0} directories are `
        + 'being watched, so plans and handoffs written outside the console may not appear.',
      how: 'Restart the console — the watch is rebuilt from scratch at boot.',
      since: '',
      href: settings,
      actions: [{ verb: 'restart', label: 'Restart the console', endpoint: '/api/restart', method: 'POST' }],
    });
  }

  // Only while it is still degraded. A healed degradation that stayed in the
  // list would be a row nothing could ever clear, which is precisely how an
  // inbox reaches 182 unread entries.
  if (facts.degraded && facts.degraded.healthy === false) {
    for (const entry of facts.degraded.recent ?? []) {
      out.push({
        kind: 'health',
        severity: 'fyi',
        subject: entry.kind,
        title: `The console degraded — ${entry.kind}`,
        need: entry.message,
        how: 'Check the console log; a restart clears a subsystem that did not recover by itself.',
        since: stableSince(entry.at),
        href: settings,
        actions: [],
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * The build
 * ------------------------------------------------------------------ */

/**
 * Everything that needs a person, in one list, sorted worst-and-oldest first.
 *
 * Pure: no filesystem, no subprocess, no clock but the `now` it is handed. The
 * caller gathers, this decides, the route performs.
 *
 * `options.all` is not a fact about the world — it is the request's own
 * `?all=1` — which is why it is a third argument rather than a field on
 * `InboxFacts`. Two-argument calls behave as the route's default: acknowledged
 * items are hidden.
 */
export function buildInbox(facts: InboxFacts = {}, now: number = Date.now(), options: InboxOptions = {}): InboxView {
  const drafts = [
    ...errandDrafts(facts),
    ...approvalDrafts(facts),
    ...planDrafts(facts),
    ...signInDrafts(facts),
    ...mcpDrafts(facts),
    ...lockDrafts(facts),
    ...stallDrafts(facts, now),
    ...rulingDrafts(facts, now),
    ...healthDrafts(facts),
  ];

  // Dedupe by id, first writer wins. The builders are written so that two
  // drafts with one id cannot happen (see ISSUE_KINDS_OWNED_ELSEWHERE and the
  // `builtIn` skip); this is the belt, because a duplicate id would mean one
  // ack silencing two rows and the operator seeing the same ask twice.
  const seen = new Set<string>();
  const items: InboxItem[] = [];
  for (const draft of drafts) {
    const item = mint(draft);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const ack = ackFor(facts.acks, item.id, item.since);
    if (ack) {
      if (!options.all) continue;
      item.ack = ack;
    }
    items.push(item);
  }

  return { items: sortInbox(items), generatedAt: new Date(now).toISOString() };
}

/**
 * Every id the current facts can produce, acknowledged or not — what
 * `pruneAcks` must be given as its keep-set.
 *
 * A separate pass rather than a flag on `buildInbox` because the route needs
 * both answers from one snapshot: the list to show, and the full id space to
 * prune against. Deriving the second from a filtered first would delete the ack
 * of every item the filter just hid, which is the opposite of what an ack does.
 */
export function inboxIds(facts: InboxFacts = {}, now: number = Date.now()): string[] {
  return buildInbox(facts, now, { all: true }).items.map((item) => item.id);
}

/* ------------------------------------------------------------------ *
 * The acks file
 *
 * Small, written rarely, read at boot: the `mcp/store.ts` shape — synchronous,
 * a `version: 1` envelope, mkdir 0700, temp-then-rename, 0600, and a read half
 * that degrades to empty and warns only on a non-ENOENT error. No debounce:
 * `notifications.ts` needs one because it rewrites a growing log on every
 * announcement; this file is touched when a person presses a button.
 *
 * Every function takes its directory as a parameter so a test never goes near
 * the operator's real state directory — the `launcher.ts` rule, for the same
 * reason. `INBOX_ACKS_DIR` is the one the console actually uses.
 * ------------------------------------------------------------------ */

/** Where the console's own acks live. Per instance, like approvals and push. */
export const INBOX_ACKS_DIR = INSTANCE_STATE_DIR;

const ACKS_FILENAME = 'inbox-acks.json';

/**
 * How many acks the file may hold.
 *
 * An ack is written per press and removed by `pruneAcks` when its item goes
 * away — but a console whose route forgets to prune would grow the file
 * forever, and a JSON file read synchronously at boot is exactly the wrong
 * place for unbounded growth. Oldest go first.
 */
const MAX_ACKS = 2000;

/** An ack this old is dropped even if its item is still asking. Six weeks. */
const DEFAULT_ACK_MAX_AGE_MS = 42 * 24 * 60 * 60 * 1000;

type AcksFile = { version: 1; acks: Record<string, InboxAck> };

export function acksFile(dir: string): string {
  return join(dir, ACKS_FILENAME);
}

/** An unreadable or absent acks file degrades to "nothing is acknowledged". */
export function readAcks(dir: string = INBOX_ACKS_DIR): Record<string, InboxAck> {
  try {
    const parsed = JSON.parse(readFileSync(acksFile(dir), 'utf8')) as AcksFile;
    if (parsed?.version === 1 && parsed.acks && typeof parsed.acks === 'object') {
      const out: Record<string, InboxAck> = {};
      for (const [id, ack] of Object.entries(parsed.acks)) {
        if (!id || !ack || typeof ack.at !== 'string') continue;
        out[id] = typeof ack.by === 'string' && ack.by ? { at: ack.at, by: ack.by } : { at: ack.at };
      }
      return out;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('inbox.acks.unreadable', { error: (error as Error).message });
    }
  }
  return {};
}

function writeAcks(dir: string, acks: Record<string, InboxAck>): void {
  const entries = Object.entries(acks);
  // Oldest first, so the slice keeps the newest MAX_ACKS.
  if (entries.length > MAX_ACKS) {
    entries.sort((a, b) => (Date.parse(a[1].at) || 0) - (Date.parse(b[1].at) || 0));
    entries.splice(0, entries.length - MAX_ACKS);
  }
  const body: AcksFile = { version: 1, acks: Object.fromEntries(entries) };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = acksFile(dir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * Acknowledge one item — seen, not cleared.
 *
 * `at` is a parameter so a test can stamp one, and because the staleness rule
 * compares it against the item's own `since`: an ack stamped from a clock the
 * caller controls is the only way to test "the thing came back".
 */
export function writeAck(dir: string, id: string, by?: string, at: string = new Date().toISOString()): InboxAck {
  const ack: InboxAck = by ? { at, by } : { at };
  const acks = readAcks(dir);
  acks[id] = ack;
  writeAcks(dir, acks);
  return ack;
}

/** Un-acknowledge one item. False when there was nothing to remove. */
export function removeAck(dir: string, id: string): boolean {
  const acks = readAcks(dir);
  if (!(id in acks)) return false;
  delete acks[id];
  writeAcks(dir, acks);
  return true;
}

/**
 * Drop acks for items that are no longer asking, and acks that have gone stale
 * with age.
 *
 * This is the second half of the un-ack rule, and it is what makes an ack safe
 * on an item with no clock. An account that is signed out records no WHEN, so
 * `since` is empty and no timestamp comparison can tell a returning sign-out
 * from the one that was acknowledged. Absence can: the item vanished from the
 * build when the account was signed in, its ack was pruned then, and when the
 * account signs out again the item comes back unacknowledged.
 *
 * `keep` must therefore be EVERY id the current facts produce — `inboxIds`,
 * not the filtered list — or pruning would delete the acks of exactly the items
 * the filter hid, un-acking everything on the next request.
 *
 * Returns how many were dropped. Writes nothing when nothing changed.
 */
export function pruneAcks(
  dir: string,
  keep: Iterable<string>,
  options: { maxAgeMs?: number; now?: number } = {},
): number {
  const acks = readAcks(dir);
  const ids = keep instanceof Set ? keep : new Set(keep);
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? DEFAULT_ACK_MAX_AGE_MS;

  let dropped = 0;
  for (const [id, ack] of Object.entries(acks)) {
    const at = Date.parse(ack.at);
    const tooOld = Number.isFinite(at) && now - at > maxAge;
    if (ids.has(id) && !tooOld) continue;
    delete acks[id];
    dropped += 1;
  }
  if (dropped) writeAcks(dir, acks);
  return dropped;
}

/** Forget every ack — the reset behind a "clear acknowledgements" control. */
export function clearAcks(dir: string): void {
  try {
    rmSync(acksFile(dir), { force: true });
  } catch (error) {
    log.warn('inbox.acks.unclearable', { error: (error as Error).message });
  }
}

/**
 * The human label of an errand's situation, for a surface that wants to say
 * WHAT kind of stop it was rather than repeat the errand's own sentence.
 * Re-exported from the shared model so a caller needs one import, not two.
 */
export function situationTitle(key: string | undefined): string {
  const { id, sub } = parseSituationKey(key ?? '');
  return situationLabel(id, sub);
}
