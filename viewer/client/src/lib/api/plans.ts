/**
 * Plans, phases, handoffs and gates — the plan surface — and the guarded write
 * verbs that act on it.
 */

import { request, post, q } from './client';
import type { EtaEstimate, PhaseEta } from './runs';

export interface PlanSummary {
  slug: string;
  title?: string;
  kind?: string;
  phases: number;
  ready: unknown[];
  /** Named explicitly — the index signature below types them `unknown`, and
   * closure is read by the nav counts, which cannot cast their way to it. */
  status?: string;
  closed?: boolean;
  [key: string]: unknown;
}

/* ---------------- the plan surface ----------------
 * These mirror `server/service.ts` (`PlanDetail`, `PhaseView`, `RouteView`) and
 * `server/analysis/stats.ts` (`PlanStats`). They are hand-written rather than
 * generated because the server is frozen for this rewrite: a shape that drifts
 * is a server change, and a server change is a decision, not an accident.
 *
 * `state` and `status` stay `string`. The engine owns that vocabulary, and
 * narrowing it here would turn an engine that learned a new word into a type
 * error in the client instead of a chip that paints grey. `asPhaseState()`
 * does the narrowing at the point of paint. */

export interface HealthIssue {
  slug: string;
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  phase?: number;
}

export interface PhaseLock {
  phase?: number;
  owner: string;
  expired: boolean;
  leaseUntil?: number;
  host?: string;
  /** When the claim was taken — the other half of "how long has this been held?". */
  claimedAt?: number;
  /**
   * What the claim covers. Absent means the claim was taken without one, which
   * the engine treats as colliding with everything — so an absent scope is not
   * "no scope", it is the widest possible one.
   */
  scope?: string[];
}

export interface PlanSummaryFull {
  slug: string;
  title: string;
  kind: string;
  status?: string;
  /**
   * The plan's status is terminal, so it reports no work and no warnings.
   * Optional because an older server does not send it — read it through
   * `lib/closure.ts`'s `isClosed()`, never directly, so the status fallback
   * applies. ⚠️ `ready`, `locks`, `qaFailures` and `stuck` stay populated on a
   * closed plan by design; gating them is the client's job.
   */
  closed?: boolean;
  /** The date `close-plan.sh` recorded, when it was closed through the verb. */
  closedOn?: string;
  closedReason?: string;
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
  /** `**MCP servers (every session):**` — attached to every phase of this plan. */
  mcpServers: string[];
  qaMode: string;
  qaFailures: number[];
  locks: PhaseLock[];
  repos: string[];
  handoffCount: number;
  lastCompleted?: string;
  spanDays?: number;
  medianGapDays?: number;
  issues: HealthIssue[];
  engineError?: string;
  issueCounts: { error: number; warning: number; info: number };
  hasHandoffs: boolean;
  /** How long this plan has left. Absent only when nothing is left. */
  eta?: EtaEstimate;
}

export interface PhaseRow {
  phase: number;
  title: string;
  dependsOn: number[];
  parallelSafe: string;
  repos: string;
  exitCriteria: string;
}

export interface PhaseAnalysis {
  phase: number;
  state: string;
  size: string;
  weight: number;
  dependsOn: number[];
  dependents: number[];
  transitiveDependents: number[];
  unblocks: number;
  onCriticalPath: boolean;
}

export interface PhaseHandoffRef {
  file: string;
  status: string;
  completed?: string;
  title: string;
  outstanding?: string;
  skillsUsed: string[];
  prompts: number;
}

export interface PhaseView {
  phase: number;
  title: string;
  state: string;
  size: string;
  weight: number;
  gated: boolean;
  gates?: string;
  gateCheck?: string;
  /** The gate's category — who can clear it. Mirrors `--gate-kind`. Optional
   * so a freshly built client keeps working against a not-yet-restarted older
   * server; absent reads as `none`. */
  gateKind?: 'human' | 'ai' | 'auto' | 'none';
  model?: string;
  effort?: string;
  goal?: string;
  readFirst?: string;
  files?: string;
  steps?: string;
  exitCriteria?: string;
  verification?: string;
  /** `**MCP:**` — registry ids this phase needs, on top of the plan-wide line. */
  mcpServers?: string[];
  handoffMustRecord?: string;
  bullets: { label: string; body: string }[];
  row?: PhaseRow;
  analysis?: PhaseAnalysis;
  qa?: { result: string; report?: string };
  lock?: PhaseLock;
  handoff?: PhaseHandoffRef;
}

