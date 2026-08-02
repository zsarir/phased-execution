/**
 * Run state: the checkpoint that survives a crash.
 *
 * A run is a long-lived thing — hours, many child processes, possibly a
 * console restart in the middle. Everything needed to pick it back up lives in
 * one JSON file per run, written after every transition and outside the repo
 * (`~/.local/state/phase-console/runs/…`), so a supervised plan never leaves
 * uncommitted machine state in someone's working tree.
 *
 * Writes are atomic: a half-written checkpoint read after a power cut is worse
 * than no checkpoint at all, because it looks valid.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { STATE_DIR } from '../config.ts';

export type RunStatus =
  /** The loop is driving phases. */
  | 'running'
  /** Asked to stop after the current phase. */
  | 'pausing'
  /** Stopped between phases; `start` picks up where it left off. */
  | 'paused'
  /** Sleeping until a usage window reopens (`waitUntil`). */
  | 'waiting'
  /** Every remaining phase needs a human — a gate, an approval, a decision. */
  | 'parked'
  /** Stopped on a condition that must not be automated past. */
  | 'halted'
  /** Nothing left to do on this plan. */
  | 'finished'
  /** A stop was requested; the child is being wound down. */
  | 'stopping';

export type PhaseStatus =
  | 'pending' | 'gated' | 'running' | 'verifying' | 'done'
  | 'failed' | 'interrupted' | 'skipped' | 'parked';

/** Terminal for this run: the loop will not pick these up again by itself. */
export const SETTLED: readonly PhaseStatus[] = ['done', 'skipped', 'failed', 'parked', 'interrupted'];

export type VerifyRun = {
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  /** Tail only — a full test-suite log does not belong in a checkpoint. */
  output: string;
};

export type VerifySummary = {
  ok: boolean;
  reason: string;
  ran: VerifyRun[];
  /** Commands present in the plan that the runner would not execute, and why. */
  notRun: { text: string; reason: string }[];
};

export type PhaseRecord = {
  phase: number;
  status: PhaseStatus;
  attempts: number;
  costUsd: number;
  model?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  note?: string;
  gate?: { clear: boolean; kind: string; detail: string };
  verification?: VerifySummary;
  lint?: { ok: boolean; summary: string };
};

export type Autonomy = 'halt-on-everything' | 'keep-going';

export type RunState = {
  id: string;
  slug: string;
  root: string;
  status: RunStatus;
  autonomy: Autonomy;
  /** The model each phase starts on; a limited model falls back from here. */
  model: string;
  phaseBudgetUsd: number | null;
  runBudgetUsd: number | null;
  spentUsd: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  activePhase: number | null;
  /** Set while a child is alive, so a restarted console can tell what it interrupted. */
  child: { pid: number; phase: number; sessionId: string; startedAt: string } | null;
  waitUntil: string | null;
  halt: { at: string; reason: string; phase?: number } | null;
  phases: Record<string, PhaseRecord>;
};

/* ------------------------------------------------------------------ *
 * Where a run lives
 * ------------------------------------------------------------------ */

/**
 * One directory per (source directory, plan). The hash keeps two checkouts of
 * the same repo apart; the basename keeps the path readable for a human who
 * goes looking, which they will the first time a run halts.
 */
export function runDir(root: string, slug: string): string {
  const key = `${createHash('sha256').update(root).digest('hex').slice(0, 8)}-${basename(root) || 'root'}`;
  return join(STATE_DIR, 'runs', key, slug);
}

export function runFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.json`);
}

export function journalFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.jsonl`);
}

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

export type NewRunOptions = {
  slug: string;
  root: string;
  model?: string;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  maxConsecutiveFailures?: number;
};

export function newRun(opts: NewRunOptions): RunState {
  const now = new Date().toISOString();
  return {
    id: randomUUID().slice(0, 8),
    slug: opts.slug,
    root: opts.root,
    status: 'running',
    // Halting on everything is the default on purpose: the first runs of an
    // unattended system should stop and show their work, not press on.
    autonomy: opts.autonomy ?? 'halt-on-everything',
    model: opts.model ?? 'sonnet',
    phaseBudgetUsd: opts.phaseBudgetUsd ?? null,
    runBudgetUsd: opts.runBudgetUsd ?? null,
    spentUsd: 0,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 2,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    phases: {},
  };
}

export function phaseRecord(state: RunState, phase: number): PhaseRecord {
  const key = String(phase);
  if (!state.phases[key]) {
    state.phases[key] = { phase, status: 'pending', attempts: 0, costUsd: 0 };
  }
  return state.phases[key];
}

/** Write the checkpoint atomically — rename is the only step a reader can see. */
export function saveRun(state: RunState): void {
  state.updatedAt = new Date().toISOString();
  const target = runFile(state.root, state.slug, state.id);
  mkdirSync(runDir(state.root, state.slug), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

export function loadRun(root: string, slug: string, id: string): RunState | null {
  try {
    return JSON.parse(readFileSync(runFile(root, slug, id), 'utf8')) as RunState;
  } catch {
    return null;
  }
}

/** Every run recorded for a plan, newest first. */
export function listRuns(root: string, slug: string): RunState[] {
  const dir = runDir(root, slug);
  if (!existsSync(dir)) return [];
  const runs: RunState[] = [];
  for (const name of readdirSync(dir)) {
    const id = /^run-([0-9a-f]{8})\.json$/.exec(name)?.[1];
    if (!id) continue;
    const state = loadRun(root, slug, id);
    if (state) runs.push(state);
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The run to offer when someone opens a plan: the one still in flight, else the
 * most recent. A finished run is still worth showing — it is the record of what
 * happened — but it must never be silently resumed.
 */
export function latestRun(root: string, slug: string): RunState | null {
  const runs = listRuns(root, slug);
  return runs.find((r) => r.status !== 'finished') ?? runs[0] ?? null;
}

/** Is a process with this pid still alive? Used to reconcile after a restart. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
