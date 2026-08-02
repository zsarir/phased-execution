/**
 * Statistics and health analysis across one source directory.
 *
 * Every number here is derived from files on disk plus the engine's own
 * classification — nothing is entered by hand, and nothing overrides what
 * `phase-graph.sh` says about state.
 */

import type { PlanRecord } from '../store.ts';
import type { Board, QaMode } from '../engine.ts';
import type { PhaseSize } from '../parse/plan.ts';
import {
  indexGraph, layerGraph, unblockValue, weightOf, resolveBudget, criticalPath, remainingWork,
  type Sizing,
} from './graph.ts';

export type PlanContext = { record: PlanRecord; board: Board; qaMode: QaMode };

export type ReadyItem = {
  slug: string;
  planTitle: string;
  phase: number;
  title: string;
  size: PhaseSize;
  weight: number;
  gated: boolean;
  unblocks: number;
  lockedBy?: string;
  lockExpired?: boolean;
  repos: string;
  activity: number;
};

export type HealthIssue = {
  slug: string;
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  phase?: number;
};

export type PlanStats = {
  slug: string;
  title: string;
  kind: PlanRecord['kind'];
  status?: string;
  created?: string;
  activity: number;
  phases: number;
  declaredPhases?: number;
  done: number;
  ready: number[];
  waiting: number;
  inProgress: number[];
  stuck: number[];
  percent: number;
  remainingWeight: number;
  remainingSessions: number;
  criticalPath: number[];
  criticalWeight: number;
  minimumSessions: number;
  bottleneck?: { phase: number; blocks: number };
  nextBest?: { phase: number; unblocks: number };
  budget: number;
  targetModel?: string;
  branch?: string;
  skills: string[];
  qaMode: QaMode['mode'];
  qaFailures: number[];
  locks: { phase: number; owner: string; expired: boolean; leaseUntil?: number }[];
  repos: string[];
  handoffCount: number;
  lastCompleted?: string;
  /** Days between the first and last recorded phase completion. */
  spanDays?: number;
  medianGapDays?: number;
  issues: HealthIssue[];
};

export type Portfolio = {
  generatedAt: number;
  totals: {
    plans: number;
    documents: number;
    orphans: number;
    phases: number;
    done: number;
    ready: number;
    waiting: number;
    inProgress: number;
    stuck: number;
    percent: number;
    remainingWeight: number;
    remainingSessions: number;
  };
  byStatus: { status: string; count: number }[];
  readyQueue: ReadyItem[];
  activeLocks: { slug: string; phase: number; owner: string; expired: boolean; leaseUntil?: number }[];
  qaModes: { mode: string; count: number }[];
  qaFailures: { slug: string; phase: number }[];
  issues: HealthIssue[];
  velocity: { week: string; count: number }[];
  calendar: { date: string; count: number }[];
  medianCycleDays?: number;
  sizeMix: { size: PhaseSize; count: number }[];
  repos: { repo: string; count: number }[];
  skills: { skill: string; count: number }[];
  models: { model: string; count: number }[];
  phaseCounts: { phases: number; plans: number }[];
  stalled: { slug: string; days: number; ready: number[] }[];
  busiest: { slug: string; completions: number }[];
};

const DAY = 86_400_000;

