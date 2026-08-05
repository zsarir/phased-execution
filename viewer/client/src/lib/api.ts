/**
 * Server access.
 *
 * There is no request cache here, unlike `web/api.js`. TanStack Query is the
 * cache now, and two caches that invalidate on different signals is how a board
 * ends up showing yesterday's state confidently. This module only knows how to
 * make a request; `queries.ts` decides when it is stale.
 */

import type { RecoveryClass } from './recovery';
import type { QaProfile } from './qa';

/** Every request carries this; non-GETs additionally need a same-origin Origin,
 *  which the dev proxy rewrites (see vite.config.ts). */
const CSRF = { 'x-phase-console': '1' } as const;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    /**
     * The parsed error body, when there was one.
     *
     * A refusal often carries more than a sentence — the recovery mint's 409
     * names the session already working on that phase, so the caller can offer
     * it instead of only saying no. Optional and untyped: every existing
     * handler reads `message` and is unaffected.
     */
    readonly body?: unknown,
  ) {
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
    throw new ApiError(message, res.status, path, body);
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

/* ---------------- the terminal ---------------- */

export interface TerminalSession {
  id: string;
  label: string;
  /** What the session runs. Absent (an older server) means a shell. */
  kind?: 'shell' | 'claude';
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  pid: number;
  clients: number;
  createdAt: number;
  /** When the pty last printed — how a list tells "working" from "waiting". */
  lastOutputAt?: number;
  /** When the last client detached, while none is attached. */
  detachedSince?: number;
  /** Claude-session facts the UI shows back — never secret. */
  meta?: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    /** What `claude --resume <id>` takes after this pty is gone. */
    claudeSessionId?: string;
    intent?: 'plan' | 'recovery' | 'qa';
    /** Set by the server on a recovery session — what it was launched to fix. */
    recovery?: { kind: string; slug?: string; phase?: number; runId?: string };
    /**
     * Set by the server on a QA session — which phase it reviews, and what
     * `test-status.md` said when it started. The snapshot is how the exit check
     * tells "recorded a verdict" from "ended next to one that was already there".
     */
    qa?: { slug: string; phase: number; before?: string; beforeReport?: string };
  };
  /**
   * Present once the process has gone. The record now OUTLIVES it until it is
   * dismissed, so this is a state the page renders rather than a moment it
   * catches.
   */
  exited?: { code: number; signal?: number; closedByOperator?: boolean };
  /** When it ended. */
  exitedAt?: number;
}

export interface TerminalState {
  /** `--allow-terminal` was given. */
  allowed: boolean;
  /** `--allow-agent` was given — claude sessions may be minted. */
  agentAllowed?: boolean;
  /** Whether `node-pty` actually loaded — `unknown` until something has tried. */
  available: 'yes' | 'no' | 'unknown';
  limit: number;
  /** Live processes — what `limit` caps. `sessions` also carries ended records. */
  live?: number;
  sessions: TerminalSession[];
}

