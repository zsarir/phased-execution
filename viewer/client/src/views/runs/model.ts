/**
 * The fleet — every run the autopilot has made, as a record you can read.
 *
 * ## What the old table left on the wire
 *
 * `/api/runs` returns the **complete** `RunState` for every run of every plan:
 * the model and effort it ran on, its autonomy and permission profile, its
 * budgets, its consecutive failures, and a full `PhaseRecord` for every phase it
 * touched — status, attempts, cost, turns, duration, the session's own closing
 * words. There is no thinner list shape; all of that arrives whether you read it
 * or not.
 *
 * The table that stood here showed six of those fields, and not the one that
 * matters most: **why the run stopped**. A row said `halted` and nothing else, so
 * the only way to learn what had gone wrong was to leave the page. Meanwhile
 * every run of every plan for all time rendered at once, unsorted and
 * unfilterable, so the halted run was somewhere in two hundred finished ones.
 *
 * ## What a row is
 *
 * A `RunRow` is that state resolved into the things a fleet reader asks: what it
 * is doing, how far it got, what it cost against what it was allowed, how long
 * it actually worked, and — always — a sentence saying why it is where it is.
 *
 * ⚠️ `RunState.phases` is a `Record<string, PhaseRecord>`. The keys are phase
 * numbers **as strings**; `Object.values` and a numeric sort are the only safe
 * way through it.
 */

import { OUTCOMES, isLive, outcomeOf, type OutcomeId } from '../run/defaults';
import type { PhaseRecord, RunResolution, RunState } from '@/lib/api';

export { OUTCOMES, type OutcomeId };

export interface RunRow {
  id: string;
  slug: string;
  status: string;
  outcome: OutcomeId;
  live: boolean;

  activePhase: number | null;
  /** Every phase this run touched, in phase order. */
  phases: PhaseRecord[];
  phasesDone: number;
  /** Retries across the whole run — attempts beyond the first. */
  retries: number;

  spentUsd: number;
  budgetUsd: number | null;
  /** 0–1, clamped for drawing. Null when the run has no budget to be a fraction of. */
  spendFraction: number | null;
  overBudget: boolean;

  /** Wall-clock the phases actually ran for, freezes already subtracted. */
  workedMs: number | null;
  createdAt: number;
  updatedAt: number;

  model: string;
  effort?: string;
  autonomy: string;
  /** Absent on the wire means `guarded`, never "unknown". */
  profile: string;
  failures: number;
  maxFailures: number;

  /** Why this run is where it is. Never empty. */
  reason: string;
  /**
   * Set once this run stopped asking for a person — by the board overtaking it
   * or by someone dismissing it. The fleet is the one page that still shows
   * resolved runs, in full: the dashboard drops them, and nothing deletes them.
   */
  resolution: RunResolution | null;
}

/** Has this stopped run stopped demanding attention? */
export function isResolved(run: RunState): boolean {
  return Boolean(run.resolved);
}

/** The phases of a run, in phase order. */
export function phasesOf(run: RunState): PhaseRecord[] {
  return Object.values(run.phases ?? {}).sort((a, b) => a.phase - b.phase);
}

/**
 * Why a run is where it is, in one sentence.
 *
 * The runner already writes this down — `halt.reason` when it stopped on
 * something that must not be automated past, `finishedReason` in the words the
 * operator needs — and the old table showed neither. Everything below those two
 * is derived from state the run is carrying anyway, because a row that says only
 * `interrupted` has told you the least useful true thing about itself.
 */
export function stopReason(run: RunState): string {
  if (run.halt?.reason) return run.halt.reason;
  if (run.finishedReason) return run.finishedReason;

  if (run.freeze) {
    const where = run.freeze.phase != null ? `phase ${run.freeze.phase}` : 'mid-phase';
    return `frozen at ${where} by ${run.freeze.by}`;
  }
  if (run.pause) {
    const where = run.pause.afterPhase != null ? ` after phase ${run.pause.afterPhase}` : '';
    return run.status === 'paused'
      ? `paused${where} by ${run.pause.by}`
      : `pausing${where}, asked by ${run.pause.by}`;
  }
  if (run.waitUntil) return `waiting for the usage window until ${run.waitUntil}`;

  switch (run.status) {
    case 'running':
      return run.activePhase != null ? `phase ${run.activePhase} is running` : 'starting';
    case 'stopping':
      return 'winding the session down';
    case 'parked':
      return 'every remaining phase needs a person';
    case 'finished':
      return 'nothing left to do on this plan';
    case 'interrupted':
      return 'nothing is driving it, and nothing recorded why';
    default:
      return run.status;
  }
}