export function planStats(ctx: PlanContext, sizing: Sizing): PlanStats {
  const { record, board, qaMode } = ctx;
  const plan = record.plan;
  const rows = plan?.graph ?? [];
  const sizes = new Map<number, PhaseSize>(rows.map((r) => [r.phase, plan?.phases[r.phase]?.size ?? 'M']));
  const budget = resolveBudget(plan?.sessionBudget.targetModel, sizing);
  const index = indexGraph(rows);

  const critical = criticalPath(index, board, sizes, sizing, budget);
  const remaining = remainingWork(rows, board, sizes, sizing, budget);

  const bottleneck = rows
    .filter((r) => board.states[r.phase] !== 'done')
    .map((r) => ({ phase: r.phase, blocks: unblockValue(index, r.phase, board) }))
    .sort((a, b) => b.blocks - a.blocks || a.phase - b.phase)[0];

  const nextBest = board.ready
    .map((phase) => ({ phase, unblocks: unblockValue(index, phase, board), critical: critical.phases.includes(phase) }))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || b.unblocks - a.unblocks || a.phase - b.phase)[0];

  const completions = record.handoffs
    .filter((h) => h.status === 'complete' && h.completed)
    .map((h) => Date.parse(h.completed!))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < completions.length; i++) gaps.push((completions[i] - completions[i - 1]) / DAY);

  const repos = [...new Set(rows.flatMap((r) => splitRepos(r.repos)))].sort();

  return {
    slug: record.slug,
    title: plan?.title ?? record.slug,
    kind: record.kind,
    status: normalisePlanStatus(plan?.status),
    created: plan?.created,
    activity: record.activity,
    phases: rows.length,
    declaredPhases: plan?.declaredPhases,
    done: board.done.length,
    ready: board.ready,
    waiting: board.waiting.length,
    inProgress: board.inProgress,
    stuck: board.stuck,
    percent: rows.length ? Math.round((board.done.length / rows.length) * 100) : 0,
    remainingWeight: remaining.weight,
    remainingSessions: remaining.sessions,
    criticalPath: critical.phases,
    criticalWeight: critical.weight,
    minimumSessions: critical.sessions,
    bottleneck: bottleneck && bottleneck.blocks > 0 ? bottleneck : undefined,
    nextBest: nextBest ? { phase: nextBest.phase, unblocks: nextBest.unblocks } : undefined,
    budget,
    targetModel: plan?.sessionBudget.targetModel,
    branch: plan?.sessionBudget.branch,
    skills: plan?.sessionBudget.skills ?? [],
    qaMode: qaMode.mode,
    qaFailures: record.qa.filter((q) => q.result === 'fail').map((q) => q.phase),
    locks: record.locks.map((l) => ({ phase: l.phase, owner: l.owner, expired: l.expired, leaseUntil: l.leaseUntil })),
    repos,
    handoffCount: record.handoffs.length,
    lastCompleted: completions.length ? new Date(completions.at(-1)!).toISOString().slice(0, 10) : undefined,
    spanDays: completions.length > 1 ? Math.round((completions.at(-1)! - completions[0]) / DAY) : undefined,
    medianGapDays: gaps.length ? round1(median(gaps)) : undefined,
    issues: healthIssues(ctx),
  };
}

/** Strip the template legend that trails many status values. */
export function normalisePlanStatus(raw?: string): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(/[—-]{1,2}\s/)[0].trim().toLowerCase();
  const known = ['active', 'complete', 'abandoned', 'superseded', 'backlog', 'approved', 'proposal'];
  return known.find((k) => first.startsWith(k)) ?? first.split(/\s+/)[0] ?? undefined;
}

function splitRepos(cell: string): string[] {
  // Parenthetical asides come off first — `api-server (+web snapshot)` is one
  // repo, and splitting on the `+` inside would invent two.
  return cell
    .replace(/\([^)]*\)?/g, ' ')
    .split(/[,+/]|\band\b/)
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9-]+$/, ''))
    .filter((s) => s && s !== '—' && s !== '-' && s.length > 1 && s.length < 32);
}

