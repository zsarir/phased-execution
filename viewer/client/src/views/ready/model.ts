/**
 * The ready queue, as a decision rather than a list.
 *
 * ## The defect this replaces
 *
 * The old view read `plan.ready` as an array of objects and pulled `phase`,
 * `title`, `size` and `gated` off each entry. `/api/plans` sends an array of
 * **numbers**. Every field therefore came back `undefined`, so every row
 * rendered as a bare slug with a "ready" chip and a link to the plan rather than
 * to the phase — and two ready phases of the same plan rendered as two
 * identical, indistinguishable rows. The page could not answer the one question
 * it exists for.
 *
 * ## What a row needs to be a decision
 *
 * `/api/plans` carries the queue and the leverage signals (`criticalPath`,
 * `nextBest`, `locks`, `activity`, `budget`). The per-phase facts — title, size,
 * weight, gate, and the exact `unblocks` count — live in the plan detail, which
 * `usePlanDetails` fetches under the same keys the plan view uses. A departure
 * is therefore built in two passes: everything derivable from the summary
 * immediately, and the rest when the detail lands. `enriched` says which pass a
 * row is in, so the board can show that a title is coming rather than implying
 * there is not one.
 *
 * Nothing here invents an engine fact. `unblocks`, `onCriticalPath`, `weight`
 * and `size` are read from `phase.analysis`; the fallbacks used before a detail
 * arrives are the summary's own `criticalPath` and `nextBest`, never a guess.
 */

import type { PhaseLock, PhaseView, PlanDetail, PlanSummaryFull } from '@/lib/api';

/** One phase that could start right now, with everything needed to choose it. */
export interface Departure {
  /** `slug#phase` — stable across re-ranks, which is what keyframes React on. */
  key: string;
  slug: string;
  planTitle: string;
  phase: number;
  title?: string;
  size?: string;
  weight?: number;
  gated: boolean;
  gates?: string;
  /** How many phases this one frees. The leverage signal. */
  unblocks: number;
  onCriticalPath: boolean;
  /** A live claim by another session — the reason not to boot this one. */
  lock?: PhaseLock;
  repos: string[];
  branch?: string;
  skills: string[];
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
export const isClaimed = (lock: PhaseLock | undefined): boolean =>
  Boolean(lock && !lock.expired);

/**
 * Build the queue.
 *
 * `now` is a parameter rather than a call to the clock so that idle days are one
 * consistent answer for the whole render — and so a test can state the date.
 */
export function toDepartures(
  plans: readonly PlanSummaryFull[],
  details: Map<string, PlanDetail>,
  now = Date.now(),
): Departure[] {
  const out: Departure[] = [];

  for (const plan of plans) {
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
        // Before the detail lands, the summary knows the leverage of exactly one
        // phase — the one the engine already named as the best next move.
        unblocks: view?.analysis?.unblocks ?? (plan.nextBest?.phase === phase ? plan.nextBest.unblocks : 0),
        onCriticalPath: view?.analysis?.onCriticalPath ?? (plan.criticalPath ?? []).includes(phase),
        lock: view?.lock ?? (plan.locks ?? []).find((l) => l.phase === phase),
        repos: plan.repos ?? [],
        branch: plan.branch,
        skills: plan.skills ?? [],
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

/* ------------------------------------------------------------------ *
 * Ranking
 *
 * Five orders, because "what should I start next" has five defensible answers
 * and which one is right depends on the day. They are deliberately not five
 * sorts of the same list: each leads with a different first key, so the top of
 * the board actually changes.
 * ------------------------------------------------------------------ */

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
    b.unblocks - a.unblocks
    || Number(b.onCriticalPath) - Number(a.onCriticalPath)
    || weightOf(a) - weightOf(b)
    || bySlugThenPhase(a, b),
  critical: (a, b) =>
    Number(b.onCriticalPath) - Number(a.onCriticalPath)
    || b.unblocks - a.unblocks
    || weightOf(a) - weightOf(b)
    || bySlugThenPhase(a, b),
  quick: (a, b) =>
    weightOf(a) - weightOf(b)
    || b.unblocks - a.unblocks
    || bySlugThenPhase(a, b),
  momentum: (a, b) =>
    b.activity - a.activity
    || a.phase - b.phase
    || bySlugThenPhase(a, b),
  unstick: (a, b) =>
    b.idleDays - a.idleDays
    || b.unblocks - a.unblocks
    || bySlugThenPhase(a, b),
};

/**
 * Rank the queue.
 *
 * A claimed phase is always pushed below the unclaimed ones regardless of order:
 * however good a move it is, it is somebody else's move, and offering it at the
 * top of the board is how two sessions end up in the same phase.
 */
export function rank(departures: readonly Departure[], by: RankId): Departure[] {
  const compare = COMPARE[by] ?? COMPARE.leverage;
  return [...departures].sort(
    (a, b) => Number(isClaimed(a.lock)) - Number(isClaimed(b.lock)) || compare(a, b),
  );
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

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

export function applyFilters(departures: readonly Departure[], filters: Filters): Departure[] {
  return departures.filter((d) => {
    if (filters.unclaimed && isClaimed(d.lock)) return false;
    if (filters.open && d.gated) return false;
    if (filters.repo && !d.repos.includes(filters.repo)) return false;
    if (filters.plan && d.slug !== filters.plan) return false;
    return true;
  });
}

/** Every repo named by the queue, most-used first — the filter's own vocabulary. */
export function repoOptions(departures: readonly Departure[]): string[] {
  const counts = new Map<string, number>();
  for (const d of departures) {
    for (const repo of d.repos) counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([repo]) => repo);
}

/* ------------------------------------------------------------------ *
 * Session load
 *
 * The one number this whole skill is organised around: a phase is sized so that
 * its working set fits a session, and a session is budgeted at a fraction of the
 * model's window. A weight on its own ("40K") means nothing to read; the same
 * weight against the plan's own budget ("a fifth of a session") is a decision.
 * ------------------------------------------------------------------ */

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

export function load(weight: number | undefined, budget: number): Load {
  if (!weight || !budget) {
    return { fraction: null, short: 'unsized', long: 'no weight declared', over: false };
  }
  const fraction = weight / budget;
  const percent = Math.round(fraction * 100);
  return {
    fraction: Math.min(1, fraction),
    short: fraction > 1 ? 'over' : `${percent}%`,
    long: fraction > 1
      ? `${percent}% of a session — more than the plan budgets for one`
      : fraction === 1 ? 'exactly one session' : `${percent}% of a session`,
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
