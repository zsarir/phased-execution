/**
 * Server access.
 *
 * There is no request cache here, unlike `web/api.js`. TanStack Query is the
 * cache now, and two caches that invalidate on different signals is how a board
 * ends up showing yesterday's state confidently. This module only knows how to
 * make a request; `queries.ts` decides when it is stale.
 */

/** Every request carries this; non-GETs additionally need a same-origin Origin,
 *  which the dev proxy rewrites (see vite.config.ts). */
const CSRF = { 'x-phase-console': '1' } as const;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly path: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { ...CSRF, ...(options.headers ?? {}) },
  });
  const type = res.headers.get('content-type') ?? '';
  const body: unknown = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = typeof body === 'string' && body
      ? body
      : (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status, path);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const q = encodeURIComponent;

/* ---------------- shapes ----------------
 * Only what the shell reads in this phase is typed. Views type their own as
 * they are ported; `unknown` is deliberate where a shape is not yet load-bearing. */

export interface ConsoleState {
  generation?: number;
  root?: { path?: string; label?: string; ok?: boolean };
  allowWrites?: boolean;
  autopilot?: boolean;
  serverStale?: boolean;
  unread?: number;
  [key: string]: unknown;
}

export interface PlanSummary {
  slug: string;
  title?: string;
  kind?: string;
  phases: number;
  ready: unknown[];
  [key: string]: unknown;
}

export interface Approval {
  id: string;
  status: string;
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
}

export interface PlanSummaryFull {
  slug: string;
  title: string;
  kind: string;
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
  model?: string;
  effort?: string;
  goal?: string;
  readFirst?: string;
  files?: string;
  steps?: string;
  exitCriteria?: string;
  verification?: string;
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

export const api = {
  /* ---- shell ---- */
  state: () => request<ConsoleState>('/api/state'),
  plans: () => request<PlanSummary[]>('/api/plans'),
  stats: () => request<unknown>('/api/stats'),
  savePrefs: (patch: Record<string, unknown>) => post<unknown>('/api/prefs', patch),

  /* ---- the directory picker ---- */
  browse: (path?: string) => request<unknown>(`/api/fs?path=${q(path ?? '')}`),
  checkRoot: (path: string) => request<unknown>(`/api/root?path=${q(path)}`),
  openRoot: (path: string) => post<unknown>('/api/root', { path }),

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
  sessionPlan: (slug: string, model?: string) =>
    request<unknown>(`/api/plans/${q(slug)}/session-plan${model ? `?model=${q(model)}` : ''}`),

  search: (query: string) => request<unknown>(`/api/search?q=${q(query)}`),
  skills: () => request<unknown>('/api/skills'),
  policy: (slug?: string) => request<unknown>(`/api/policy${slug ? `?slug=${q(slug)}` : ''}`),
  addPolicy: (rules: unknown) => post<unknown>('/api/policy', rules),
  editPolicy: (edit: Record<string, unknown>) => post<unknown>('/api/policy', { by: 'console', ...edit }),
  write: (body: unknown, dry?: boolean) => post<unknown>(`/api/write${dry ? '?dry=1' : ''}`, body),

  /* ---- autopilot ---- */
  runs: () => request<unknown>('/api/runs'),
  run: (slug: string) => request<unknown>(`/api/run/${q(slug)}`),
  runJournal: (slug: string, id?: number, limit?: number) =>
    request<unknown>(`/api/run/${q(slug)}/journal${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`),
  runTranscript: (slug: string, id?: number, limit?: number) =>
    request<unknown>(`/api/run/${q(slug)}/transcript${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`),
  runStart: (slug: string, options?: unknown) => post<unknown>(`/api/run/${q(slug)}/start`, options),
  runPause: (slug: string) => post<unknown>(`/api/run/${q(slug)}/pause`),
  runResume: (slug: string) => post<unknown>(`/api/run/${q(slug)}/resume`),
  runStop: (slug: string) => post<unknown>(`/api/run/${q(slug)}/stop`),
  runSkip: (slug: string, phase: number) => post<unknown>(`/api/run/${q(slug)}/skip`, { phase }),
  runRetry: (slug: string, phase: number) => post<unknown>(`/api/run/${q(slug)}/retry`, { phase }),
  runRecheck: (slug: string, phase: number) => post<unknown>(`/api/run/${q(slug)}/recheck`, { phase }),
  runCloseout: (slug: string, phase: number) => post<unknown>(`/api/run/${q(slug)}/closeout`, { phase }),
  runResumePhase: (slug: string, phase: number, instruction?: string) =>
    post<unknown>(`/api/run/${q(slug)}/resume-phase`, { phase, instruction }),
  phaseDiagnosis: (slug: string, phase: number | string) =>
    request<unknown>(`/api/run/${q(slug)}/diagnosis/${q(String(phase))}`),
  runSettings: (slug: string, patch: unknown) => post<unknown>(`/api/run/${q(slug)}/settings`, patch),
  runFreeze: (slug: string) => post<unknown>(`/api/run/${q(slug)}/freeze`),
  runThaw: (slug: string) => post<unknown>(`/api/run/${q(slug)}/thaw`),
  runAsk: (slug: string, question: string, key: string) =>
    post<unknown>(`/api/run/${q(slug)}/ask`, { question, key }),
  runSteer: (slug: string, instruction: string, key: string) =>
    post<unknown>(`/api/run/${q(slug)}/steer`, { instruction, key }),

  approvals: () => request<Approval[]>('/api/approvals'),
  decide: (id: string, decision: string, reason?: string, remember?: string, rule?: unknown) =>
    post<unknown>(`/api/approvals/${q(id)}`, {
      decision, reason, by: 'console', ...(remember ? { remember, rule } : {}),
    }),

  /* ---- the notification inbox ---- */
  notifications: (query: Record<string, unknown> = {}) => request<unknown>(
    `/api/notifications?${new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v != null && v !== '' && v !== false)
        .map(([k, v]) => [k, v === true ? '1' : String(v)]),
    )}`,
  ),
  markNotificationsRead: (ids?: string[]) =>
    post<unknown>('/api/notifications/read', ids?.length ? { ids } : {}),
  clearNotifications: (what: string | { id: string }) => request<unknown>(
    `/api/notifications?${typeof what === 'string' ? `scope=${what}` : `id=${q(what.id)}`}`,
    { method: 'DELETE' },
  ),

  /* ---- signing in, and restarting the console itself ---- */
  auth: (force?: boolean) => request<unknown>(`/api/auth${force ? '?force=1' : ''}`),
  authLogin: () => post<unknown>('/api/auth/login'),
  restartReadiness: () => request<unknown>('/api/restart'),
  restart: () => post<unknown>('/api/restart', { by: 'console' }),
};
