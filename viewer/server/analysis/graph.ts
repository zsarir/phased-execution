/**
 * Graph analysis the scripts don't provide: layering for the route map,
 * transitive dependents, unblock value, critical path and weight arithmetic.
 *
 * Status never comes from here — it comes from the engine. This module only
 * reasons about the shape of the graph the plan declares.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PhaseRow, PhaseSize } from '../parse/plan.ts';
import type { Board, PhaseState } from '../engine.ts';

export type Sizing = {
  S: number; M: number; L: number;
  budgetHaiku: number; budgetBig: number; budgetDefault: number;
};

const FALLBACK: Sizing = {
  S: 15_000, M: 40_000, L: 90_000,
  budgetHaiku: 40_000, budgetBig: 200_000, budgetDefault: 40_000,
};

/** Read the canonical constants from the skill's `scripts/sizing.env` (F5 SSOT). */
export function loadSizing(scriptsDir: string): Sizing {
  try {
    const text = readFileSync(join(scriptsDir, 'sizing.env'), 'utf8');
    const values: Record<string, number> = {};
    for (const line of text.split('\n')) {
      const m = /^([A-Z_]+)=(\d+)/.exec(line.trim());
      if (m) values[m[1]] = Number(m[2]);
    }
    return {
      S: values.SIZE_S ?? FALLBACK.S,
      M: values.SIZE_M ?? FALLBACK.M,
      L: values.SIZE_L ?? FALLBACK.L,
      budgetHaiku: values.BUDGET_HAIKU ?? FALLBACK.budgetHaiku,
      budgetBig: values.BUDGET_BIG ?? FALLBACK.budgetBig,
      budgetDefault: values.BUDGET_DEFAULT ?? FALLBACK.budgetDefault,
    };
  } catch {
    return { ...FALLBACK };
  }
}

export function weightOf(size: PhaseSize | undefined, sizing: Sizing): number {
  return size === 'S' ? sizing.S : size === 'L' ? sizing.L : sizing.M;
}

/** Mirrors the engine's `resolve_budget`: a number wins, else the model class. */
export function resolveBudget(model: string | undefined, sizing: Sizing): number {
  const alias = (model ?? '').toLowerCase().trim();
  if (!alias) return sizing.budgetDefault;
  if (/^\d+$/.test(alias)) return Number(alias);
  if (alias.includes('haiku')) return sizing.budgetHaiku;
  if (/opus|sonnet|fable|mythos/.test(alias)) return sizing.budgetBig;
  return sizing.budgetDefault;
}

export type GraphIndex = {
  phases: number[];
  deps: Map<number, number[]>;
  dependents: Map<number, number[]>;
};

export function indexGraph(rows: PhaseRow[]): GraphIndex {
  const phases = rows.map((r) => r.phase);
  const known = new Set(phases);
  const deps = new Map<number, number[]>();
  const dependents = new Map<number, number[]>();
  for (const p of phases) { deps.set(p, []); dependents.set(p, []); }

  for (const row of rows) {
    for (const dep of row.dependsOn) {
      if (!known.has(dep)) continue;            // undefined dependency — lint's business
      deps.get(row.phase)!.push(dep);
      dependents.get(dep)!.push(row.phase);
    }
  }
  return { phases, deps, dependents };
}

/** Everything downstream of `phase`, transitively. */
export function transitiveDependents(index: GraphIndex, phase: number): number[] {
  const seen = new Set<number>();
  const stack = [...(index.dependents.get(phase) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(index.dependents.get(next) ?? []));
  }
  return [...seen].sort((a, b) => a - b);
}

/** How much work finishing this phase releases: downstream phases not yet done. */
export function unblockValue(index: GraphIndex, phase: number, board: Board): number {
  return transitiveDependents(index, phase).filter((p) => board.states[p] !== 'done').length;
}

/**
 * Longest-path layering (column per phase) for the route map. A phase sits one
 * column right of its deepest dependency, so every edge points forward.
 */
export function layerGraph(index: GraphIndex): Map<number, number> {
  const depth = new Map<number, number>();
  const visiting = new Set<number>();

  const walk = (phase: number): number => {
    const cached = depth.get(phase);
    if (cached !== undefined) return cached;
    if (visiting.has(phase)) return 0;           // cycle — lint reports it; don't hang
    visiting.add(phase);
    const deps = index.deps.get(phase) ?? [];
    const value = deps.length ? Math.max(...deps.map(walk)) + 1 : 0;
    visiting.delete(phase);
    depth.set(phase, value);
    return value;
  };

  for (const phase of index.phases) walk(phase);
  return depth;
}

export type RouteNode = { phase: number; layer: number; row: number };

/**
 * Layered order for drawing: columns from `layerGraph`, rows ordered by the
 * mean row of each phase's dependencies (barycentre, two passes) so lines
 * cross as little as possible.
 */