/** What a shutdown or a restart is about to stop. Both dialogs render it. */
export interface SessionInventory {
  live: number;
  agent: number;
  terminal: number;
  ended: number;
  sessions: { id: string; label: string; kind: 'shell' | 'claude' }[];
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

/** A single-use ticket for one WebSocket upgrade. Never logged, never stored. */
export interface TerminalTicket {
  ok: true;
  sessionId: string;
  token: string;
  expiresAt: number;
  path: string;
  /** The session as it now is — so the caller never races its own creation. */
  session: TerminalSession;
}

/**
 * How full the console is right now: lanes in use, lanes allowed, and anything
 * waiting for a scope to clear.
 *
 * `throttledUntil` is an account-wide usage window, not a per-run one — when it
 * is set, nothing starts anywhere, and saying so is the difference between a
 * queue that looks stuck and one that explains itself.
 */
export interface Concurrency {
  max: number;
  live: number;
  queued: number;
  throttledUntil: number | null;
}

/** Who is holding a scope an entry is waiting on, and which tokens collided. */
export interface QueueHolder {
  kind: 'grant' | 'lock' | 'reserved';
  slug: string;
  phase: number | null;
  owner: string;
  scope: string[];
  overlaps: string[];
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

/** A phase's declared scope, and what it would collide with if started now. */
export interface PhaseScope {
  phase: number;
  scope: string[];
  conflicts: string[];
}

export interface ConsoleState {
  generation?: number;
  root?: RootInfo;
  allowWrites?: boolean;
  allowRun?: boolean;
  /** `--allow-terminal`: the shell gate the nav reads on every page. */
  allowTerminal?: boolean;
  /** `--allow-agent`: interactive claude sessions in the browser terminal. */
  allowAgent?: boolean;
  autopilot?: boolean;
  /** True once `server/` on disk is newer than the process serving this page. */
  serverStale?: boolean;
  /** Which static root answered — the migration seam, surfaced in Settings. */
  staticRoot?: 'dist' | 'not-built';
  supervisor?: SupervisorInfo;
  unread?: number;
  scriptsDir?: string;
  /**
   * Skills a NEW run would start with (`--default-skills` /
   * `PHASE_CONSOLE_DEFAULT_SKILLS`). Not what a run HAS — that is on the run.
   */
  defaultSkills?: string[];
  /**
   * `--remote` / `--remote-user`. Optional like everything else here: a new
   * client can be talking to a server started before these existed, and a
   * missing answer must read as "this server cannot say", never as "none".
   */
  remoteHosts?: string[];
  remoteUsers?: string[];
  /** The port this console is served on — setup commands embed it. */
  port?: number;
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
} {
  const prefs = state?.prefs ?? {};
  return {
    attachDefaultSkills: prefs.attachDefaultSkills ?? false,
    qaByDefault: prefs.qaByDefault ?? false,
    gitMode: prefs.gitMode === 'new-branch' ? 'new-branch' : 'default-branch',
    openPrOnComplete: prefs.openPrOnComplete ?? true,
    repoGuard: prefs.repoGuard ?? true,
  };
}

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

/* ---------------- the autopilot ----------------
 * Mirrors `server/runner/state.ts` (`RunState`, `PhaseRecord`, `VerifySummary`),
 * `server/runner/approvals.ts` (`Approval`), `server/service.ts`
 * (`PhaseDiagnosis`, `RecoveryAction`) and `server/analysis/stats.ts`
 * (`EtaEstimate`). Hand-written for the same reason the plan shapes are: the
 * server is frozen, so a shape that drifts is a decision rather than an accident.
 *
 * `status` unions ARE narrowed here, unlike the plan surface's phase `state`.
 * They are the runner's own closed vocabulary rather than the engine's open one,
 * and every tone table below is keyed by them — an unknown status should be a
 * type error at the table, not a chip that silently paints grey. */

export type RunStatus =
  | 'running' | 'waiting' | 'paused' | 'pausing' | 'frozen'
  // `parked` — every remaining phase needs a person. Written by `reconcileRun`
  // when a run's child is alive but nothing is driving it, and by an approval
  // that timed out. It was missing from this union while the server emitted it
  // all along, so the tone tables the note above promises would catch an
  // unknown status simply had no entry for it: the one status meaning "waiting
  // on you" was drawn as the one meaning nothing in particular.
  | 'parked'
  // `queued` — admitted to the scheduler and waiting for a scope something else
  // is holding. A loop IS behind it (that is what is awaiting admission), but it
  // has spawned nothing and holds no lock. See `server/runner/state.ts`.
  | 'queued'
  // `halting` — a halt is recorded (the card is already up, it keys on
  // `run.halt`) and the remaining lanes are draining; flips to `halted` when
  // the last one settles. Live in every way that matters to the controls.
  | 'halting'
  | 'halted' | 'finished' | 'stopping' | 'interrupted';

export type PhaseStatus =
  | 'pending' | 'gated' | 'running' | 'verifying' | 'done'
  | 'failed' | 'interrupted' | 'skipped' | 'parked'
  /** Waiting on the scheduler for a scope that something else is holding. */
  | 'queued'
  | 'awaiting-verification';

export type Autonomy = 'halt-on-everything' | 'keep-going';
export type PermissionProfile = 'guarded' | 'trusted' | 'bypass';

export interface VerifyRun {
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  output: string;
}

export interface VerifySummary {
  ok: boolean;
  reason: string;
  ran: VerifyRun[];
  notRun: { text: string; reason: string }[];
}

export interface PhaseRecord {
  phase: number;
  status: PhaseStatus;
  attempts: number;
  costUsd: number;
  turns?: number;
  durationMs?: number;
  frozenMs?: number;
  /** Left by a checkpointed freeze; makes Continue a `--resume` rather than a restart. */
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  /** What the session's own `init` said it was running on — not always what it was asked for. */
  actualModel?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  note?: string;
  verification?: VerifySummary;
  lint?: { ok: boolean; summary: string };
  closeout?: { at: string; ok: boolean; sessionId?: string; note?: string };
  said?: string;
}

export interface PhaseOptions {
  model?: string;
  effort?: string;
  tools?: string[];
  permissionMode?: string;
  skills?: string[];
  /** Drop the RUN's skills for this phase; its own `skills` still apply. */
  skillsOff?: boolean;
}

/** One live `claude -p` process: which phase it is on, and the session it holds. */
export interface ChildRef {
  pid: number;
  phase: number;
  sessionId: string;
  startedAt: string;
}

export interface RunState {
  id: string;
  slug: string;
  root: string;
  status: RunStatus;
  autonomy: Autonomy;
  model: string;
  effort?: string;
  limits?: { status: string; window?: string; utilization?: number; resetsAt?: number; at: string };
  phaseBudgetUsd: number | null;
  runBudgetUsd: number | null;
  spentUsd: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  activePhase: number | null;
  /**
   * The mirror lane, and every reader written before the pool.
   *
   * One run can drive several disjoint-scope phases at once, so this is the
   * LOWEST-numbered live lane rather than "the" child — chosen for stability, so
   * it does not flip between lanes on every write. It is load-bearing, not
   * legacy: `reconcileRun` and every console built before lanes answer "is
   * something running" from it. `children` is the full picture.
   */
  child: ChildRef | null;
  /** Every live lane, keyed by phase — STRING keys, like `phases`. */
  children?: Record<string, ChildRef>;
  /** How many lanes this run may hold at once. Never more than the console's cap. */
  maxParallel?: number;
  waitUntil: string | null;
  halt: { at: string; reason: string; phase?: number } | null;
  pause: { requestedAt: string; afterPhase: number | null; by: string } | null;
  freeze: { at: string; phase: number | null; pid: number; by: string; escalateAt: string } | null;
  finishedReason?: string;
  onlyPhases?: number[];
  phaseOptions?: Record<string, PhaseOptions>;
  skills?: string[];
  permissionProfile?: PermissionProfile;
  /**
   * The run's git strategy, echoed off the state file. Absent means
   * default-branch — including on servers from before the feature — so render
   * nothing rather than falling back to preferences here: a header states the
   * run's own record.
   */
  gitMode?: 'new-branch';
  /** Meaningful only with `gitMode: 'new-branch'`; absent there means true. */
  openPr?: boolean;
  /**
   * Why this stopped run no longer wants a person — the board overtook it
   * (`auto`), or someone dismissed it. Annotation, never deletion: the run is
   * still here, still halted, still readable. See `server/runner/state.ts`.
   */
  resolved?: RunResolution | null;
  /** A person put the card back; the board resolver leaves it alone from then on. */
  reopenedAt?: string | null;
  phases: Record<string, PhaseRecord>;
}

export interface RunResolution {
  at: string;
  auto: boolean;
  reason: string;
  by?: string;
  note?: string;
}

/**
 * Which link of the fallback chain answered — and therefore how much of a claim
 * the number is. `etaLabel()` in `lib/format` turns it into words.
 */
export type EtaBasis = 'plan' | 'portfolio' | 'heuristic';

/** Always a range, always hedged — see `server/analysis/stats.ts`. */
export interface EtaEstimate {
  ratePerWeight: number;
  samples: number;
  basis: EtaBasis;
  remainingWeight: number;
  remainingPhases: number;
  lowMs: number;
  highMs: number;
  label: string;
}

/** One phase's own estimate — a point, not a range. */
export interface PhaseEta {
  phase: number;
  weight: number;
  estMs: number;
  basis: EtaBasis;
  label: string;
}

export interface RunDetail {
  run: RunState | null;
  history: RunState[];
  eta: EtaEstimate | null;
  /**
   * One estimate per open lane. The REMAINDER is not here on purpose: the
   * elapsed clock ticks in the browser, so a server-computed "time left" would
   * be stale the instant it was serialised. See `server/service.ts`.
   *
   * Optional for the same reason as `PlanDetail.eta` — an older server process
   * under a newer client simply does not send it.
   */
  phaseEta?: PhaseEta[];
}

export interface Evidence {
  label: string;
  body: string;
}

export interface Approval {
  id: string;
  runId: string;
  slug: string;
  phase: number | null;
  /** `verify` is a question for a person, not a permission question. */
  kind: 'gate' | 'tool' | 'verify';
  title: string;
  detail: string;
  evidence: Evidence[];
  tool?: { name: string; input?: { command?: string; [key: string]: unknown }; cwd?: string };
  suggestedRule?: string;
  createdAt: string;
  expiresAt: string;
  status: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

export interface DecideResult {
  ok?: boolean;
  /** The rule can be refused while the card is still answered — both are reported. */
  error?: string;
  wrote?: string;
  scope?: string;
}

export interface RecoveryAction {
  id: 'recheck' | 'closeout' | 'resume' | 'retry' | 'skip';
  label: string;
  detail: string;
}

export interface PhaseDiagnosis {
  runId: string;
  phase: number;
  status: string;
  blockedOn: 'board' | 'verification' | 'lint' | null;
  boardState: string;
  said: string | null;
  verification: VerifySummary | null;
  /** Where the commands ran, relative to the root — `.` when it is the root. */
  verifiedIn: string | null;
  lint: { ok: boolean; summary: string } | null;
  closeout: { at: string; ok: boolean; sessionId?: string; note?: string } | null;
  sessionId: string | null;
  resumable: boolean;
  note: string | null;
  workingTree: string[];
  lock: string | null;
  actions: RecoveryAction[];
}

export interface TranscriptEntry {
  seq: number;
  at: string;
  event: string;
  data: Record<string, unknown>;
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

/** What a start or a settings change sends. Every field is checked server-side. */
export interface RunSettings {
  model?: string;
  effort?: string;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  phaseOptions?: Record<string, PhaseOptions>;
  skills?: string[];
  permissionProfile?: PermissionProfile;
  onlyPhases?: number[];
  resumeRunId?: string;
  /** Work on one plan-wide branch (`pe/<slug>`) instead of what is checked out. */
  gitMode?: 'default-branch' | 'new-branch';
  /** New-branch runs only: the final phase pushes and opens a PR. */
  openPr?: boolean;
  /** Seed the machine's default skills into this run. */
  attachDefaultSkills?: boolean;
  /** START only: turn the plan's QA gate on before the run begins. */
  qa?: boolean;
}

/** `{ run }` — every mutating run endpoint answers in this envelope. */
export interface RunEnvelope {
  run: RunState | null;
  error?: string;
}

export interface AskResult {
  ok: boolean;
  /** The browser's own retry landed twice; the server saw the key and said so. */
  repeated?: boolean;
  error?: string;
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
    slug: string; phase: number; owner: string; expired: boolean; leaseUntil?: number; closed?: boolean;
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

/* ---------------- the notification inbox ---------------- */

export type DeliveryOutcome = 'sent' | 'throttled' | 'failed' | 'gone';

export interface DeliveryRecord {
  device: string;
  label: string;
  outcome: DeliveryOutcome;
  at: string;
  detail?: string;
}

export interface NotificationRecord {
  id: string;
  at: string;
  category: string;
  title: string;
  body: string;
  /** Built by the server's `routeFor` and never by hand. */
  url: string;
  /** What it is about — the fields a scoped read matches on. */
  slug?: string;
  runId?: string;
  phase?: number;
  sessionId?: string;
  urgent: boolean;
  read: boolean;
  delivery: DeliveryRecord[];
}

/**
 * Which records a scoped read marks. Every field given must match, and an
 * empty scope matches **nothing** — a page whose slug has not resolved yet must
 * not clear the whole inbox.
 */
export interface NotificationScope {
  slug?: string;
  category?: string;
  runId?: string;
  sessionId?: string;
  phase?: number;
}

export interface ReadResult {
  changed: number;
  unread: number;
}

export interface NotificationCategory {
  id: string;
  label: string;
  detail: string;
  byDefault: boolean;
  urgent: boolean;
}

export interface InboxPage {
  items: NotificationRecord[];
  total: number;
  unread: number;
  /** `items` was cut short — so "Show older" can be offered honestly. */
  more: boolean;
  categories: NotificationCategory[];
  /** How many devices are subscribed. A count, not the register. */
  devices: number;
  outOfBand: { configured: boolean };
}

export interface InboxQuery {
  category?: string;
  unread?: boolean;
  limit?: number;
  before?: string;
}

/* ---------------- push ----------------
 * The endpoint and keys never leave the server; `service` is the endpoint's
 * origin, which is the only thing a browser can match its own subscription
 * against. */

export interface PushDevice {
  id: string;
  label: string;
  service: string;
  categories: Record<string, boolean>;
  createdAt: string;
  lastOkAt: string | null;
  failures: number;
}

export interface PushState {
  publicKey: string;
  devices: PushDevice[];
  categories: NotificationCategory[];
}

/* ---------------- the permission policy ---------------- */

export interface RuleSupport {
  raw: string;
  tool: string;
  form: string;
  support: string;
  note?: string;
}

export interface PolicyLists {
  deny: string[];
  ask: string[];
  allow: string[];
}

export interface PolicyView {
  defaults: PolicyLists;
  extra: PolicyLists;
  plan: { slug: string; path: string; extra: PolicyLists } | null;
  effective: PolicyLists;
  file: string;
  profiles: { id: string; label: string }[];
  /** Rules the syntax accepts that nothing honours. */
  inert: { raw: string; note: string }[];
  support: RuleSupport[];
  hookTools: string[];
  wrappersNotStripped: string[];
  /** Tools this console has actually been asked about. */
  seen?: string[];
}

/** What `POST /api/policy` accepts — one scope, one edit. */
export interface PolicyEdit {
  scope: 'global' | 'plan';
  slug?: string | null;
  add?: Partial<Record<keyof PolicyLists, string[]>>;
  remove?: Partial<Record<keyof PolicyLists, string[]>>;
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

export const api = {
  /* ---- shell ---- */
  state: () => request<ConsoleState>('/api/state'),
  /** The admission queue: what holds a scope, and what is waiting on it. */
  queue: () => request<QueueSnapshot>('/api/queue'),
  /** This machine's tailnet — devices, and whether `serve` points here. */
  tailscale: () => request<TailscaleStatus>('/api/tailscale'),
  /** Each phase's scope and what it would collide with if started right now. */
  runScopes: (slug: string) =>
    request<{ scopes: PhaseScope[] }>(`/api/run/${encodeURIComponent(slug)}/scopes`),
  plans: () => request<PlanSummary[]>('/api/plans'),
  stats: () => request<Portfolio>('/api/stats'),
  savePrefs: (patch: Record<string, unknown>) => post<unknown>('/api/prefs', patch),

  /* ---- the directory picker ---- */
  browse: (path?: string) => request<DirListing>(`/api/fs?path=${q(path ?? '')}`),
  checkRoot: (path: string) => request<RootCheck>(`/api/root?path=${q(path)}`),
  openRoot: (path: string) => post<OpenRootResult>('/api/root', { path }),

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

  search: (query: string) => request<SearchResult>(`/api/search?q=${q(query)}`),
  skills: () => request<SkillInfo[]>('/api/skills'),
  policy: (slug?: string) => request<PolicyView>(`/api/policy${slug ? `?slug=${q(slug)}` : ''}`),
  addPolicy: (rules: unknown) => post<PolicyView>('/api/policy', rules),
  editPolicy: (edit: PolicyEdit) => post<PolicyView>('/api/policy', { by: 'console', ...edit }),
  write: (body: WriteRequest, dry?: boolean) => post<WriteResult>(`/api/write${dry ? '?dry=1' : ''}`, body),

  /* ---- stale claims ----
     The owner comes off the lock file on the server, so nothing here asks a
     person to retype `someone@example.com/opus-p2` from a card that never
     showed it. A live lease answers 409 and stays claimed. */
  releaseLock: (slug: string, phase: number) =>
    post<LockRelease>('/api/locks/release', { slug, phase }),
  releaseExpiredLocks: () =>
    post<{ results: LockRelease[]; released: number }>('/api/locks/release', { expired: true }),

  /* ---- autopilot ---- */
  runs: () => request<RunState[]>('/api/runs'),
  run: (slug: string) => request<RunDetail>(`/api/run/${q(slug)}`),
  runJournal: (slug: string, id?: number, limit?: number) =>
    request<unknown>(`/api/run/${q(slug)}/journal${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`),
  runTranscript: (slug: string, id?: string, limit?: number) =>
    request<TranscriptEntry[]>(`/api/run/${q(slug)}/transcript${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`),
  runStart: (slug: string, options?: RunSettings) => post<RunEnvelope>(`/api/run/${q(slug)}/start`, options),
  runPause: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/pause`),
  runResume: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/resume`),
  runStop: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/stop`, phase ? { phase } : undefined),
  runSkip: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/skip`, { phase }),
  runRetry: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/retry`, { phase }),
  runRecheck: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/recheck`, { phase }),
  runCloseout: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/closeout`, { phase }),
  runResumePhase: (slug: string, phase: number, instruction?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/resume-phase`, { phase, instruction }),
  phaseDiagnosis: (slug: string, phase: number | string) =>
    request<PhaseDiagnosis>(`/api/run/${q(slug)}/diagnosis/${q(String(phase))}`),
  runSettings: (slug: string, patch: RunSettings) => post<RunEnvelope>(`/api/run/${q(slug)}/settings`, patch),
  // `phase` is optional on all five per-session controls: omitted means "the
  // session that is running", which is what they meant before a run could hold
  // more than one. Naming it makes the server refuse rather than act on
  // whichever phase is running by the time the request lands.
  runFreeze: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/freeze`, phase ? { phase } : undefined),
  runThaw: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/thaw`, phase ? { phase } : undefined),
  // Dismissing a stopped run's card, and putting it back. By run id, because
  // the card belongs to the run that raised it — not to whichever run of that
  // plan happens to be newest.
  runResolve: (slug: string, runId: string, note?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/resolve`, { runId, ...(note ? { note } : {}) }),
  runUnresolve: (slug: string, runId: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/unresolve`, { runId }),
  runAsk: (slug: string, question: string, key: string, phase?: number) =>
    post<AskResult>(`/api/run/${q(slug)}/ask`, { question, key, ...(phase ? { phase } : {}) }),
  runSteer: (slug: string, instruction: string, key: string, phase?: number) =>
    post<AskResult>(`/api/run/${q(slug)}/steer`, { instruction, key, ...(phase ? { phase } : {}) }),