export interface RouteNode {
  phase: number;
  layer: number;
  row: number;
  state: string;
  size: string;
  gated: boolean;
  title: string;
  /** Claimed, and whether the claim still holds. Absent on an older server. */
  locked?: 'live' | 'stale';
}

export interface RouteView {
  nodes: RouteNode[];
  edges: { from: number; to: number }[];
  layers: number;
  rows: number;
}

export interface BatchGroup {
  index: number;
  kind: string;
  /** Already formatted by the engine — `180K`, not a token count. */
  weight: string;
  phases: number[];
  gated: boolean;
  note?: string;
}

export interface SessionPlanView {
  excluded?: number[];
  groups: BatchGroup[];
  raw: string;
  budget?: string;
}

export interface LintResult {
  ok: boolean;
  issues: string[];
  summary: string;
  timedOut?: boolean;
}

export interface SessionBudgetView {
  raw: string;
  targetModel?: string;
  budget?: string;
  branch?: string;
  skills: string[];
  /** `**MCP servers (every session):**` — attached to every phase of this plan. */
  mcpServers: string[];
  qaGate?: 'on' | 'off';
}

export interface PlanFile {
  slug: string;
  title: string;
  provenance?: string;
  context?: string;
  architecture?: string;
  endToEnd?: string;
  sessionBudget: SessionBudgetView;
  graph: PhaseRow[];
  callouts: string[];
  sections: { title: string; body: string }[];
  path?: string;
}

export interface HandoffRow {
  phase: number;
  file: string;
  title: string;
  status: string;
  completed?: string;
  bytes: number;
  mtime: number;
  prompts: number;
  skillsUsed: string[];
}

export interface PlanDetail {
  summary: PlanSummaryFull;
  plan: PlanFile | null;
  phases: PhaseView[];
  route: RouteView;
  batches: SessionPlanView | null;
  boardText: string;
  lint: LintResult | null;
  handoffs: HandoffRow[];
  index: { phase: number; title: string; status: string; link?: string }[];
  /**
   * The plan's own estimate and one per phase, from a single rate reading.
   *
   * Optional because the server is whatever Node loaded at startup while the
   * client is read from disk per request — upgrading the skill under a running
   * console leaves a new UI talking to an old API (see `state.serverStale`), and
   * a required field would make that show up as a crash rather than a missing
   * line. Every read site already spells it `detail.eta?.…`.
   */
  eta?: { plan: EtaEstimate | null; perPhase: PhaseEta[] };
  qa: { phase: number; result: string; report?: string }[];
  locks: PhaseLock[];
  git: {
    sha?: string; subject?: string; author?: string; date?: string;
    relativeDate?: string; dirty?: boolean;
  };
  memory: { key: string; path: string; text: string; indexLines: string[] } | null;
}

export interface HandoffDetail {
  slug: string;
  phase: number;
  file: string;
  path: string;
  title: string;
  status: string;
  rawStatus?: string;
  completed?: string;
  nextPhase?: string;
  dependsOn: number[];
  blocks: number[];
  parallelSafe: number[];
  skillsUsed: string[];
  keyFiles: string[];
  memoryKey?: string;
  outstanding?: string;
  prompts: number;
  finalPhase?: boolean;
  body: string;
  bytes: number;
  mtime: number;
}

/** `phase-graph.sh --gate-status` for one phase. */
export interface GateStatus {
  kind: string;
  clear: boolean;
  detail: string;
}