export function healthIssues(ctx: PlanContext): HealthIssue[] {
  const { record, board } = ctx;
  const plan = record.plan;
  const issues: HealthIssue[] = [];
  const add = (severity: HealthIssue['severity'], kind: string, message: string, phase?: number) =>
    issues.push({ slug: record.slug, severity, kind, message, phase });

  if (record.kind === 'orphan-handoffs') {
    add('warning', 'orphan', 'Handoff folder with no plan file in docs/plans');
    return issues;
  }
  if (!plan?.phased) return issues;

  if (board.error) add('error', 'engine', `Engine could not read the graph: ${board.error}`);

  if (plan.declaredPhases && plan.declaredPhases !== plan.graph.length) {
    add('error', 'phase-count',
      `Front matter says ${plan.declaredPhases} phases but the graph table parses ${plan.graph.length} rows`);
  }

  const known = new Set(plan.graph.map((r) => r.phase));
  for (const row of plan.graph) {
    for (const dep of row.dependsOn) {
      if (!known.has(dep)) add('error', 'undefined-dep', `Phase ${row.phase} depends on ${dep}, which is not in the table`, row.phase);
    }
  }

  for (const phase of board.done) {
    if (!record.handoffs.some((h) => h.phase === phase)) {
      add('warning', 'missing-handoff', `Phase ${phase} counts as done but has no handoff file`, phase);
    }
  }

  for (const handoff of record.handoffs) {
    const row = plan.graph.find((r) => r.phase === handoff.phase);
    if (row && handoff.dependsOn.length && !sameSet(handoff.dependsOn, row.dependsOn)) {
      add('warning', 'depends-drift',
        `Phase ${handoff.phase} handoff lists depends_on [${handoff.dependsOn}] but the graph says [${row.dependsOn}]`,
        handoff.phase);
    }
    if (handoff.status === 'in-progress' || handoff.status === 'blocked') {
      const age = Math.round((Date.now() - handoff.mtime) / DAY);
      add(handoff.status === 'blocked' ? 'error' : 'warning', 'stale-handoff',
        `Phase ${handoff.phase} handoff is ${handoff.status}${age > 0 ? `, untouched ${age}d` : ''}`, handoff.phase);
    }
    if (record.index.length && !record.index.some((r) => r.phase === handoff.phase)) {
      add('info', 'index-drift', `Phase ${handoff.phase} is missing from INDEX.md`, handoff.phase);
    }
  }

  for (const row of record.qa) {
    if (row.result === 'fail') add('error', 'qa-fail', `Phase ${row.phase} QA recorded fail — dependents stay blocked`, row.phase);
  }

  for (const lock of record.locks) {
    if (lock.expired) add('info', 'stale-lock', `Phase ${lock.phase} lock by ${lock.owner} has expired`, lock.phase);
  }

  if (plan.phased && !record.handoffDir && board.done.length > 0) {
    add('warning', 'no-handoff-dir', 'Plan reports progress but has no handoff folder');
  }

  return issues;
}