  approvals: () => request<Approval[]>('/api/approvals'),
  decide: (id: string, decision: string, reason?: string, remember?: string, rule?: string) =>
    post<DecideResult>(`/api/approvals/${q(id)}`, {
      decision, reason, by: 'console', ...(remember ? { remember, rule } : {}),
    }),

  /* ---- the notification inbox ---- */
  notifications: (query: InboxQuery = {}) => request<InboxPage>(
    `/api/notifications?${new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v != null && v !== '' && v !== false)
        .map(([k, v]) => [k, v === true ? '1' : String(v)]),
    )}`,
  ),
  markNotificationsRead: (ids?: string[]) =>
    post<ReadResult>('/api/notifications/read', ids?.length ? { ids } : {}),
  // Scoped: only the records that are *about* this thing. An empty scope
  // matches nothing on the server, so a slug that has not resolved yet cannot
  // clear the inbox by accident.
  markNotificationsReadFor: (scope: NotificationScope) =>
    post<ReadResult>('/api/notifications/read', scope),
  clearNotifications: (what: string | { id: string }) => request<unknown>(
    `/api/notifications?${typeof what === 'string' ? `scope=${what}` : `id=${q(what.id)}`}`,
    { method: 'DELETE' },
  ),

  /* ---- push: the register, not the browser half ----
     Subscribing is `lib/push.ts` — it needs a service worker and a permission
     prompt, neither of which belongs in a fetch helper. */
  push: () => request<PushState>('/api/push'),
  pushSubscribe: (body: { subscription: unknown; label: string; categories?: Record<string, boolean> }) =>
    post<{ device?: PushDevice; state?: PushState; error?: string }>('/api/push/subscribe', body),
  pushUnsubscribe: (endpoint: string) => post<{ removed?: unknown; state?: PushState }>('/api/push/unsubscribe', { endpoint }),
  pushCategories: (id: string, categories: Record<string, boolean>) =>
    post<{ device?: PushDevice }>('/api/push/categories', { id, categories }),
  pushTest: (id: string) => post<{ ok: boolean; detail: string }>('/api/push/test', { id }),