export function toRows(runs: readonly RunState[]): RunRow[] {
  return runs.map((run) => {
    const phases = phasesOf(run);
    const worked = phases.reduce((sum, p) => sum + (p.durationMs ?? 0), 0);
    const budget = run.runBudgetUsd ?? null;
    const spent = run.spentUsd ?? 0;

    return {
      id: run.id,
      slug: run.slug,
      status: run.status,
      outcome: outcomeOf(run.status),
      live: isLive(run.status),

      activePhase: run.activePhase ?? null,
      phases,
      phasesDone: phases.filter((p) => p.status === 'done').length,
      retries: phases.reduce((sum, p) => sum + Math.max(0, (p.attempts ?? 1) - 1), 0),

      spentUsd: spent,
      budgetUsd: budget,
      // Clamped here rather than in the meter: `LoadMeter` draws the fraction it
      // is given, and 140% of a budget would draw a bar past its own track.
      spendFraction: budget ? Math.min(1, spent / budget) : null,
      overBudget: Boolean(budget) && spent > budget!,

      workedMs: worked || null,
      createdAt: Date.parse(run.createdAt) || 0,
      updatedAt: Date.parse(run.updatedAt) || 0,

      model: run.model,
      effort: run.effort,
      autonomy: run.autonomy,
      profile: run.permissionProfile ?? 'guarded',
      failures: run.consecutiveFailures ?? 0,
      maxFailures: run.maxConsecutiveFailures ?? 0,

      reason: stopReason(run),
      resolution: run.resolved ?? null,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

export const SORTS = [
  { id: 'updated', label: 'Latest', hint: 'most recent first' },
  { id: 'cost', label: 'Cost', hint: 'most expensive first' },
  { id: 'worked', label: 'Longest', hint: 'most time on task' },
  { id: 'plan', label: 'Plan', hint: 'grouped by name' },
] as const;

export type SortId = (typeof SORTS)[number]['id'];

export const isSortId = (value: string): value is SortId => SORTS.some((s) => s.id === value);

const byRecency = (a: RunRow, b: RunRow) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

const COMPARE: Record<SortId, (a: RunRow, b: RunRow) => number> = {
  updated: byRecency,
  cost: (a, b) => b.spentUsd - a.spentUsd || byRecency(a, b),
  worked: (a, b) => (b.workedMs ?? 0) - (a.workedMs ?? 0) || byRecency(a, b),
  plan: (a, b) => a.slug.localeCompare(b.slug) || byRecency(a, b),
};

/**
 * Order the fleet.
 *
 * A live run is pinned to the top of every order. Whatever you sorted by, the
 * thing currently spending money on your behalf is the row you came to see, and
 * an ordering that buries it under two hundred finished runs is an ordering that
 * answers the wrong question.
 */
export function sortRows(rows: readonly RunRow[], by: SortId): RunRow[] {
  const compare = COMPARE[by] ?? COMPARE.updated;
  return [...rows].sort((a, b) => Number(b.live) - Number(a.live) || compare(a, b));
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

export interface Filters {
  /** Free text over the plan slug and the run id. */
  query: string;
  /** One outcome, or every outcome. */
  outcome: string;
  /** One plan, or every plan. */
  plan: string;
}

/**
 * Everything, to start with.
 *
 * Deliberately not "hide finished": the fleet's default reading is the whole
 * record. A page that opened already filtered would make a run somebody is
 * looking for appear to have never happened.
 */
export const NO_FILTERS: Filters = { query: '', outcome: '', plan: '' };

export function applyFilters(rows: readonly RunRow[], filters: Filters): RunRow[] {
  const words = filters.query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (filters.outcome && row.outcome !== filters.outcome) return false;
    if (filters.plan && row.slug !== filters.plan) return false;
    if (!words.length) return true;
    const haystack = `${row.slug} ${row.id}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** How many runs each outcome holds — the filter chips' own counts. */
export function outcomeCounts(rows: readonly RunRow[]): Record<OutcomeId, number> {
  const counts = { live: 0, attention: 0, halted: 0, finished: 0, interrupted: 0 };
  for (const row of rows) counts[row.outcome]++;
  return counts;
}

/** Every plan the fleet has ever run, busiest first. */
export function planOptions(rows: readonly RunRow[]): { slug: string; runs: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([slug, runs]) => ({ slug, runs }));
}

/* ------------------------------------------------------------------ *
 * Grouping and totals
 * ------------------------------------------------------------------ */

export interface Group {
  key: string;
  rows: RunRow[];
}

/** Rows keep the order the sort gave them; grouping only says where headings fall. */
export function groupRows(rows: readonly RunRow[], grouped: boolean): Group[] {
  if (!grouped) return [{ key: '', rows: [...rows] }];
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const list = groups.get(row.slug);
    if (list) list.push(row);
    else groups.set(row.slug, [row]);
  }
  return [...groups].map(([key, list]) => ({ key, rows: list }));
}

/**
 * What the visible fleet adds up to.
 *
 * `spent` is the sum across what is on screen, not across everything the
 * autopilot has ever done — a total that ignored the filter would sit above a
 * list it does not describe.
 */
export function fleetTotals(rows: readonly RunRow[]) {
  let live = 0;
  let attention = 0;
  let spent = 0;
  let worked = 0;
  for (const row of rows) {
    if (row.outcome === 'live') live++;
    if (row.outcome === 'attention') attention++;
    spent += row.spentUsd;
    worked += row.workedMs ?? 0;
  }
  return { shown: rows.length, live, attention, spent, worked };
}
