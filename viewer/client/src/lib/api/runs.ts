/**
 * The autopilot — runs, phase records, approvals, the convergence loop, and the
 * ETA shapes every other surface reads.
 */

import { request, post, q } from './client';

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
  | 'running'
  | 'waiting'
  | 'paused'
  | 'pausing'
  | 'frozen'
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
  | 'halted'
  | 'finished'
  | 'stopping'
  | 'interrupted';

export type PhaseStatus =
  | 'pending'
  | 'gated'
  | 'running'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'skipped'
  | 'parked'
  /** Waiting on the scheduler for a scope that something else is holding. */
  | 'queued'
  /**
   * Parked on an EXTERNAL clock the session declared (a CI build, a PR
   * auto-merge, a deploy window). Not a failure and not settled: the runner
   * resumes the phase's own session at `parkedUntil`.
   */
  | 'waiting'
  | 'awaiting-verification';

export type Autonomy = 'halt-on-everything' | 'keep-going';
export type PermissionProfile = 'guarded' | 'trusted' | 'bypass';

export interface VerifyRun {
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  output: string;
  /** `terminal` when a person re-ran it in the integrated terminal. */
  via?: 'terminal';
}

export interface VerifySummary {
  ok: boolean;
  reason: string;
  ran: VerifyRun[];
  notRun: { text: string; reason: string }[];
  /** Commands skipped because their lead binary does not exist here —
   * neither ran nor failed; "I could not check" made explicit. */
  skipped?: { command: string; lead: string; reason: string }[];
}

/** Mirrors `server/runner/state.ts` — the shared KIND_PROFILE covers all of these. */
export type HaltKind =
  | 'verify-failed'
  | 'no-handoff'
  | 'phase-blocked'
  | 'waiting-external-timeout'
  | 'needs-human'
  | 'plan-lint'
  | 'phase-crashed'
  | 'budget'
  | 'plan-unreadable'
  | 'failure-streak'
  | 'models-exhausted'
  | 'verification-preflight'
  | 'mcp-preflight'
  | 'run-preflight'
  | 'recovery-failed'
  | 'orphaned-session'
  | 'runner-crashed';

/** One structured boarding-preflight finding (`preflight` is the frozen string twin). */
export interface PreflightWarning {
  kind: 'human-check' | 'missing-lead' | 'cwd-unpinned' | 'nothing-runnable';
  message: string;
  lead?: string;
  command?: string;
}

/* ---------------- liveness (Phase 5's server B) ---------------- */

/**
 * What the runner can see about a lane that has NOT stopped.
 *
 * Three signals, worst first — the order `shared/attention-model.js`
 * `STALL_SIGNALS` declares, which is the order a reader should be told about
 * them in. Deliberately a different list from the inbox's `StallKind`: these
 * are about a session that exists and is spending, and four of the inbox's
 * five kinds describe a phase with no session at all.
 */
export type StallSignal = 'stalemate' | 'silent' | 'spinning';

/** The episode in progress: which signal, since when, and the one line of evidence. */
export interface StallState {
  signal: StallSignal;
  /** ISO — when the condition BECAME true, not when the ticker noticed. */
  since: string;
  detail: string;
}

/** A tool call that went out and has not come back. */
export interface OpenTool {
  id: string;
  name: string;
  since: string;
}

/**
 * One live lane, as `GET /api/run/:slug` reports it (`liveness[]`).
 *
 * `commitsSinceStart` and `treeDirty` cost a subprocess each, so the server
 * refreshes them every five minutes rather than every tick: they answer "has
 * this phase produced anything at all", which does not change per turn. Read
 * them as a few minutes old and never as a live clock.
 */
export interface LaneLiveness {
  phase: number;
  lastOutputAt: string;
  lastToolUseAt?: string;
  turnsSinceLastTool: number;
  commitsSinceStart: number;
  treeDirty: boolean;
  openTool?: OpenTool;
  stall?: StallState;
}

/* ---------------- rulings (Phase 5's ledger) ---------------- */

export type RulingKind = 'ambiguity' | 'deviation' | 'deferral';

