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

  /* ---- plans ---- */
  plan: (slug: string, model?: string) =>
    request<unknown>(`/api/plans/${q(slug)}${model ? `?model=${q(model)}` : ''}`),
  planRaw: (slug: string) => request<unknown>(`/api/plans/${q(slug)}/raw`),
  handoff: (slug: string, phase: number | string) => request<unknown>(`/api/plans/${q(slug)}/handoff/${phase}`),
  prompt: (slug: string, phase: number | string) => request<unknown>(`/api/plans/${q(slug)}/prompt/${phase}`),
  nextPrompt: (slug: string, phase?: number | string) =>
    request<unknown>(`/api/plans/${q(slug)}/next-prompt/${phase ?? 'none'}`),
  qaPrompt: (slug: string, phase: number | string) => request<unknown>(`/api/plans/${q(slug)}/qa-prompt/${phase}`),
  boardText: (slug: string) => request<unknown>(`/api/plans/${q(slug)}/board`),
  memoryBlock: (slug: string) => request<unknown>(`/api/plans/${q(slug)}/memory-block`),
  gate: (slug: string, phase: number | string) => request<unknown>(`/api/plans/${q(slug)}/gate/${phase}`),
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