  /* ---- the terminal ----
     `terminalTicket` is the handshake: a POST, so it carries the console header
     and the same-origin check that the WebSocket upgrade that follows cannot.
     See `server/terminal.ts` for why the socket alone is not defensible. */
  terminal: () => request<TerminalState>('/api/terminal'),
  terminalTicket: (body: { sessionId?: string; cols?: number; rows?: number }) =>
    post<TerminalTicket>('/api/terminal', body),
  /**
   * Mint a claude-kind session. The server composes and validates the argv —
   * this body is enum choices, a bounded prompt, and nothing executable.
   */
  agentTicket: (body: {
    cols?: number; rows?: number;
    model?: string; effort?: string; permissionMode?: string;
    prompt?: string; skills?: string[]; resume?: string;
    intent?: 'plan' | 'recovery' | 'qa'; brief?: string;
    /* A recovery names its TARGET and nothing else — the server reads the
       board, the run and the diagnosis and composes the prompt itself. */
    recoveryClass?: RecoveryClass; slug?: string; phase?: number; runId?: string;
    /* A review names its target the same way. `activate` turns QA on for the
       plan first; `permissionProfile` is the one place bypass is offered, and
       the server refuses it on any other kind of session. */
    activate?: boolean; permissionProfile?: QaProfile;
  }) => post<TerminalTicket>('/api/terminal', { kind: 'claude', ...body }),
  /**
   * Turn QA on for a plan that has it off.
   *
   * Write-class rather than agent-class: it creates `test-status.md` and
   * backfills the already-complete phases as waived, which is a change to the
   * repository whether or not a review is ever minted.
   */
  qaActivate: (slug: string, phase: number) =>
    post<{ ok: boolean; mode: string; detail: string }>(`/api/plans/${q(slug)}/qa-mode`, { phase }),
  terminalClose: (id: string) =>
    request<{ closed: boolean; state: TerminalState }>(`/api/terminal?id=${q(id)}`, { method: 'DELETE' }),
  /** Drop the record of a session that has already ended. Refused on a live one. */
  sessionDismiss: (id: string) =>
    request<{ ok: boolean; reason?: string; state: TerminalState }>(
      `/api/terminal?id=${q(id)}&action=dismiss`, { method: 'DELETE' },
    ),

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
