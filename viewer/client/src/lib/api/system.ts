/**
 * The console itself — the tailnet, the portfolio, search, skills, the
 * directory picker, the desktop launcher, sign-in, restart and shutdown.
 */

import { request, post, q } from './client';
import type { ConsoleState, SupervisorInfo } from './state';
import type { SessionInventory } from './sessions';
import type { HealthIssue } from './plans';
import type { EtaBasis } from './runs';

export interface ShutdownReadiness {
  supervisor: SupervisorInfo;
  /** How it will actually stop — `launchctl` unloads the job, `exit` just ends. */
  stop: { via: 'launchctl' | 'exit'; label?: string; detail: string };
  busy: boolean;
  run: { slug: string; status: string } | null;
  sessions: SessionInventory;
  /** How to get it back — the last thing this console will tell you. */
  restartHint: string;
}

/** One machine on the tailnet, reduced to what the Settings card renders. */
export interface TailscaleDevice {
  hostName: string;
  dnsName: string;
  ips: string[];
  os?: string;
  online: boolean;
  /** Only present, and only useful, for a device that is offline now. */
  lastSeen?: string;
}

/**
 * The tailnet as this machine sees it.
 *
 * `serve.active` and `serve.forOurPort` stay separate on the wire because they
 * have different fixes: nothing is served, versus something else is.
 */
export type TailscaleStatus =
  | { state: 'not-installed' }
  | { state: 'installed-not-running'; detail?: string }
  | {
      state: 'running';
      tailnet?: string;
      magicDns: boolean;
      magicDnsSuffix?: string;
      self: TailscaleDevice;
      peers: TailscaleDevice[];
      serve: { active: boolean; forOurPort: boolean; url?: string };
    };

/** Where a one-click desktop launcher would land, and whether this platform can. */
export interface LauncherPlanView {
  platform: string;
  supported: boolean;
  path?: string;
  kind?: 'command' | 'desktop-entry';
  note: string;
  rootOpen: boolean;
  fullFlags: readonly string[];
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  method?: string;
  organisation?: string;
  subscription?: string;
  checkedAt: string;
  /** Present when the probe could not answer — different from answering "no". */
  detail?: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: 'personal' | 'project' | 'plugin';
  plugin?: string;
  path: string;
}

/* ---------------- search ----------------
 * Mirrors `server/search.ts`. `kind` stays open for the same reason a phase
 * `state` does: the index decides what it indexes. */

export interface SearchHit {
  slug: string;
  kind: string;
  section: string;
  phase?: number;
  title: string;
  score: number;
  snippet: string;
}

export interface SearchResult {
  query: string;
  total: number;
  groups: { slug: string; title: string; hits: SearchHit[] }[];
}

/* ---------------- the portfolio ----------------
 * Mirrors `server/analysis/stats.ts` (`Portfolio`). */

export interface PortfolioTotals {
  plans: number;
  documents: number;
  orphans: number;
  /**
   * Plans an operator has closed. ⚠️ The census fields (`phases`, `done`,
   * `percent`, `waiting`, `inProgress`, `stuck`) still count them; the
   * forward-looking ones (`ready`, `remainingWeight`, `remainingSessions`) do
   * not. Closing a plan quiets it — it never deletes its history.
   */
  closed: number;
  phases: number;
  done: number;
  ready: number;
  waiting: number;
  inProgress: number;
  stuck: number;
  percent: number;
  remainingWeight: number;
  remainingSessions: number;
}

export interface Portfolio {
  generatedAt: number;
  totals: PortfolioTotals;
  /** `closed`: this status word is terminal. Carried by the server so a consumer
   * groups the terminal statuses without re-deriving the predicate. */
  byStatus: { status: string; count: number; closed?: boolean }[];
  /** `closed`: the lock's plan is terminal, so the lock is debris — `phase-lock.sh
   * conflicts` skips it and it blocks nobody. Optional for an older server. */
  activeLocks: {
    slug: string;
    phase: number;
    owner: string;
    expired: boolean;
    leaseUntil?: number;
    closed?: boolean;
  }[];
  issues: HealthIssue[];
  velocity: { week: string; count: number }[];
  calendar: { date: string; count: number }[];
  medianCycleDays?: number;
  sizeMix: { size: string; count: number }[];
  repos: { repo: string; count: number }[];
  skills: { skill: string; count: number }[];
  models: { model: string; count: number }[];
  stalled: { slug: string; days: number; ready: number[] }[];
  busiest: { slug: string; completions: number }[];
  /** How fast a phase has actually been going lately, pooled across every plan. */
  rate?: { ratePerWeight: number; basis: EtaBasis; samples: number; spread: number };
}

/* ---------------- the directory picker ---------------- */

export interface DirListing {
  path: string;
  parent?: string;
  entries: { name: string; path: string; hasDocs: boolean }[];
}

/** `server/config.ts` `RootCheck` — `ok` is the only field always meaningful. */
export interface RootCheck {
  path: string;
  ok: boolean;
  label: string;
  planCount: number;
  handoffCount: number;
  docsDir?: string;
  plansDir?: string;
  reason?: string;
}

export interface OpenRootResult {
  check: RootCheck;
  state: ConsoleState;
}

/* ---------------- restarting the console ---------------- */

export interface RestartReadiness {
  ok: boolean;
  reason?: string;
  supervisor: SupervisorInfo;
  busy: boolean;
  run: { slug: string; status: string; phase?: number } | null;
  /** A restart has always killed every pty. Now it says so before it does. */
  sessions?: SessionInventory;
}

/** The console's own fetchers — merged into `api` by `./index`. */
export const systemApi = {
  /** This machine's tailnet — devices, and whether `serve` points here. */
  tailscale: () => request<TailscaleStatus>('/api/tailscale'),
  stats: () => request<Portfolio>('/api/stats'),

  /* ---- the directory picker ---- */
  browse: (path?: string) => request<DirListing>(`/api/fs?path=${q(path ?? '')}`),
  checkRoot: (path: string) => request<RootCheck>(`/api/root?path=${q(path)}`),
  openRoot: (path: string) => post<OpenRootResult>('/api/root', { path }),

  search: (query: string) => request<SearchResult>(`/api/search?q=${q(query)}`),
  skills: () => request<SkillInfo[]>('/api/skills'),

  /* ---- the desktop launcher ---- */
  launcherPlan: () => request<LauncherPlanView>('/api/launcher'),
  createLauncher: () => post<{ ok: true; path: string; note: string }>('/api/launcher'),

  /* ---- signing in, and restarting the console itself ---- */
  auth: (force?: boolean) => request<AuthStatus>(`/api/auth${force ? '?force=1' : ''}`),
  authLogin: () => post<{ opened?: boolean; detail?: string }>('/api/auth/login'),
  restartReadiness: () => request<RestartReadiness>('/api/restart'),
  restart: () => post<unknown>('/api/restart', { by: 'console' }),

  /* The off switch. `confirm` is required by the server so a replayed or stray
   * POST cannot end a console; the dialog is what supplies it. */
  shutdownReadiness: () => request<ShutdownReadiness>('/api/shutdown'),
  shutdown: () => post<{ ok: boolean; reason?: string }>('/api/shutdown', { confirm: true, by: 'console' }),
};
