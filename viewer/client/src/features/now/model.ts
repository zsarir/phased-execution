/**
 * Now, as data — what needs a person, what is running, what is next.
 *
 * ## Why the whole page is decided here
 *
 * The dashboard this replaces made its decisions inside its render: which run
 * counted as live, which ready phase to recommend, whether a card was a demand
 * or information. Every one of those was then untestable without a server, a
 * fetch mock and a click — so the rules drifted, and the page and the ready
 * board recommended different phases for a fortnight before anyone noticed.
 *
 * The split `views/dashboard/now.tsx` already drew for demands is applied to
 * the whole page here: **this module decides, the components render, and the
 * server performs.** Nothing in this file imports React, touches the network
 * or reads a clock it was not handed — `now` is a parameter everywhere, so one
 * render is one consistent answer and a test can state the date.
 *
 * ## Three questions, three sections
 *
 *  1. **Needs you** — `GET /api/inbox`. The server already decided WHAT is
 *     asking and WHICH remedies exist (`server/inbox.ts`, pure for the same
 *     reasons); this file only sorts the actions into the one that goes on the
 *     row and the ones that fold behind it, and counts what a filter would
 *     leave. Never re-derives an item, an id or a severity.
 *  2. **Running now** — the live LANES, not the runs. A run with three
 *     disjoint-scope phases in flight is three things being worked on, and the
 *     old strip drew it as one line with one clock.
 *  3. **Next up** — the departures board's ranking, moved here whole. It is
 *     the same decision the Ready page made, and the two pages disagreeing
 *     about the best next move is the defect that made having both a mistake.
 */

import { STALL_DEFAULTS } from '@shared/attention-model.js';
import { isClosed } from '@/lib/closure';
import type {
  ChildRef,
  ForeignSession,
  InboxAction,
  InboxItem,
  InboxSeverity,
  LaneLiveness,
  PhaseEta,
  PhaseLock,
  PhaseRecord,
  PhaseView,
  PlanDetail,
  PlanSummaryFull,
  RunState,
} from '@/lib/api';

/* ================================================================== *
 * 1 · The inbox
 * ================================================================== */

/**
 * The action a row leads with, and the ones that fold behind it.
 *
 * The server sends the remedies in the order it wants them offered — sign-in
 * before continue, release before stop — so "first" is a decision that was
 * already made and this must not re-make it. What it adds is the one rule the
 * wire cannot carry: an action whose capability is OFF (`flag`) must never be
 * the primary, because a row whose leading button cannot be pressed reads as a
 * row that cannot be answered. It stays in the list, disabled, naming the flag.
 */
export function splitActions(item: InboxItem): { primary?: InboxAction; rest: InboxAction[] } {
  const actions = item.actions ?? [];
  const index = actions.findIndex((action) => !action.flag);
  if (index < 0) return { rest: actions };
  return { primary: actions[index], rest: actions.filter((_, i) => i !== index) };
}

/** What `--allow-<flag>` an action wants, said the way the operator would fix it. */
export const FLAG_REASON: Record<string, string> = {
  run: 'Runs are off. Restart the console with --allow-run.',
  agent: 'Agent sessions are off. Restart the console with --allow-agent.',
  writes: 'Writes are off. Restart the console with --allow-writes.',
  accounts: 'Account management is off. Restart the console with --allow-accounts.',
  mcp: 'MCP management is off. Restart the console with --allow-mcp.',
  terminal: 'Terminals are off. Restart the console with --allow-terminal.',
};

export const flagReason = (flag: string | undefined): string | undefined =>
  flag ? (FLAG_REASON[flag] ?? `This needs --allow-${flag}.`) : undefined;

/** How many of each severity — the header strip's "N need you" and the badge. */
export function inboxCounts(items: readonly InboxItem[]): Record<InboxSeverity | 'total', number> {
  const counts = { urgent: 0, 'needs-you': 0, fyi: 0, total: items.length };
  for (const item of items) {
    if (item.severity in counts) counts[item.severity] += 1;
  }
  return counts;
}

