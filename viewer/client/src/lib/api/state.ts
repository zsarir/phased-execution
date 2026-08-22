/**
 * The console shell — what `/api/state` reports, the admission queue, and the
 * server-side preferences with their shipped defaults.
 *
 * Shapes mirror `server/service.ts` and `server/config.ts`. Hand-written rather
 * than generated, like every module here: a shape that drifts is a server
 * change, and a server change is a decision, not an accident.
 */

import { request, post } from './client';
import type { McpPolicy } from './runs';

/* ---------------- shapes ----------------
 * Only what the shell reads in this phase is typed. Views type their own as
 * they are ported; `unknown` is deliberate where a shape is not yet load-bearing. */

/** A directory the console has read, as `/api/state` reports it. */
export interface RootInfo {
  path?: string;
  label?: string;
  ok?: boolean;
  docsDir?: string;
  plansDir?: string;
  planCount?: number;
  handoffCount?: number;
  reason?: string;
}

/** The phase weights and session budgets the engine's `sizing.env` declares. */
export interface Sizing {
  S?: number;
  M?: number;
  L?: number;
  budgetBig?: number;
  budgetHaiku?: number;
  [key: string]: number | undefined;
}

/**
 * What `lifecycle.ts` reports about whatever started this process.
 *
 * `supervised` — not `ok`. The field was declared as `ok` here and has always
 * been sent as `supervised`, so every read of it was `undefined`; nothing
 * happened to notice because only `detail` was ever read. A page that gated a
 * button on it would have found the console permanently unsupervised.
 */
export interface SupervisorInfo {
  /** Whether a clean exit is expected to come back. */
  supervised?: boolean;
  kind?: 'launchd' | 'systemd' | 'declared' | 'none';
  detail?: string;
  /** True when supervision is inferred rather than read from a plist. */
  assumed?: boolean;
}

/**
 * How full the console is right now: lanes in use, lanes allowed, and anything
 * waiting for a scope to clear.
 *
 * `throttledUntil` is an ACCOUNT usage window, not a per-run one — the soonest
 * expiry across every throttled account, kept for older readers. With several
 * accounts, `throttledAccounts` says which login was told to come back when;
 * a run paying with a different one keeps going.
 */
export interface Concurrency {
  max: number;
  live: number;
  queued: number;
  throttledUntil: number | null;
  throttledAccounts?: { accountId: string; until: number }[];
}

/** Who is holding a scope an entry is waiting on, and which tokens collided. */
export interface QueueHolder {
  kind: 'grant' | 'lock' | 'reserved';
  slug: string;
  phase: number | null;
  owner: string;
  scope: string[];
  overlaps: string[];
  /** When a `lock` holder's lease lapses (ms epoch) — "lease ends <t>". */
  leaseUntil?: number;
}

export interface QueueEntry {
  id: string;
  slug: string;
  phase: number | null;
  runId: string;
  scope: string[];
  since: number;
  waitingOn: QueueHolder[];
  bypassed: number;
  reserving: boolean;
}

export interface QueueSnapshot extends Concurrency {
  grants: { id: string; slug: string; phase: number | null; runId: string; scope: string[]; at: number }[];
  entries: QueueEntry[];
}

/** A phase's declared scope, and what it would collide with if started now. */
export interface PhaseScope {
  phase: number;
  scope: string[];
  conflicts: string[];
}

export interface InstanceInfo {
  id: string;
  name: string;
  /** A console that serves one project and refuses to be repointed. */
  pinned: boolean;
}