export function routeLayout(index: GraphIndex): RouteNode[] {
  const layers = layerGraph(index);
  const columns = new Map<number, number[]>();
  for (const phase of index.phases) {
    const layer = layers.get(phase) ?? 0;
    if (!columns.has(layer)) columns.set(layer, []);
    columns.get(layer)!.push(phase);
  }
  for (const list of columns.values()) list.sort((a, b) => a - b);

  const rowOf = new Map<number, number>();
  for (const list of columns.values()) list.forEach((phase, i) => rowOf.set(phase, i));

  for (let pass = 0; pass < 2; pass++) {
    for (const layer of [...columns.keys()].sort((a, b) => a - b)) {
      const list = columns.get(layer)!;
      const score = new Map<number, number>();
      for (const phase of list) {
        const deps = index.deps.get(phase) ?? [];
        const rows = deps.map((d) => rowOf.get(d) ?? 0);
        score.set(phase, rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : rowOf.get(phase) ?? 0);
      }
      list.sort((a, b) => (score.get(a)! - score.get(b)!) || a - b);
      list.forEach((phase, i) => rowOf.set(phase, i));
    }
  }

  return index.phases
    .map((phase) => ({ phase, layer: layers.get(phase) ?? 0, row: rowOf.get(phase) ?? 0 }))
    .sort((a, b) => a.layer - b.layer || a.row - b.row);
}

export type CriticalPath = { phases: number[]; weight: number; sessions: number };

/**
 * The longest remaining dependency chain, weighted by phase size. Because
 * phases run one session at a time, this is the floor on how much work is left
 * no matter what order the ready phases are taken in.
 */
export function criticalPath(
  index: GraphIndex,
  board: Board,
  sizes: Map<number, PhaseSize>,
  sizing: Sizing,
  budget: number,
): CriticalPath {
  const best = new Map<number, { weight: number; path: number[] }>();

  const walk = (phase: number, seen = new Set<number>()): { weight: number; path: number[] } => {
    const cached = best.get(phase);
    if (cached) return cached;
    if (seen.has(phase)) return { weight: 0, path: [] };
    seen.add(phase);

    const own = board.states[phase] === 'done' ? 0 : weightOf(sizes.get(phase), sizing);
    let winner = { weight: own, path: board.states[phase] === 'done' ? [] : [phase] };

    for (const dependent of index.dependents.get(phase) ?? []) {
      const sub = walk(dependent, new Set(seen));
      if (own + sub.weight > winner.weight) {
        winner = { weight: own + sub.weight, path: [...(board.states[phase] === 'done' ? [] : [phase]), ...sub.path] };
      }
    }
    best.set(phase, winner);
    return winner;
  };

  let overall = { weight: 0, path: [] as number[] };
  for (const phase of index.phases) {
    const candidate = walk(phase);
    if (candidate.weight > overall.weight) overall = candidate;
  }
  return {
    phases: overall.path,
    weight: overall.weight,
    sessions: overall.weight > 0 ? Math.max(1, Math.ceil(overall.weight / budget)) : 0,
  };
}

export type PhaseAnalysis = {
  phase: number;
  state: PhaseState;
  size: PhaseSize;
  weight: number;
  dependsOn: number[];
  dependents: number[];
  transitiveDependents: number[];
  unblocks: number;
  onCriticalPath: boolean;
};

export function analysePhases(
  rows: PhaseRow[],
  board: Board,
  sizes: Map<number, PhaseSize>,
  sizing: Sizing,
  path: number[],
): PhaseAnalysis[] {
  const index = indexGraph(rows);
  const critical = new Set(path);
  return rows.map((row) => ({
    phase: row.phase,
    state: board.states[row.phase] ?? 'waiting',
    size: sizes.get(row.phase) ?? 'M',
    weight: weightOf(sizes.get(row.phase), sizing),
    dependsOn: index.deps.get(row.phase) ?? [],
    dependents: index.dependents.get(row.phase) ?? [],
    transitiveDependents: transitiveDependents(index, row.phase),
    unblocks: unblockValue(index, row.phase, board),
    onCriticalPath: critical.has(row.phase),
  }));
}

/** Remaining weight and the sessions it implies at this plan's budget. */
export function remainingWork(
  rows: PhaseRow[],
  board: Board,
  sizes: Map<number, PhaseSize>,
  sizing: Sizing,
  budget: number,
): { weight: number; sessions: number; phases: number } {
  const remaining = rows.filter((r) => board.states[r.phase] !== 'done');
  const weight = remaining.reduce((sum, r) => sum + weightOf(sizes.get(r.phase), sizing), 0);
  return { weight, phases: remaining.length, sessions: weight ? Math.max(1, Math.ceil(weight / budget)) : 0 };
}