/**
 * What the badge and the header count.
 *
 * `fyi` is deliberately excluded: a ruling worth reading and a lock nobody is
 * queued behind are both real rows, and neither is a person being waited on.
 * A badge that counts them is a badge that is never zero, and a badge that is
 * never zero stops being read — the exact failure the 182-unread notification
 * inbox demonstrated.
 */
export const needsYouCount = (items: readonly InboxItem[] | undefined): number =>
  (items ?? []).filter((item) => item.severity !== 'fyi').length;

/* ================================================================== *
 * 2 · The live lanes
 * ================================================================== */

/**
 * Run statuses that mean a loop is behind this run right now.
 *
 * `features/runs/defaults.ts` `isLive` is the same list and is the one the run
 * page reads; it is imported rather than copied by every caller here.
 */
export { isLive } from '@/features/runs/defaults';

/** One phase being worked on right now, with everything a row shows. */
export interface NowLane {
  /** `${runId}#${phase}` — stable across re-sorts, which is what keys React. */
  key: string;
  slug: string;
  planTitle: string;
  runId: string;
  phase: number;
  /** From the plan detail, once it lands — see `enriched`. */
  title?: string;
  /** The LANE's status, never the run's: a run runs, a lane may be verifying. */
  status: string;
  runStatus: string;
  model?: string;
  effort?: string;
  /** The live child, when there is one — a queued lane has none. */
  child?: ChildRef;
  startedAt?: string;
  costUsd: number;
  turns?: number;
  attempts: number;
  liveness?: LaneLiveness;
  /** The park's own clock and the session's words for what it waits on. */
  parkedUntil?: string;
  parkReason?: string;
  watch?: string[];
  /** Queued behind somebody else's lock since this instant. */
  lockWaitSince?: string;
  /** The server's own estimate for this phase. Never computed here. */
  eta?: PhaseEta;
  /** Frozen under SIGSTOP — the lane's own flag, not the run's single slot. */
  frozen: boolean;
  /** The plan detail has landed, so `title` and `eta` are real. */
  enriched: boolean;
}

/** Lane statuses that are "being worked on" rather than settled. */
const LANE_STATUSES = new Set([
  'running',
  'verifying',
  'awaiting-verification',
  'queued',
  'waiting',
  'parked',
  'gated',
]);

/**
 * Every lane of every live run, worst first.
 *
 * Read from `run.phases` rather than `run.children`, deliberately: `children`
 * holds only lanes with a live process, and a lane queued behind a lock or
 * parked on an external clock is exactly the one somebody is asking about.
 * `child` is then attached where there is one, which is what tells a running
 * lane from a waiting one on the row.
 *
 * Liveness comes off the phase record — `RunDetail.liveness[]` is fresher, but
 * it costs one `GET /api/run/:slug` per plan and this page holds none of them.
 * The record's copy is what the server itself falls back to; the row draws it
 * through `Heartbeat`, which reports silence rather than pretending to a pulse.
 */