export interface ConsoleState {
  generation?: number;
  root?: RootInfo;
  /**
   * Which console this is, on a machine that may be running several.
   *
   * Optional like everything else on this type: a new client can be talking to
   * a server started before instances existed, and every consumer must read a
   * missing answer as "this server cannot say" rather than inventing one.
   */
  instance?: InstanceInfo;
  allowWrites?: boolean;
  allowRun?: boolean;
  /** The environment doctor's findings (PATH rot, broken push delivery). */
  environment?: { issues: { kind: string; detail: string; fix: string }[] };
  /** `--allow-terminal`: the shell gate the nav reads on every page. */
  allowTerminal?: boolean;
  /** `--allow-agent`: interactive claude sessions in the browser terminal. */
  allowAgent?: boolean;
  /** `--allow-accounts`: registering Claude accounts. The meters are always on. */
  allowAccounts?: boolean;
  /**
   * Whether MCP servers may be REGISTERED here. Reading the registry, the
   * catalog and the connection statuses never needs it.
   */
  allowMcp?: boolean;
  autopilot?: boolean;
  /** True once `server/` on disk is newer than the process serving this page. */
  serverStale?: boolean;
  /** Which static root answered — the migration seam, surfaced in Settings. */
  staticRoot?: 'dist' | 'not-built';
  /** The commit `dist` was built from (`dist/.build-rev`); null when unstamped. */
  distRev?: string | null;
  supervisor?: SupervisorInfo;
  unread?: number;
  scriptsDir?: string;
  /**
   * Skills a NEW run would start with (`--default-skills` /
   * `PHASE_CONSOLE_DEFAULT_SKILLS`). Not what a run HAS — that is on the run.
   */
  defaultSkills?: string[];
  /**
   * Every model this console will START a phase on, strongest first — the
   * server's own `offeredModels()`, read from `scripts/models.env`.
   *
   * Optional like everything else here: an older server cannot say, and the
   * form falls back to its build's copy rather than offering nothing. Offering
   * and ACCEPTING are different questions — the door still takes any spelling
   * `models.env` knows, including ones absent from this list.
   */
  models?: string[];
  /**
   * `--remote` / `--remote-user`. Optional like everything else here: a new
   * client can be talking to a server started before these existed, and a
   * missing answer must read as "this server cannot say", never as "none".
   */
  remoteHosts?: string[];
  remoteUsers?: string[];
  /** The port this console is served on — setup commands embed it. */
  port?: number;
  /** Which OS the SERVER runs on — the setup commands differ per platform. */
  platform?: string;
  /** The server's home dir, so absolute paths render as "$HOME/…". */
  home?: string;
  sizing?: Sizing;
  searchDocs?: number;
  repo?: {
    available?: boolean;
    branch?: string;
    ahead?: number;
    behind?: number;
    dirty?: string[];
  };
  recentRoots?: { path: string; label: string }[];
  watcher?: { ok?: boolean; detail?: string };
  health?: unknown;
  /**
   * Every live run. The singular `run` field is gone — "the first live run of
   * ANY plan" reads plan B's run while looking at plan A the moment two drive.
   */
  runs?: unknown[];
  /** How full the console is, straight from the scheduler. */
  concurrency?: Concurrency;
  /**
   * Server-side preferences. `notify` is the global per-category switch the
   * console consults before it announces anything at all — it is server truth
   * and deliberately NOT mirrored into `lib/prefs.ts` (browser-local UI
   * settings), because a notification suppressed in one tab has to stay
   * suppressed for the process, not for the tab that happened to set it.
   */
  prefs?: {
    notify?: Record<string, boolean>;
    /**
     * Automation defaults — the opening values for every launch surface. Each
     * launch can override them for itself. Resolve absent keys through
     * `automationPrefs`, never ad hoc, so every surface agrees on defaults.
     */
    attachDefaultSkills?: boolean;
    qaByDefault?: boolean;
    gitMode?: 'default-branch' | 'new-branch';
    openPrOnComplete?: boolean;
    repoGuard?: boolean;
    autoRecoverByDefault?: boolean;
    autoContinueRecovery?: boolean;
    mcpPolicy?: McpPolicy;
    /** The remediation ladder's caps and toggles (server `Prefs`; Settings ▸ Automation renders them). */
    ladderPerPhaseRungs?: number;
    ladderPerPhaseUsd?: number;
    ladderPerRunRungs?: number;
    ladderPerRunUsd?: number;
    ladderPerDayUsd?: number;
    unblockAttempts?: boolean;
    staleClaimTakeover?: boolean;
    resumeAtBoot?: boolean;
    autoAccountSwitch?: boolean;
    convergeEveryMs?: number;
    /** A spent run budget is raised ONCE by this percentage (0 = never) — the resource ladder's `raise-budget` rung. */
    budgetAutoRaisePct?: number;
    /** How long a `require` MCP park waits for the server before continuing without it (0 = forever). */
    mcpRequireTimeoutMs?: number;
    /**
     * When a live lane stops being work (`shared/attention-model.js`
     * `STALL_DEFAULTS`, Phase 5). Thresholds, not policy: crossing one
     * announces and journals, it never acts.
     */
    stallSilentMs?: number;
    stallSpinTurns?: number;
    stallStalemateAttempts?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * The automation preferences with the server's own defaults applied — the one
 * place the `?? default` chain lives. The server sanitises on load and save,
 * so these fallbacks only matter against an older server that has never
 * written the keys.
 */
export function automationPrefs(state: ConsoleState | undefined): {
  attachDefaultSkills: boolean;
  qaByDefault: boolean;
  gitMode: 'default-branch' | 'new-branch';
  openPrOnComplete: boolean;
  repoGuard: boolean;
  autoRecoverByDefault: boolean;
  autoContinueRecovery: boolean;
  mcpPolicy: McpPolicy;
} {
  const prefs = state?.prefs ?? {};
  return {
    attachDefaultSkills: prefs.attachDefaultSkills ?? false,
    qaByDefault: prefs.qaByDefault ?? false,
    gitMode: prefs.gitMode === 'new-branch' ? 'new-branch' : 'default-branch',
    openPrOnComplete: prefs.openPrOnComplete ?? true,
    repoGuard: prefs.repoGuard ?? true,
    autoRecoverByDefault: prefs.autoRecoverByDefault ?? true,
    autoContinueRecovery: prefs.autoContinueRecovery ?? true,
    // Only the exact word may stop a plan, matching the server's own coercion.
    // A console running an older server has never written the key, and reads
    // as the shipped default rather than as the behaviour it used to have.
    mcpPolicy: prefs.mcpPolicy === 'require' ? 'require' : 'continue',
  };
}

/**
 * The ladder's preferences (`server/config.ts` `DEFAULT_PREFS`), the shipped
 * values. Settings ▸ Automation's ladder card shows them as "shipped: …" and
 * `ladderPrefs()` falls back to them against a server that never wrote a key.
 */
export const LADDER_PREF_DEFAULTS = {
  ladderPerPhaseRungs: 3,
  ladderPerPhaseUsd: 100,
  ladderPerRunRungs: 10,
  ladderPerRunUsd: 400,
  ladderPerDayUsd: 600,
  unblockAttempts: true,
  staleClaimTakeover: true,
  resumeAtBoot: true,
  autoAccountSwitch: true,
  convergeEveryMs: 300_000,
  budgetAutoRaisePct: 25,
  mcpRequireTimeoutMs: 1_800_000,
} as const;

export type LadderPrefs = {
  ladderPerPhaseRungs: number;
  ladderPerPhaseUsd: number;
  ladderPerRunRungs: number;
  ladderPerRunUsd: number;
  ladderPerDayUsd: number;
  unblockAttempts: boolean;
  staleClaimTakeover: boolean;
  resumeAtBoot: boolean;
  autoAccountSwitch: boolean;
  convergeEveryMs: number;
  budgetAutoRaisePct: number;
  mcpRequireTimeoutMs: number;
};

/**
 * The ladder's preferences with the server's own defaults applied — the same
 * one-place `?? default` rule as `automationPrefs`, for the twelve knobs the
 * ladder card renders. The server sanitises on load and save (a finite number
 * ≥ 0, a real boolean), so these fallbacks only matter against an older server
 * that has never written the keys.
 */
export function ladderPrefs(state: ConsoleState | undefined): LadderPrefs {
  const prefs = state?.prefs ?? {};
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  const d = LADDER_PREF_DEFAULTS;
  return {
    ladderPerPhaseRungs: num(prefs.ladderPerPhaseRungs, d.ladderPerPhaseRungs),
    ladderPerPhaseUsd: num(prefs.ladderPerPhaseUsd, d.ladderPerPhaseUsd),
    ladderPerRunRungs: num(prefs.ladderPerRunRungs, d.ladderPerRunRungs),
    ladderPerRunUsd: num(prefs.ladderPerRunUsd, d.ladderPerRunUsd),
    ladderPerDayUsd: num(prefs.ladderPerDayUsd, d.ladderPerDayUsd),
    unblockAttempts: bool(prefs.unblockAttempts, d.unblockAttempts),
    staleClaimTakeover: bool(prefs.staleClaimTakeover, d.staleClaimTakeover),
    resumeAtBoot: bool(prefs.resumeAtBoot, d.resumeAtBoot),
    autoAccountSwitch: bool(prefs.autoAccountSwitch, d.autoAccountSwitch),
    convergeEveryMs: num(prefs.convergeEveryMs, d.convergeEveryMs),
    budgetAutoRaisePct: num(prefs.budgetAutoRaisePct, d.budgetAutoRaisePct),
    mcpRequireTimeoutMs: num(prefs.mcpRequireTimeoutMs, d.mcpRequireTimeoutMs),
  };
}

/** The shell's fetchers — merged into `api` by `./index`. */
export const stateApi = {
  /* ---- shell ---- */
  state: () => request<ConsoleState>('/api/state'),
  /** The admission queue: what holds a scope, and what is waiting on it. */
  queue: () => request<QueueSnapshot>('/api/queue'),
  /** Each phase's scope and what it would collide with if started right now. */
  runScopes: (slug: string) =>
    request<{ scopes: PhaseScope[] }>(`/api/run/${encodeURIComponent(slug)}/scopes`),
  savePrefs: (patch: Record<string, unknown>) => post<unknown>('/api/prefs', patch),
};