/* ---------------- the guarded write verbs ----------------
 * Every one of them shells out to a phased-execution script, and every one is
 * refused unless the server was started with `--allow-writes`. `dry` returns
 * the exact invocation without running it — the preview the dialog shows. */

export interface WriteRequest {
  action: string;
  slug?: string;
  phase?: number;
  [field: string]: unknown;
}

/** What became of one release attempt. A bulk release returns one per lock. */
export interface LockRelease {
  slug: string;
  phase: number;
  ok: boolean;
  /** Read from the lock file; null when there was no lock to read. */
  owner: string | null;
  detail?: string;
}

export interface WriteResult {
  /** Absent on a dry run — a preview neither succeeded nor failed. */
  ok?: boolean;
  dryRun?: boolean;
  /** The literal command line. Present on a dry run and a real one. */
  command?: string;
  description?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** The plan surface's fetchers — merged into `api` by `./index`. */
export const plansApi = {
  plans: () => request<PlanSummary[]>('/api/plans'),

  /* ---- plans ----
     The prompt endpoints answer `text/plain`; `request` already returns a
     string for a non-JSON content type, so they are typed as one. */
  plan: (slug: string, model?: string) =>
    request<PlanDetail>(`/api/plans/${q(slug)}${model ? `?model=${q(model)}` : ''}`),
  planRaw: (slug: string) => request<string>(`/api/plans/${q(slug)}/raw`),
  handoff: (slug: string, phase: number | string) =>
    request<HandoffDetail>(`/api/plans/${q(slug)}/handoff/${phase}`),
  prompt: (slug: string, phase: number | string) => request<string>(`/api/plans/${q(slug)}/prompt/${phase}`),
  nextPrompt: (slug: string, phase?: number | string) =>
    request<string>(`/api/plans/${q(slug)}/next-prompt/${phase ?? 'none'}`),
  qaPrompt: (slug: string, phase: number | string) => request<string>(`/api/plans/${q(slug)}/qa-prompt/${phase}`),
  boardText: (slug: string) => request<string>(`/api/plans/${q(slug)}/board`),
  memoryBlock: (slug: string) => request<string>(`/api/plans/${q(slug)}/memory-block`),
  gate: (slug: string, phase: number | string) => request<GateStatus>(`/api/plans/${q(slug)}/gate/${phase}`),
  approveGate: (slug: string, phase: number, body: { approve: boolean; by?: string; note?: string; continueRun?: boolean }) =>
    post<{ ok: boolean; gate: GateStatus | null; detail: string; resumed?: boolean }>(
      `/api/plans/${q(slug)}/gate/${phase}`, body,
    ),
  sessionPlan: (slug: string, model?: string) =>
    request<unknown>(`/api/plans/${q(slug)}/session-plan${model ? `?model=${q(model)}` : ''}`),
  write: (body: WriteRequest, dry?: boolean) => post<WriteResult>(`/api/write${dry ? '?dry=1' : ''}`, body),

  /* ---- stale claims ----
     The owner comes off the lock file on the server, so nothing here asks a
     person to retype `someone@example.com/opus-p2` from a card that never
     showed it. A live lease answers 409 and stays claimed. */
  /* `force` takes a claim whose lease is still running. That is the operator
     deciding another session is gone, and it is the only way past a live claim
     now that one blocks a run — so it is a separate argument, never a default,
     and every caller that passes it asks for confirmation first. */
  releaseLock: (slug: string, phase: number, force = false) =>
    post<LockRelease>('/api/locks/release', force ? { slug, phase, force } : { slug, phase }),
  releaseExpiredLocks: () =>
    post<{ results: LockRelease[]; released: number }>('/api/locks/release', { expired: true }),

  /**
   * Turn QA on for a plan that has it off.
   *
   * Write-class rather than agent-class: it creates `test-status.md` and
   * backfills the already-complete phases as waived, which is a change to the
   * repository whether or not a review is ever minted.
   */
  qaActivate: (slug: string, phase: number) =>
    post<{ ok: boolean; mode: string; detail: string }>(`/api/plans/${q(slug)}/qa-mode`, { phase }),
};