export function nowLanes(
  runs: readonly RunState[],
  details: Map<string, PlanDetail> = new Map(),
  now = Date.now(),
): NowLane[] {
  const out: NowLane[] = [];

  for (const run of runs) {
    if (!isLiveRun(run)) continue;
    const detail = details.get(run.slug);
    const phases = new Map((detail?.phases ?? []).map((p: PhaseView) => [p.phase, p]));
    const etas = new Map((detail?.eta?.perPhase ?? []).map((e) => [e.phase, e]));

    for (const [key, record] of Object.entries(run.phases ?? {})) {
      if (!record || !/^\d+$/.test(key)) continue;
      if (!LANE_STATUSES.has(record.status)) continue;
      const child = run.children?.[key] ?? (run.child?.phase === record.phase ? run.child : undefined);
      const view = phases.get(record.phase);
      out.push({
        key: `${run.id}#${record.phase}`,
        slug: run.slug,
        planTitle: detail?.summary?.title || run.slug,
        runId: run.id,
        phase: record.phase,
        ...(view?.title ? { title: view.title } : {}),
        status: record.status,
        runStatus: run.status,
        ...((record.model ?? run.model) ? { model: record.model ?? run.model } : {}),
        ...((record.effort ?? run.effort) ? { effort: record.effort ?? run.effort } : {}),
        ...(child ? { child } : {}),
        ...((child?.startedAt ?? record.startedAt)
          ? { startedAt: child?.startedAt ?? record.startedAt }
          : {}),
        costUsd: record.costUsd ?? 0,
        ...(record.turns != null ? { turns: record.turns } : {}),
        attempts: record.attempts ?? 0,
        ...(record.liveness ? { liveness: record.liveness } : {}),
        ...(record.parkedUntil ? { parkedUntil: record.parkedUntil } : {}),
        ...(record.parkReason ? { parkReason: record.parkReason } : {}),
        ...(record.watch?.length ? { watch: record.watch } : {}),
        ...(record.lockWaitSince ? { lockWaitSince: record.lockWaitSince } : {}),
        ...(etas.get(record.phase) ? { eta: etas.get(record.phase)! } : {}),
        frozen: Boolean(child?.frozen ?? (run.freeze && run.freeze.phase === record.phase)),
        enriched: view != null,
      });
    }
  }

  return out.sort((a, b) => laneOrder(a, b, now));
}

/**
 * Worst first, then oldest.
 *
 * A lane that is not moving outranks a healthy one however long the healthy
 * one has been going: the whole reason to look at this list is to find the one
 * that is not working. Within a rank the oldest leads, for the same reason
 * `sortInbox` puts the oldest ask first — the newest thing is the one you
 * already know about.
 *
 * ⚠️ **"Not moving" is TWO facts, and reading only the first is the defect
 * this comment exists for.** `liveness.stall` is the runner's own record,
 * written by a 60-second ticker; `liveness.lastOutputAt` is the raw clock the
 * row's heartbeat draws from. Seen live on the Phase 8 tour: a lane silent for
 * 34 minutes with no `stall` record yet sat BELOW a healthy one, while the
 * heartbeat beside it read `silent 34:29` and the inbox above it carried a
 * stall row about that very phase — three surfaces on one screen, two saying
 * "this one" and the ordering saying "not especially". The CLOCK decides the
 * order; the record only supplies the badge's word.
 */