/**
 * One judgement call a session recorded — `phase-outcome.sh <slug> <N> ruling`.
 *
 * A ruling is not an outcome and never becomes one: nothing acts on it, which
 * is the property that makes it safe for a session to record whenever it is in
 * doubt. `ack` is an annotation, never a resolution — a ruling is never "done",
 * and acking one appends a line to the ledger rather than editing the old one.
 */
export interface Ruling {
  id: string;
  slug: string;
  phase: number;
  kind: RulingKind;
  what: string;
  why?: string;
  /** The field that makes a ruling worth reading. */
  costIfWrong?: string;
  sessionId?: string;
  at: string;
  ack?: { at: string; by?: string };
}

/* ---------------- the journal ---------------- */

/**
 * One line of a run's journal (`server/runner/journal.ts` `JournalEntry`).
 *
 * `seq` is per run and monotonic, which is what makes a line permalinkable:
 * `#/plan/:slug/run?j=<seq>` names one entry for as long as the run exists.
 */
export interface JournalEntry {
  seq: number;
  time: string;
  event: string;
  phase?: number;
  data?: Record<string, unknown>;
}

/* ---------------- claimed vs evidenced ---------------- */

/**
 * `shared/evidence-model.js` `deriveEvidence` output — the four facts behind a
 * claim, and whether they back it.
 *
 * Named `evidenced`, never `done`: the board says a phase is done, and this
 * says whether anything on disk agrees. `why` is never empty.
 */
export interface EvidenceProof {
  board: 'done' | 'in-progress' | 'stuck' | 'ready' | 'waiting' | 'unknown';
  handoff: 'absent' | 'pending' | 'in-progress' | 'blocked' | 'complete' | 'unknown';
  verification: 'none' | 'red' | 'skipped' | 'human' | 'green';
  qa: 'off' | 'fail' | 'pending' | 'pass' | 'waived';
  evidenced: boolean;
  why: string[];
}

export interface PhaseRecord {
  phase: number;
  status: PhaseStatus;
  attempts: number;
  costUsd: number;
  turns?: number;
  durationMs?: number;
  frozenMs?: number;
  /** When a `waiting` park elapses and the runner resumes the phase's session. */
  parkedUntil?: string;
  /** The session's own words for what it is waiting on. */
  parkReason?: string;
  /** Refs for the external things being waited on (`gh:…#run/N`, `lock:slug/N`). */
  watch?: string[];
  /** How many waiting-external parks this phase has taken (capped by the runner). */
  waits?: number;
  /** When this phase started queueing behind a foreign lock. */
  lockWaitSince?: string;
  /**
   * How many times this phase called each attached MCP server, by id. Zero for
   * an id means it was attached and never touched — the interesting number,
   * since every attached server is paid for on every turn.
   */
  mcpCalls?: Record<string, number>;
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
  /** Boarding-preflight warnings on the §Verification — advisory, absent when clean. */
  preflight?: string[];
  /** The same findings, structured — what a page filters and badges by. */
  preflightDetail?: PreflightWarning[];
  /** Servers this phase asked for and boarded without. Absent when all connected. */
  mcpDegraded?: McpDegradation[];
  verification?: VerifySummary;
  lint?: { ok: boolean; summary: string };
  closeout?: { at: string; ok: boolean; sessionId?: string; note?: string };
  said?: string;
  /**
   * The classifier's last word on this phase (`server/runner/situation.ts`),
   * cached on the record for the table and the Ways-forward strip — `key` is
   * `id:sub`, `why` the evidence lines. Never an input to anything.
   */
  situation?: { key: string; at: string; why?: string[] };
  /**
   * A rung's instruction for the NEXT boarding — the brief the runner appends
   * (`fresh` | `resume` | `unblock` | `continue` | `closeout`) and the session
   * it resumes, when one exists. Consumed the moment the session spawns.
   */
  boardingHint?: BoardingHint;
  /** A `require` MCP park on its clock: when it parked and what was unreachable. */
  mcpPark?: { at: string; degraded: McpDegradation[] };
  /** The gate evaluation at boarding. */
  gate?: { clear: boolean; kind: string; detail: string };
  /**
   * The lane's last liveness snapshot, persisted on the record.
   *
   * Stale by construction once the lane is gone — it is what the SERVER falls
   * back to when no runner is live (`service.runLiveness`), and the record's
   * own `status` is what says whether to believe it. Prefer `RunDetail.liveness`
   * for anything in flight.
   */
  liveness?: LaneLiveness;
  /** The stall episode in progress. Cleared when an attempt is given up on. */
  stall?: StallState;
}