export function portfolio(contexts: PlanContext[], sizing: Sizing): Portfolio {
  const stats = contexts.map((ctx) => ({ ctx, stats: planStats(ctx, sizing) }));
  const plans = stats.filter((s) => s.stats.kind === 'plan');

  const totals = {
    plans: plans.length,
    documents: stats.filter((s) => s.stats.kind === 'document').length,
    orphans: stats.filter((s) => s.stats.kind === 'orphan-handoffs').length,
    phases: sum(plans.map((s) => s.stats.phases)),
    done: sum(plans.map((s) => s.stats.done)),
    ready: sum(plans.map((s) => s.stats.ready.length)),
    waiting: sum(plans.map((s) => s.stats.waiting)),
    inProgress: sum(plans.map((s) => s.stats.inProgress.length)),
    stuck: sum(plans.map((s) => s.stats.stuck.length)),
    percent: 0,
    remainingWeight: sum(plans.filter((s) => s.stats.status !== 'complete').map((s) => s.stats.remainingWeight)),
    remainingSessions: sum(plans.filter((s) => s.stats.status !== 'complete').map((s) => s.stats.remainingSessions)),
  };
  totals.percent = totals.phases ? Math.round((totals.done / totals.phases) * 100) : 0;

  const readyQueue: ReadyItem[] = [];
  for (const { ctx, stats: s } of plans) {
    const plan = ctx.record.plan!;
    const index = indexGraph(plan.graph);
    for (const phase of s.ready) {
      const row = plan.graph.find((r) => r.phase === phase);
      const detail = plan.phases[phase];
      const lock = ctx.record.locks.find((l) => l.phase === phase);
      readyQueue.push({
        slug: ctx.record.slug,
        planTitle: plan.title,
        phase,
        title: detail?.title || row?.title || `Phase ${phase}`,
        size: detail?.size ?? 'M',
        weight: weightOf(detail?.size, sizing),
        gated: detail?.gated ?? false,
        unblocks: unblockValue(index, phase, ctx.board),
        lockedBy: lock?.owner,
        lockExpired: lock?.expired,
        repos: row?.repos ?? '',
        activity: ctx.record.activity,
      });
    }
  }
  readyQueue.sort((a, b) => b.unblocks - a.unblocks || b.activity - a.activity);

  const completions: { date: string; slug: string }[] = [];
  for (const { ctx } of stats) {
    for (const handoff of ctx.record.handoffs) {
      if (handoff.status !== 'complete') continue;
      const date = handoff.completed ?? new Date(handoff.mtime).toISOString().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) completions.push({ date, slug: ctx.record.slug });
    }
  }

  const gaps: number[] = [];
  for (const { ctx } of plans) {
    const times = ctx.record.handoffs
      .filter((h) => h.status === 'complete' && h.completed)
      .map((h) => Date.parse(h.completed!))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY);
  }

  const now = Date.now();
  const stalled = plans
    .filter((s) => s.stats.ready.length > 0 && s.stats.status !== 'complete')
    .map((s) => ({ slug: s.stats.slug, days: Math.round((now - s.stats.activity) / DAY), ready: s.stats.ready }))
    .filter((s) => s.days >= 7)
    .sort((a, b) => b.days - a.days);

  return {
    generatedAt: now,
    totals,
    byStatus: tally(stats.map((s) => s.stats.status ?? 'unset')).map(([status, count]) => ({ status, count })),
    readyQueue,
    activeLocks: stats.flatMap(({ ctx }) => ctx.record.locks.map((l) => ({
      slug: ctx.record.slug, phase: l.phase, owner: l.owner, expired: l.expired, leaseUntil: l.leaseUntil,
    }))).sort((a, b) => Number(a.expired) - Number(b.expired) || (b.leaseUntil ?? 0) - (a.leaseUntil ?? 0)),
    qaModes: tally(plans.map((s) => s.stats.qaMode)).map(([mode, count]) => ({ mode, count })),
    qaFailures: stats.flatMap(({ ctx }) => ctx.record.qa.filter((q) => q.result === 'fail')
      .map((q) => ({ slug: ctx.record.slug, phase: q.phase }))),
    issues: stats.flatMap((s) => s.stats.issues),
    velocity: weeklyBuckets(completions.map((c) => c.date), 26),
    calendar: tally(completions.map((c) => c.date)).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    medianCycleDays: gaps.length ? round1(median(gaps)) : undefined,
    sizeMix: (['S', 'M', 'L'] as PhaseSize[]).map((size) => ({
      size,
      count: plans.reduce((n, s) => n + Object.values(s.ctx.record.plan?.phases ?? {}).filter((p) => p.size === size).length, 0),
    })),
    repos: tally(plans.flatMap((s) => s.stats.repos)).slice(0, 14).map(([repo, count]) => ({ repo, count })),
    skills: tally(stats.flatMap(({ ctx }) => ctx.record.handoffs.flatMap((h) => h.skillsUsed)))
      .slice(0, 14).map(([skill, count]) => ({ skill, count })),
    models: tally(plans.map((s) => s.stats.targetModel ?? 'unspecified')).map(([model, count]) => ({ model, count })),
    phaseCounts: tally(plans.map((s) => String(s.stats.phases)))
      .map(([phases, plansCount]) => ({ phases: Number(phases), plans: plansCount }))
      .sort((a, b) => a.phases - b.phases),
    stalled,
    busiest: tally(completions.map((c) => c.slug)).slice(0, 10).map(([slug, completionCount]) => ({ slug, completions: completionCount })),
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function sum(list: number[]): number { return list.reduce((a, b) => a + b, 0); }

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function tally(list: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sameSet(a: number[], b: number[]): boolean {
  const left = [...new Set(a)].sort((x, y) => x - y).join(',');
  const right = [...new Set(b)].sort((x, y) => x - y).join(',');
  return left === right;
}

/** ISO week key (`2026-W31`) buckets for the last `weeks` weeks, oldest first. */
export function weeklyBuckets(dates: string[], weeks: number): { week: string; count: number }[] {
  const counts = new Map<string, number>();
  const now = new Date();
  const keys: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 7 * DAY);
    const key = isoWeek(d);
    keys.push(key);
    counts.set(key, 0);
  }
  for (const date of dates) {
    const key = isoWeek(new Date(`${date}T12:00:00Z`));
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  return keys.map((week) => ({ week, count: counts.get(week) ?? 0 }));
}

export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export { layerGraph };