export function laneOrder(a: NowLane, b: NowLane, now = Date.now()): number {
  const rank = laneRank(a, now) - laneRank(b, now);
  if (rank !== 0) return rank;
  const at = Date.parse(a.startedAt ?? '');
  const bt = Date.parse(b.startedAt ?? '');
  const ax = Number.isFinite(at) ? at : Infinity;
  const bx = Number.isFinite(bt) ? bt : Infinity;
  if (ax !== bx) return ax < bx ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Silent past the runner's own floor, by the lane's own clock.
 *
 * `STALL_DEFAULTS.stallSilentMs` — the same constant the detector uses and the
 * same one the row's `Heartbeat` stops pulsing at, so the order, the dot and
 * the push notification cannot disagree about when silence begins.
 */
export function laneSilent(lane: NowLane, now = Date.now()): boolean {
  if (lane.status !== 'running') return false;
  const last = Date.parse(lane.liveness?.lastOutputAt ?? '');
  return Number.isFinite(last) && now - last >= STALL_DEFAULTS.stallSilentMs;
}

function laneRank(lane: NowLane, now: number): number {
  if (lane.liveness?.stall || laneSilent(lane, now)) return 0;
  if (lane.frozen) return 1;
  if (lane.status === 'running' || lane.status === 'verifying') return 2;
  return 3;
}

/** Whether a run has a loop behind it — `isLive` over the run's own status. */
export function isLiveRun(run: RunState | null | undefined): boolean {
  return run != null && LIVE_RUN_STATUSES.has(run.status);
}

const LIVE_RUN_STATUSES = new Set([
  'running',
  'waiting',
  'pausing',
  'stopping',
  'frozen',
  'queued',
  'halting',
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The one run per plan this page talks about — the newest that still matters.
 *
 * Moved verbatim from `views/pulse/index.tsx`, whose page this absorbs. Its
 * test moved with it.
 */
export function pulseRuns(runs: readonly RunState[], now = Date.now()): RunState[] {
  const newestPerPlan = new Map<string, RunState>();
  for (const run of runs) {
    const seen = newestPerPlan.get(run.slug);
    if (!seen || Date.parse(run.updatedAt) > Date.parse(seen.updatedAt)) {
      newestPerPlan.set(run.slug, run);
    }
  }
  const rank = (run: RunState): number => {
    if (isLiveRun(run)) return 0;
    if (!run.resolved && ['halted', 'interrupted', 'parked'].includes(run.status)) return 1;
    return 2;
  };
  return [...newestPerPlan.values()]
    .filter((run) => rank(run) < 2 || now - Date.parse(run.updatedAt) < DAY_MS)
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * Hook-reported sessions no lane row will draw: live ones with no plan (a
 * `claude` in the repository that claimed nothing) or whose plan has no lane
 * here, plus what ended in the last hour — the "just left" an operator asks
 * about. Moved from `views/pulse/index.tsx`.
 */
/** The vehicle a hook-reported session is, in words. */
export function foreignVehicle(session: Pick<ForeignSession, 'kind'>): string {
  return session.kind === 'agent'
    ? 'Console agent'
    : session.kind === 'autopilot'
      ? 'Autopilot session'
      : 'Terminal session';
}

export function otherSessions(
  sessions: readonly ForeignSession[] | undefined,
  // A `NowLane` satisfies this, and so does a bare `RunState` — `child` is
  // `ChildRef | null` there. Widening the parameter rather than the field is
  // what lets a caller hand over either without a cast.
  lanes: readonly { slug: string; child?: ChildRef | null }[],
  now = Date.now(),
): ForeignSession[] {
  if (!sessions?.length) return [];
  const shown = new Set(lanes.map((lane) => lane.slug));
  const own = new Set(lanes.map((lane) => lane.child?.sessionId).filter(Boolean));
  return sessions
    .filter((s) => !own.has(s.sessionId))
    .filter(
      (s) =>
        (s.presence === 'live' && !(s.plan && shown.has(s.plan.slug))) ||
        (s.presence === 'ended' && s.endedAt != null && now - Date.parse(s.endedAt) < HOUR_MS),
    )
    .sort(
      (a, b) =>
        (a.presence === 'live' ? 0 : 1) - (b.presence === 'live' ? 0 : 1) ||
        b.lastSeen.localeCompare(a.lastSeen),
    );
}

/**
 * Why nothing is running, in the words that say what to do about it.
 *
 * An empty lane list has five distinct causes and they want five different
 * answers. The old strip said "Nothing is running" for all of them — including
 * for a console that CANNOT run, where the Start button it offered beside that
 * sentence was going to 403.
 */
export function idleReason(input: {
  allowRun: boolean;
  signedOut: boolean;
  ready: number;
  queued: number;
  needsYou: number;
}): { headline: string; detail: string } {
  if (input.signedOut) {
    return {
      headline: 'Nothing can start — Claude is signed out here',
      detail: 'Sign the machine login in, or pick an account under Settings ▸ Accounts.',
    };
  }
  if (!input.allowRun) {
    return {
      headline: 'Nothing is running, and this console cannot start anything',
      detail: 'It was started without --allow-run. Everything below is still readable.',
    };
  }
  if (input.queued > 0) {
    return {
      headline: 'Nothing is running yet',
      detail: `${input.queued} lane${input.queued === 1 ? ' is' : 's are'} queued behind a scope somebody else holds.`,
    };
  }
  if (input.needsYou > 0) {
    return {
      headline: 'Nothing is running',
      detail: `${input.needsYou} thing${input.needsYou === 1 ? '' : 's'} above ${input.needsYou === 1 ? 'is' : 'are'} waiting on you — clearing one is what starts the next.`,
    };
  }
  if (input.ready > 0) {
    return { headline: 'Nothing is running', detail: 'Next up is below — start one from there.' };
  }
  return {
    headline: 'Nothing is running',
    detail: 'Nothing is ready either: every remaining phase is waiting on one that has not landed.',
  };
}

/* ================================================================== *
 * 3 · Next up — the departures board, moved whole
 *
 * From `views/ready/model.ts`. Nothing about the ranking changed: the Ready
 * page and the dashboard's own "next move" line were two implementations of
 * one decision, and this section is the surviving one.
 * ================================================================== */

/** One phase that could start right now, with everything needed to choose it. */
export interface Departure {
  /** `slug#phase` — stable across re-ranks, which is what keyframes React. */
  key: string;
  slug: string;
  planTitle: string;
  phase: number;
  title?: string;
  size?: string;
  weight?: number;
  gated: boolean;
  gates?: string;
  /** Who can clear the gate — human / ai / auto. Absent on older servers. */
  gateKind?: 'human' | 'ai' | 'auto' | 'none';
  /** How many phases this one frees. The leverage signal. */
  unblocks: number;
  onCriticalPath: boolean;
  /** A live claim by another session — the reason not to boot this one. */
  lock?: PhaseLock;
  repos: string[];
  branch?: string;
  skills: string[];
  /** MCP servers the plan attaches to every session. */
  mcpServers: string[];
  model?: string;
  effort?: string;
  /** This phase failed its QA gate on a previous attempt. */
  qaFailed: boolean;
  /** The plan's session budget in tokens — what `weight` is a fraction of. */
  budget: number;
  /** Whole days since anything in this plan moved. */
  idleDays: number;
  activity: number;
  planPercent: number;
  planPhases: number;
  planDone: number;
  planErrors: number;
  /** The plan detail has landed, so title/size/weight are real. */
  enriched: boolean;
}

const DAY = 86_400_000;

/** A lock only counts as a claim while its lease is live. */
export const isClaimed = (lock: PhaseLock | undefined): boolean => Boolean(lock && !lock.expired);

/**
 * Build the queue.
 *
 * ## Closed plans never board
 *
 * The highest-stakes closure gate in the client, and the one place the server
 * cannot do it for us: `stats.ready` is `board.ready` verbatim — the engine
 * deliberately still reports what a closed plan never finished, so its own
 * page can say so — and a closed plan therefore arrives here with a populated
 * `ready` array. Every row this emits is an invitation to boot a session, and
 * emitting one for an abandoned plan is the console recommending work the
 * operator has already said will never happen.
 */
export function toDepartures(
  plans: readonly PlanSummaryFull[],
  details: Map<string, PlanDetail>,
  now = Date.now(),
): Departure[] {
  const out: Departure[] = [];

  for (const plan of plans) {
    if (isClosed(plan)) continue;
    const ready = (plan.ready ?? []).filter((n): n is number => typeof n === 'number');
    if (!ready.length) continue;

    const detail = details.get(plan.slug);
    const phases = new Map((detail?.phases ?? []).map((p: PhaseView) => [p.phase, p]));
    const idleDays = plan.activity ? Math.max(0, Math.floor((now - plan.activity) / DAY)) : 0;

    for (const phase of ready) {
      const view = phases.get(phase);
      out.push({
        key: `${plan.slug}#${phase}`,
        slug: plan.slug,
        planTitle: plan.title || plan.slug,
        phase,
        title: view?.title,
        size: view?.size,
        weight: view?.analysis?.weight ?? view?.weight,
        gated: view?.gated ?? false,
        gates: view?.gates,
        gateKind: view?.gateKind,
        // Before the detail lands, the summary knows the leverage of exactly one
        // phase — the one the engine already named as the best next move.
        unblocks: view?.analysis?.unblocks ?? (plan.nextBest?.phase === phase ? plan.nextBest.unblocks : 0),
        onCriticalPath: view?.analysis?.onCriticalPath ?? (plan.criticalPath ?? []).includes(phase),
        lock: view?.lock ?? (plan.locks ?? []).find((l) => l.phase === phase),
        repos: plan.repos ?? [],
        branch: plan.branch,
        skills: plan.skills ?? [],
        mcpServers: plan.mcpServers ?? [],
        model: view?.model ?? plan.targetModel,
        effort: view?.effort,
        qaFailed: (plan.qaFailures ?? []).includes(phase),
        budget: plan.budget || 0,
        idleDays,
        activity: plan.activity ?? 0,
        planPercent: plan.percent ?? 0,
        planPhases: plan.phases ?? 0,
        planDone: plan.done ?? 0,
        planErrors: plan.issueCounts?.error ?? 0,
        enriched: view != null,
      });
    }
  }

  return out;
}

/**
 * Five orders, because "what should I start next" has five defensible answers
 * and which one is right depends on the day. They are deliberately not five
 * sorts of the same list: each leads with a different first key, so the top of
 * the board actually changes.
 */
export const RANKS = [
  {
    id: 'leverage',
    label: 'Leverage',
    hint: 'frees the most work',
    blurb: 'Phases that unblock the most other phases first — the fastest way to widen the board.',
  },
  {
    id: 'critical',
    label: 'Critical path',
    hint: 'sets the finish date',
    blurb: 'The chain the plan cannot finish without. Everything else has slack; these do not.',
  },
  {
    id: 'quick',
    label: 'Quick wins',
    hint: 'smallest first',
    blurb: 'Lightest phases first — what fits in the time you actually have.',
  },
  {
    id: 'momentum',
    label: 'Momentum',
    hint: 'most recent plan',
    blurb: 'Where you were last working. The context is still warm, in your head and in the handoff.',
  },
  {
    id: 'unstick',
    label: 'Unstick',
    hint: 'idle longest',
    blurb: 'Plans with ready work nobody has touched. These are the ones that quietly rot.',
  },
] as const;

export type RankId = (typeof RANKS)[number]['id'];

/** Unknown weights sort last in every size-sensitive order rather than as zero. */
const weightOf = (d: Departure): number => (d.weight && d.weight > 0 ? d.weight : Number.MAX_SAFE_INTEGER);

const bySlugThenPhase = (a: Departure, b: Departure): number =>
  a.slug.localeCompare(b.slug) || a.phase - b.phase;

const COMPARE: Record<RankId, (a: Departure, b: Departure) => number> = {
  leverage: (a, b) =>
    b.unblocks - a.unblocks ||
    Number(b.onCriticalPath) - Number(a.onCriticalPath) ||
    weightOf(a) - weightOf(b) ||
    bySlugThenPhase(a, b),
  critical: (a, b) =>
    Number(b.onCriticalPath) - Number(a.onCriticalPath) ||
    b.unblocks - a.unblocks ||
    weightOf(a) - weightOf(b) ||
    bySlugThenPhase(a, b),
  quick: (a, b) => weightOf(a) - weightOf(b) || b.unblocks - a.unblocks || bySlugThenPhase(a, b),
  momentum: (a, b) => b.activity - a.activity || a.phase - b.phase || bySlugThenPhase(a, b),
  unstick: (a, b) => b.idleDays - a.idleDays || b.unblocks - a.unblocks || bySlugThenPhase(a, b),
};

/**
 * Rank the queue.
 *
 * A claimed phase is always pushed below the unclaimed ones regardless of
 * order: however good a move it is, it is somebody else's move, and offering
 * it at the top of the board is how two sessions end up in the same phase.
 */
export function rank(departures: readonly Departure[], by: RankId): Departure[] {
  const compare = COMPARE[by] ?? COMPARE.leverage;
  return [...departures].sort(
    (a, b) => Number(isClaimed(a.lock)) - Number(isClaimed(b.lock)) || compare(a, b),
  );
}

export interface Filters {
  /** Hide phases another session is holding. */
  unclaimed: boolean;
  /** Hide phases that cannot start until a gate is cleared by hand. */
  open: boolean;
  /** One repo, or every repo. */
  repo: string;
  /** One plan, or every plan. */
  plan: string;
}

export const NO_FILTERS: Filters = { unclaimed: false, open: false, repo: '', plan: '' };

/**
 * ⚠️ `repo` and `plan` have no control on Now — the board's two `<select>`s did
 * not come with it (see this file's header). They stay in the shape because the
 * filter is one function and the plan page will want "this plan only"; the
 * board's `repoOptions` vocabulary builder went, because a list of options for
 * a control that does not exist is dead code the deletion sweep would have to
 * find later.
 */

export function applyFilters(departures: readonly Departure[], filters: Filters): Departure[] {
  return departures.filter((d) => {
    if (filters.unclaimed && isClaimed(d.lock)) return false;
    if (filters.open && d.gated) return false;
    if (filters.repo && !d.repos.includes(filters.repo)) return false;
    if (filters.plan && d.slug !== filters.plan) return false;
    return true;
  });
}

export interface Load {
  /** 0–1, clamped for drawing. Absent when there is no weight or no budget. */
  fraction: number | null;
  /** For the meter itself, where the bar is the message and the text is a check. */
  short: string;
  /** For prose and for the accessible name, where there is room to be exact. */
  long: string;
  /** The phase is heavier than the plan's own session budget. */
  over: boolean;
}

/**
 * The one number this whole skill is organised around: a phase is sized so its
 * working set fits a session, and a session is budgeted at a fraction of the
 * model's window. `40K` means nothing to read; the same weight against the
 * plan's own budget — `a fifth of a session` — is a decision.
 */
export function load(weight: number | undefined, budget: number): Load {
  if (!weight || !budget) {
    return { fraction: null, short: 'unsized', long: 'no weight declared', over: false };
  }
  const fraction = weight / budget;
  const percent = Math.round(fraction * 100);
  return {
    fraction: Math.min(1, fraction),
    short: fraction > 1 ? 'over' : `${percent}%`,
    long:
      fraction > 1
        ? `${percent}% of a session — more than the plan budgets for one`
        : fraction === 1
          ? 'exactly one session'
          : `${percent}% of a session`,
    over: fraction > 1,
  };
}

/**
 * What the queue adds up to.
 *
 * `sessions` is the engine's own `remainingSessions` summed over the plans on
 * the board, never a division this module performs — batching is the engine's
 * decision and a second implementation of it here would eventually disagree.
 */
export function queueTotals(departures: readonly Departure[], plans: readonly PlanSummaryFull[]) {
  const slugs = new Set(departures.map((d) => d.slug));
  let sessions = 0;
  for (const plan of plans) if (slugs.has(plan.slug)) sessions += plan.remainingSessions ?? 0;
  return {
    phases: departures.length,
    plans: slugs.size,
    claimed: departures.filter((d) => isClaimed(d.lock)).length,
    gated: departures.filter((d) => d.gated).length,
    sessions,
  };
}

/* ================================================================== *
 * 4 · Plans in flight
 * ================================================================== */

/**
 * The plans a strip is drawn for: open, unfinished, most recently active
 * first.
 *
 * "Unfinished" is not the same question as "still being worked on". `done <
 * phases` is true of every abandoned plan ever written, so without the closure
 * gate the home page opens on a wall of plans nobody is coming back to.
 */
export function plansInFlight(plans: readonly PlanSummaryFull[], limit: number): PlanSummaryFull[] {
  return plans
    .filter((p) => p.kind === 'plan' && !isClosed(p) && (p.done ?? 0) < (p.phases ?? 0))
    .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))
    .slice(0, limit);
}

/** A phase record read straight off a run, for the tests that hand-build one. */
export type LaneRecord = PhaseRecord;