/** What a rung told the runner to do at the phase's next boarding. */
export interface BoardingHint {
  situation: string;
  rung: string;
  brief: 'fresh' | 'resume' | 'unblock' | 'continue' | 'closeout' | (string & {});
  sessionId?: string;
  instruction?: string;
  escalate?: 'model';
  at: string;
  by?: string;
}

/**
 * What a phase does when one of its MCP servers cannot be reached.
 *
 * `continue` (the shipped default) runs it without that server and says so, in
 * the session's prompt and in the phase record. `require` parks at boarding,
 * which is what every phase used to do — one signed-out server halted a real
 * eleven-phase plan that named no MCP servers of its own.
 */
export type McpPolicy = 'continue' | 'require';

/** One server a phase asked for and did not get, with the errand it implies. */
export interface McpDegradation {
  id: string;
  reason: 'needs-auth' | 'failed' | 'unregistered' | 'switched-off';
  detail?: string;
}

export interface PhaseOptions {
  model?: string;
  effort?: string;
  tools?: string[];
  permissionMode?: string;
  skills?: string[];
  /** Drop the RUN's skills for this phase; its own `skills` still apply. */
  skillsOff?: boolean;
  /** MCP servers this phase attaches, on top of the plan's and the run's. */
  mcpServers?: string[];
  /**
   * Drop the RUN's MCP servers for this phase. The PLAN's own `**MCP:**` bullet
   * still applies — that is a versioned statement about what the phase needs,
   * not somebody's preference for one run.
   */
  mcpOff?: boolean;
  /**
   * This phase's answer to an unreachable server. The most specific there is,
   * and the only one that outranks the plan.
   */
  mcpPolicy?: McpPolicy;
}

/** One live `claude -p` process: which phase it is on, and the session it holds. */
export interface ChildRef {
  pid: number;
  phase: number;
  sessionId: string;
  startedAt: string;
  /**
   * Set while THIS lane sits under SIGSTOP. The run-level `freeze` slot can
   * only name one lane; with several frozen at once this is the per-lane truth
   * the controls read.
   */
  frozen?: { at: string; by: string; escalateAt: string };
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
  /** `kind` is the halt's machine-readable class; absent on older records. */
  /** `kind` mirrors `server/runner/state.ts`'s HaltKind (open-ended for
   * records written by other versions); readers go through the shared
   * KIND_PROFILE, never string literals. */
  halt: { at: string; reason: string; phase?: number; kind?: HaltKind | (string & {}) } | null;
  pause: { requestedAt: string; afterPhase: number | null; by: string } | null;
  freeze: { at: string; phase: number | null; pid: number; by: string; escalateAt: string } | null;
  finishedReason?: string;
  onlyPhases?: number[];
  phaseOptions?: Record<string, PhaseOptions>;
  skills?: string[];
  /** MCP servers every phase of this run attaches, on top of the plan's own. */
  mcpServers?: string[];
  /** This run's answer to an unreachable server. Absent = `continue`. */
  mcpPolicy?: McpPolicy;
  permissionProfile?: PermissionProfile;
  /** The Claude account this run spawns as. Absent = the machine login. */
  accountId?: string;
  /** What the run does at the shared usage window. Absent = `wait`. */
  onLimit?: OnLimitPolicy;
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
  /**
   * Who last stopped the run — the operator (Stop, Pause, an escalated
   * freeze) or the system (a halt or park the loop wrote, a console shutdown,
   * a crash found at boot). The convergence loop picks up only the system's
   * stops. Absent on runs written before the field existed.
   */
  stoppedBy?: 'operator' | 'system';
  /** The run-level ask for a person, when a stop has no phase to hang it on. */
  errand?: Errand | null;
  /**
   * The resource ladder raised the run budget once (`budgetAutoRaisePct`); its
   * presence is what makes the raise happen once per run.
   */
  budgetRaise?: { from: number; to: number; pct: number; at: string } | null;
  /** Recovery bookkeeping, keyed by phase (`plan` for a plan-wide repair) — see `RecoverySlot`. */
  recoveries?: Record<string, RecoverySlot>;
  /** Present when the run heals its own auto-recoverable halts. */
  autoRecover?: { attempts: number };
  /**
   * The rulings written SINCE this run started, folded in by the watcher.
   *
   * A slice, not the ledger: `runs/<instance>/<slug>/rulings.ndjson` is per
   * plan and outlives every run, so a plan on its fourth run would otherwise
   * carry three runs of history. `GET /api/run/:slug/rulings` reads the whole
   * file, which is what the page shows.
   */
  rulings?: Ruling[];
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
 * What a person is asked for, ONCE, when the ladder for a phase is exhausted
 * or the situation is intrinsically human: the situation, what was tried (so
 * nobody tries it again by hand), what is needed, and how to give it.
 */
export interface Errand {
  phase: number;
  situation: string;
  tried: string[];
  need: string;
  how: string;
  at: string;
}

/** One rung the ladder climbed on a phase (`server/runner/state.ts` `RungRecord`). */
export interface RungRecord {
  situation: string;
  rung: string;
  at: string;
  params?: Record<string, string | number | boolean>;
  costUsd?: number;
  outcome?: 'running' | 'fixed' | 'no-defect' | 'superseded' | 'failed';
  note?: string;
}

/**
 * A run's recovery bookkeeping for one phase (`server/runner/state.ts`
 * `RunState.recoveries[phase]`). `lastOutcome` is the verdict the server has
 * always written and this type once never carried — `no-defect` ("looked,
 * found nothing wrong") was invisible and toasted as a failure.
 */
export interface RecoverySlot {
  attempts: number;
  lastAt: string;
  lastReason?: string;
  fixed?: boolean;
  lastOutcome?: 'fixed' | 'no-defect' | 'superseded' | 'failed';
  /** The ladder's own history for this phase — every rung climbed, in order. */
  rungs?: RungRecord[];
  /** The one open ask for a person, when the ladder is exhausted. */
  errand?: Errand;
  /** Resumes after console restarts killed this phase's lane (bounded). */
  bootResumes?: number;
}

/**
 * One action of a convergence pass, flattened (`server/converge.ts`
 * `ConvergeActionView`): what the loop did, to which phase, and why.
 */
export interface ConvergeActionView {
  kind: 'release-debris' | 'relaunch' | 'errand' | 'heal' | 'skip' | (string & {});
  phase?: number | null;
  situation?: string;
  rung?: string;
  vehicle?: string;
  owner?: string;
  session?: string;
  reboard?: { phase: number; situation: string; rung: string; brief?: string }[];
  rearm?: number[];
  need?: string;
  launched?: boolean;
  ok: boolean;
  why: string;
}

/** The convergence loop's last pass on a plan — the Pulse's convergence line. */
export interface ConvergeView {
  slug: string;
  trigger: 'boot' | 'change' | 'timer' | 'halt' | 'button' | (string & {});
  at: string;
  launched: boolean;
  noop: boolean;
  actions: ConvergeActionView[];
  errands: number;
}

/** `GET /api/converge`: whether the loop runs by itself here, its cadence, its queue and its last reports. */
export interface ConvergeStatusView {
  automatic: boolean;
  everyMs: number;
  pending: { slug: string; trigger: string; dueAt: number }[];
  running: string[];
  reports: ConvergeView[];
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
  /**
   * One entry per live lane. Rides along for the same reason `eta` does: "is
   * this lane working" is a question about ONE moment, and a second request
   * could be answered against a different one.
   *
   * Optional because an older server process under a newer client simply does
   * not send it — read an absent array as "this server cannot tell you", never
   * as "nothing is stalled".
   */
  liveness?: LaneLiveness[];
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
  id:
    | 'recheck'
    | 'closeout'
    | 'resume'
    | 'retry'
    | 'skip'
    | 'fix-agent'
    | 'mcp-continue'
    | 'continue-run'
    | 'release'
    | 'force-release'
    | 'dismiss';
  label: string;
  detail: string;
  /** How it acts: check | own-session | new-agent | run-control | claim | mcp. */
  mechanism?: string;
  /** Which console capability gates it (run | agent | writes), when one does. */
  flag?: string | null;
  /** Set on `fix-agent`: which agent briefing to launch. */
  recoveryClass?: string;
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
  /** The classifier's word for the phase and why (`server/runner/situation.ts`); null when it could not read. */
  situation: {
    id: string;
    sub?: string;
    key: string;
    label: string;
    blurb: string;
    actor: 'machine' | 'person' | 'wait' | 'none' | string;
    why: string[];
  } | null;
  /** The evidence it was decided from, as short lines. Absent on older servers. */
  evidence?: string[];
  /**
   * Claimed versus evidenced for this phase, from the four facts on disk.
   * Absent on a server from before Phase 4.
   */
  proof?: EvidenceProof;
  /** THIS phase's rulings, from the whole ledger — not just this run's slice. */
  rulings?: Ruling[];
}

export interface TranscriptEntry {
  seq: number;
  at: string;
  event: string;
  data: Record<string, unknown>;
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
  /** MCP servers every phase of this run attaches, on top of the plan's own. */
  mcpServers?: string[];
  /** What a phase does when one of those will not connect. Absent = the preference. */
  mcpPolicy?: McpPolicy;
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
  /** A registered account id, `default`, or `auto` (most 5-hour headroom). */
  accountId?: string;
  /** What to do at the shared usage window. */
  onLimit?: OnLimitPolicy;
  /** Heal auto-recoverable halts by launching the fix agent. Sticky on resume. */
  autoRecover?: boolean;
}

/** The on-limit policies a run can carry. `wait` is the pre-accounts behavior. */
export type OnLimitPolicy = 'wait' | 'switch' | 'pause';

/** `{ run }` — every mutating run endpoint answers in this envelope. */
export interface RunEnvelope {
  run: RunState | null;
  /** Start only: phases whose §Verification would park at boarding — advisory. */
  preflight?: string[];
  error?: string;
}

export interface AskResult {
  ok: boolean;
  /** The browser's own retry landed twice; the server saw the key and said so. */
  repeated?: boolean;
  error?: string;
}

/** The autopilot's fetchers — merged into `api` by `./index`. */
export const runsApi = {
  /* ---- autopilot ---- */
  runs: () => request<RunState[]>('/api/runs'),
  run: (slug: string) => request<RunDetail>(`/api/run/${q(slug)}`),
  runJournal: (slug: string, id?: number, limit?: number) =>
    request<JournalEntry[]>(
      `/api/run/${q(slug)}/journal${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`,
    ),
  /**
   * The PLAN's whole ruling ledger, oldest first — not the run's slice.
   *
   * Answers before any run exists, which is the common case for a plan
   * somebody is driving by hand.
   */
  runRulings: (slug: string) => request<{ rulings: Ruling[] }>(`/api/run/${q(slug)}/rulings`),
  runTranscript: (slug: string, id?: string, limit?: number) =>
    request<TranscriptEntry[]>(
      `/api/run/${q(slug)}/transcript${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`,
    ),
  runStart: (slug: string, options?: RunSettings) => post<RunEnvelope>(`/api/run/${q(slug)}/start`, options),
  runPause: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/pause`),
  runResume: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/resume`),
  runStop: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/stop`, phase ? { phase } : undefined),
  runSkip: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/skip`, { phase }),
  runRetry: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/retry`, { phase }),
  runRecheck: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/recheck`, { phase }),
  runCloseout: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/closeout`, { phase }),
  /** Set the run to `continue` and retry every phase the MCP preflight parked. */
  runMcpContinue: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/mcp-continue`, {}),
  runRecover: (slug: string) =>
    post<{
      outcome: 'running' | 'resumed' | 'recovering' | 'errand' | 'nothing-to-do';
      detail: string;
      steps: string[];
      run: RunState | null;
      /** The one ask for a person, when the outcome is `errand`. */
      errand?: Errand;
    }>(`/api/run/${q(slug)}/recover`, {}),
  runVerifyCommand: (slug: string, phase: number, command: string) =>
    post<{ ok: true; sessionId: string; token: string; expiresAt: number }>(
      `/api/run/${q(slug)}/verify-command`,
      { phase, command },
    ),
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
      decision,
      reason,
      by: 'console',
      ...(remember ? { remember, rule } : {}),
    }),

  /* ---- the convergence loop ---- */
  converge: () => request<ConvergeStatusView>('/api/converge'),
};
