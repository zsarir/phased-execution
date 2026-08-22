/**
 * The phase loop.
 *
 * For each ready phase: check its gate, claim its lock, ask the engine for the
 * boot prompt, run it as one `claude -p` process, and then — the part that
 * matters — **check the work independently**. The session's own report is
 * evidence, not proof: it is the same session whose job it was to succeed. So
 * the runner re-runs the plan's verification commands, re-lints, and re-reads
 * the board from disk. A phase advances only when all three agree.
 *
 * Two resumes, both required and quite different:
 *
 *   **Plan-level** — fresh or half-finished is the same code path. `--memory-block`
 *   derives ready from the done-*set*, so a plan with 1, 4 and 5 done and 2, 3
 *   outstanding needs no cursor and no special case. There is deliberately no
 *   "current phase" stored anywhere; the board is the truth.
 *
 *   **Run-level** — a console that died mid-phase left a child behind. That is
 *   reconciled explicitly (`adopt`) and never guessed at: a phase that may have
 *   half-committed is parked for a person, not silently re-run.
 *
 * Concurrency is deliberately one run at a time. Two sessions editing one
 * working tree is not parallelism, it is a merge conflict with extra steps.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import {
  classify, fallbackChain, limitBucket, nextModel, resetWaitUntil, MODEL_FALLBACK, type Disposition,
} from './errors.ts';
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type StreamEvent } from './spawn.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './verify.ts';
import { loadVerifyEnv, type VerifyEnv } from './verify-env.ts';
import {
  failureContext, resumeBrief, resumeInstruction, unblockBrief, type BriefFacts,
} from './failure-context.ts';
import {
  applyEvent, evaluateStall, livenessOf, newLaneSignals, stallThresholds,
  type LaneLiveness, type LaneSignals, type StallThresholds,
} from './liveness.ts';
import { ingestRulings, rulingsFile, type Ruling } from './rulings.ts';
import {
  classifySituation, collectEvidence, parseLockStatus, situation as situationOf, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './situation.ts';
import {
  accountRung, chargeRung, errandFor, nextRung, rungKey, rungsFor, DEFAULT_LADDER_CAPS, type LadderCaps, type Rung,
} from './ladder.ts';
import type { RungRecord } from './state.ts';
import {
  childrenOf, loadRun, newRun, phaseRecord, saveRun, pidAlive, IN_FLIGHT, SETTLED,
  PHASE_IN_FLIGHT, reconcileRecordsAgainstBoard, mcpReasonText, resetForRetry, consoleStoppedNote,
  type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome } from './outcome.ts';
import {
  AdmissionAborted, autopilotOwner, type Scheduler, type ScopeGrant,
} from './scheduler.ts';
import { formatScope } from '../../shared/scope.js';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';

export type RunnerEvent = (event: string, data: Record<string, unknown>) => void;

/**
 * Recognises the three park sentences `preflightVerification` writes. The
 * drive loop's halt matches record notes against this to name the right
 * remedy and to mark an all-verification halt machine-recoverable; the
 * service's recovery write-back uses the same test to know which parked
 * records a plan repair may reset. Lives beside the code that writes those
 * sentences: change one, change both.
 */
export const VERIFICATION_PARK_NOTE = /§Verification|states no verification/;

/**
 * Recognises the park sentences `preflightMcp` writes, so the halt can name the
 * right remedy and the recovery classifier can pick between "sign it in" and
 * "it is not registered". Lives beside the code that writes those sentences:
 * change one, change both.
 */
export const MCP_PARK_NOTE = /MCP server/;
/** The half of those that a person fixes by signing in, rather than by editing. */
export const MCP_AUTH_PARK_NOTE = /needs authentication/;

/**
 * Recognises the sentence the two-hour lock-wait cap writes, so the halt can
 * say that a Retry restarts the wait. Same rule as the two above: it lives
 * beside the code that writes it.
 */
export const LOCK_CAP_PARK_NOTE = /is locked by .* and has waited/;

/**
 * What one phase's MCP servers came to, decided once at boarding.
 *
 * `usable` is the set that gets a `--mcp-config`; `degraded` is what it asked
 * for and did not get; `park` is non-null only under `require`. `strict` is the
 * narrow case where every requested server was lost — see `resolveMcp`.
 */
export type McpResolution = {
  usable: string[];
  degraded: McpDegradation[];
  park: string | null;
  strict: boolean;
};

export type RunnerDeps = {
  scriptsDir: string;
  /** Injectable so the loop can be tested without spending money on a model. */
  spawn?: SpawnFn;
  verify?: typeof verifyPhase;
  /** The plan's `**Verification:**` text for a phase, from the service's store. */
  verificationText: (slug: string, phase: number) => Promise<string | undefined> | string | undefined;
  /**
   * Whether the phase's raw plan block DECLARES a Verification bullet at all —
   * regardless of what the parser made of it. Separates two park messages that
   * used to be one: "the plan states no verification" was also shown for a
   * plan that stated it in a shape the parser lost, and the operator went
   * looking for a bug in their plan instead of ours.
   */
  verificationDeclared?: (slug: string, phase: number) => Promise<boolean> | boolean;
  /**
   * The plan's `**Verify in:**` path for a phase — where those commands mean to
   * be run, relative to the run's root. Read from the same store and for the
   * same reason: the plan is the only thing that knows.
   */
  verifyIn?: (slug: string, phase: number) => Promise<string | undefined> | string | undefined;
  /**
   * The phase's Repos cell, as tokens. Used only to SUGGEST a `Verify in:` when
   * a verification fails and the plan already says which repo the phase is
   * about — never to choose a directory. See `verifyHint`.
   */
  phaseRepos?: (slug: string, phase: number) => Promise<string[] | undefined> | string[] | undefined;
  /**
   * Admission control. Without one, every phase runs the moment it is ready —
   * which is exactly what this runner did before lanes existed, and is the
   * right behaviour for a test harness that is not exercising concurrency.
   */
  scheduler?: Scheduler;
  /**
   * The phase's scope tokens, from the plan's Repos column. What the scheduler
   * admits against, and what the child is told it holds (`PE_SCOPE`).
   *
   * Distinct from `phaseRepos`, which is a repo-NAME view used only to suggest
   * a `Verify in:`. Same cell, two readings, and conflating them would make a
   * cosmetic hint load-bearing for concurrency.
   */
  phaseScope?: (slug: string, phase: number) => Promise<string[] | undefined> | string[] | undefined;
  /** Lanes this run may fill at once. The scheduler still enforces the global cap. */
  maxParallel?: number | (() => number);
  /**
   * The plan's own `**Model:**` / `**Effort:**` bullets for a phase.
   *
   * The plan format has allowed a per-phase model override for as long as there
   * has been a plan format, and the runner ignored it completely — so a plan
   * that said "this phase wants Opus" ran on whatever the run defaulted to and
   * nobody was told. Read from the store, exactly as the verification text is,
   * because the plan is the source for what a phase needs.
   */
  phaseDefaults?: (slug: string, phase: number) => { model?: string; effort?: string } | undefined;
  /**
   * The MCP servers the PLAN says a phase needs — its §Session budget line
   * unioned with the phase's own `**MCP:**` bullet, as `phase-graph.sh --mcp N`
   * computes it. Read from the engine for the same reason `phaseDefaults` is
   * read from the store: the plan is the source for what a phase needs, and a
   * console-side re-derivation would be a second parser to keep in step.
   */
  planMcp?: (slug: string, phase: number) => string[];
  /**
   * What the PLAN says a phase should do when one of its servers is
   * unreachable — its per-phase `**MCP policy:**` bullet, else the
   * §Session budget line. Read from the store for the same reason `planMcp`
   * is: the plan is the durable statement about what the work needs.
   *
   * Absent (no plan, no bullet) means the plan has no opinion, and the run's
   * own setting answers. See `mcpPolicyFor`.
   */
  planMcpPolicy?: (slug: string, phase: number) => McpPolicy | undefined;
  /**
   * A phase boarded without servers it asked for. Told to the service so it
   * can announce it once — the runner has no notification vocabulary of its
   * own, and a degraded phase that only reaches the journal is a degraded
   * phase nobody hears about.
   */
  onMcpDegraded?: (state: RunState, phase: number, degraded: McpDegradation[]) => void;
  /**
   * Resolve a phase's server set into a `--mcp-config` file, and check it can
   * actually connect before the phase boards.
   *
   * Both are one dependency because they must agree: the set that is probed has
   * to be the set that is passed, or the preflight is answering about something
   * else. Absent in harnesses that are not exercising MCP, in which case a run
   * attaches nothing and behaves exactly as it did before this existed.
   */
  mcp?: {
    preflight: (ids: string[], cwd: string) => Promise<{
      ok: boolean;
      blocking: { id: string; status: string; error?: { message: string } }[];
      unknown: string[];
      disabled: string[];
      probeError?: string;
    }>;
    configFor: (runId: string, ids: string[]) => Promise<string | null>;
  };
  /**
   * The plan's own `**Branch:**` prose from §Session budget, verbatim. Read
   * only to WARN: when a run's console-set git strategy contradicts a branch
   * the plan names, the session is told about the discrepancy rather than left
   * to discover two authorities disagreeing mid-commit.
   */
  planBranch?: (slug: string) => string | undefined;
  /** The plan's title, for the PR the final phase is asked to open. */
  planTitle?: (slug: string) => string | undefined;
  /** Without one, sessions run on the deny rules alone and nothing can be asked. */
  approvals?: Approvals;
  /** Where the child posts its hook calls, e.g. `http://127.0.0.1:4123`. */
  origin?: string;
  /**
   * What the session streams back. All three cost nothing but volume, and the
   * volume is what makes an unattended phase legible: without `subagentText` a
   * phase that delegates is a silent gap, and without `partialMessages` its
   * words arrive in lumps minutes apart.
   */
  stream?: { partialMessages?: boolean; subagentText?: boolean; hookEvents?: boolean };
  /**
   * The environment that makes a child run AS a given account — a profile's
   * `CLAUDE_CONFIG_DIR`, a token account's `CLAUDE_CODE_OAUTH_TOKEN`, or null
   * for the machine login. Service-provided (`accounts.envFor`); absent in
   * harnesses that are not exercising accounts. Async because a token may live
   * in a keychain, and resolved per spawn so a switch lands on the very next
   * session.
   */
  accountEnv?: (accountId: string | undefined) => Promise<NodeJS.ProcessEnv | null>;
  /**
   * The account a limit-hit run should continue under, from cached meters.
   * Null when no other account has headroom. Sync on purpose — consulted
   * mid-phase with nothing worth awaiting.
   */
  pickAccount?: (excluding: string | undefined, forModel?: string) => string | null;
  /** A limit landed: remember it on the account and tell the operator. */
  onAccountLimited?: (accountId: string | undefined, window: string, resetsAt: Date | null, detail: string) => void;
  /**
   * Probe the RUN's account before spending a session on it. Absent, the
   * legacy probe runs — which only ever answers for the machine login.
   */
  checkAuth?: (accountId: string | undefined) => Promise<AuthStatus>;
  /** Copy a session transcript between two accounts' config dirs. See `accounts/transcripts.ts`. */
  portTranscript?: (sessionId: string, fromAccount: string | undefined, toAccount: string | undefined) => boolean;
  onEvent?: RunnerEvent;
  /**
   * The store's parsed handoff for a phase — its status and its Outstanding
   * section — for the situation classifier and the re-board briefs. Absent in
   * harnesses; the board's own word (`stuck` / `in-progress`) still speaks.
   */
  handoffFor?: (slug: string, phase: number) =>
    { exists?: boolean; status?: string; outstanding?: string } | null | undefined;
  /** The ladder's caps (Settings ▸ Automation). Absent = the shipped defaults. */
  ladderCaps?: () => Partial<LadderCaps>;
  /**
   * Every ladder rung this console climbed TODAY, across every run.
   *
   * A dep and not a field, because the per-day cap is the one ladder cap whose
   * denominator a single run cannot see. `ladderPerDayUsd` is a promise about
   * the MACHINE — "do not spend more than this healing things today" — and a
   * runner that counted only its own rungs would let three runs spend the cap
   * three times over. Absent reads as unknown and therefore uncounted, which
   * is `nextRung`'s own convention for `dayHistory`.
   */
  dayHistory?: () => readonly RungRecord[];
  /**
   * Whether ONE bounded unblock session may be spent on a phase whose handoff
   * declares it blocked (the `unblockAttempts` preference). Absent = yes. Off
   * means the errand is written at once — the operator asked to be asked.
   */
  unblockAttempts?: () => boolean;
  /**
   * May a `human` gate be briefed to the phase's own session to verify and
   * clear, instead of stopping the run for a person? Absent = no, and that is
   * the right default: the plan author wrote `human`. See
   * `Prefs.delegateHumanGates`.
   */
  delegateHumanGates?: () => boolean;
  /**
   * The resource ladder's knobs (Settings ▸ Automation), read live so a change
   * applies to the next wall rather than the next run. Absent = the shipped
   * defaults: an auth or usage wall switches to an account that can pay, a
   * spent run budget is raised once by 25% (within the ladder's per-run USD
   * cap), a `require` MCP park continues without its servers after 30 min.
   */
  autoAccountSwitch?: () => boolean;
  budgetAutoRaisePct?: () => number;
  mcpRequireTimeoutMs?: () => number;
  /**
   * The ranked list `pickAccount` takes its head from — for the auth
   * preflight, which PROBES each candidate's login before trusting it
   * (headroom says nothing about whether a login still works). Absent, the
   * preflight tries `pickAccount`'s one answer.
   */
  rankAccounts?: (excluding: string | undefined, forModel?: string) => string[];
  /**
   * A `require` MCP park timed out and the phase goes ahead without its
   * servers. Told to the service so the operator hears ONCE — the errand is
   * already on the record by the time this fires.
   */
  onMcpRequireTimeout?: (state: RunState, phase: number, result: McpContinueResult) => void;
  /**
   * The session registry's presence for a lock (Phase 5): `ended` means the
   * holder's session is gone — its SessionEnd arrived, or its process is — so
   * the claim is debris, not a queue: the boarding belt-check releases it as
   * the holder and goes on, instead of waiting out a lease nobody holds.
   * Absent: every lock reads `unknown` and lease rules decide, as before.
   */
  lockPresence?: (lock: { slug: string; phase: number; owner: string; session?: string }) => 'live' | 'ended' | 'unknown';
  /** Verification-card answer window override — tests only; defaults to `VERIFY_ANSWER_MS`. */
  verifyAnswerMs?: number;
  /**
   * The MCP registry's enabled ids, for `PE_MCP_SERVERS` on the runner's own
   * engine calls — the same fact `Service.engineOpts` already passes on the
   * service side, threaded here so the runner's `validate.sh` in `confirm()`
   * carries the F15 advisory too instead of silently running without it.
   */
  mcpIds?: () => string[];
  /** Lease keepalive cadence override — tests only; defaults to `LEASE_REFRESH_MS`. */
  leaseRefreshMs?: number;
  /** Minimum park window override — tests only; defaults to one minute. */
  waitFloorMs?: number;
  now?: () => Date;
  /**
   * The console's stall thresholds (`config.ts` prefs), read fresh on every
   * evaluation so a number changed in Settings applies to the lane already
   * running rather than to the next run. Absent means the shipped defaults.
   */
  stallThresholds?: () => Partial<StallThresholds> | undefined;
};

export type StartOptions = {
  slug: string;
  root: string;
  model?: string;
  effort?: string;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  /** Continue this run id instead of creating one. */
  resumeRunId?: string;
  /** Drive only these phases, then finish. Absent means the whole plan. */
  onlyPhases?: number[];
  /** Per-phase model / effort / tools / skills, keyed by phase number. */
  phaseOptions?: Record<string, PhaseOptions>;
  /** Skills every phase invokes, on top of the plan's own. */
  skills?: string[];
  /** MCP servers every phase attaches, on top of the plan's own. */
  mcpServers?: string[];
  /** What a phase does when a server will not connect. Defaults to `continue`. */
  mcpPolicy?: McpPolicy;
  /** How much this run may do unasked. Defaults to `guarded`. */
  permissionProfile?: PermissionProfile;
  /** Lanes this run may fill. Never above the console's own cap. */
  maxParallel?: number;
  /** Work on one plan-wide branch instead of what is checked out. */
  gitMode?: 'default-branch' | 'new-branch';
  /** New-branch runs only: tell the final phase to push and open a PR. */
  openPr?: boolean;
  /** Heal auto-recoverable halts by launching the fix agent. Sticky on resume. */
  autoRecover?: boolean | { attempts?: number };
  /** The account sessions spawn as. Absent/`default` = the machine login. */
  accountId?: string;
  /** What to do at the shared usage window. Absent = `wait`, the old behavior. */
  onLimit?: OnLimitPolicy;
  /**
   * Consumed by the Service before the runner sees the run — `qa` activates the
   * plan's QA gate at start, `attachDefaultSkills` decides whether the machine's
   * default skills are seeded into `skills`. Carried here so route parsing
   * stays one shape; `Runner.start` itself ignores both.
   */
  qa?: boolean;
  attachDefaultSkills?: boolean;
  /**
   * Resume only: re-board these phases by rung. Each record is reset to
   * `pending` with a `boardingHint` — boarding then assembles the named brief
   * — and the loop drives it under normal admission. This is the seam the
   * convergence loop (Phase 3) acts through: one orchestration, never a
   * second. The CALLER accounts the rung (`recoveries[phase].rungs`); the
   * runner journals `phase.reboard-requested` and boards.
   */
  reboard?: ReboardRequest[];
};

/** One re-board asked of `start({resumeRunId, reboard})`. */
export type ReboardRequest = {
  phase: number;
  /** The `id:sub` situation key the rung was chosen for. */
  situation: string;
  /** The rung vehicle (`ladder.ts` `RungVehicle`). */
  rung: string;
  /** Which brief boarding assembles; defaults by rung (`briefForRung`). */
  brief?: BoardingBrief;
  sessionId?: string;
  instruction?: string;
  escalate?: 'model';
  by?: string;
};

/** The three ways to move a stuck phase forward without starting it over. */
export type RecoverMode = 'recheck' | 'closeout' | 'resume';

export type RecoverOptions = {
  slug: string;
  root: string;
  /** The stored run holding the phase. Recovery never invents a new run. */
  runId: string;
  phase: number;
  mode: RecoverMode;
  /** `resume` only: what the operator wants the session to do differently. */
  instruction?: string;
  by?: string;
};

/** Per phase: one first try, plus room for a model switch, a resume and a retry. */
const MAX_ATTEMPTS = 4;
/**
 * Per verification command. Half an hour, stated here rather than left to
 * `verify.ts`'s default, because the number is a statement about what a phase's
 * verification IS: a full suite, often a build, sometimes a container. At the
 * old default a slow-but-green check came back red at fifteen minutes and
 * halted a phase that had done nothing wrong.
 */
const VERIFY_TIMEOUT_MS = 30 * 60_000;
/** Give a stopped session time to run its own SessionEnd hooks before SIGKILL. */
const SIGTERM_GRACE_MS = 15_000;
/**
 * How long a "please check this by hand" card waits. Unlike a tool approval
 * there is no hook holding a socket open, and the honest unit for "open the app
 * and look at the gate stack" is hours, not the ten minutes a permission
 * prompt gets.
 */
const VERIFY_ANSWER_MS = 12 * 60 * 60 * 1_000;

/**
 * A closeout is paperwork: verify, commit, write the handoff, update the index.
 * Generous enough for a phase whose verification is a full suite, tight enough
 * that a session which misreads the ask and starts coding again runs out.
 */
const CLOSEOUT_MAX_TURNS = 60;

/* ---- the waiting-external park (console-runtime knobs) ----
 * Runner constants, deliberately NOT in scripts/sizing.env: the F5 single-source
 * rule is for numbers both bash and TS read, and bash never reads these. They
 * are documented in viewer/README.md beside the other runtime knobs. */

/** A waiting-external outcome that names no window: check back in half an hour. */
export const WAIT_DEFAULT_MS = 30 * 60_000;
/**
 * How many waiting-external parks one phase may take. A phase that keeps
 * re-filing the same wait is not waiting, it is stuck — the cap turns that
 * into an honest halt instead of an infinite quiet loop.
 */
export const WAIT_MAX_PER_PHASE = 4;
/** Total wall-clock one phase may spend parked, across all its waits. */
export const WAIT_BUDGET_MS = 8 * 60 * 60_000;
/**
 * How long a phase may queue behind a foreign lock before an honest park
 * naming the holder. Bounds the dead-but-unexpired-lock case.
 */
export const LOCK_WAIT_CAP_MS = 2 * 60 * 60_000;
/**
 * The lease keepalive cadence — a third of phase-lock.sh's default 30-minute
 * lease, so a live 47-minute phase can never silently lose its claim mid-work
 * (a lapsed lease is taken over by anyone; that is the cooperative design, and
 * it must not fire while the holder is alive and working).
 */
export const LEASE_REFRESH_MS = 10 * 60_000;
/**
 * The boarding belt-check's backoff against a foreign lock the scheduler's
 * store-fed view has not caught up with: 1 s, doubling, capped here. The
 * scheduler owns the real wait (it now reads the entry's own lock file live —
 * see `SchedulerDeps.liveLock`); this bounds the re-board rate for a harness
 * or a console whose store is slower than its belt-check, which used to spin
 * three bash subprocesses a second.
 */
export const LOCK_BACKOFF_MAX_MS = 30_000;

/**
 * Record statuses the drive loop's own ladder pass classifies. `interrupted`
 * and `failed` used to be SETTLED full stop — a resumed run whose only open
 * record was one of them parked at once, and the only way forward was a press.
 * `pending` joins the list ONLY for phases the board reads `stuck` or
 * `in-progress` (a handoff exists and is not complete): a ready+pending phase
 * is an ordinary candidate and needs no classification.
 */
const LADDER_STATUSES: readonly PhaseStatus[] = ['interrupted', 'failed'];

/** The default brief for a rung, when a `start({reboard})` caller names none. */
export function briefForRung(rung: string, hasSession: boolean): BoardingBrief {
  switch (rung) {
    case 'reboard-resume-brief': return 'resume';
    case 'resume-own-session': return hasSession ? 'continue' : 'resume';
    case 'unblock-session': return 'unblock';
    case 'closeout-own-session': return hasSession ? 'closeout' : 'resume';
    default: return 'fresh';
  }
}

/**
 * One step UP the model chain for an `escalate: model` rung — the reverse of
 * `nextModel`, which demotes. Null at the top (or for a model the chain does
 * not know); the CLI's own in-process fallback still applies on the way down.
 */
export function escalateModel(model?: string): string | null {
  if (!model) return null;
  const short = MODEL_FALLBACK.find((m) => model.includes(m));
  if (!short) return null;
  const index = MODEL_FALLBACK.indexOf(short);
  return index > 0 ? MODEL_FALLBACK[index - 1] : null;
}

/** The instruction a `fix-verification` continue carries (situation verify-red). */
function fixVerificationInstruction(phase: number): string {
  return [
    `Phase ${phase}'s §Verification is RED. Read the failing command(s) and their output below, fix the`,
    'cause, re-run the verification until it is green, then commit with explicit paths and write the',
    'handoff `complete`. Read `git status` and `git diff` FIRST — anything uncommitted is your own',
    'earlier work; never stash, checkout or reset it away.',
  ].join('\n');
}

/**
 * The contract an unattended session cannot be assumed to infer, stated where
 * it cannot be missed. Appended by the RUNNER (never woven into the engine's
 * text) to every boot, closeout and wait-resume prompt, because it is true
 * only under a supervisor: an interactive session may simply keep its turn
 * and wait, and telling it otherwise would be wrong.
 *
 * Born from a live transcript: a phase-8 session did 47 minutes of real work,
 * then called `ScheduleWakeup` and backgrounded two `gh` watchers and ended
 * its turn — all three void under `claude -p`, where the process exits on the
 * turn result and background tasks die seconds later. The exit read `success`;
 * the board read `ready`; the run halted.
 */
function unattendedDirective(scriptsDir: string, slug: string, phase: number): string {
  return [
    '',
    '',
    'UNATTENDED SESSION CONTRACT (you are running under a supervisor, non-interactively):',
    '- The process EXITS when your turn ends. ScheduleWakeup, Monitor, and backgrounded',
    '  watcher loops do not survive it — never end your turn expecting to be woken.',
    '- Your deliverable is the handoff. A phase with no handoff does not exist to the board,',
    '  and a clean exit without one reads as a failed phase.',
    '- If the work cannot finish because an EXTERNAL process must complete first (a CI build,',
    '  a PR auto-merge, a deploy window): commit what is done, write the handoff now with',
    '  `status: in-progress` (the durable pause marker), then declare the wait and stop:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} waiting-external \\`,
    '        --wait-minutes <realistic-window> --reason "<what you are waiting on>" --watch <ref>',
    '  The supervisor parks the phase and RESUMES THIS SESSION when the window elapses.',
    '- Blocked on a lock or scope conflict? Do not wait for a user reply that cannot come:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} blocked --reason "lock held by <owner>" --watch lock:${slug}/${phase}`,
    '  then stop; the supervisor queues the retry for when the lock frees.',
    '- Need a person (an MCP sign-in, a manual gate, credentials)? Declare it and stop:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} needs-human --reason "<what and why>"`,
    '- Must stop with WORK STILL LEFT (your budget or context is nearly spent)? Commit what is done,',
    '  write the handoff `in-progress`, then declare it so the supervisor RESUMES you instead of',
    '  reading a failed phase:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} partial --reason <budget|context|other>`,
    '- Made a judgement call the plan did not make for you — read an ambiguous instruction one way,',
    '  departed from what the plan said, or deliberately left something for later? RECORD IT. It costs',
    '  one line, nothing acts on it, and it is the thing the next session most needs and handoffs most',
    '  often omit:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} ruling --kind ambiguity|deviation|deferral \\`,
    '        --what "<what you decided>" --why "<why>" [--cost-if-wrong "<what it costs if this was wrong>"]',
    '  It is not an outcome and it never ends your turn; declare the outcome as well.',
    '- Never end the turn silently waiting. Declare an outcome or finish the closeout.',
    '  Ending your turn with words like "waiting for the build" and NO declared outcome',
    '  reads as a FAILED phase and stops the run.',
    '- The supervisor re-runs §Verification itself in plain bash and SKIPS (records, never',
    '  fails) any command whose binary does not exist on this machine — if your',
    '  §Verification depends on rg/python, verify with what exists and note it in the handoff.',
  ].join('\n');
}

/**
 * What the runner says when a waiting-external park's window elapses and the
 * board still does not read done. Resumes the SAME session — its context is
 * the whole point — and keeps the escape hatch open: an external process that
 * genuinely needs longer gets a re-filed wait, not a lie.
 */
function waitResumePrompt(slug: string, phase: number, reason?: string, watch?: string[]): string {
  return [
    `The wait window you declared for phase ${phase} of \`${slug}\` has elapsed`
      + `${reason ? ` (you were waiting on: ${reason})` : ''}.`,
    ...(watch?.length ? [`You were watching: ${watch.join(', ')}.`] : []),
    '',
    'Pick up the closeout:',
    '',
    '1. Re-check the external process(es). If they finished, run the plan\'s §Verification',
    '   commands, commit, and write the handoff `complete` (red verification → handoff',
    '   `blocked` with the failure recorded — never `complete` on red).',
    `2. If they are STILL not finished, re-file the wait with a realistic window —`,
    `   \`bash scripts/phase-outcome.sh ${slug} ${phase} waiting-external --wait-minutes <M> --reason "…"\` —`,
    '   and stop. Do not sit in the turn waiting.',
    '3. If they failed, write the handoff `blocked` recording exactly what failed.',
    '',
    'Do not start new work. Never end the turn without a handoff or a declared outcome.',
  ].join('\n');
}

/** A promise the drive loop can be woken through, re-armed after every fire. */
function wakeSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * What the runner says to a session that finished its work and stopped short of
 * recording it.
 *
 * This is `SKILL.md` §Mode 3 steps 1–4 and nothing else. The two constraints
 * that matter are both about honesty: it must not start new work (it is being
 * resumed to write down what happened, not to have second thoughts), and it must
 * hand off `blocked` rather than `complete` when verification is red — otherwise
 * the closeout becomes a machine for turning failures into green boards, which
 * is worse than the halt it replaces.
 */
function closeoutPrompt(slug: string, phase: number, boardState: string, branch?: string): string {
  return [
    `You exited without closing phase ${phase} of \`${slug}\`. The board still reads `
      + `"${boardState}", which means the handoff was never written or is not marked complete.`,
    '',
    'Finish the closeout, and nothing else:',
    '',
    `1. Run the plan's §Phase ${phase} Verification commands.`,
    '2. If any of them is red, write the handoff with status `blocked` and record the failure in it.',
    '   Never write a `complete` handoff on red verification.',
    '3. Commit the changed files with explicit paths (never `git add -A`), in the relevant submodule(s).',
    ...(branch
      ? [`   This run works on the plan's branch \`${branch}\` — commit there (check it out if`,
        '   needed), never on the default branch.']
      : []),
    '   If verification CANNOT finish because an external process must complete first (a CI',
    '   build, a PR auto-merge, a deploy window), write the handoff `in-progress` instead and',
    `   declare the wait — \`bash scripts/phase-outcome.sh ${slug} ${phase} waiting-external`,
    '   --wait-minutes <M> --reason "…"\` — then stop; the supervisor resumes you when it elapses.',
    `4. Run \`scripts/new-handoff.sh ${slug} ${phase} <title> [status]\`, then fill in the frontmatter`,
    '   and the body. Review the generated "Start next phase(s)" section rather than rewriting it.',
    '5. Update `INDEX.md`.',
    '',
    'Do not start new work, do not refactor anything, and do not revisit decisions the phase already',
    'made. If you cannot close it — the work genuinely is not finished, or something blocks you —',
    'write the handoff `blocked` saying exactly what, and stop.',
  ].join('\n');
}

/** A session's closing words, short enough to sit inside a halt reason. */
function condenseSaid(said: string): string {
  const line = said.replace(/\s+/g, ' ').trim();
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

/**
 * How long a frozen phase may stay frozen before it is checkpointed instead.
 *
 * `SIGSTOP` is the right answer for the minute you need to look at something —
 * it is instant, it loses nothing, and `SIGCONT` picks up mid-token. It is the
 * wrong answer for going to bed: a stopped process holds its memory, its file
 * handles and — the part that actually bites — a prompt cache that expires
 * underneath it anyway, so a session thawed hours later pays for the whole
 * context again and may find the world it was editing has moved.
 *
 * So a freeze held past this converts into the durable form: the child is asked
 * to stop, its `sessionId` is written into the checkpoint, and Continue starts
 * the phase again with `--resume` against that id.
 */
const FREEZE_ESCALATE_MS = 15 * 60 * 1_000;

/** How many idempotency keys are worth remembering. Minutes, not hours. */
const MAX_INJECT_KEYS = 200;

/** What a write to a live session answers with. */
export type AskResult = {
  ok: boolean;
  reason?: string;
  /** Correlates the console's line, the CLI's echo and the session's reply. */
  mark?: string;
  /** This exact message had already been sent; nothing was written again. */
  repeated?: boolean;
};

/**
 * Things worth knowing before spending a session finding them out.
 *
 * ## The check that used to be here, and why it is not
 *
 * This refused to start a run in a workspace whose trust prompt had not been
 * accepted, on the grounds that Claude Code ignores a repository's own
 * `permissions` and hooks until it has been. That was true once. Measured
 * against CLI v2.1.220, in a directory with no trust record at all, it is not:
 *
 *   - a repo `.claude/settings.json` **PreToolUse hook fired**
 *   - a repo `permissions.deny` rule **blocked the command**
 *
 * (`-p` mode skips the trust dialog outright — the CLI's own help says so —
 * and loads the settings anyway.) So the refusal was blocking runs in every
 * repository the operator happened not to have opened interactively, for a
 * reason that had stopped being true, with a message explaining a danger that
 * was not there. A wrong refusal is not the safe side of a guess.
 *
 * The deeper reason it is not needed: this runner passes its own deny rules to
 * every child through `--settings`, at CLI scope. Those are not workspace
 * settings and workspace trust has no bearing on them, so the layer the
 * console actually relies on holds regardless. The repository's own rules are
 * a bonus on top, and now they load too.
 *
 * `preflight` stays as the place for checks that ARE worth a second before a
 * session — it currently has none, and adding a wrong one back would cost more
 * than the empty function does. Returns a reason to refuse, or null.
 */
export function preflight(_root: string, _configFile = join(homedir(), '.claude.json')): string | null {
  return null;
}

/**
 * One phase in flight: its session, its admission, and whether it is stopped.
 *
 * A run used to be one phase at a time, so "the child", "the handle" and "the
 * frozen pid" could each be a single field on the runner. A run may now drive
 * several disjoint-scope phases, and every one of those fields becomes a
 * question that only makes sense per phase — so they live here, keyed by phase
 * number, and the single fields survive as a MIRROR of one lane. See
 * `syncMirror`.
 */
type Lane = {
  phase: number;
  pid: number | null;
  handle: SpawnHandle | null;
  grant: ScopeGrant | null;
  /** When the operator stopped this session where it stood, and when that expires. */
  frozen: { at: string; by: string; escalateAt: string } | null;
  /** Armed while this lane is frozen; fires its escalation to a checkpoint. */
  freezeTimer: NodeJS.Timeout | null;
  /**
   * The operator ended THIS lane only. Consumed by `attempt()` the way
   * `checkpointed` is, but the record settles `interrupted` and the loop
   * carries on — a per-lane stop is aimed at one session, not at the run.
   */
  stopped: { at: string; by: string } | null;
  /** Set when this lane's freeze was escalated, so exit 143 is not read as a crash. */
  checkpointed: boolean;
  /**
   * Why this lane was checkpointed, when it was NOT the freeze escalation:
   * `carryOn: true` tells the settle guard to keep the loop driving (an
   * account switch re-runs the phase immediately) instead of pausing the run
   * the way an escalated freeze does. Null for the freeze path.
   */
  checkpointNote: { carryOn: boolean } | null;
  /**
   * The lease keepalive: refreshes the lane's phase lock every third of its
   * lease while the lane lives, so a 47-minute session never silently loses
   * its 30-minute claim mid-work. Cleared before the lock is released, and
   * stopped the moment a refresh discovers a foreign takeover.
   */
  leaseTimer: NodeJS.Timeout | null;
  /** A refresh is in flight — see `refreshLease` for why overlap is refused. */
  leaseBusy?: boolean;
  /**
   * What the stream has said about this lane so far (`runner/liveness.ts`).
   * Folded in `onStream`, read by the 60-second ticker, and thrown away with
   * the lane — the durable half is `record.liveness` / `record.stall`.
   */
  signals: LaneSignals;
  /**
   * When the tree was last asked about (ms). `git status` and `git log` are
   * two subprocesses per scope directory, and the question they answer — has
   * this phase produced anything at all — does not change per turn, so it is
   * asked on a much slower cadence than the tick.
   */
  gitAt?: number;
};

/** How often the liveness ticker evaluates every live lane. */
const LIVENESS_TICK_MS = 60_000;

/** How often that tick is allowed to spend subprocesses on the working tree. */
const LIVENESS_GIT_EVERY_MS = 5 * 60_000;

export class Runner {
  private deps: RunnerDeps;
  private state: RunState | null = null;
  private journal: Journal | null = null;
  private transcript: Transcript | null = null;
  private abort: AbortController | null = null;
  private driving: Promise<void> | null = null;
  /**
   * Every phase this run has in flight, keyed by phase number.
   *
   * The source of truth for "what is running"; `state.child`,
   * `state.activePhase` and `state.freeze` are all derived from it.
   */
  private lanes = new Map<number, Lane>();
  /** The 60-second liveness ticker; armed with the first lane, retired with the last. */
  private livenessTimer: NodeJS.Timeout | null = null;
  private childPid: number | null = null;
  /** The live session, while there is one — what `/btw` talks to. */
  private handle: SpawnHandle | null = null;
  /** Set when the operator stopped us, so exit 143 is not read as a mystery. */
  private stopRequested = false;
  /**
   * Fired by `halt()` so lanes sleeping on a retry backoff or a usage window
   * wake and re-check, instead of spawning another attempt on a stopped run.
   */
  private haltSignal = new EventTarget();
  /** Path to the 0600 settings file carrying this run's deny rules and hook. */
  private settingsPath: string | null = null;
  /** Idempotency keys of operator messages already written, newest last. */
  private injected = new Map<string, AskResult>();
  /** Set while `recover` drives a single session rather than the phase loop. */
  private recovering = false;
  /**
   * The docs watcher's poke. The FLAG is the truth; the promise only ends the
   * drive loop's sleep — a wake that lands between the race settling and the
   * signal re-arming is still seen, because the loop top reads the flag.
   */
  private docsDirty = false;
  private wake = wakeSignal();
  /**
   * Resolutions the Service could not write because this loop owns the state
   * (`syncRecoveredRun` used to return null there and the record stayed
   * failed forever). Drained at the top of every drive tick.
   */
  private pendingResolutions: { phase: number; outcome: 'done' | 'no-defect'; by: string }[] = [];
  /** Per-phase pokes armed at `parkedUntil`, so a live loop resumes a wait on time. */
  private parkPokes = new Map<number, NodeJS.Timeout>();
  /**
   * What the loop's ladder pass last judged, per phase, as a fingerprint of the
   * record and the board. A record the ladder left standing (deferred, or
   * nothing to climb) is not re-classified — and re-journalled — every tick;
   * it is looked at again when its status, its attempt count or the board's
   * word about it changes. Cleared on start and on retry.
   */
  private ladderSeen = new Map<number, string>();
  /**
   * Set by the console's shutdown checkpoint: the stop about to land on the
   * lanes is the SYSTEM's, not the operator's — the run is stamped so the
   * convergence loop may pick it back up at the next boot.
   */
  private shuttingDown = false;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  current(): RunState | null { return this.state; }
  busy(): boolean { return this.driving !== null; }

  /**
   * The docs watcher saw the plan or a handoff (or a lock) change. Wakes the
   * drive loop so the board is re-read NOW rather than when the current lane
   * settles — which, on a one-lane run, used to be hours away.
   */
  noteDocsChanged(): void {
    this.docsDirty = true;
    this.wake.resolve();
  }

  /**
   * A recovery finished while this loop owns the run: queue its write so the
   * loop applies it under its own ownership next tick, instead of the Service
   * skipping the write-back entirely (the stale-failed-record bug).
   */
  enqueueResolution(resolution: { phase: number; outcome: 'done' | 'no-defect'; by: string }): void {
    if (!this.state) return;
    this.pendingResolutions.push(resolution);
    this.wake.resolve();
  }

  /**
   * Rewrite this run's records from a board the caller already read. The
   * stopped-run counterpart of the drive loop's own reconcile pass — the
   * Service calls it before deciding a halt still needs a recovery.
   */
  reconcileAgainstBoard(board: Record<number, string>): { changed: boolean; closed: number[] } {
    const state = this.state;
    if (!state) return { changed: false, closed: [] };
    const result = reconcileRecordsAgainstBoard(state, board);
    if (result.changed) {
      for (const phase of result.closed) {
        this.clearParkPoke(phase);
        this.record('phase.reconciled', { by: 'the board', outcome: 'done' }, phase);
      }
      this.persist();
      this.emit('run', { state });
    }
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Lanes
   * ---------------------------------------------------------------- */

  /** The phases with a live session right now. */
  livePhases(): number[] { return [...this.lanes.keys()].sort((a, b) => a - b); }

  /**
   * Every live lane's liveness, computed NOW rather than read off the last
   * tick.
   *
   * The record's own `liveness` is at most a minute old, which is right for a
   * checkpoint and wrong for a page that just asked. A caller with no runner
   * falls back to the records; a caller with one gets the current answer.
   */
  liveness(): LaneLiveness[] {
    return [...this.lanes.values()]
      .map((lane) => livenessOf(lane.phase, lane.signals))
      .sort((a, b) => a.phase - b.phase);
  }

  /**
   * Fold a freshly-read ruling ledger into this run, journalling each new one.
   *
   * Scoped to rulings written since this run STARTED. The ledger is per plan
   * and outlives every run — a plan on its fourth run would otherwise ingest
   * three runs' worth of history the first time the watcher fired, and journal
   * every line of it. `GET /api/run/:slug/rulings` reads the whole file, so
   * nothing is hidden; this is the run's own slice.
   */
  ingestRulings(ledger: readonly Ruling[]): number {
    const state = this.state;
    if (!state) return 0;
    const mine = ledger.filter((ruling) => !state.createdAt || ruling.at >= state.createdAt);
    const { rulings, added } = ingestRulings(state.rulings, mine);
    if (!added.length) return 0;
    state.rulings = rulings;
    for (const ruling of added) {
      this.record('phase.ruling', {
        id: ruling.id, kind: ruling.kind, what: ruling.what,
        ...(ruling.why ? { why: ruling.why } : {}),
        ...(ruling.costIfWrong ? { costIfWrong: ruling.costIfWrong } : {}),
        ...(ruling.sessionId ? { sessionId: ruling.sessionId } : {}),
        at: ruling.at,
      }, ruling.phase);
    }
    this.persist();
    this.emit('rulings', { added: added.length });
    return added.length;
  }

  /**
   * The lane a control is aimed at: the one named, or the mirror.
   *
   * Naming nothing means "whatever is running", which is what every caller
   * before lanes meant and still means when only one thing is.
   */
  private laneFor(phase?: number | null): Lane | undefined {
    if (phase != null) return this.lanes.get(phase);
    return this.mirrorLane();
  }

  /**
   * The one lane the single-lane fields describe.
   *
   * Lowest phase number rather than "most recent": it has to be *stable*, or
   * `state.child` would flip between lanes on every write and a console
   * watching it would see a run bouncing between phases it is calmly running
   * in parallel.
   */
  private mirrorLane(): Lane | undefined {
    let chosen: Lane | undefined;
    for (const lane of this.lanes.values()) {
      if (!chosen || lane.phase < chosen.phase) chosen = lane;
    }
    return chosen;
  }

  /**
   * Rewrite the single-lane fields from the lane table.
   *
   * `state.child` and `state.activePhase` are **load-bearing mirrors**, not
   * leftovers: `reconcileRun`, every console built before lanes, and the run
   * header all read them to answer "is something running, and what?". Dropping
   * them in favour of `children` would make every one of those report a busy
   * run as idle. So both recordings are kept in step here, in one place, and
   * `children` is the complete one.
   */
  private syncMirror(): void {
    const state = this.state;
    if (!state) return;

    const children: Record<string, ChildRef> = {};
    for (const lane of this.lanes.values()) {
      if (lane.pid == null) continue;
      children[String(lane.phase)] = {
        pid: lane.pid,
        phase: lane.phase,
        sessionId: state.phases[String(lane.phase)]?.sessionId ?? '',
        startedAt: state.phases[String(lane.phase)]?.startedAt ?? new Date().toISOString(),
        // On the lane's own entry, not only the single `freeze` slot — several
        // lanes can be frozen at once, and reconcile + the client read per pid.
        ...(lane.frozen ? { frozen: lane.frozen } : {}),
      };
    }
    if (Object.keys(children).length) state.children = children;
    else delete state.children;

    const mirror = this.mirrorLane();
    state.child = mirror?.pid != null ? children[String(mirror.phase)] ?? null : null;
    this.childPid = state.child?.pid ?? null;
    this.handle = mirror?.handle ?? null;
    // A run between phases points at nothing; one driving lanes points at the
    // mirror. Left stale, a finished phase goes on rendering a "running now"
    // chip in the phases table.
    if (this.lanes.size) state.activePhase = mirror?.phase ?? state.activePhase;
    else if (!this.recovering) state.activePhase = null;
  }

  /**
   * Record a spawned child against its lane — or, with no lane, against the
   * single-lane fields directly.
   *
   * The no-lane path is not dead code: `closeout` and `resumeWithInstruction`
   * are spawns like any other, and both can be reached on a run whose lane
   * table has already been torn down.
   */
  private attachPid(phase: number, pid: number | null): void {
    const lane = this.lanes.get(phase);
    if (lane) { lane.pid = pid; this.syncMirror(); return; }
    const state = this.state;
    this.childPid = pid;
    if (!state) return;
    state.child = pid == null
      ? null
      : {
        pid, phase,
        sessionId: state.phases[String(phase)]?.sessionId ?? '',
        startedAt: new Date().toISOString(),
      };
  }

  private attachHandle(phase: number, handle: SpawnHandle | null): void {
    const lane = this.lanes.get(phase);
    if (lane) { lane.handle = handle; this.syncMirror(); return; }
    this.handle = handle;
  }

  /** How many phases of THIS run may be in flight. The scheduler caps the fleet. */
  private maxLanes(): number {
    const max = typeof this.deps.maxParallel === 'function'
      ? this.deps.maxParallel()
      : this.deps.maxParallel;
    const wanted = this.state?.maxParallel ?? max ?? 1;
    return Math.max(1, wanted);
  }

  /**
   * The shutdown-handler key for a run.
   *
   * Named per run because the registry is name-keyed: with a pool, two runners
   * registering `'runner'` would evict each other's checkpoint handler, and the
   * evicted one would be the run that silently failed to checkpoint on the way
   * out.
   */
  private shutdownKey(runId: string): string { return `runner:${runId}`; }

  /** What this phase touches, for admission and for the child's `PE_SCOPE`. */
  private async scopeFor(phase: number): Promise<string[]> {
    const state = this.state!;
    const declared = await this.deps.phaseScope?.(state.slug, phase);
    // Saying nothing means it could touch anything — the same fail-safe
    // `scopeOfRow` takes on an empty Repos cell.
    return declared?.length ? declared : ['all'];
  }

  /**
   * Whether what is driving is a recovery rather than the phase loop.
   *
   * Both set `driving`, and they answer differently to exactly one control:
   * there is no phase boundary in a recovery for a Pause to wait at. See `pause`.
   */
  recoveringNow(): boolean { return this.recovering; }

  /**
   * Why a control aimed at a named phase cannot act, or null when it can.
   *
   * Naming a phase is not decoration. A control tapped on a phone reaches this
   * server whole seconds later, by which time the phase it was aimed at may
   * have ended — and freezing whatever started next is a different act from the
   * one that was asked for. Naming nothing still means "whatever is running",
   * which is what every caller before per-phase controls did, so this answers
   * null and changes nothing for them.
   */
  phaseMismatch(phase?: number | null): string | null {
    if (phase == null) return null;
    // Asked of the lane table, not of the mirror. With several phases in
    // flight, `state.child` names one of them — so a control correctly aimed
    // at a live lane that happens not to be the mirror would be refused with
    // "phase 5 is not the one running", while phase 5 was running perfectly.
    if (this.lanes.has(phase)) return null;
    const running = this.livePhases();
    if (!running.length) {
      return this.driving
        ? `phase ${phase} has no session running just now — the run is between phases, or verifying`
        : `phase ${phase} has nothing running to act on`;
    }
    return running.length === 1
      ? `phase ${phase} is not the one running — phase ${running[0]} is`
      : `phase ${phase} is not one of the ones running — phases ${running.join(', ')} are`;
  }
  /** Resolves once the loop has stopped driving. */
  async wait(): Promise<void> { await this.driving; }

  /* ---------------------------------------------------------------- *
   * Starting, and picking up where something left off
   * ---------------------------------------------------------------- */

  async start(options: StartOptions): Promise<RunState> {
    if (this.driving) throw new Error('A run is already in progress. Pause or stop it first.');

    const state = options.resumeRunId
      // No live id: by definition nothing is driving anything, or the guard
      // above would have thrown. Reconciling here is what turns a run left
      // claiming "running" by a killed console into one that can be continued.
      ? loadRun(options.root, options.slug, options.resumeRunId, null)
      : null;
    if (options.resumeRunId && !state) throw new Error(`No run ${options.resumeRunId} for ${options.slug}.`);
    let resumedStreak = 0;

    this.state = state ?? newRun({
      slug: options.slug,
      root: options.root,
      model: options.model,
      effort: options.effort,
      autonomy: options.autonomy,
      phaseBudgetUsd: options.phaseBudgetUsd,
      runBudgetUsd: options.runBudgetUsd,
      onlyPhases: options.onlyPhases,
      phaseOptions: options.phaseOptions,
      skills: options.skills,
      mcpServers: options.mcpServers,
      mcpPolicy: options.mcpPolicy,
      permissionProfile: options.permissionProfile,
      gitMode: options.gitMode,
      openPr: options.openPr,
      accountId: options.accountId,
      onLimit: options.onLimit,
      autoRecover: options.autoRecover,
    });

    if (state) {
      // Resuming: the halt that stopped it has been seen, and anything left
      // mid-flight is reconciled before a new child is started.
      this.state.halt = null;
      this.state.waitUntil = null;
      // A pause recorded by a console that is no longer here would otherwise
      // stop this loop before it ran anything.
      this.state.pause = null;
      // Same for a freeze, and for the last run's closing words: both describe
      // the run that stopped, not the one about to start.
      this.state.freeze = null;
      delete this.state.finishedReason;
      // And for the stop's paperwork. A resolution — auto or manual — annotates
      // the stop that was showing, and a reopen-veto protects that annotation;
      // resuming ends the stop they were both about. Left in place, a stale
      // `resolved` made a resumed run's SECOND halt raise no card at all
      // (autoResolveRun short-circuits on it, and the UI reads resolved as
      // dismissed) — a real run halted twice and said nothing the second time.
      this.state.resolved = null;
      this.state.reopenedAt = null;
      // Whoever stopped it last, the run is being started again now — and the
      // run-level errand was about that stop.
      delete this.state.stoppedBy;
      delete this.state.errand;
      const blocked = this.adopt(this.state);
      if (blocked) { this.persist(); return this.state; }
      // An operator pressing Start/Continue is a person back in the loop — the
      // same signal `park()` treats as clearing the slate. Carried across the
      // resume, a spent failure budget meant the continued run halted on its
      // first stumble, however long ago the failures it inherited were.
      resumedStreak = this.state.consecutiveFailures;
      this.state.consecutiveFailures = 0;
      if (options.model) this.state.model = options.model;
      if (options.effort) this.state.effort = options.effort;
      if (options.autonomy) this.state.autonomy = options.autonomy;
      if (options.phaseBudgetUsd !== undefined) this.state.phaseBudgetUsd = options.phaseBudgetUsd;
      if (options.runBudgetUsd !== undefined) this.state.runBudgetUsd = options.runBudgetUsd;
      // Continuing with a phase list replaces the old one; continuing without
      // one clears it, so "Continue" never silently inherits a single-phase run.
      if (options.onlyPhases?.length) this.state.onlyPhases = [...options.onlyPhases];
      else delete this.state.onlyPhases;
      // Per-phase choices and skills are sticky across a continue: they belong
      // to the run, not to one press of the button.
      if (options.phaseOptions) this.state.phaseOptions = { ...options.phaseOptions };
      if (options.skills) this.state.skills = [...options.skills];
      if (options.maxParallel !== undefined) {
        if (options.maxParallel > 0) this.state.maxParallel = options.maxParallel;
        else delete this.state.maxParallel;
      }
      // Account and on-limit policy are sticky like skills: absent on a
      // continue means "keep what the run already is", and naming the machine
      // login or `wait` explicitly returns the run to the omission state.
      if (options.accountId !== undefined) {
        if (options.accountId && options.accountId !== 'default') this.state.accountId = options.accountId;
        else delete this.state.accountId;
      }
      if (options.onLimit !== undefined) {
        if (options.onLimit !== 'wait') this.state.onLimit = options.onLimit;
        else delete this.state.onLimit;
      }
      // Auto-recovery is sticky the same way: absent means "keep what the run
      // already is", and an explicit false returns it to the omission state.
      if (options.autoRecover !== undefined) {
        if (options.autoRecover) {
          this.state.autoRecover = {
            attempts: Math.max(1,
              (typeof options.autoRecover === 'object' ? options.autoRecover.attempts ?? 0 : 0)
              || this.state.autoRecover?.attempts || 2),
          };
        } else {
          delete this.state.autoRecover;
        }
      }
      // The git strategy is sticky the same way: absent means "keep what the
      // run already is" — a resume must never re-read the machine defaults and
      // silently move a half-finished run onto (or off) its branch.
      if (options.gitMode === 'new-branch') {
        this.state.gitMode = 'new-branch';
        this.state.openPr = options.openPr ?? this.state.openPr ?? true;
      } else if (options.gitMode === 'default-branch') {
        delete this.state.gitMode;
        delete this.state.openPr;
      } else if (options.openPr !== undefined && this.state.gitMode === 'new-branch') {
        this.state.openPr = options.openPr;
      }
      // A run resumed from disk may carry lanes recorded by the console that
      // died. Nothing is behind them now — `adopt` has already ruled on the
      // dangerous case — so they must not present as live for a second longer.
      delete this.state.children;
    }

    this.journal = new Journal(this.state.root, this.state.slug, this.state.id);
    this.transcript = new Transcript(this.state.root, this.state.slug, this.state.id);
    this.ladderSeen.clear();

    // Re-boards asked of this resume (the convergence loop's seam): the record
    // is reset and hinted here, journalled, and boards under normal admission
    // like any candidate. Only on a resume — a fresh run has no history to
    // re-board — and only for phases the run knows.
    if (state && options.reboard?.length) {
      for (const ask of options.reboard) {
        const record = phaseRecord(this.state, ask.phase);
        if (PHASE_IN_FLIGHT.includes(record.status)) continue;
        const hint: BoardingHint = {
          situation: ask.situation, rung: ask.rung,
          brief: ask.brief ?? briefForRung(ask.rung, Boolean(ask.sessionId)),
          ...(ask.sessionId ? { sessionId: ask.sessionId } : {}),
          ...(ask.instruction ? { instruction: ask.instruction } : {}),
          ...(ask.escalate ? { escalate: ask.escalate } : {}),
          at: new Date().toISOString(),
          ...(ask.by ? { by: ask.by } : {}),
        };
        this.reboardWith(record, hint);
        this.record('phase.reboard-requested', {
          situation: hint.situation, rung: hint.rung, brief: hint.brief,
          sessionId: hint.sessionId ?? null, by: ask.by ?? 'console',
        }, ask.phase);
      }
    }

    // Both refusals cost about a second and save a session each. The auth one
    // saves considerably more than that: without it an expired login is
    // discovered once per phase, each time as a session that reports success,
    // spends nothing and does nothing.
    // The probe runs as the RUN's account: a run pinned to a profile used to
    // pass preflight on the machine login's health and burn a session per
    // phase finding out the profile had expired.
    const auth = this.deps.checkAuth
      ? await this.deps.checkAuth(this.state.accountId)
      : await checkAuth(this.state.root, true);
    let refusal = preflight(this.state.root) ?? (auth.loggedIn ? null : authRefusal(auth.detail));
    let tried: string[] = [];
    if (refusal && !auth.loggedIn) {
      // The auth wall's first rung, climbed before anyone is told: a signed-in
      // account that can pay takes the run. Only when none will does this
      // become the park it always was — now with the errand named on it.
      const climbed = await this.switchAccountAtPreflight(auth.detail);
      tried = climbed.tried;
      if (climbed.switched) refusal = null;
    }
    if (refusal) {
      this.state.status = 'parked';
      this.state.stoppedBy = 'system';
      this.state.halt = { at: new Date().toISOString(), reason: refusal, kind: 'run-preflight' };
      if (!auth.loggedIn) {
        // The one ask, with what was already tried so nobody repeats it by
        // hand. `how` is the console's own sign-in sentence when it composed
        // one (it names the account and the exact command); the generic
        // errand otherwise.
        const paying = this.state.accountId ?? 'the machine login';
        const base = errandFor('resource-wall:auth', tried, 0);
        const errand: Errand = {
          ...base,
          need: `A signed-in Claude account for this run — it is set to pay as ${paying}, whose login is expired or signed out.`,
          how: auth.detail && /sign|login|setup-token/i.test(auth.detail) ? auth.detail : base.how,
        };
        this.state.errand = errand;
        this.record('run.errand', { ...errand, reason: 'no signed-in account could take the run', by: 'runner' });
      }
      this.record('run.preflight-refused', { reason: refusal, ...(tried.length ? { tried } : {}) });
      this.persist();
      log.warn('runner.preflight', { root: this.state.root, reason: refusal });
      return this.state;
    }

    this.state.status = 'running';
    this.abort = new AbortController();
    this.stopRequested = false;
    this.settingsPath = this.armSettings(this.state.id);
    this.record('run.start', {
      runId: this.state.id, slug: this.state.slug, model: this.state.model,
      autonomy: this.state.autonomy, resumed: Boolean(state),
      // Named even when it is the default — argv never shows an account, so
      // the journal is the audit trail for whose quota a run spends.
      account: this.state.accountId ?? 'default',
      ...(this.state.onLimit ? { onLimit: this.state.onLimit } : {}),
      ...(this.state.onlyPhases?.length ? { onlyPhases: this.state.onlyPhases } : {}),
    });
    // The journal only exists from a few lines up; `was` keeps the audit
    // trail the counter itself loses.
    if (resumedStreak) this.record('run.failure-streak-reset', { was: resumedStreak });
    this.persist();

    const runId = this.state.id;
    onShutdown(this.shutdownKey(runId), () => this.checkpointForShutdown());
    this.driving = this.drive().finally(() => {
      this.driving = null;
      offShutdown(this.shutdownKey(runId));
      // Every grant and every pending admission this run held. The loop was
      // the only thing making them real, and it has ended — leaving them would
      // hold this run's scope against every other plan until the process died.
      this.deps.scheduler?.releaseRun(runId);
      this.deps.approvals?.disarm(runId);
    });
    return this.state;
  }

  /**
   * Drive one stuck phase forward, without re-running it.
   *
   * The console had exactly two verbs for a phase that stopped: Retry, which
   * starts it again from its boot prompt and throws away however long the
   * session had been working, and Skip, which marks it abandoned. Neither fits
   * the common case — a phase that did the work and stopped short of recording
   * it — so the operator's only honest option was to open a terminal.
   *
   * The three modes here are the missing middle:
   *
   *   `recheck`  re-runs the three checks and spawns nothing. For "I fixed it
   *              by hand, look again".
   *   `closeout` asks the phase's own session to finish its closeout — the same
   *              continuation the runner attempts by itself, on demand and
   *              without the "only once" guard, because a person asking for it
   *              is a new fact.
   *   `resume`   the same, carrying an instruction the operator typed. This is
   *              `/btw` for a session that has already exited.
   *
   * All three end in `confirm()`, so nothing here can mark a phase done that the
   * board, the verification and `validate.sh` do not all agree about.
   */
  async recover(options: RecoverOptions): Promise<RunState> {
    if (this.driving) throw new Error('A run is already in progress. Pause or stop it first.');

    const state = loadRun(options.root, options.slug, options.runId, null);
    if (!state) throw new Error(`No run ${options.runId} for ${options.slug}.`);
    const record = state.phases[String(options.phase)];
    if (!record) throw new Error(`Run ${options.runId} never reached phase ${options.phase}.`);

    this.state = state;
    // Only this phase's own halt explains anything here: a stop recorded
    // against another phase is not this recovery's story.
    const haltedWith = state.halt?.phase === options.phase ? state.halt.reason : null;
    // The halt is NOT cleared here. It used to be — "a run being worked on
    // must not go on looking stopped" — and the cost was worse than the look:
    // a recovery that crashed re-halted with a generic message and the
    // original reason was gone, and a recovery skipped mid-way left the run
    // looking unstopped over a phase still reading failed. The status flip to
    // `running` below is what tells the console work is happening; the halt
    // stands as the record of why until the recovery SUCCEEDS, and the
    // success path (and only it) clears halt, resolution and reopen-veto
    // together.
    delete state.finishedReason;
    state.status = 'running';
    state.activePhase = options.phase;

    this.journal = new Journal(state.root, state.slug, state.id);
    this.transcript = new Transcript(state.root, state.slug, state.id);
    this.abort = new AbortController();
    this.stopRequested = false;
    this.settingsPath = this.armSettings(state.id);
    this.record('run.recover', { mode: options.mode, phase: options.phase, by: options.by ?? 'console' }, options.phase);
    this.persist();
    // Before the work starts, not after it finishes. `runRecovery` can spend
    // minutes inside a spawn, and until this emit existed the console showed
    // the halted run — cleared status, cleared halt, all of it invisible —
    // for the whole of that. The `finally` emit below still reports the end.
    this.emit('run', { state });

    onShutdown(this.shutdownKey(state.id), () => this.checkpointForShutdown());
    this.recovering = true;
    this.driving = this.runRecovery({ ...options, haltedWith }).finally(() => {
      this.driving = null;
      this.recovering = false;
      offShutdown(this.shutdownKey(state.id));
      this.deps.approvals?.disarm(state.id);
      this.deps.scheduler?.releaseRun(state.id);
      this.persist();
      this.emit('run', { state });
    });
    return state;
  }

  private async runRecovery(options: RecoverOptions & { haltedWith?: string | null }): Promise<void> {
    const state = this.state!;
    const record = phaseRecord(state, options.phase);
    const owner = autopilotOwner(state.id);

    // A recovery spawns a session that edits the working tree exactly as a
    // phase does, and until now it was the one path that started one without
    // asking anybody. That was invisible while a single runner made it
    // impossible for anything else to be running; with a pool it is a second
    // agent in a tree another plan is mid-phase on.
    let grant: ScopeGrant | null = null;
    try {
      grant = await this.admit(options.phase, 'recovery');
    } catch (error) {
      if (error instanceof AdmissionAborted) {
        this.record('phase.recovery-cancelled', { phase: options.phase }, options.phase);
        state.status = 'paused';
        return;
      }
      throw error;
    }

    // A recovery is one session, but it is still a session: giving it a lane
    // is what lets Freeze and Stop reach it, and what puts its child in
    // `children` so a console restart reconciles it like any other.
    const lane: Lane = {
      phase: options.phase, pid: null, handle: null, grant,
      frozen: null, freezeTimer: null, stopped: null, checkpointed: false, checkpointNote: null, leaseTimer: null,
      // No `idleAttempts` carry-over: a recovery is not another attempt at the
      // phase, and counting it as one would let three recoveries — each of
      // which may legitimately change nothing — declare a stalemate.
      signals: newLaneSignals(this.now().getTime()),
    };
    this.lanes.set(options.phase, lane);
    this.armLivenessTicker();
    // A recovery session holds the phase lock exactly as a phase session does,
    // and can run just as long — the keepalive applies equally.
    this.armLeaseTimer(lane, autopilotOwner(state.id));

    try {
      if (options.mode !== 'recheck') {
        // An operator asking again is a new fact, not a repeat of the automatic
        // attempt — so the once-only guard is cleared rather than honoured.
        record.closeout = undefined;
      }

      if (options.mode === 'resume') {
        const said = await this.resumeWithInstruction(
          options.phase, options.instruction ?? '', options.haltedWith);
        if (said) { this.halt(said, options.phase, 'recovery-failed'); return; }
      }

      const ok = await this.confirmed(options.phase);
      if (!ok) return; // confirm() halted (or re-halted) and said why

      // Success — and only success — retires the stop this recovery was
      // about: the halt, its resolution, and any reopen-veto go together,
      // exactly as `start` does on resume.
      state.halt = null;
      state.resolved = null;
      state.reopenedAt = null;

      if (record.status === 'waiting') {
        // The recovery session declared waiting-external instead of closing —
        // the honest outcome for a phase whose external clock has not landed.
        // The run waits with the phase; the service re-arms the resume.
        state.status = 'waiting';
        state.waitUntil = record.parkedUntil ?? null;
        state.finishedReason = `phase ${options.phase} is waiting on external work`
          + `${record.parkReason ? ` (${record.parkReason})` : ''}; resumes at ${record.parkedUntil}.`;
        this.record('run.waiting-external', {
          phases: [options.phase], waitUntil: record.parkedUntil ?? null,
        }, options.phase);
        return;
      }

      state.status = 'parked';
      state.finishedReason = `phase ${options.phase} was closed by ${options.by ?? 'console'}. `
        + 'Continue to carry on through the rest of the plan.';
      this.record('run.recovered', { phase: options.phase, mode: options.mode }, options.phase);
    } catch (error) {
      log.error('runner.recover.crashed', { error });
      this.halt(`the recovery of phase ${options.phase} failed: ${(error as Error)?.message ?? error}`, options.phase, 'recovery-failed');
    } finally {
      this.clearLeaseTimer(lane);
      await this.release(options.phase, owner);
      this.deps.scheduler?.release(lane.grant);
      this.clearFreezeTimer(lane);
      this.lanes.delete(options.phase);
      // A recovery has no drive loop to finalize a drain: its halt above was
      // written while its own lane was still in the table, so with that lane
      // gone the run lands on the final word here.
      if (state.status === 'halting') {
        state.status = this.parkPending ? 'parked' : 'halted';
        this.parkPending = false;
      }
      this.syncMirror();
      this.childPid = null;
      this.handle = null;
      state.child = null;
      delete state.children;
    }
  }

  /**
   * Ask the scheduler for this phase's scope, recording the wait.
   *
   * With no scheduler wired the answer is immediate and unconditional, which
   * is what every test harness that is not about concurrency wants — and what
   * this runner did before admission existed.
   */
  private async admit(phase: number, kind: 'phase' | 'recovery'): Promise<ScopeGrant | null> {
    const state = this.state!;
    const scheduler = this.deps.scheduler;
    if (!scheduler) return null;

    const scope = await this.scopeFor(phase);
    const request = {
      slug: state.slug,
      phase,
      runId: state.id,
      scope,
      // The account the lane would spend, so a throttle on someone ELSE'S
      // window never queues this run — and one on ours does.
      ...(state.accountId ? { accountId: state.accountId } : {}),
      signal: this.abort?.signal,
    };

    // Asked BEFORE joining the queue, so "queued" is visible for the whole
    // wait rather than inferred afterwards. Only when it genuinely blocks —
    // announcing a queue for an admission that is free would put a `queued`
    // badge on every phase the console ever starts.
    const blockers = scheduler.wouldBlock(request);
    if (blockers.length) {
      const record = phaseRecord(state, phase);
      if (kind === 'phase') record.status = 'queued';
      // The run's own durable shadow of the queue. Deliberately NOT in
      // `IN_FLIGHT`: a queued run has done nothing, so a console restart may
      // re-adopt it rather than reconciling it into `interrupted`.
      // Only when NOTHING of this run is live: with another lane mid-session,
      // stamping the RUN `queued` repaints a working run as waiting for the
      // whole of that phase (seen live — phase 4 driving, run reading
      // `queued` because phases 5–6 sat behind its scope). The queued LANE
      // is already honest in `record.status` and the tabs.
      if (!this.livePhases().length) state.status = 'queued';
      this.record('phase.queued', {
        scope: formatScope(scope),
        waitingOn: blockers.map((holder) => ({
          slug: holder.slug, phase: holder.phase, owner: holder.owner, overlaps: holder.overlaps,
        })),
      }, phase);
      this.emit('phase', { phase, status: 'queued', scope, waitingOn: blockers });
      this.persist();
      this.emit('run', { state });
    }

    const grant = await scheduler.admit(request);
    if (blockers.length) {
      // Back to running: the wait is over, and a run left reading `queued`
      // while its session works would be the same lie in the other direction.
      // Compare-and-set: the wait can be minutes, and a status someone ELSE
      // wrote during it — a halt from another lane erased exactly here on a
      // real run, a freeze, a stop — is a fact this lane must not overwrite.
      if (state.status === 'queued') state.status = this.resumedStatus();
      this.record('phase.admitted', {
        scope: formatScope(scope), waitedMs: Date.now() - Date.parse(state.updatedAt),
      }, phase);
      this.emit('phase', { phase, status: 'running', scope });
      this.persist();
      this.emit('run', { state });
    }
    return grant;
  }

  /** Resume the phase's session with the operator's own words. Returns a refusal. */
  /**
   * The environment every child session starts from: the console's own, the
   * run's ACCOUNT layered over it (a profile's `CLAUDE_CONFIG_DIR`, a token's
   * `CLAUDE_CODE_OAUTH_TOKEN`, nothing for the machine login), then the
   * run-specific facts on top so they always win.
   *
   * ONE composer for all three spawn sites — attempt, closeout, and the
   * resume-with-instruction path recovery rides on. A switched run whose
   * closeout missed the account env would resume its transcript under the
   * wrong credentials, which is precisely the quiet kind of wrong. Resolved
   * per spawn, so an account switch lands on the very next session; a
   * resolution failure degrades to the machine login rather than blocking the
   * phase, and says so in the journal.
   */
  private async sessionEnv(extra: Record<string, string>): Promise<NodeJS.ProcessEnv> {
    const accountId = this.state?.accountId;
    let account: NodeJS.ProcessEnv | null = null;
    if (this.deps.accountEnv) {
      try {
        account = await this.deps.accountEnv(accountId);
        if (accountId && !account) {
          this.record('run.account-env-missing', { accountId });
        }
      } catch (error) {
        this.record('run.account-env-failed', { accountId, error: (error as Error).message });
      }
    }
    return {
      ...process.env,
      // Sessions run `validate.sh`/`phase-graph.sh` themselves per the skill's
      // protocol; under launchd the parent env has no registry, so F15's MCP
      // advisory was silently dead inside every unattended session. Resolved
      // per spawn — a registry change lands on the next session. Set-but-empty
      // is a real answer (a console with nothing registered); ABSENT deps mean
      // no registry is wired at all, and the advisory stays off.
      ...(this.deps.mcpIds ? { PE_MCP_SERVERS: this.deps.mcpIds().join(' ') } : {}),
      ...account,
      ...extra,
    };
  }

  /**
   * Move this run onto the account with the most headroom, mid-phase.
   *
   * True when a switch happened: `state.accountId` now names the account every
   * next spawn pays with, and — when the interrupted session's transcript
   * could be carried into that account's config dir — `sessionAccountId` says
   * the conversation went along. False means there was nowhere better to go,
   * and the caller falls back to waiting exactly as if no second account
   * existed.
   */
  private trySwitchAccount(phase: number, record: PhaseRecord, reason: string, model?: string): boolean {
    const state = this.state!;
    const from = state.accountId;
    // Named so per-model walls disqualify only where they bind: an account
    // exhausted on Opus still takes this phase when it runs on Sonnet.
    const next = this.deps.pickAccount?.(from, model ?? record.model ?? state.model);
    if (!next || next === (from ?? 'default')) return false;
    let ported = false;
    if (record.sessionId) {
      ported = this.deps.portTranscript?.(record.sessionId, record.sessionAccountId, next) ?? false;
      if (ported) {
        if (next === 'default') delete record.sessionAccountId;
        else record.sessionAccountId = next;
      }
    }
    this.record('phase.account-switch', { from: from ?? 'default', to: next, ported, reason }, phase);
    this.emit('phase', { phase, status: 'running', accountSwitch: { from: from ?? 'default', to: next } });
    if (next === 'default') delete state.accountId;
    else state.accountId = next;
    return true;
  }

  /** Is the recorded session's transcript where the CURRENT account will look? */
  private transcriptFollows(record: PhaseRecord): boolean {
    return (record.sessionAccountId ?? 'default') === (this.state?.accountId ?? 'default');
  }

  /**
   * The auth wall's first rung: move a run whose account will not sign in
   * onto one that will, before anything is spent. Each candidate is PROBED
   * in ranking order (`checkAuth` — headroom says nothing about a login) and
   * the first that answers signed-in takes the run; `tried` names the ones
   * that did not, for the errand. Off under `autoAccountSwitch: false`, and
   * impossible without the account-aware probe (the legacy one answers only
   * for the machine login).
   */
  private async switchAccountAtPreflight(detail?: string): Promise<{ switched: boolean; tried: string[] }> {
    const state = this.state!;
    const tried: string[] = [];
    if (this.deps.autoAccountSwitch?.() === false || !this.deps.checkAuth) return { switched: false, tried };
    const from = state.accountId;
    const ranked = this.deps.rankAccounts?.(from, state.model)
      ?? [this.deps.pickAccount?.(from, state.model)].filter((id): id is string => Boolean(id));
    for (const next of ranked) {
      if (next === (from ?? 'default')) continue;
      const probe = await this.deps.checkAuth(next === 'default' ? undefined : next);
      if (!probe.loggedIn) { tried.push(`switch-account → ${next}: not signed in`); continue; }
      this.record('run.account-switched', {
        from: from ?? 'default', to: next, at: 'preflight', reason: 'auth',
        detail: detail ?? null, tried,
      });
      if (next === 'default') delete state.accountId;
      else state.accountId = next;
      this.emit('run', { state });
      return { switched: true, tried };
    }
    return { switched: false, tried };
  }

  /**
   * Sit out a usage window. `pause` checkpoints the phase and stops for a
   * person (the `escalateFreeze` shape: phase back to pending with a session
   * to resume, run paused, reason on the run); `wait` — the default — puts
   * the RUN to `waiting` on the clock and sleeps. Restart-safe either way:
   * reconcile keeps `waitUntil`, the service re-arms the resume at boot.
   *
   * `errand` is the one ask left on the run while it waits (a reset too far
   * out and no other account), cleared when the wait ends; `policy` overrides
   * the run's `onLimit` for a wall the policy does not speak for (a model
   * window is not the shared window). Answers what the attempt loop does
   * next: `continue` (the window passed, try again) or `stop` (paused,
   * aborted, or the run halted meanwhile).
   */
  private async waitOutWindow(
    phase: number, record: PhaseRecord, at: Date, reason: string,
    opts: { errand?: Errand; policy?: 'wait' | 'pause' } = {},
  ): Promise<'continue' | 'stop'> {
    const state = this.state!;
    const policy = opts.policy ?? ((state.onLimit ?? 'wait') === 'pause' ? 'pause' : 'wait');
    if (policy === 'pause') {
      record.status = 'pending';
      if (record.sessionId) record.resumeSessionId = record.sessionId;
      state.status = 'paused';
      state.waitUntil = at.toISOString();
      state.finishedReason = `usage limit — resets ${at.toLocaleString()}. `
        + 'Continue now under another account, or wait for the window.';
      if (opts.errand) {
        state.errand = opts.errand;
        this.record('run.errand', { ...opts.errand, reason, by: 'runner' });
      }
      this.record('run.limit-paused', { until: state.waitUntil, reason }, phase);
      this.persist();
      this.emit('run', { state });
      return 'stop';
    }

    state.status = 'waiting';
    state.waitUntil = at.toISOString();
    if (opts.errand) {
      state.errand = opts.errand;
      this.record('run.errand', { ...opts.errand, reason, by: 'runner' });
    }
    this.record('run.waiting', { until: state.waitUntil, reason });
    this.persist();
    await this.sleep(Math.max(0, at.getTime() - this.now().getTime()));
    if (this.abort?.signal.aborted) return 'stop';
    // A wait can be hours, which makes it the likeliest place for a pause
    // to be armed — and writing `running` unconditionally is how one got
    // thrown away. `state.pause` is the durable record of the request;
    // the status word is derived from it, never the other way round.
    // Compare-and-set for the same reason as after the queue wait: a
    // status another lane wrote while this one slept is not this lane's
    // to overwrite.
    if (state.status === 'waiting') state.status = this.resumedStatus();
    state.waitUntil = null;
    // The ask was about this wait; the wait is over.
    if (opts.errand && state.errand === opts.errand) delete state.errand;
    // And a lane woken into a halted run must stand down, not spawn
    // attempt N+1 hours after the run stopped.
    if (state.halt) {
      record.status = 'interrupted';
      record.note = 'the run halted while this phase waited for a usage window';
      return 'stop';
    }
    return 'continue';
  }

  /**
   * The budget wall's first rung: a spent run budget is raised ONCE, by
   * `budgetAutoRaisePct` and never past the ladder's per-run USD cap, so a
   * run a few dollars short of done does not stop for a person over the
   * rounding. Journalled; the second exhaustion is the errand. False when
   * there is nothing to raise to: already raised, the raise switched off, the
   * budget at or above the cap, or a raise the run has already overspent.
   */
  private raiseBudgetOnce(): boolean {
    const state = this.state!;
    if (!state.runBudgetUsd || state.budgetRaise) return false;
    const pct = this.deps.budgetAutoRaisePct?.() ?? DEFAULT_BUDGET_RAISE_PCT;
    if (!(pct > 0)) return false;
    const cap = this.deps.ladderCaps?.().perRunUsd ?? DEFAULT_LADDER_CAPS.perRunUsd;
    const from = state.runBudgetUsd;
    const to = Math.round(Math.min(from * (1 + pct / 100), Math.max(cap, from)) * 100) / 100;
    if (to <= from || to <= state.spentUsd) return false;
    state.budgetRaise = { from, to, pct, at: new Date().toISOString() };
    state.runBudgetUsd = to;
    this.record('run.budget-raised', { from, to, pct, cap, spentUsd: state.spentUsd });
    this.emit('run', { state });
    this.persist();
    return true;
  }

  /** The budget halt, with the errand naming what was already tried. */
  private haltOnBudget(): void {
    const state = this.state!;
    const raise = state.budgetRaise;
    const cap = this.deps.ladderCaps?.().perRunUsd ?? DEFAULT_LADDER_CAPS.perRunUsd;
    const pct = this.deps.budgetAutoRaisePct?.() ?? DEFAULT_BUDGET_RAISE_PCT;
    const tried = raise
      ? [`raise-budget → raised $${raise.from} → $${raise.to} (${raise.pct}%), spent again`]
      : !(pct > 0)
        ? ['raise-budget → switched off (budgetAutoRaisePct is 0)']
        : [`raise-budget → not possible within the $${cap} per-run ladder cap`];
    const errand = errandFor('resource-wall:budget', tried, 0);
    state.errand = errand;
    this.record('run.errand', { ...errand, reason: `the run budget of $${state.runBudgetUsd} is spent`, by: 'runner' });
    this.halt(
      `the run budget of $${state.runBudgetUsd} is spent${raise ? ` (raised once from $${raise.from})` : ''}`,
      undefined, 'budget',
    );
  }

  private async resumeWithInstruction(
    phase: number, instruction: string, haltedWith?: string | null,
  ): Promise<string | null> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const sessionId = record.sessionId ?? record.resumeSessionId;
    if (!sessionId) {
      return `phase ${phase} has no session left to resume — retry it instead, or close it by hand`;
    }

    const spawn = this.deps.spawn ?? spawnClaude;
    const board = await this.board();
    // The operator's words first — they are the newest fact and the reason this
    // resume exists — then what the phase already knows went wrong, then the
    // closeout procedure. A resumed session has the earlier transcript in its
    // own context, but not the runner's verdict on it: the verification ran
    // AFTER that session exited, so the failure it is being asked to fix is
    // something it has never seen.
    const prompt = [
      instruction.trim(),
      this.retryContext(record, haltedWith),
      closeoutPrompt(state.slug, phase, board.states[phase] ?? 'unknown',
        state.gitMode === 'new-branch' ? `pe/${state.slug}` : undefined),
    ].filter(Boolean).join('\n\n---\n\n');

    this.record('phase.resume-instruction', { sessionId, instruction: instruction.slice(0, 2_000) }, phase);
    // A resumed phase IS running, and nothing said so. The record kept whatever
    // terminal status it had halted on, so the header clock never started, the
    // dashboard counted the run as stopped, and the runs list showed a finished
    // run with a live session underneath it. The phase clock reads `startedAt`,
    // which is left alone when the phase already has one — this is a second
    // stretch of the same phase, not a new one.
    record.status = 'running';
    record.startedAt ??= new Date().toISOString();
    record.attemptStartedAt = new Date().toISOString();
    this.persist();
    this.emit('phase', { phase, status: 'running', model: record.model ?? state.model });
    this.emit('run', { state });

    let outcome;
    try {
      outcome = await spawn({
        prompt,
        cwd: state.root,
        model: record.model ?? state.model,
        effort: record.effort ?? state.effort,
        name: `${state.slug} p${phase} recover`,
        resume: sessionId,
        budgetUsd: state.phaseBudgetUsd,
        maxTurns: CLOSEOUT_MAX_TURNS,
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        env: await this.sessionEnv({
          PE_OWNER: autopilotOwner(state.id),
          PE_SCOPE: formatScope(this.lanes.get(phase)?.grant?.scope ?? await this.scopeFor(phase)),
          PE_OUTCOME_FILE: this.outcomePath(phase),
          // Where a decision goes. Separate from the outcome file on purpose:
          // an outcome is read once and consumed, a ruling is appended and
          // kept, and a session must be able to record the second without
          // touching the first.
          PE_RULINGS_FILE: rulingsFile(this.state!.root, this.state!.slug),
        }),
        signal: this.abort?.signal,
        // The same wiring `attempt` uses, and for the same reason: `state.child`
        // is what Freeze and Stop signal, and what the console reads to know a
        // session is alive. Recorded here it was a bare pid nobody else could
        // see, so a recovery could not be frozen or stopped at all.
        onPid: (pid) => {
          this.attachPid(phase, pid);
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      });
    } finally {
      this.attachPid(phase, null);
      this.attachHandle(phase, null);
    }

    state.spentUsd += outcome.costUsd;
    record.costUsd += outcome.costUsd;
    // The same dollars, booked a second time against the ladder rung that
    // caused this attempt — a no-op unless the ladder is what reboarded it.
    chargeRung(state.recoveries?.[String(record.phase)], outcome.costUsd);
    record.turns = (record.turns ?? 0) + outcome.turns;
    if (outcome.sessionId) record.sessionId = outcome.sessionId;
    if (outcome.resultText) record.said = outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200);
    // Mark it attempted so `confirm()` does not immediately spawn a second one.
    record.closeout = { at: new Date().toISOString(), ok: true, sessionId, note: 'resumed with an operator instruction' };
    this.record('phase.resume-done', { costUsd: outcome.costUsd, turns: outcome.turns, said: record.said }, phase);
    return null;
  }

  /**
   * Mint this run's token and write the settings the children will load.
   *
   * The settings carry two things that must not be confused: `permissions.deny`,
   * which the CLI enforces itself and which was measured holding with this
   * console unreachable, and the HTTP hook, which fails open and therefore
   * carries workflow rather than safety.
   */
  private armSettings(runId: string): string | null {
    const { approvals, origin } = this.deps;
    if (!approvals || !origin) {
      log.warn('runner.no-approvals', {
        note: 'no approval broker configured — sessions run on the deny rules alone',
      });
      return null;
    }
    try {
      const token = approvals.arm(runId);
      const path = this.writeSettings(runId, token, origin);
      this.record('run.settings', { path, profile: this.profile() });
      return path;
    } catch (error) {
      log.error('runner.settings', { error });
      return null;
    }
  }

  /** This run's profile. Absent on every run written before profiles existed. */
  private profile(): PermissionProfile {
    return this.state?.permissionProfile ?? 'guarded';
  }

  private writeSettings(runId: string, token: string, origin: string): string {
    return writeSettingsFile(runId, buildSettings({
      runId,
      token,
      origin,
      policy: loadPolicyFor(this.state?.slug ?? null),
      profile: this.profile(),
      openPrCarveOut: this.openPrCarveOut(),
    }));
  }

  /**
   * Whether this run gets the push/PR carve-out — new-branch runs that will
   * open a PR, and nothing else. `rearmSettings` already rebuilds the settings
   * file when the run's git mode is patched mid-run.
   */
  private openPrCarveOut(): boolean {
    return this.state?.gitMode === 'new-branch' && this.state.openPr !== false;
  }

  /**
   * Rewrite this run's settings after a profile change, keeping the token.
   *
   * The file is read by the *next* phase's child — the one already running
   * loaded it at startup and cannot reload it, which is why this is honest
   * about applying from the next phase. What does change immediately is the
   * hook classifier: it reads the profile off the live state on every call, so
   * the running phase stops being asked from its very next tool use.
   */
  private rearmSettings(): void {
    const { approvals, origin } = this.deps;
    if (!approvals || !origin || !this.state) return;
    // This run's token, named. With a pool, "the live token" is a question with
    // several answers, and rewriting our settings file with a neighbour's would
    // make every subsequent hook call from our child unauthorised — which this
    // hook reads as silence, and silence fails open.
    const token = approvals.liveToken(this.state.id);
    if (!token) return;
    try {
      this.settingsPath = this.writeSettings(this.state.id, token, origin);
      this.record('run.settings', { path: this.settingsPath, profile: this.profile() });
    } catch (error) {
      log.error('runner.settings', { error });
    }
  }

  /**
   * Reconcile a run whose console went away mid-phase. Returns a reason when
   * the run must not proceed on its own.
   *
   * The dangerous case is a child that outlived us: it was reparented, it is
   * still editing the repo, and we cannot see its output any more. Starting a
   * second session on that phase would have two agents writing one tree. So it
   * parks, loudly, with the pid to look at.
   */
  private adopt(state: RunState): string | null {
    // Every lane the last console recorded, however it spelled them. Checking
    // only `state.child` would let a run whose mirror happened to have exited
    // start a second session on a phase another child is still writing.
    const children = childrenOf(state);
    if (!children.length) return null;

    const alive = children.filter((child) => pidAlive(child.pid));
    if (alive.length) {
      const first = alive[0];
      state.status = 'parked';
      state.halt = {
        at: new Date().toISOString(),
        reason: alive.length === 1
          ? `a session from an earlier console is still running (pid ${first.pid}, phase ${first.phase}). `
            + 'Let it finish or stop it, then start this run again.'
          : `${alive.length} sessions from an earlier console are still running (`
            + `${alive.map((child) => `pid ${child.pid}, phase ${child.phase}`).join('; ')}). `
            + 'Let them finish or stop them, then start this run again.',
        phase: first.phase,
        kind: 'orphaned-session',
      };
      for (const child of alive) phaseRecord(state, child.phase).status = 'running';
      state.stoppedBy = 'system';
      this.record('run.adopt.alive', {
        pids: alive.map((child) => child.pid), phases: alive.map((child) => child.phase),
      }, first.phase);
      return state.halt.reason;
    }

    state.child = null;
    delete state.children;
    // The phase may in fact have completed — the child could have written its
    // handoff and exited in the moment the console was gone. The board says so
    // or it does not; either way this is checked, never assumed.
    for (const child of children) {
      const record = phaseRecord(state, child.phase);
      record.status = 'interrupted';
      record.note = `the console stopped while phase ${child.phase} was running (pid ${child.pid})`;
      this.record('run.adopt.interrupted', { pid: child.pid, phase: child.phase }, child.phase);
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Control
   * ---------------------------------------------------------------- */

  /**
   * Finish the current phase, then stop.
   *
   * Returns whether it took effect here. It does not when nothing is driving
   * this run — after a console restart there is no loop to tell — and the
   * caller then edits the checkpoint instead. Answering `false` rather than
   * returning silently is the whole point: a Pause that quietly does nothing
   * is indistinguishable from one that worked.
   */
  pause(by = 'console'): boolean {
    if (!this.state || !this.driving) return false;
    // A recovery is one session, not the phase loop — and `pausing` is a word
    // only the loop reads. Arming it here lit the Pause button, changed the
    // badge to "pausing", and stopped precisely nothing, which is the failure
    // this method's own comment calls the worst of the three. Freeze stops a
    // recovery where it stands, and Stop ends it; there is no boundary for a
    // Pause to wait for, so saying no is the honest answer.
    if (this.recovering) return false;
    // A halt outranks a pause: the run is already stopping for a stronger
    // reason, and writing `pausing` over a draining `halting` would repaint
    // the stop as an operator's tidy boundary pause — card urgency lost.
    if (this.state.halt) return false;
    if (this.state.status === 'pausing') return true;
    this.state.status = 'pausing';
    this.state.pause = {
      requestedAt: new Date().toISOString(),
      afterPhase: this.state.activePhase,
      by,
    };
    this.record('run.pause-requested', { afterPhase: this.state.pause.afterPhase, by });
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /* ---- freezing the phase itself, rather than waiting for its boundary ---- */

  /**
   * Stop the running session where it stands.
   *
   * The existing Pause waits for a phase boundary, which is correct and is
   * often not what is wanted: watching a phase walk into something wrong, the
   * useful control is the one that stops it *now*, before it writes the next
   * file — and `SIGSTOP` does that between one syscall and the next, losing
   * nothing. The session is not killed, not asked to wrap up, not told
   * anything: it is simply not scheduled until `thaw()`.
   *
   * Held too long it converts to a checkpoint instead — see `FREEZE_ESCALATE_MS`.
   */
  freeze(by = 'console', phase?: number | null): boolean {
    const state = this.state;
    if (!state || !this.driving) return false;
    // The lane named — or, with nothing named, EVERY lane holding a live
    // session. "Freeze" from the run's own controls means "stop the run where
    // it stands", and freezing only the mirror lane of three left two sessions
    // editing under a run the console then called frozen.
    const targets = phase != null
      ? [this.lanes.get(phase)].filter((lane): lane is Lane => Boolean(lane))
      : [...this.lanes.values()];
    const eligible = targets.filter((lane) => !lane.frozen && lane.pid != null && pidAlive(lane.pid));
    if (!eligible.length) {
      // Everything asked for is already frozen: truthful success. Nothing with
      // a live pid at all: refusal, so the button can say so.
      return targets.some((lane) => lane.frozen);
    }

    let frozenCount = 0;
    for (const lane of eligible) {
      const pid = lane.pid!;
      try { process.kill(pid, 'SIGSTOP'); } catch (error) {
        log.warn('runner.freeze', { pid, error });
        continue;
      }
      const at = new Date().toISOString();
      const escalateAt = new Date(this.now().getTime() + FREEZE_ESCALATE_MS).toISOString();
      lane.frozen = { at, by, escalateAt };
      lane.freezeTimer = setTimeout(() => this.escalateFreeze(lane), FREEZE_ESCALATE_MS);
      lane.freezeTimer.unref?.();
      frozenCount++;
      this.record('run.frozen', { pid, phase: lane.phase, by, escalateAt }, lane.phase);
    }
    if (!frozenCount) return false;

    this.syncFrozenStatus();
    this.syncMirror();
    this.syncFreezeMirror();
    this.persist();
    this.emit('run', { state });
    return true;
  }

  /** Let a frozen session carry on, mid-token, in the same process. */
  thaw(phase?: number | null): boolean {
    const state = this.state;
    if (!state) return false;
    // The lane named, or every frozen lane — thaw-all is the undo of
    // freeze-all, and thawing only the first of two frozen lanes left the
    // other stopped behind a run that had gone back to `running`.
    const targets = phase != null
      ? [this.lanes.get(phase)].filter((lane): lane is Lane => Boolean(lane?.frozen))
      : [...this.lanes.values()].filter((lane) => lane.frozen);
    if (!targets.length) return false;

    let thawed = 0;
    for (const lane of targets) {
      const pid = lane.pid;
      this.clearFreezeTimer(lane);
      if (pid && pidAlive(pid)) {
        try { process.kill(pid, 'SIGCONT'); } catch (error) {
          log.warn('runner.thaw', { pid, error });
          continue;
        }
      }
      // Frozen time is not work time. Left in, an hour on the kitchen table
      // would show up as an hour the phase spent thinking, and every
      // throughput figure built on it would be wrong.
      const frozenMs = Math.max(0, this.now().getTime() - Date.parse(lane.frozen!.at));
      if (frozenMs) {
        const record = phaseRecord(state, lane.phase);
        record.frozenMs = (record.frozenMs ?? 0) + frozenMs;
      }
      lane.frozen = null;
      thawed++;
      this.record('run.thawed', { pid, frozenMs }, lane.phase);
    }
    if (!thawed) return false;

    // Same rule as the wait-until disposition: a pause armed while the session
    // was frozen is still a pause, and thawing is not taking it back — that is
    // what `resumePause` is for. Only back to `running` once NOTHING is frozen:
    // with lanes, thawing one of two still leaves a session stopped.
    this.syncFrozenStatus();
    this.syncMirror();
    this.syncFreezeMirror();
    this.persist();
    this.emit('run', { state });
    return true;
  }

  /** Any lane the operator has stopped where it stands. */
  private frozenLane(): Lane | undefined {
    for (const lane of this.lanes.values()) if (lane.frozen) return lane;
    return undefined;
  }

  /**
   * `frozen` is the run's word only while NOTHING is left running: with lanes,
   * a freeze can cover one session of three, and the run is still running.
   * `state.pause` survives underneath — `resumedStatus()` restores `pausing`
   * when the last freeze lifts.
   */
  private syncFrozenStatus(): void {
    const state = this.state;
    if (!state) return;
    const live = [...this.lanes.values()].filter((lane) => lane.pid != null);
    const allFrozen = live.length > 0 && live.every((lane) => lane.frozen);
    if (allFrozen) state.status = 'frozen';
    else if (state.status === 'frozen') state.status = this.resumedStatus();
  }

  /**
   * Recompute the single-slot `state.freeze` from the lane table.
   *
   * Lowest frozen phase, the same stability rule as `mirrorLane()`: the slot
   * is what pre-lanes readers watch, and it must not flip between lanes on
   * every write. Null when nothing is frozen — a stale block would make a live
   * run look held.
   */
  private syncFreezeMirror(): void {
    const state = this.state;
    if (!state) return;
    let chosen: Lane | undefined;
    for (const lane of this.lanes.values()) {
      if (!lane.frozen) continue;
      if (!chosen || lane.phase < chosen.phase) chosen = lane;
    }
    state.freeze = chosen
      ? {
        at: chosen.frozen!.at,
        phase: chosen.phase,
        pid: chosen.pid ?? 0,
        by: chosen.frozen!.by,
        escalateAt: chosen.frozen!.escalateAt,
      }
      : null;
  }

  /**
   * A freeze nobody came back to. Convert it into something that survives a
   * closed laptop: stop the child, keep its session id, and leave the phase
   * pending so Continue re-runs it with `--resume` rather than from scratch.
   */
  private escalateFreeze(target?: Lane): void {
    const state = this.state;
    // The timer names its lane; a caller that does not — the test that drives
    // this directly rather than waiting fifteen real minutes — means "the one
    // that is frozen", which is what it meant when there could only be one.
    const lane = target ?? this.frozenLane();
    if (!lane) return;
    lane.freezeTimer = null;
    if (!state || !lane.frozen) return;
    const pid = lane.pid;
    const phase = lane.phase;
    const record = phaseRecord(state, phase);
    const sessionId = record?.sessionId;

    lane.checkpointed = true;
    lane.frozen = null;
    if (pid && pidAlive(pid)) {
      // SIGCONT first, or SIGTERM is queued against a stopped process and its
      // own SessionEnd hooks never run.
      try { process.kill(pid, 'SIGCONT'); } catch { /* already gone */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }

    if (record) {
      record.status = 'pending';
      record.resumeSessionId = sessionId;
      record.note = sessionId
        ? `frozen for ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes, then checkpointed — `
          + `Continue resumes session ${sessionId}`
        : 'frozen too long and checkpointed, but the session reported no id to resume — '
          + 'Continue starts this phase again from its boot prompt';
    }
    lane.pid = null;
    this.syncMirror();
    this.syncFreezeMirror();
    // Only when this was the last thing running. With another lane still
    // OPEN — live or not yet spawned or itself checkpointed — writing `paused`
    // here would tell the console the run had stopped while a session carried
    // on under it, and nulling the halt would erase a stop another lane wrote.
    // The old test was "every other lane has no pid", which a lane between
    // admission and spawn, or one just checkpointed, passes.
    const others = [...this.lanes.values()].filter((other) => other !== lane);
    if (!others.length) {
      state.status = 'paused';
      // The freeze was the operator's act; its escalation is their stop.
      state.stoppedBy = 'operator';
      state.halt = null;
    } else {
      this.syncFrozenStatus();
    }
    this.record('run.freeze-escalated', {
      pid, phase, sessionId: sessionId ?? null, afterMs: FREEZE_ESCALATE_MS,
    }, phase ?? undefined);
    this.persist();
    this.emit('run', { state });
  }

  private clearFreezeTimer(lane: Lane): void {
    if (!lane.freezeTimer) return;
    clearTimeout(lane.freezeTimer);
    lane.freezeTimer = null;
  }

  /**
   * Move this run onto another account NOW — the operator's verb, distinct
   * from the on-limit policy doing it by itself.
   *
   * A live lane is checkpointed the way an escalated freeze checkpoints one
   * (SIGCONT+SIGTERM, session id kept, phase back to `pending`) but with
   * `carryOn` set, so the loop keeps driving and the very next attempt spawns
   * under the new account — porting the transcript on its way in. A lane
   * asleep on a usage window holds no process at all; the wake event ends its
   * sleep so it, too, re-attempts now instead of at the old account's reset.
   */
  switchAccount(accountId: string | undefined, by = 'console'):
    { ok: true; checkpointed: number } | { ok: false; reason: string } {
    const state = this.state;
    if (!state) return { ok: false, reason: 'this console holds no run for that plan' };
    const target = accountId && accountId !== 'default' ? accountId : undefined;
    if ((state.accountId ?? 'default') === (target ?? 'default')) {
      return { ok: false, reason: `the run is already on ${target ?? 'the machine login'}` };
    }
    const from = state.accountId ?? 'default';
    if (target) state.accountId = target;
    else delete state.accountId;

    let checkpointed = 0;
    for (const lane of this.lanes.values()) {
      if (lane.pid == null || !pidAlive(lane.pid)) continue;
      this.checkpointLane(lane, `account switch by ${by}`);
      checkpointed++;
    }
    this.haltSignal.dispatchEvent(new Event('wake'));
    this.record('run.account-switch', { from, to: target ?? 'default', by, checkpointed });
    this.persist();
    this.emit('run', { state });
    return { ok: true, checkpointed };
  }

  /** The switch's half of `escalateFreeze`: end the child, keep the session. */
  private checkpointLane(lane: Lane, why: string): void {
    const state = this.state!;
    const record = phaseRecord(state, lane.phase);
    const sessionId = record.sessionId;
    this.clearFreezeTimer(lane);
    lane.frozen = null;
    lane.checkpointed = true;
    lane.checkpointNote = { carryOn: true };
    if (lane.pid && pidAlive(lane.pid)) {
      // SIGCONT first, or SIGTERM is queued against a stopped process and its
      // own SessionEnd hooks never run — same order as the freeze escalation.
      try { process.kill(lane.pid, 'SIGCONT'); } catch { /* already gone */ }
      try { process.kill(lane.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    record.status = 'pending';
    record.resumeSessionId = sessionId;
    record.note = sessionId
      ? `checkpointed (${why}) — the next attempt resumes session ${sessionId}`
      : `checkpointed (${why}); the session had no id yet, so the next attempt starts from its boot prompt`;
    // Recomputed, not nulled: another lane may still be frozen, and its mirror
    // must survive this lane's checkpoint.
    this.syncFreezeMirror();
    this.record('phase.checkpointed', { sessionId: sessionId ?? null, why }, lane.phase);
  }

  /** Take back a pause that has not been reached yet. */
  resumePause(): boolean {
    if (!this.state || !this.driving) return false;
    if (this.state.status !== 'pausing') return false;
    this.state.status = 'running';
    this.state.pause = null;
    this.record('run.pause-cancelled');
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /** Stop now: the child gets SIGTERM so its own SessionEnd hooks still run. */
  async stop(): Promise<void> {
    if (!this.state) return;
    // Nothing is driving: the loop already ended and left a status behind. A
    // Stop that quietly does nothing here is worse than no Stop at all — the
    // operator presses it, the badge still says `running`, and the console has
    // told them a lie about its own state.
    if (!this.driving) {
      if (IN_FLIGHT.includes(this.state.status)) {
        // Read the status BEFORE overwriting it. This line exists to record
        // what was interrupted, and taking it afterwards made it record the
        // word "interrupted" every single time — the one fact it was for.
        const was = this.state.status;
        this.state.status = 'interrupted';
        this.state.stoppedBy = 'operator';
        this.state.child = null;
        this.state.pause = null;
        this.state.halt ??= { at: new Date().toISOString(), reason: 'stopped by the operator', phase: this.state.activePhase ?? undefined };
        this.record('run.stopped-while-idle', { was });
        this.persist();
        this.emit('run', { state: this.state });
      }
      return;
    }
    this.stopRequested = true;
    // Every lane, not just the mirror. A Stop that killed one of three sessions
    // and reported the run stopped would leave two agents editing a tree with
    // no supervisor and no console claiming responsibility for them.
    const lanes = [...this.lanes.values()];
    let wasFrozen = false;
    for (const lane of lanes) {
      this.clearFreezeTimer(lane);
      // A stopped process cannot act on SIGTERM: the signal is queued and its
      // own SessionEnd hooks never run, so a frozen phase stopped from the
      // console would sit there until SIGKILL. Wake it first, then ask it to
      // stop.
      if (lane.frozen) wasFrozen = true;
      lane.frozen = null;
      if (lane.pid && pidAlive(lane.pid)) {
        try { process.kill(lane.pid, 'SIGCONT'); } catch { /* already gone */ }
      }
    }
    // The persisted `children[].frozen` flags must clear with the lanes they
    // describe, or the checkpoint says two contradictory things about one pid.
    this.syncMirror();
    this.state.freeze = null;
    this.state.status = 'stopping';
    this.record('run.stop-requested', {
      pids: lanes.map((lane) => lane.pid).filter((pid): pid is number => pid != null),
      phases: lanes.map((lane) => lane.phase),
      wasFrozen,
    });
    this.persist();
    // Aborts the spawns AND every admission still queued — a stopped run must
    // not leave an entry in the queue that would start a session later.
    this.abort?.abort();
    for (const lane of lanes) {
      const pid = lane.pid;
      if (!pid) continue;
      setTimeout(() => {
        if (pidAlive(pid)) {
          log.warn('runner.sigkill', { pid, note: 'child ignored SIGTERM' });
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }, SIGTERM_GRACE_MS).unref();
    }
    await this.driving;
  }

  /**
   * Stop ONE lane's session and let the rest of the run carry on.
   *
   * `stop()` is the whole-run verb: it aborts every spawn and drains the loop.
   * Watching one phase go wrong in a three-lane run, that is a bigger hammer
   * than the situation calls for — this ends a single session (SIGCONT first
   * for the same reason `stop()` sends it, then SIGTERM, then the same
   * grace-then-SIGKILL backstop), records the phase `interrupted`, and hands
   * the loop back to its scheduling. It is neither a failure (the streak is
   * untouched) nor an endorsement; dependents of the stopped phase never
   * become ready, so the run parks at its end naming them honestly.
   */
  stopPhase(phase: number, by = 'console'): { ok: true } | { ok: false; reason: string } {
    const state = this.state;
    if (!state || !this.driving) return { ok: false, reason: 'nothing is driving this run' };
    const record = state.phases[String(phase)];
    const lane = this.lanes.get(phase);
    if (!lane) {
      // No lane yet: a record can still be settled out of the admission queue.
      // The arrival guard in `runPhaseAdmitted` abandons a settled phase, so
      // the eventually-granted admission releases without spawning.
      if (record?.status === 'queued') {
        record.status = 'interrupted';
        record.note = `stopped by ${by} before it started — the rest of the run carries on`;
        record.endedAt = new Date().toISOString();
        this.record('phase.stopped', { by, before: 'admission' }, phase);
        this.persist();
        this.emit('phase', { phase, status: record.status });
        return { ok: true };
      }
      return { ok: false, reason: this.phaseMismatch(phase) ?? `phase ${phase} is not running` };
    }
    if (record?.status === 'verifying' || record?.status === 'awaiting-verification') {
      return {
        ok: false,
        reason: `phase ${phase} is being verified — its session already ended, so there is nothing to stop`,
      };
    }

    this.clearFreezeTimer(lane);
    if (lane.frozen) {
      // Credit the held time before the record settles, exactly as a thaw would.
      const frozenMs = Math.max(0, this.now().getTime() - Date.parse(lane.frozen.at));
      if (frozenMs && record) record.frozenMs = (record.frozenMs ?? 0) + frozenMs;
      lane.frozen = null;
    }
    lane.stopped = { at: new Date().toISOString(), by };
    const pid = lane.pid;
    if (pid && pidAlive(pid)) {
      // A stopped process cannot act on SIGTERM — wake it first, the same
      // order as the freeze escalation.
      try { process.kill(pid, 'SIGCONT'); } catch { /* already gone */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        if (pidAlive(pid)) {
          log.warn('runner.sigkill', { pid, note: 'child ignored SIGTERM after a phase stop' });
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }, SIGTERM_GRACE_MS).unref();
    }
    this.syncMirror();
    this.syncFreezeMirror();
    this.syncFrozenStatus();
    this.record('phase.stop-requested', { pid: pid ?? null, by }, phase);
    this.persist();
    this.emit('run', { state });
    return { ok: true };
  }

  /**
   * A per-lane stop, consumed: settle the record and hand the loop back.
   *
   * `interrupted` rather than `failed`, and the failure streak untouched — a
   * stop is the operator's decision, not a diagnosis. The session id is kept
   * so Retry can offer to resume rather than restart.
   */
  private settleStoppedLane(
    lane: Lane, phase: number, before?: string,
  ): { carryOn: boolean; completed: boolean } {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const by = lane.stopped?.by ?? 'console';
    lane.stopped = null;
    record.status = 'interrupted';
    record.note = `stopped by ${by} — the rest of the run carries on`;
    record.endedAt = new Date().toISOString();
    record.resumeSessionId ??= record.sessionId;
    this.record('phase.stopped', { by, ...(before ? { before } : {}) }, phase);
    this.emit('phase', { phase, status: record.status });
    return { carryOn: true, completed: false };
  }

  /**
   * Put a question to the phase that is running right now.
   *
   * A phase is otherwise a process you can watch and cannot speak to: the only
   * way to ask it anything was to stop it, which throws away the session. The
   * session's stdin is held open for exactly this, so the question becomes one
   * more turn in the same conversation — same context, same warm cache — and
   * the phase carries on afterwards.
   *
   * The framing is not decoration. Dropped in bare, "why did you skip the
   * cache?" reads as a new instruction and can quietly redirect the phase; the
   * preamble says what it is and what to do after answering.
   */
  ask(question: string, by = 'console', key?: string, phase?: number | null): AskResult {
    return this.inject('ask', question, by, key, phase);
  }

  /**
   * Tell the phase to do something differently. See `frameSteer` for why this
   * is a separate verb rather than an Ask with different words.
   */
  steer(instruction: string, by = 'console', key?: string, phase?: number | null): AskResult {
    return this.inject('steer', instruction, by, key, phase);
  }

  /**
   * One write to a live session's stdin, whatever it is called on the button.
   *
   * `key` is the caller's idempotency key. Two POSTs carrying the same one — a
   * double click, a retried fetch, a phone that reconnected mid-request — are
   * one write and one journal line. Without it the second POST is a second turn
   * for the model to answer and, before the close rule was rewritten, a
   * permanent leak in the counter that decided when stdin closed.
   */
  private inject(
    kind: 'ask' | 'steer', body: string, by: string, key?: string, targetPhase?: number | null,
  ): AskResult {
    const text = body.trim();
    if (!text) return { ok: false, reason: kind === 'ask' ? 'nothing to ask' : 'nothing to say' };
    if (text.length > 8_000) return { ok: false, reason: 'that is longer than a message' };

    if (key) {
      const seen = this.injected.get(key);
      // Answered from the record rather than re-sent. The caller cannot tell the
      // difference, which is the point of an idempotency key.
      if (seen) return { ...seen, repeated: true };
    }

    // The named lane's stdin, not "the" session's. With three phases running,
    // a question typed under phase 5 that arrived at phase 2's session would
    // be answered confidently by the wrong agent about the wrong work.
    const lane = this.laneFor(targetPhase);
    const handle = lane?.handle ?? (targetPhase == null ? this.handle : null);
    if (!handle?.open()) {
      return {
        ok: false,
        reason: this.driving
          ? 'no session is running just now — the run is between phases, or verifying'
          : 'nothing is running to ask',
      };
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    const mark = markFor(kind, id);
    const framed = kind === 'ask' ? frameQuestion(text, mark) : frameSteer(text, mark);
    if (!handle.send(framed)) {
      return { ok: false, reason: 'the session stopped accepting input as the message was sent' };
    }

    const result: AskResult = { ok: true, mark: `${kind}:${id}` };
    if (key) this.remember(key, result);

    const phase = lane?.phase ?? this.state?.activePhase ?? undefined;
    // Two event names, on purpose: a journal that records a course correction
    // as a question cannot later explain why the phase changed direction.
    this.record(kind === 'ask' ? 'phase.asked' : 'phase.steered', {
      by, mark: result.mark, [kind === 'ask' ? 'question' : 'instruction']: text.slice(0, 500),
    }, phase);
    // Shown immediately rather than waiting for the CLI's echo: the operator
    // pressed a key and is owed the evidence of it. The echo arrives a moment
    // later carrying the same mark, and the console folds it into this line as
    // a delivery tick rather than printing the message a second time.
    this.emit('stream', { phase, kind: 'injected', text, mark: result.mark, steer: kind === 'steer' });
    return result;
  }

  /** Bounded, and oldest-first: an idempotency key is only interesting briefly. */
  private remember(key: string, result: AskResult): void {
    this.injected.set(key, result);
    while (this.injected.size > MAX_INJECT_KEYS) {
      const oldest = this.injected.keys().next().value;
      if (oldest === undefined) break;
      this.injected.delete(oldest);
    }
  }

  /**
   * Stop the run and say a person is needed — without calling it a failure.
   *
   * The case this exists for is an approval nobody answered. That used to
   * resolve as a plain `deny`, and a denial is a *verdict*: the session reads
   * "no" as a decision about the work and adapts around it, so a `git commit`
   * refused because everyone was asleep became a phase that carried on with an
   * uncommitted tree and its `consecutiveFailures` climbing. Parking says the
   * true thing instead — the question is still open, nothing is wrong with the
   * work, and the phase can be retried the moment someone answers.
   */
  /** A park that is draining: the finalizer lands on `parked`, not `halted`. */
  private parkPending = false;

  park(reason: string, phase: number | null = null): boolean {
    if (!this.state) return false;
    if (this.state.halt) return false;
    const at = phase ?? this.state.activePhase;
    this.state.halt = { at: new Date().toISOString(), reason, ...(at !== null ? { phase: at } : {}) };
    // With lanes still live the run is DRAINING, not stopped — the same reason
    // `halt()` uses `halting`, and for the same cost when it is got wrong:
    // `parked` is not IN_FLIGHT, so a console that died mid-drain would never
    // pid-check those children. `park` is also what the approval-timeout hook
    // calls, from OUTSIDE the loop, while a lane is live: measured on a real
    // run, 17 minutes of sessions editing trees under a `parked` status.
    // `parkPending` carries the intended terminal word through the drain, so
    // the finalizer lands on `parked` rather than `halted` — a park and a halt
    // are different facts and the operator is shown different things for them.
    this.parkPending = this.lanes.size > 0;
    this.state.status = this.lanes.size ? 'halting' : 'parked';
    this.state.stoppedBy = 'system';
    // Not counted against the failure budget: nobody being awake is not the
    // phase going wrong twice.
    this.state.consecutiveFailures = 0;
    this.record('run.parked', { reason }, at ?? undefined);
    log.warn('runner.parked', { runId: this.state.id, slug: this.state.slug, reason, phase: at });
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /** Take a phase off this run's list without running it. */
  skip(phase: number): void {
    if (!this.state) return;
    const record = phaseRecord(this.state, phase);
    record.status = 'skipped';
    record.note = 'skipped by the operator';
    this.record('phase.skip', {}, phase);
    this.persist();
    // `record()` alone reaches the console as `run:journal`, which is
    // stream-only and invalidates nothing: the row this just changed went on
    // showing its old status until something else happened to emit. Every
    // action that edits the record says so at the moment it acts.
    this.emit('run', { state: this.state });
  }

  /**
   * Change how the rest of the run behaves, without stopping it.
   *
   * Everything here applies from the NEXT phase: the running child was started
   * with a model, an effort and a budget already fixed in its argv, and there
   * is no honest way to change those underneath it. Saying so is better than
   * appearing to change something that will not change.
   */
  configure(patch: RunSettingsPatch, by = 'console'): boolean {
    if (!this.state) return false;
    const before = this.profile();
    const carveBefore = this.openPrCarveOut();
    applySettings(this.state, patch);
    const after = this.profile();

    if (after !== before) {
      // Its own journal line, separate from the generic reconfigure: this is
      // the one setting that changes what a session is *permitted* to do, and
      // "who widened this run, and when" has to be answerable later without
      // reading a diff of the whole patch.
      this.record('run.permission-profile', { from: before, to: after, by });
      log.warn('runner.permission-profile', { runId: this.state.id, from: before, to: after, by });
      this.rearmSettings();
    } else if (this.openPrCarveOut() !== carveBefore) {
      // The carve-out is part of the settings file too — a git-mode change is
      // a permission change by another name, and gets the same rebuild.
      this.record('run.push-carve-out', { on: this.openPrCarveOut(), by });
      this.rearmSettings();
    }

    this.record('run.reconfigured', { ...patch });
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /**
   * Put a line in the live run's journal from outside the runner.
   *
   * Used for things that are *about* a run without being decisions it made — a
   * rule an operator wrote while watching it. Silently does nothing when no run
   * is live, because the alternative is a caller that has to check first and
   * will eventually forget to.
   */
  note(event: string, data: Record<string, unknown> = {}, phase?: number): void {
    if (!this.state) return;
    this.record(event, data, phase);
  }

  /**
   * "Continue without these servers" for ONE `require`-parked phase — by the
   * clock (`mcpRequireTimeoutMs`, the service's timer) or by the ladder. The
   * phase's own MCP policy becomes `continue`, the record is reset to board
   * fresh with the hint on it, the errand is recorded, and the loop is woken
   * so it boards on the next tick under normal admission. Null when the
   * phase is not such a park any more (healed, retried, or never parked) —
   * every caller's race lands here and answers "nothing to do".
   *
   * Only a live loop boards it; for a stopped run the service flips the
   * stored record with the same function and restarts the run.
   */
  continueMcpPark(phase: number, by = 'timeout'): McpContinueResult | null {
    if (!this.state) return null;
    const result = continueMcpParkedRecord(this.state, phase, { by, now: this.now() });
    if (!result) return null;
    this.record('phase.mcp-require-timeout', {
      servers: result.servers, waitedMs: result.waitedMs, by,
    }, phase);
    this.record('phase.errand', {
      ...result.errand, label: 'MCP server unavailable',
      reason: `waited ${Math.round(result.waitedMs / 60_000)} min under the require policy`, by,
    }, phase);
    this.ladderSeen.delete(phase);
    this.emit('phase', { phase, status: 'pending', note: null, errand: result.errand, mcpContinue: result.servers });
    this.persist();
    this.wake.resolve();
    this.deps.onMcpRequireTimeout?.(this.state, phase, result);
    return result;
  }

  /**
   * A declared outcome that arrived from OUTSIDE a lane: `phase-outcome.sh`
   * run by a session nobody here spawned — a person's `claude`, whose file
   * landed in the console's inbox (`runs/<instance>/<slug>/outcomes/`). The
   * same vocabulary as a lane's own declaration, read the same way:
   *
   *   waiting-external  the record is parked `waiting` until `resume_after`
   *                     (the session's own clock; floored and budgeted like a
   *                     lane's) and THAT session is what resumes — the phase's
   *                     context is the whole point;
   *   partial           the record is reset with a resume hint and the loop
   *                     boards it at once — continuing the session when it can
   *                     be reached, a fresh boot with the resume brief when not;
   *   blocked / needs-human / complete
   *                     journalled; the classifier reads the declaration as
   *                     evidence and the ladder takes it from there.
   *
   * A phase a lane of this run is working, or whose record is done, is left
   * alone — the declaration is journalled as ignored and the file was consumed.
   */
  declareOutcome(phase: number, declared: PhaseOutcome, by = 'unsupervised'): 'parked' | 'boarding' | 'noted' | 'ignored' | null {
    const state = this.state;
    if (!state) return null;
    const record = phaseRecord(state, phase);
    const ignore = (reason: string): 'ignored' => {
      this.record('phase.outcome-ignored', { status: declared.status, reason, by, sessionId: declared.session_id ?? null }, phase);
      return 'ignored';
    };
    if (this.lanes.has(phase)) return ignore('a lane of this run is working the phase');
    if (record.status === 'done') return ignore('the record is already done');
    this.record('phase.outcome', {
      status: declared.status, reason: declared.reason ?? null,
      resumeAfter: declared.resume_after ?? null, watch: declared.watch,
      sessionId: declared.session_id ?? null, by,
    }, phase);
    if (declared.session_id) {
      // The declaring session is the one to resume. A session nobody here
      // spawned lives under the machine's own login — `resumableSession` ports
      // its transcript when the run pays as somebody else.
      record.sessionId = declared.session_id;
      delete record.sessionAccountId;
    }
    let verdict: 'parked' | 'boarding' | 'noted';
    switch (declared.status) {
      case 'waiting-external': {
        record.resumeSessionId = declared.session_id ?? record.sessionId;
        verdict = this.parkWaiting(phase, declared) ? 'parked' : 'noted';
        break;
      }
      case 'partial': {
        resetForRetry(record);
        const brief = declared.session_id ? 'continue' : 'resume';
        record.boardingHint = {
          situation: 'work-in-progress', rung: 'resume-own-session', brief,
          ...(declared.session_id ? { sessionId: declared.session_id } : {}),
          at: new Date().toISOString(), by,
        };
        this.record('phase.reboard-requested', { situation: 'work-in-progress', rung: 'resume-own-session', brief, by }, phase);
        this.emit('phase', { phase, status: record.status, note: record.note ?? null });
        verdict = 'boarding';
        break;
      }
      default:
        verdict = 'noted';
    }
    this.persist();
    this.wake.resolve();
    return verdict;
  }

  /** Clear a phase's terminal state so the loop will pick it up again. */
  retry(phase: number): void {
    if (!this.state) return;
    const record = phaseRecord(this.state, phase);
    // The ONE reset — `state.ts` `resetForRetry`, shared with the stored-run
    // Retry in the service. The two used to carry their own copies and
    // drifted twice (a retried phase kept the preflight and the missing
    // servers of an attempt that was no longer going to happen; the lock-cap
    // clock survived into the retry and re-parked it instantly).
    resetForRetry(record);
    this.ladderSeen.delete(phase);
    this.state.consecutiveFailures = 0;
    this.state.halt = null;
    this.record('phase.retry-requested', {}, phase);
    this.persist();
    // See `skip`. Retry is the one this was reported against: the halt banner
    // stayed on screen, the phase still read `failed`, and the only way to
    // learn the retry had been accepted was to reload the page.
    this.emit('run', { state: this.state });
  }

  /* ---------------------------------------------------------------- *
   * The loop
   * ---------------------------------------------------------------- */

  private async drive(): Promise<void> {
    const state = this.state!;
    /**
     * The lanes this loop is waiting on, keyed by phase.
     *
     * Never rejects — `laneOf` converts a throw into a settled lane, because
     * `Promise.race` rejecting on one lane would abandon every other lane
     * still holding a live session.
     */
    const inFlight = new Map<number, Promise<{ phase: number; carryOn: boolean }>>();
    /** Something said stop. Admit nothing more; let what is running finish. */
    let stopping = false;

    /**
     * Wait for the next lane to settle. The only place the loop advances.
     *
     * The empty guard is not defensive clutter: `Promise.race([])` returns a
     * promise that never settles, so one wrong path into here would hang the
     * loop forever with no error, no log line and a run that reads `running`
     * for as long as the console lives.
     */
    const settleOne = async (): Promise<void> => {
      if (!inFlight.size) return;
      // The race includes the wake signal: a handoff written by an OUTSIDE
      // session (a manual terminal, another console) used to be invisible
      // until a lane settled — on a one-lane run, hours. The docs watcher
      // resolves the signal; the loop top re-reads the board. `docsDirty` is
      // the truth and the promise only ends the sleep, so a poke landing
      // between the race settling and the re-arm is still seen.
      const done = await Promise.race([
        ...inFlight.values(),
        this.wake.promise.then(() => null),
      ]);
      this.wake = wakeSignal();
      if (done === null) { this.docsDirty = false; return; }
      inFlight.delete(done.phase);
      this.persist();
      if (!done.carryOn) stopping = true;
    };

    /**
     * Drain before concluding anything.
     *
     * Every ending below — paused, halted, finished, out of budget — is a
     * statement about the whole run, and making it while a lane is still
     * editing a repository would be false. So each one waits its turn: with a
     * single lane this is exactly the old `break`, and with several it is the
     * difference between "the run stopped" and "the run stopped, and two
     * sessions carried on writing without a supervisor".
     */
    const draining = async (): Promise<boolean> => {
      if (!inFlight.size) return false;
      await settleOne();
      return true;
    };

    try {
      while (true) {
        if (this.abort?.signal.aborted) {
          if (await draining()) continue;
          state.status = 'paused';
          state.pause = null;
          if (this.shuttingDown) {
            // The console is going away under a run that was working. Said
            // so, and stamped as the system's stop: the convergence loop picks
            // it up at the next boot (`resumeAtBoot`), which it would never do
            // for a stop the operator asked for.
            state.stoppedBy = 'system';
            state.finishedReason ??= 'the console shut down while this run was working — it continues by itself once the console is back';
          } else {
            state.stoppedBy = 'operator';
            state.finishedReason ??= 'stopped by the operator';
          }
          break;
        }
        if (state.status === 'pausing') {
          // A pause stops ADMITTING. What is already running is left to finish
          // — that is what "after this phase" has always meant, and with lanes
          // it means after all of them.
          if (await draining()) continue;
          state.status = 'paused';
          state.stoppedBy = 'operator';
          this.record('run.paused', { afterPhase: state.pause?.afterPhase ?? null });
          state.finishedReason = state.pause?.afterPhase != null
            ? `paused by ${state.pause.by} after phase ${state.pause.afterPhase} finished`
            : `paused by ${state.pause?.by ?? 'the operator'} at a phase boundary`;
          state.pause = null;
          break;
        }
        if (state.status === 'halting') {
          // The reconcile pass below can CLEAR a halt whose anchor phase the
          // board has overtaken (someone finished it by hand mid-drain). A
          // halting run whose halt is gone is not halting any more — it goes
          // back to driving instead of finalizing a stop about nothing.
          if (!state.halt) {
            state.status = this.resumedStatus();
            this.record('run.halt-superseded', { note: 'the board overtook the halt while lanes drained' });
            continue;
          }
          // A halt in one lane stops ADMITTING; what is already running drains
          // — the same shape as a pause, with a worse reason. Only when the
          // last lane settles may the run read `halted`: "halted" with live
          // sessions still editing trees is a lie, and one reconcile would
          // compound (halted is not IN_FLIGHT, so a dead console mid-drain
          // would never pid-check those children).
          if (await draining()) continue;
          state.status = this.parkPending ? 'parked' : 'halted';
          this.parkPending = false;
          break;
        }
        // An out-of-band park — the approval-timeout hook is the one that
        // matters — sets `state.halt` and `parked` from OUTSIDE this loop, and
        // the loop had no branch for it. So it fell through, re-read the board
        // and admitted candidates: `runPhase` then read the gate, took a lock
        // and boarded a phase on a run the console had already stopped, two
        // bash subprocesses and a journal line per turn, indefinitely. Fires at
        // the default single lane too, as soon as the parked phase's own
        // session finishes.
        if (state.status === 'parked' && state.halt) {
          if (await draining()) continue;
          break;
        }
        if (stopping) {
          if (await draining()) continue;
          break;
        }
        if (state.runBudgetUsd && state.spentUsd >= state.runBudgetUsd) {
          if (await draining()) continue;
          // The budget wall's one rung — raise once within the policy cap —
          // then the errand. `continue` re-enters the loop top with the new cap.
          if (this.raiseBudgetOnce()) continue;
          this.haltOnBudget();
          break;
        }

        const board = await this.board();
        // Re-read, because `board()` is a `phase-graph.sh` subprocess and the
        // whole gap between the check at the top of this loop and here is time
        // an operator can press Pause in. They did, repeatedly, and watched the
        // next phase start anyway: the flag was set a few hundred milliseconds
        // after the only line that read it. Going back to the top rather than
        // breaking here keeps ONE piece of pause bookkeeping, up there.
        // `halting` for the same reason: a lane can halt the run while the
        // board subprocess is in flight, and the loop top owns that bookkeeping.
        if (state.status === 'pausing' || state.status === 'halting') continue;
        if (board.error) {
          if (await draining()) continue;
          this.halt(`the engine could not read the plan: ${board.error}`, undefined, 'plan-unreadable');
          break;
        }

        // Records first: resolutions queued by recoveries, then anything the
        // board has overtaken — a phase finished outside this run flips to
        // done HERE, halts anchored to it clear, and the loop never spends a
        // session on work somebody already did.
        this.applyReconcile(board);
        // A lock-cap park re-arms the moment the lock it waited on is gone —
        // the docs watcher wakes this tick on the release. See `rearmLockCapParks`.
        await this.rearmLockCapParks(board);

        const outstanding = [...board.ready, ...board.waiting, ...board.inProgress, ...board.stuck];
        // A run asked for specific phases is finished when THOSE are settled —
        // not when the plan is. Restricting the candidate list here rather than
        // in the caller keeps one definition of "ready" (the engine's).
        const asked = state.onlyPhases?.length ? new Set(state.onlyPhases) : null;
        const nowIso = new Date().toISOString();

        // The ladder's own pass, after reconcile and before the candidate set:
        // records the last boarding settled badly (`interrupted`, `failed`) and
        // phases whose handoff exists but is not complete are CLASSIFIED
        // (runner/situation.ts) and, when a rung this runner can drive exists,
        // reset to `pending` with a boarding hint — so a resumed run whose only
        // open record is an interrupted never-started phase boards it fresh on
        // this very tick, and a failed phase with unfinished work on disk
        // resumes its own session, with nobody pressing anything.
        await this.climbLadder(board, asked);

        // A waiting-external phase whose window has elapsed re-boards through
        // the normal lanes — but from the board's point of view it may read
        // `in-progress` (the session wrote the durable pause marker before
        // parking), which `board.ready` never lists. So expired waits join the
        // candidate set explicitly, and unexpired ones are filtered out below.
        // `stuck` is in the list too: a session that wrote a `blocked` handoff
        // AND declared a wait used to be a phase that was never a candidate
        // yet always "waiting" — the run re-entered `waiting` with a past
        // clock forever (the measured livelock). Its own session is resumed
        // exactly like the in-progress shape.
        const expiredWaits = Object.values(state.phases)
          .filter((r) => r.status === 'waiting' && r.parkedUntil && r.parkedUntil <= nowIso)
          .map((r) => r.phase)
          .filter((p) => board.states[p] === 'ready' || board.states[p] === 'in-progress' || board.states[p] === 'stuck');
        // Phases the ladder (or a `start({reboard})`) asked to board: `pending`
        // with a hint, on a board that does not read done — `in-progress` and
        // `stuck` included, which `board.ready` never lists.
        const hinted = Object.values(state.phases)
          .filter((r) => r.status === 'pending' && r.boardingHint)
          .map((r) => r.phase)
          .filter((p) => ['ready', 'in-progress', 'stuck'].includes(board.states[p] ?? ''));
        const candidates = [...new Set([...board.ready, ...expiredWaits, ...hinted])]
          .filter((p) => !asked || asked.has(p))
          .filter((p) => !SETTLED.includes(phaseRecord(state, p).status))
          .filter((p) => {
            const record = phaseRecord(state, p);
            if (record.status !== 'waiting') return true;
            return !!record.parkedUntil && record.parkedUntil <= nowIso;
          })
          // A phase this loop is already driving is not a candidate to start
          // again. The board cannot know — it reads handoffs, and a phase in
          // flight has not written one yet.
          .filter((p) => !inFlight.has(p));

        // Nothing to start, but something is running: it may be about to make
        // more phases ready. Concluding "finished" here is the fastest way to
        // stop a plan one phase in.
        if (!candidates.length && await draining()) continue;

        // Everything startable is parked on an external clock: the RUN waits —
        // restart-safe (`waiting`→`paused` keeps the clock on reconcile, and
        // the service re-arms the resume at boot, exactly like a usage-window
        // sleep) — instead of halting a plan that is merely early. Checked
        // before the scoped-run ending, or a run scoped to a waiting phase
        // would declare itself finished mid-wait.
        // Only waits whose clock is still AHEAD: an expired one is either a
        // candidate above, or — when its board state cannot board (`waiting`,
        // `done`) — not a reason to hold the run on a clock that has passed.
        // Counting expired waits here was the other half of the livelock: the
        // run went back to `waiting` with a `waitUntil` in the past.
        const waitingRecords = Object.values(state.phases)
          .filter((r) => r.status === 'waiting' && r.parkedUntil && r.parkedUntil > nowIso)
          .filter((r) => !asked || asked.has(r.phase));
        if (!candidates.length && waitingRecords.length) {
          const soonest = [...waitingRecords].map((r) => r.parkedUntil!).sort()[0];
          const names = waitingRecords.map((r) => r.phase).sort((a, b) => a - b).join(', ');
          state.status = 'waiting';
          state.stoppedBy = 'system';
          state.waitUntil = soonest;
          state.finishedReason = `waiting on external work — phase${waitingRecords.length === 1 ? '' : 's'} `
            + `${names} parked (${waitingRecords.map((r) => r.parkReason).filter(Boolean).join('; ') || 'declared waits'}); `
            + `resumes at ${soonest}.`;
          this.record('run.waiting-external', {
            phases: waitingRecords.map((r) => r.phase), waitUntil: soonest,
          });
          break;
        }

        // "Settled" here has to mean settled WELL. `SETTLED` includes `parked`,
        // `gated` and `failed`, so a scoped run whose one phase parked used to
        // report itself finished — "this run was scoped to phase 1, and it is
        // settled" — which is true of the status field and false about the
        // world, and it hid the park's own explanation entirely. A scoped run
        // that ends on a phase needing a person falls through to the halt
        // below, which names the blocker and its remedy like any other run.
        const unsettled = asked
          ? [...asked].filter((p) => ['parked', 'gated', 'failed'].includes(phaseRecord(state, p).status))
          : [];
        if (asked && !candidates.length && !unsettled.length) {
          state.status = 'finished';
          // The single most-reported "it doesn't go to the next phase". The run
          // was scoped — usually from a per-row "Run only this" control — did
          // exactly what it was asked, and then said nothing about why it
          // stopped one phase in. It says so now, and the console offers the
          // one-click widening beside it.
          const list = [...asked].join(', ');
          state.finishedReason = `this run was scoped to phase ${list}, and ${asked.size === 1 ? 'it is' : 'those are'} `
            + 'settled. Continue with the scope cleared to carry on through the rest of the plan.';
          this.record('run.finished', {
            onlyPhases: [...asked],
            note: 'the phases this run was asked for are settled',
          });
          break;
        }

        if (!candidates.length) {
          // Two DAG leaves finishing together means neither read as "last", so
          // neither was told to open the PR. The last leaf to land is asked
          // now, in its own session — it holds the branch, the commits and the
          // context — while the run still reads running; only when no session
          // can be resumed for it does the branch end "awaiting its PR".
          let prEnding: string | null = null;
          if (!outstanding.length && state.gitMode === 'new-branch'
            && state.openPr !== false && !this.prBlockEmitted) {
            prEnding = await this.openPrFromLastLeaf();
          }
          state.status = outstanding.length ? 'parked' : 'finished';
          if (outstanding.length) state.stoppedBy = 'system'; else delete state.stoppedBy;
          state.finishedReason = outstanding.length
            ? undefined
            : `every phase of ${state.slug} is done.`;
          if (!outstanding.length && state.gitMode === 'new-branch'
            && state.openPr !== false && !this.prBlockEmitted) {
            this.record('run.pr-pending', { branch: `pe/${state.slug}` });
            state.finishedReason = `every phase of ${state.slug} is done. The work branch `
              + `pe/${state.slug} still awaits its PR — no phase ran as the plan's last and no `
              + 'session could be resumed to open it, so push it and open one by hand, or re-run the final phase.';
          } else if (prEnding) {
            state.finishedReason = prEnding;
          }
          if (outstanding.length) {
            // Parking with work left is not self-explanatory: every phase this
            // loop will not pick up again needs its ACTUAL blocker named — a
            // gated phase parked with "is parked", and a blocked-handoff phase
            // hid behind "waiting on a gate or an earlier phase", and both
            // read as dead ends (reported twice, with two real plans).
            const readyRecords = board.ready.map((p) => ({ p, record: phaseRecord(state, p) }));
            // Phases the ladder parked with an ERRAND — one named ask for a
            // person, written after every automatic rung was tried or when the
            // situation was a person's from the start. Named first: they are
            // the doors that exist, whatever the board reads for them.
            const errands = Object.entries(state.recoveries ?? {})
              .filter(([key, slot]) => slot.errand && /^\d+$/.test(key)
                && state.phases[key]?.status === 'parked' && (!asked || asked.has(Number(key))))
              .map(([key, slot]) => ({ p: Number(key), errand: slot.errand! }));
            const errandPhases = new Set(errands.map((e) => e.p));
            // The phases whose QA verdict is holding the DAG, read from the
            // board rather than from this run's records — the blocker is a
            // phase the board reads DONE, so it has no open record to find it
            // by. Everything below used to derive from `readyRecords`, which is
            // empty in exactly the case that most needs explaining: a plan
            // wedged with nothing ready at all.
            const qaHolders = Object.entries(board.qa ?? {})
              .filter(([, verdict]) => verdict !== 'pass' && verdict !== 'waived')
              .map(([phase, verdict]) => ({ p: Number(phase), verdict }))
              .filter(({ p }) => Number.isFinite(p))
              .sort((x, y) => x.p - y.p);
            const heldByQa = (p: number): number[] => Object.entries(board.blockedBy ?? {})
              .filter(([, deps]) => deps.includes(p)).map(([blocked]) => Number(blocked)).sort((x, y) => x - y);
            const held = [
              ...errands.map(({ p, errand }) => `phase ${p} needs you — ${errand.need} (${errand.how})`),
              ...readyRecords.filter(({ p }) => !errandPhases.has(p)).map(({ p, record }) =>
                `phase ${p} is ${record.status}${record.note ? ` (${record.note})` : ''}`),
              ...board.stuck.filter((p) => !errandPhases.has(p)).map((p) =>
                `phase ${p}'s handoff is marked blocked — its Outstanding section says why`),
              ...qaHolders.filter(({ p }) => !errandPhases.has(p)).map(({ p, verdict }) => {
                const blocks = heldByQa(p);
                return `phase ${p} is done but its QA verdict is ${verdict}`
                  + (blocks.length ? `, which holds phase${blocks.length === 1 ? '' : 's'} ${blocks.join(', ')}` : '');
              }),
            ].join('; ');

            // The remedy tail names only doors that exist. It used to be one
            // fixed sentence advertising gate confirmation and Repair with AI
            // to runs with no gate and no blocked handoff — an operator did
            // nothing on that advice, correctly, and the run stayed down.
            const verificationParked = readyRecords.filter(({ record }) =>
              record.status === 'parked' && Runner.VERIFICATION_PARK.test(record.note ?? ''));
            const remedies: string[] = [];
            if (errands.length) remedies.push('a phase parked with an errand takes that errand, then Retry');
            if (readyRecords.some(({ record }) => record.status === 'gated')) {
              remedies.push('Gates need your confirmation (then Retry re-checks them)');
            }
            if (board.stuck.length) remedies.push('a blocked handoff has Repair with AI');
            if (readyRecords.some(({ record }) => record.status === 'failed')) {
              remedies.push('failed phases take Retry or Skip');
            }
            if (verificationParked.length) {
              remedies.push('an unrunnable §Verification takes a plan edit or Repair with AI, then Retry');
            }
            // Two doors, because there genuinely are two — and neither was ever
            // named. A recorded verdict is not a defect the autopilot can clear:
            // somebody has to give a verdict, or say the gate does not apply.
            if (qaHolders.length) {
              remedies.push('a QA verdict that holds the plan takes Record a verdict on that phase '
                + '(pass or waived), or a fresh QA session — or "**QA gate:** off" in the plan\'s '
                + '§Session budget if this plan should not gate on QA at all');
            }
            // The MCP park had NO remedy string at all, which is how a run
            // parked on three signed-out servers ended with a halt sentence
            // that named the problem and then stopped talking. Two doors,
            // because there genuinely are two: fix the server, or decide the
            // phase does not need it. The second is one button.
            const mcpParked = readyRecords.filter(({ record }) =>
              record.status === 'parked' && MCP_PARK_NOTE.test(record.note ?? ''));
            if (mcpParked.length) {
              const signIn = mcpParked.some(({ record }) => MCP_AUTH_PARK_NOTE.test(record.note ?? ''));
              remedies.push(signIn
                ? 'a signed-out MCP server takes Settings ▸ MCP (the parked phase requeues itself once it '
                  + 'connects), or Continue without these servers'
                : 'an MCP server this console cannot reach takes Settings ▸ MCP, or Continue without these servers');
            }
            // A lock-cap park is the same shape of dead end and had the same
            // silence: the holder is named in the note, but nothing said the
            // wait can simply be restarted.
            if (readyRecords.some(({ record }) =>
              record.status === 'parked' && LOCK_CAP_PARK_NOTE.test(record.note ?? ''))) {
              remedies.push('a phase that waited out another plan\'s lock takes Retry once the holder releases');
            }
            const tail = remedies.length ? ` ${remedies.join('; ')}.` : '';

            // When the ONLY thing in the way is verification parks, the halt
            // carries a machine-readable kind (and a phase to anchor on) so
            // auto-recovery can pick it up instead of a person. MCP parks get
            // the same treatment for the console's sake rather than a repair
            // agent's — no agent can sign a server in, but the run page can
            // offer the one button that releases the run, and it needs to know
            // that is what it is looking at.
            const allVerification = verificationParked.length > 0
              && verificationParked.length === readyRecords.length && !board.stuck.length;
            const allMcp = mcpParked.length > 0
              && mcpParked.length === readyRecords.length && !board.stuck.length;
            // A plan nothing can move: no ready phase, no lane in flight, and a
            // QA verdict holding the rest. It is anchored on the HOLDING phase
            // — the one a person can actually act on — which is a phase the
            // board reads done, and therefore one no record-derived anchor
            // could ever have found.
            const deadlocked = qaHolders.length > 0 && !board.ready.length && !board.inProgress.length;
            state.halt ??= {
              at: new Date().toISOString(),
              reason: held
                ? `nothing left to run on its own — ${held}.${tail}`
                : `nothing is ready to run: ${outstanding.length} phase(s) are still waiting on a gate or an earlier phase.`,
              ...(deadlocked
                ? { kind: 'plan-deadlocked', phase: qaHolders[0].p }
                : allVerification
                  ? { kind: 'verification-preflight', phase: verificationParked[0].p }
                  : allMcp
                    ? { kind: 'mcp-preflight', phase: mcpParked[0].p }
                    : {}),
            };
            state.finishedReason = state.halt.reason;
          }
          this.record(outstanding.length ? 'run.parked' : 'run.finished', {
            outstanding, done: board.done,
          });
          break;
        }

        // Fill every free lane this run is allowed, then wait for the first to
        // settle. One lane makes this exactly what it was: start a phase, wait
        // for it, go round again.
        for (const phase of candidates) {
          if (inFlight.size >= this.maxLanes()) break;
          // Belt-and-braces: nothing above awaits between the status re-check
          // and here today, but a pause or halt must stop the SECOND lane of a
          // burst too if that ever changes.
          if (state.status === 'pausing' || state.status === 'halting') break;
          inFlight.set(phase, this.laneOf(phase, board));
        }
        await settleOne();
      }
    } catch (error) {
      // A throw in here would otherwise be an unhandled rejection, which is one
      // of the ways this console used to disappear.
      log.error('runner.crashed', { error });
      this.halt(`the runner itself failed: ${(error as Error)?.message ?? error}`, undefined, 'runner-crashed');
    } finally {
      // A drain the loop never finished — a `break` that bypassed the loop top,
      // or the `catch` above halting with lanes still recorded — must still
      // land on the final word: nothing is running past this line. A park that
      // was draining lands on `parked`; only a halt lands on `halted`.
      if (state.status === 'halting') {
        state.status = this.parkPending ? 'parked' : 'halted';
        this.parkPending = false;
      }
      // Park pokes die with the loop: a stopped run's resume is the service's
      // boot/timer decision, made from `waitUntil` on the record — not a
      // callback into a loop that no longer exists.
      for (const timer of this.parkPokes.values()) clearTimeout(timer);
      this.parkPokes.clear();
      // Whatever is left is not running any more, whichever way the loop left.
      for (const lane of this.lanes.values()) this.clearFreezeTimer(lane);
      this.lanes.clear();
      this.disarmLivenessTicker();
      this.syncMirror();
      state.child = null;
      delete state.children;
      this.childPid = null;
      this.handle = null;
      // A freeze cannot outlive the loop that would have thawed it.
      state.freeze = null;
      // The token dies with the loop. Anything still waiting on a decision is
      // answered rather than left holding a socket nobody is watching — this
      // run's cards only, because another run's are still answerable.
      this.deps.approvals?.disarm(state.id);
      // …and neither does the question it was asking. A phase left reading
      // `awaiting-verification` on a run that has stopped goes on presenting as
      // "Waiting on you" — a card whose broker is disarmed, whose run is over,
      // and which no answer can reach. The state file for the halted 02:55 run
      // still said this hours later.
      this.settleAwaitingVerification();
      this.persist();
      this.emit('run', { state });
    }
  }

  /**
   * One lane, as a promise that always settles.
   *
   * `Promise.race` is how the loop waits, and a race rejects the moment ANY
   * racer does — which would drop the loop out of its `while` while other
   * lanes still held live sessions, with nothing left to reap them. So a lane
   * that throws becomes a lane that finished badly.
   */
  private laneOf(phase: number, board: Board): Promise<{ phase: number; carryOn: boolean }> {
    return this.runPhase(phase, board).then(
      (carryOn) => ({ phase, carryOn }),
      (error: unknown) => {
        log.error('runner.lane.crashed', { phase, error });
        this.halt(`phase ${phase} failed inside the runner: ${(error as Error)?.message ?? error}`, phase, 'phase-crashed');
        return { phase, carryOn: false };
      },
    );
  }

  /** Returns false when the run must stop. */
  private async runPhase(phase: number, board: Board): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    // `activePhase` is set at SPAWN time by `syncMirror`, never here. The gap
    // between this line and the spawn is three subprocesses and possibly a
    // queue wait; a phase can still turn out not to start, and one that never
    // starts must not have the run claiming to be on it — the pointer feeds
    // the header chip, the "in-progress" row, the ask box and run:state emits,
    // and an early write here is what made an armed pause look ignored.

    /* ---- gate ----
     * PHASE_EXEC_GATES=1 is the deliberate opt-in `cmd` gates wait for — the
     * runner is the automation the comment in phase-graph.sh names, and it was
     * the one caller that forgot to say so, leaving every cmd gate reporting
     * "not executed" forever. Page views still never execute plan-authored
     * commands: Service.gateStatus passes no env. */
    const gate = readGateStatus(await this.engine(['--gate-status', String(phase)], { PHASE_EXEC_GATES: '1' }));
    record.gate = gate;
    // A `human` gate the operator has DELEGATED behaves like an ai-clearable
    // one: the boot prompt briefs the session to verify each condition against
    // evidence it can cite and record the clearance, or stop with the condition
    // it could not verify named. Off unless asked for — see `delegateHumanGates`.
    // `--gate-status` reports the human family as `manual:` (the *kind* word
    // `human` comes from `--gate-kind`), so match the same set the classifier
    // does. "not executed" is excluded: that is a `cmd` gate the read declined
    // to run, not a person's decision — and the runner passes PHASE_EXEC_GATES=1
    // precisely so it never sees one.
    const humanFamily = /^(manual|human|OVERDUE)$/i.test(gate.kind)
      && !/\bnot executed\b/i.test(gate.detail ?? '');
    const delegated = humanFamily && this.deps.delegateHumanGates?.() === true;
    if (!gate.clear) {
      if (gate.kind === 'ai' || delegated) {
        // An ai-clearable gate is the session's FIRST task, not a wall: the
        // engine's own boot prompt orders it to verify each condition, do the
        // work to make failing ones true, and record the clearance before
        // implementing. Booting is exactly how this gate gets cleared. A
        // delegated human gate rides the same path under its own journal line,
        // because "a person's gate a session was asked to verify" is a
        // different fact from "a gate the plan marked ai-clearable" and an
        // audit has to be able to tell them apart.
        this.record(delegated ? 'phase.gate-delegated' : 'phase.gate-ai', { gate }, phase);
      } else {
        // human or auto: nothing this run can do — a person must approve (the
        // phase page's Gate card), or the world must change. `gated`, not
        // `parked`: the reader's next move is different, and so is the label.
        record.status = 'gated';
        record.note = `gate not clear: ${gate.kind}${gate.detail ? ` — ${gate.detail}` : ''}`;
        this.record('phase.gated', { gate }, phase);
        this.emit('phase', { phase, status: record.status, gate });
        // Other ready phases may still be runnable, so this is not a halt.
        return true;
      }
    }

    // A pause, halt or stop armed while the gate subprocess ran must end the
    // boarding BEFORE admission — past this point the phase visibly queues
    // (journal line, queued tab, run:state emit) for a run that has already
    // decided to stop.
    const blockedAfterGate = this.boardingBlocked();
    if (blockedAfterGate) {
      this.record('phase.not-started', {
        reason: blockedAfterGate === 'pause'
          ? 'a pause was armed while the gate was checked'
          : blockedAfterGate === 'halted'
            ? 'the run halted while the gate was checked'
            : 'the run was stopped while the gate was checked',
      }, phase);
      return true;
    }

    /* ---- admission ----
     * Before the lock belt-check, and deliberately so. The lock answers "is
     * this PHASE taken"; admission answers "may anything touch these REPOS
     * right now", which is the larger question and the one that can make a
     * phase wait rather than fail. Asking it after the gate keeps a gated
     * phase from occupying a queue slot it was never going to use. */
    let grant: ScopeGrant | null = null;
    try {
      grant = await this.admit(phase, 'phase');
    } catch (error) {
      if (!(error instanceof AdmissionAborted)) throw error;
      // Stopped while it waited. Nothing started, so nothing is owed an
      // explanation beyond the journal — and the phase stays startable.
      if (record.status === 'queued') record.status = 'pending';
      this.record('phase.not-started', {
        reason: 'the run was stopped while this phase waited for its scope',
      }, phase);
      return true;
    }

    // The lane exists from here on, so every control can find this phase even
    // before its child has a pid — and so the `finally` below has exactly one
    // place to undo all of it.
    const lane: Lane = {
      phase, pid: null, handle: null, grant, frozen: null, freezeTimer: null, stopped: null, checkpointed: false, checkpointNote: null, leaseTimer: null,
      // The stalemate counter is the phase's, not the lane's: three attempts
      // that changed nothing is a claim about the phase, and each of those
      // attempts had a lane of its own.
      signals: newLaneSignals(this.now().getTime(), { idleAttempts: record.idleAttempts }),
    };
    this.lanes.set(phase, lane);
    this.armLivenessTicker();

    try {
      return await this.runPhaseAdmitted(phase, board, lane);
    } finally {
      this.clearLeaseTimer(lane);
      this.deps.scheduler?.release(lane.grant);
      this.clearFreezeTimer(lane);
      this.lanes.delete(phase);
      this.syncMirror();
      this.persist();
    }
  }

  /**
   * The phase itself, once its scope is held. Split out so the grant, the lane
   * and the mirror are released in exactly one place however this returns.
   */
  private async runPhaseAdmitted(
    phase: number, board: Board, lane: Lane,
  ): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    // A waiting-external phase whose window elapsed boards as a RESUME of its
    // own session, never a fresh boot — its context is the whole point.
    // Decided here, before anything rewrites the status.
    const resuming = record.status === 'waiting';
    // The ladder's instruction for this boarding, if it left one. Read here for
    // the same reason, and consumed (deleted) only when the session actually
    // spawns, so a boarding abandoned at the gate, the queue or a preflight
    // park keeps its hint for the next tick.
    const hint = resuming ? undefined : record.boardingHint;

    /* ---- arrived from the queue into a run that stopped wanting it ----
     * The wait inside `admit()` can be minutes. A halt from another lane, an
     * armed pause or a stop during it must abandon this phase on arrival —
     * before the lock read, the boot prompt and the spawn — with the record
     * restored so the phase stays startable. */
    const blockedOnArrival = this.boardingBlocked();
    if (blockedOnArrival) {
      if (record.status === 'queued') record.status = 'pending';
      this.record('phase.not-started', {
        reason: blockedOnArrival === 'pause'
          ? 'a pause was armed while this phase waited for its scope'
          : blockedOnArrival === 'halted'
            ? 'the run halted while this phase waited for its scope'
            : 'the run was stopped while this phase waited for its scope',
      }, phase);
      return true;
    }

    // Settled while it waited — a per-phase stop or a skip landed during the
    // queue. The guard above only asks about run-level blocks, so a phase
    // skipped or stopped in the queue still spawned a session for work nobody
    // wanted. The record keeps the status the settling verb gave it.
    if (SETTLED.includes(record.status)) {
      this.record('phase.not-started', {
        reason: `this phase was settled (${record.status}) while it waited for its scope`,
      }, phase);
      return true;
    }

    /* ---- lock ----
     * Checked, not claimed. The boot prompt already tells the session to claim
     * its own phase, and a lock the runner took first is a lock the session
     * reads as a stranger's — it then refuses to touch the phase, exactly as
     * the skill's concurrency guardrail says it should, and the supervisor
     * deadlocks against its own worker. Seen in a real run twice.
     *
     * So the entity doing the work holds the lock. The runner only looks, so it
     * can park rather than start a session that would immediately stop.
     *
     * A LAPSED lease is not a holder. `phase-lock.sh status` prints `held by X`
     * for an expired claim too and appends `(EXPIRED — free to take over)`;
     * this used to read only the first half, so a session that died without
     * releasing parked every attempt at its phase — for the thirty minutes of
     * the lease, and then forever after, since nothing renews a dead claim. The
     * script is still the one deciding what a claim means; we just read the
     * whole sentence it wrote. */
    const owner = autopilotOwner(state.id);
    const status = await this.script('phase-lock.sh', [state.slug, 'status', String(phase)]);
    const expired = status.stdout.includes('EXPIRED');
    let holder = expired ? undefined : /held by (\S+)/.exec(status.stdout)?.[1];
    const heldSession = /\[session: ([A-Za-z0-9._-]+)\]/.exec(status.stdout)?.[1];
    if (holder && holder !== owner && heldSession
      && this.deps.lockPresence?.({ slug: state.slug, phase, owner: holder, session: heldSession }) === 'ended') {
      // Presence beats the lease (Phase 5): the holder's session has ended —
      // the registry saw its SessionEnd, or its process is gone — so the claim
      // is debris, released AS the holder (the runner's own release, `--git`
      // never passed), journalled, and boarding goes on. The scheduler reached
      // the same verdict one layer up (`SchedulerDeps.presence`); this is the
      // belt-check's half of it, for the lock file the session itself reads.
      const released = await this.script('phase-lock.sh', [state.slug, 'release', String(phase), '--owner', holder]);
      this.record('phase.lock-debris-released', {
        holder, session: heldSession, ok: released.code === 0, by: 'boarding',
        detail: (released.stdout + released.stderr).trim().slice(0, 160),
      }, phase);
      if (released.code === 0) holder = undefined;
    }
    if (holder && holder !== owner) {
      /* This used to park — TERMINALLY, since `parked` is settled — so a phase
       * a person was working by hand never boarded again for the life of the
       * run (observed live). The scheduler now treats a foreign same-phase
       * lock as an ordinary holder, so the right disposition is back to the
       * queue: admission waits on the lock with the holder named, wakes on
       * the docs watcher, the lease timer, and the idle poll — and this check
       * shrinks to what it always really was, the race window between grant
       * and spawn. Bounded: past the cap, the park returns, honestly worded. */
      // Without a scheduler there is no queue to wait in, so the historical
      // terminal park is the only honest disposition (harness configurations
      // only — the console always wires one).
      if (!this.deps.scheduler) {
        record.status = 'parked';
        record.note = `phase ${phase} is locked by ${holder} — ${status.stdout.trim().slice(0, 160)}`;
        this.record('phase.lock-refused', { holder, detail: record.note }, phase);
        return true;
      }
      const guardOn = this.deps.scheduler.snapshot().guard;
      if (guardOn) {
        record.lockWaitSince ??= new Date().toISOString();
        const waitedMs = Date.now() - Date.parse(record.lockWaitSince);
        if (waitedMs > LOCK_WAIT_CAP_MS) {
          record.status = 'parked';
          record.note = `phase ${phase} is locked by ${holder} and has waited `
            + `${Math.round(waitedMs / 60_000)} minutes for it — ${status.stdout.trim().slice(0, 160)}`;
          this.record('phase.lock-wait-capped', { holder, waitedMs }, phase);
          this.emit('phase', { phase, status: 'parked', note: record.note });
          // The clock stops with the wait. It used to survive the park — it is
          // only cleared after a SUCCESSFUL claim, below — so the next Retry
          // measured from the original timestamp, found itself still over the
          // cap, and parked again without waiting a second. Retry now means the
          // two hours start over, which is the only thing it could sensibly mean.
          record.lockWaitSince = undefined;
          return true;
        }
        record.status = 'queued';
        record.note = `queued behind ${holder} — ${status.stdout.trim().slice(0, 160)}`;
        // Back off, doubling to a half-minute cap: the store's watcher-debounced
        // lock view can lag what the script just read off disk, and at a flat
        // one-second floor this re-boarded at ~1 Hz (three bash subprocesses a
        // second, measured) until the store caught up. The scheduler owns the
        // real wait — and reads this very phase's lock file live on every scan
        // (`SchedulerDeps.liveLock`), so in the console this window is one
        // refusal wide; the backoff bounds a harness or a console without it.
        const backoffMs = Math.min(LOCK_BACKOFF_MAX_MS, (record.lockBackoffMs ?? 0) * 2 || 1_000);
        record.lockBackoffMs = backoffMs;
        this.record('phase.lock-race', { holder, detail: record.note, backoffMs }, phase);
        this.emit('phase', { phase, status: 'queued', note: record.note });
        await this.sleep(backoffMs);
        return true;
      }
      // Guard off: the operator has said cross-actor scope conflicts are
      // theirs to manage. Proceed, with the fact journalled — matching what
      // admission decided one layer up, so the two can never disagree.
      this.record('phase.lock-ignored', { holder, note: 'the repo guard is off' }, phase);
    }
    record.lockWaitSince = undefined;
    delete record.lockBackoffMs;
    // The child holds the lock; the supervisor keeps its lease alive. A live
    // 47-minute session must never silently lose its 30-minute claim mid-work.
    this.armLeaseTimer(lane, owner);

    /* ---- verification preflight ----
     * Before the prompt and the spawn: only "nothing would run at all" parks;
     * everything else is a journal warning. See `preflightVerification`. */
    const unrunnable = await this.preflightVerification(phase);
    if (unrunnable) {
      record.status = 'parked';
      record.note = unrunnable;
      this.record('phase.verify-preflight-parked', { reason: unrunnable }, phase);
      this.emit('phase', { phase, status: 'parked', note: unrunnable });
      return true;
    }

    /* ---- MCP preflight ----
     * Same place and same reasoning as the verification preflight: before the
     * prompt and before the spawn, because a phase whose GitHub server was
     * never signed in will otherwise spend an hour discovering that, and the
     * session cannot fix it — there is no `/mcp` panel in `-p`, and the CLI
     * says so to the model rather than to anyone who could act.
     *
     * What CHANGED is the verdict, not the timing. `require` still parks here.
     * `continue` — the default — boards without the servers it could not reach
     * and tells the session exactly which, because the alternative turned out
     * to be worse than the problem: a run whose ready phases all park has
     * nothing left to do, so one signed-out server halted an eleven-phase plan
     * that named no MCP servers at all.
     *
     * Resolved ONCE and carried to the spawn: the set that was probed has to be
     * the set that is passed, or the preflight answered about something else. */
    const chosenOptions = this.optionsFor(phase);
    const mcp = await this.resolveMcp(phase, chosenOptions);
    if (mcp.park) {
      record.status = 'parked';
      record.note = mcp.park;
      // The park's clock starts here: past `mcpRequireTimeoutMs` the phase
      // continues without these servers (`continueMcpPark`), with the errand.
      record.mcpPark = { at: new Date().toISOString(), degraded: mcp.degraded };
      const timeoutMs = this.deps.mcpRequireTimeoutMs?.() ?? DEFAULT_MCP_REQUIRE_TIMEOUT_MS;
      this.record('phase.mcp-preflight-parked', {
        reason: mcp.park, servers: mcp.degraded.map((row) => row.id), timeoutMs,
      }, phase);
      this.emit('phase', { phase, status: 'parked', note: mcp.park, mcpPark: record.mcpPark, timeoutMs });
      return true;
    }
    if (mcp.degraded.length) {
      record.mcpDegraded = mcp.degraded;
      const summary = mcp.degraded
        .map((row) => `${row.id} (${row.detail ?? mcpReasonText(row.reason)})`)
        .join(', ');
      this.record('phase.mcp-degraded', { degraded: mcp.degraded, attached: mcp.usable }, phase);
      this.emit('phase', { phase, mcpDegraded: mcp.degraded });
      this.deps.onMcpDegraded?.(state, phase, mcp.degraded);
      log.warn('runner.mcp-degraded', { slug: state.slug, phase, summary });
    } else {
      delete record.mcpDegraded;
    }

    /* ---- prompt ---- */
    // `PE_GATE_DELEGATE` swaps the human-gate block for the delegated brief:
    // verify each condition against evidence you can cite, record the clearance,
    // or STOP naming the condition you could not verify. Passed only when the
    // operator asked for it — the default prompt still says a person must clear
    // the gate, because by default one must.
    const engineText = readText(await this.engine(
      ['--boot-prompt', String(phase)],
      this.deps.delegateHumanGates?.() === true ? { PE_GATE_DELEGATE: '1' } : undefined,
    ));
    if (!engineText.trim()) {
      await this.release(phase, owner);
      this.halt(`the engine produced no boot prompt for phase ${phase}`, phase, 'plan-unreadable');
      return false;
    }
    // Appended, never woven in: `phase-graph.sh` stays the only thing that
    // decides what a boot prompt says about the plan — including the plan's own
    // skills line. This is the operator adding to it for one run.
    // `skillsOff` drops the RUN's list for this phase and keeps the phase's own:
    // "not the default here" and "nothing at all here" are different asks, and a
    // phase that names a skill has clearly asked for that one.
    const own = state.phaseOptions?.[String(phase)];
    const extraSkills = own?.skillsOff
      ? [...(own.skills ?? [])]
      : [...(state.skills ?? []), ...(own?.skills ?? [])];
    // A retry used to get the SAME prompt as the first attempt, because the
    // engine's boot prompt describes the job and the job did not change. So a
    // second session opened knowing everything about what to do and nothing
    // about the eleven failures the first one left behind — and re-derived them
    // by running the suite again, or did not, and wrote the same code twice.
    //
    // Between the engine's text and the skill directive, so the plan still
    // speaks first and the directive still has the last word.
    const context = this.retryContext(record);
    // The git strategy sits between the failure context and the directive: the
    // plan still speaks first, the operator's branch rule is stated before the
    // work begins, and the skill directive keeps the last word.
    const git = await this.gitStrategy(phase, board);
    // The MCP directive names only what the CONSOLE added: the engine's own text
    // already names what the plan asked for, and repeating it would read as two
    // authorities saying the same thing slightly differently.
    //
    // The degraded ids are subtracted, because the directive's first sentence
    // says the servers were "verified connected before it started" and that has
    // to keep being true. They come back in the directive's second half, named
    // as unavailable — which the plan's own servers need too, so `degraded` is
    // passed whole rather than filtered to the console's additions.
    const dropped = new Set(mcp.degraded.map((row) => row.id));
    const ownMcp = (own?.mcpOff
      ? [...(own.mcpServers ?? [])]
      : [...(state.mcpServers ?? []), ...(own?.mcpServers ?? [])]).filter((id) => !dropped.has(id));
    // A wait-resume replaces the engine's boot text — the session already has
    // the whole boot context; what it needs is the elapsed-window instruction.
    // Everything appended after (git strategy, directives) applies to both.
    // A ladder hint picks one of the five briefs instead (`composeBrief`):
    // `fresh` is the engine text alone, `resume`/`unblock` append a brief to
    // it, `continue`/`closeout` resume the phase's own session and carry no
    // engine text — the session has it — unless that session cannot be
    // resumed, in which case they degrade to the self-contained `resume`.
    let base = resuming
      ? waitResumePrompt(state.slug, phase, record.parkReason, record.watch)
      : engineText;
    let failureInsert = context;
    let resumeId: string | undefined;
    let cappedTurns: number | undefined;
    if (hint) {
      const composed = await this.composeBrief(phase, board, hint, engineText);
      base = composed.prompt;
      resumeId = composed.resume;
      cappedTurns = composed.maxTurns;
      // The briefs carry the failure evidence themselves; a second copy of it
      // after them would be the same log quoted twice.
      failureInsert = '';
      this.record('phase.brief', {
        brief: composed.brief, asked: hint.brief, situation: hint.situation, rung: hint.rung,
        resume: resumeId ?? null, bytes: Buffer.byteLength(composed.prompt),
        ...(composed.degraded ? { degraded: composed.degraded } : {}),
      }, phase);
    }
    const prompt = base + (failureInsert ? `\n\n${failureInsert}\n` : '') + git
      + skillDirective(extraSkills) + mcpDirective(ownMcp, mcp.degraded)
      + unattendedDirective(this.deps.scriptsDir, state.slug, phase);
    if (failureInsert) this.record('phase.retry-context', { bytes: Buffer.byteLength(failureInsert) }, phase);
    if (extraSkills.length) this.record('phase.skills', { skills: [...new Set(extraSkills)] }, phase);

    /* ---- the last chance to not start ----
     * The gate check, the lock check and the boot prompt are three subprocesses
     * — seconds, sometimes more. A pause armed during them used to be read only
     * after the session had already been spawned, which is the same defect as
     * the one at the top of `drive` and needs the same answer in the one place
     * that can still act on it: immediately before the phase is marked running.
     * `true` because the run carries on to the loop top, which owns every piece
     * of pause bookkeeping and will stop there. */
    if (this.boardingBlocked()) {
      await this.release(phase, owner);
      this.record('phase.not-started', {
        reason: state.status === 'pausing'
          ? 'a pause was armed before it started'
          : state.halt ? 'the run halted before it started' : 'the run was stopped',
      }, phase);
      return true;
    }

    /* ---- what this phase runs as ---- */
    const chosen = this.optionsFor(phase);
    if (resuming) {
      // The park is over: accrue the time actually spent parked (the console
      // may have been down past `parkedUntil`, so this is measured, not
      // planned), hand the session id to the resume machinery, and clear the
      // clock so a crash mid-resume re-parks cleanly rather than double-firing.
      const parkedFrom = record.endedAt ?? record.parkedUntil;
      record.parkedMs = (record.parkedMs ?? 0)
        + (parkedFrom ? Math.max(0, Date.now() - Date.parse(parkedFrom)) : 0);
      record.resumeSessionId ??= record.sessionId;
      record.parkedUntil = undefined;
      this.clearParkPoke(phase);
      this.record('phase.wait-resume', {
        waits: record.waits ?? 0, parkedMs: record.parkedMs, sessionId: record.sessionId ?? null,
      }, phase);
    }
    record.status = 'running';
    // `startedAt` is the PHASE's first start — the commit window `producedWork`
    // measures from, which a second boarding must not move forward past the
    // first attempt's commits. `attemptStartedAt` is THIS boarding's, and is
    // what the outcome file's staleness guard compares against.
    const boardedAt = new Date().toISOString();
    record.startedAt ??= boardedAt;
    record.attemptStartedAt = boardedAt;
    // The hint is spent: the session it asked for is about to exist.
    if (hint) delete record.boardingHint;
    if (resumeId) record.resumeSessionId = resumeId;
    // The phase is now genuinely starting: the active-phase pointer follows
    // the lane table (the mirror rule), written here and nowhere earlier.
    this.syncMirror();
    record.model = record.model ?? chosen.model;
    record.effort = record.effort ?? chosen.effort;
    if (hint?.escalate === 'model') {
      const stronger = escalateModel(record.model);
      if (stronger && stronger !== record.model) {
        this.record('phase.model-escalated', { from: record.model, to: stronger, rung: hint.rung }, phase);
        record.model = stronger;
      }
    }
    this.record('phase.start', {
      model: record.model, effort: record.effort ?? null,
      // Where each choice came from, so a phase that ran on an unexpected model
      // can be explained without re-reading three files.
      source: chosen.source,
      ...(chosen.tools?.length ? { tools: chosen.tools } : {}),
      ...(chosen.permissionMode ? { permissionMode: chosen.permissionMode } : {}),
      title: board.states[phase],
      ...(hint ? { brief: hint.brief, situation: hint.situation, rung: hint.rung } : {}),
      ...(resuming ? { waitResume: true } : {}),
    }, phase);
    this.emit('phase', { phase, status: 'running', model: record.model, effort: record.effort });

    /* ---- the session, with the error policy driving retries ---- */
    const settled = await this.attempt(phase, prompt, record.model!, owner, lane, chosen, {
      // A wait-resume is a continuation, not the phase: capped like a closeout
      // so a session that misreads the ask and starts new work runs out. A
      // `closeout` brief is capped the same way, for the same reason; a
      // `continue` is the phase itself and is not.
      ...(resuming ? { maxTurns: CLOSEOUT_MAX_TURNS } : cappedTurns ? { maxTurns: cappedTurns } : {}),
      mcp,
    });
    if (!settled.carryOn) { await this.release(phase, owner); return false; }
    if (!settled.completed) { await this.release(phase, owner); return true; }

    /* ---- independent verification ----
     * The lock is held across this, and released after. It used to be released
     * first, which meant a phase sitting in `awaiting-verification` — up to
     * twelve hours — was unlocked and read `ready` to every other session that
     * looked. Closeout needs it held too: it resumes the session that owns it. */
    try {
      return await this.confirmed(phase);
    } finally {
      await this.release(phase, owner);
    }
  }

  /**
   * What the previous attempt(s) at this phase left behind, as prompt text.
   *
   * One method rather than two call sites building it, because the retry path
   * and the resume path must tell the session the same story — they differ in
   * what surrounds the context, never in the context itself.
   *
   * `halt` is passed in rather than read off the run, because by the time any
   * of this is assembled `state.halt` is always null: `retry()`, `recover()` and
   * a resumed `start()` all clear the banner first, deliberately — a run being
   * worked on must not go on looking stopped. The caller that still has the
   * reason hands it over; the callers that never had one pass nothing. Whoever
   * passes it must have checked it belongs to THIS phase: a stop recorded
   * against phase 3 would open phase 5's session with an authoritative account
   * of a failure in code it is not about to touch.
   */
  private retryContext(record: PhaseRecord, halt?: string | null): string {
    // Nothing has run yet: no attempt, no verdict, no closing words. There is
    // no story to tell and a header promising one would be a lie.
    if (!(record.attempts > 0 || record.verification || record.said)) return '';
    return failureContext(record, halt);
  }

  /** Journalled once per run: the plan and the console disagree about branches. */
  private branchMismatchNoted = false;

  /** Whether any phase of this run was handed the PR block. See `run.pr-pending`. */
  private prBlockEmitted = false;

  /** The phase this loop most recently verified green — the last leaf, when the plan ends. */
  private lastDonePhase: number | null = null;

  /**
   * Ask the last leaf's own session to push the work branch and open the
   * pull request — the git-strategy PR block, verbatim, as one more resumed
   * turn. Two DAG leaves finishing together is how a new-branch run used to
   * end with `run.pr-pending` and a sentence; the session that landed last
   * holds the branch, the commits and the context, and is the right one to
   * finish the job. Answers the run's ending sentence when a session was
   * spent on it (whatever it then managed — its words are journalled, the
   * branch's state lives on the remote), null when none could be resumed —
   * the honest "awaiting its PR" ending stays for that.
   */
  private async openPrFromLastLeaf(): Promise<string | null> {
    const state = this.state!;
    const branch = `pe/${state.slug}`;
    const done = Object.values(state.phases)
      .filter((r) => r.status === 'done' && r.sessionId)
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .map((r) => r.phase);
    const candidates = [...new Set([this.lastDonePhase, ...done])].filter((p): p is number => p != null);
    const phase = candidates.find((p) => {
      const r = state.phases[String(p)];
      return Boolean(r?.sessionId) && this.transcriptFollows(r);
    });
    if (phase == null) return null;
    const record = phaseRecord(state, phase);
    const spawn = this.deps.spawn ?? spawnClaude;
    const title = this.deps.planTitle?.(state.slug) ?? state.slug;
    const prompt = `Every phase of ${state.slug} is done now, and yours was the last to land — so the pull `
      + `request falls to you. Your handoff is written; do not reopen the work.\n\n${prBlockText(branch, title)}`;
    this.record('phase.pr-session', { sessionId: record.sessionId, branch }, phase);
    this.emit('phase', { phase, prSession: true });

    let outcome;
    try {
      outcome = await spawn({
        prompt,
        cwd: state.root,
        model: record.model ?? state.model,
        effort: record.effort ?? state.effort,
        name: `${state.slug} p${phase} pull request`,
        resume: record.sessionId,
        // Paperwork, like a closeout: capped so a confused session cannot
        // re-open the work it was asked only to publish.
        budgetUsd: state.phaseBudgetUsd === null ? null : Math.max(1, state.phaseBudgetUsd / 4),
        maxTurns: CLOSEOUT_MAX_TURNS,
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        env: await this.sessionEnv({
          PE_OWNER: autopilotOwner(state.id),
          PE_SCOPE: formatScope(await this.scopeFor(phase)),
          PE_OUTCOME_FILE: this.outcomePath(phase),
          // Where a decision goes. Separate from the outcome file on purpose:
          // an outcome is read once and consumed, a ruling is appended and
          // kept, and a session must be able to record the second without
          // touching the first.
          PE_RULINGS_FILE: rulingsFile(this.state!.root, this.state!.slug),
        }),
        signal: this.abort?.signal,
        onPid: (pid) => {
          this.attachPid(phase, pid);
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      });
    } catch (error) {
      this.record('phase.pr-session-failed', { error: (error as Error)?.message ?? String(error) }, phase);
      return null;
    } finally {
      this.attachPid(phase, null);
      this.attachHandle(phase, null);
    }

    state.spentUsd += outcome.costUsd;
    record.costUsd += outcome.costUsd;
    // The same dollars, booked a second time against the ladder rung that
    // caused this attempt — a no-op unless the ladder is what reboarded it.
    chargeRung(state.recoveries?.[String(record.phase)], outcome.costUsd);
    record.turns = (record.turns ?? 0) + outcome.turns;
    const said = outcome.resultText ? outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200) : undefined;
    const ok = classify(outcome.signal).kind === 'ok';
    this.prBlockEmitted = true;
    this.record('phase.pr-session-done', { ok, costUsd: outcome.costUsd, turns: outcome.turns, said }, phase);
    return `every phase of ${state.slug} is done. Phase ${phase}'s session was asked to push ${branch} and `
      + `open the pull request${said ? ` — it said: ${said.slice(0, 300)}` : ''}.`;
  }

  /**
   * The operator's git strategy for this phase's session, or '' — which is the
   * only value a default-branch run ever gets, so every prompt composed before
   * this feature existed is byte-identical after it.
   *
   * The console never runs a git write itself; these are instructions to the
   * session, which is the entity that holds the lock and owns the tree. Three
   * escalations ride on the base block: a WORKTREE variant when someone else
   * is live in a shared repository right now (switching branches in a shared
   * checkout would swap files under the other session mid-edit — the skill's
   * conventions name a linked worktree as the escape hatch, and this automates
   * exactly that); a MISMATCH note when the plan's own §Session budget names a
   * different branch; and the PR block when this is the plan's last remaining
   * phase and the run was asked to open one.
   */
  private async gitStrategy(phase: number, board: Board): Promise<string> {
    const state = this.state!;
    if (state.gitMode !== 'new-branch') return '';
    const branch = `pe/${state.slug}`;
    const scope = await this.scopeFor(phase);

    // The honesty probe, guard-independent: it fires under guard-off by
    // design, and on a guard-on race where a foreign lock appeared after
    // admission. Either way the session must know it is not alone.
    const overlaps = this.deps.scheduler?.overlapsFor({
      slug: state.slug, phase, runId: state.id, scope,
    }) ?? [];
    const worktree = overlaps.length > 0;
    if (worktree) {
      this.record('phase.shared-checkout', {
        scope,
        holders: overlaps.map((h) => `${h.slug} P${h.phase ?? '?'} (${h.owner})`),
        guard: this.deps.scheduler?.snapshot().guard === false ? 'off' : 'on(race)',
      }, phase);
    }

    // The plan's Branch prose, read only to warn. The default idioms —
    // "current branch", "no new branch", "default" — are not a named branch.
    const prose = this.deps.planBranch?.(state.slug)?.trim();
    const planNames = prose && !/current|no new branch|default/i.test(prose) ? prose : undefined;
    if (planNames && !this.branchMismatchNoted) {
      this.branchMismatchNoted = true;
      this.record('run.branch-mismatch', { plan: planNames, run: branch });
    }

    // Final ⇔ every OTHER phase on the board is done, this is the only live
    // lane, and the run is the whole plan (a scoped run finishing is not the
    // plan finishing). Two leaves finishing together therefore never both read
    // final — `run.pr-pending` at finish covers that honestly instead.
    const phases = Object.keys(board.states).map(Number);
    const final = !state.onlyPhases?.length
      && phases.filter((p) => p !== phase).every((p) => board.done.includes(p))
      && this.livePhases().every((p) => p === phase);
    const pr = final && state.openPr !== false;
    if (pr) this.prBlockEmitted = true;

    const checkoutBullet = worktree
      ? `- CAUTION — another live session shares a repository with this phase right now\n`
        + `  (${overlaps.map((h) => `${h.slug} P${h.phase ?? '?'} (${h.owner})`).join('; ')}), so you must NOT switch\n`
        + `  branches in the shared checkout: that would swap files under the other\n`
        + `  session mid-edit. Use a linked worktree instead, as the skill's conventions\n`
        + `  prescribe for overlapping sessions:\n`
        + `      git worktree add ../<repo>-pe-${state.slug} ${branch}\n`
        + `  (add \`-b ${branch}\` to that command if the branch does not exist yet). Do\n`
        + `  ALL of this phase's work inside that worktree directory and commit there.\n`
        + `  Do not remove the worktree when you finish — later phases of this run\n`
        + `  reuse it. If it already exists, work in it as it stands.`
      : `- In each scoped repository, BEFORE editing anything: if \`${branch}\` exists\n`
        + `  (locally or on the remote), check it out; otherwise create it from the\n`
        + `  repository's default branch. Later phases of this run reuse it — leave it\n`
        + `  checked out when you finish.`;

    const mismatch = planNames
      ? `\n- Note: the plan's §Session budget names the branch \`${planNames}\`. This run\n`
        + `  was started with the console's new-branch strategy, which wins for sessions\n`
        + `  the console mints: use \`${branch}\`, and record the discrepancy in your\n`
        + `  handoff so the plan can be updated.`
      : '';

    const title = this.deps.planTitle?.(state.slug) ?? state.slug;
    const prBlock = pr ? `\n\n${prBlockText(branch, title)}` : '';

    this.record('phase.git-strategy', { mode: 'new-branch', branch, worktree, pr }, phase);

    return `\n\nGit strategy for this run — set by the operator in the console. For this run\n`
      + `it overrides whatever §Session budget says about branches:\n\n`
      + `- All work for this plan lands on ONE plan-wide branch: \`${branch}\`, in every\n`
      + `  repository in this phase's scope (${scope.join(', ')}).\n`
      + `${checkoutBullet}\n`
      + `- Commit only to \`${branch}\`. Never commit to the default branch, never push\n`
      + `  the default branch, and do not create any other branch.\n`
      + `- Handoff, INDEX and lock commits in the docs repository follow the skill's\n`
      + `  usual rules — do not invent a separate branch just for docs.${mismatch}${prBlock}\n`;
  }

  /**
   * What one phase runs as, resolved from the three places that may say.
   *
   * Order is deliberate and never rearranged: what the operator chose for THIS
   * run wins, because it is the most recent and most specific decision; then
   * the plan, because it is the durable statement of what the phase needs; then
   * the run's defaults. `source` records which of the three answered, so the
   * journal can explain a surprising model rather than merely recording it.
   */
  private optionsFor(phase: number): PhaseOptions & { source: Record<string, string> } {
    const state = this.state!;
    const chosen = state.phaseOptions?.[String(phase)] ?? {};
    const plan = this.deps.phaseDefaults?.(state.slug, phase) ?? {};
    const source: Record<string, string> = {};

    const pick = (key: 'model' | 'effort', fallback?: string): string | undefined => {
      if (chosen[key]) { source[key] = 'run'; return chosen[key]; }
      if (plan[key]) { source[key] = 'plan'; return plan[key]; }
      if (fallback) source[key] = 'default';
      return fallback;
    };

    return {
      model: pick('model', state.model),
      effort: pick('effort', state.effort),
      tools: chosen.tools,
      permissionMode: chosen.permissionMode,
      skills: chosen.skills,
      mcpServers: chosen.mcpServers,
      mcpOff: chosen.mcpOff,
      // Passed through rather than resolved here: `mcpPolicyFor` consults the
      // plan BEFORE the run, which is the opposite of this function's
      // run-beats-plan rule, and folding it in would hide that reversal.
      mcpPolicy: chosen.mcpPolicy,
      source,
    };
  }

  /**
   * Every MCP server this phase runs with, deduped, first-seen order.
   *
   * Three contributors, and they compose rather than override: what the PLAN
   * says the phase needs (its §Session budget line plus its own `**MCP:**`
   * bullet, from the engine), what the operator chose for this RUN, and what
   * they chose for this PHASE. `mcpOff` drops only the run's — the plan's
   * statement is versioned and survives, because a phase that says it needs
   * Playwright is describing the work, not somebody's preference for one run.
   */
  private mcpFor(phase: number, chosen: PhaseOptions): string[] {
    const state = this.state!;
    const fromPlan = this.deps.planMcp?.(state.slug, phase) ?? [];
    const fromRun = chosen.mcpOff ? [] : (state.mcpServers ?? []);
    return [...new Set([...fromPlan, ...fromRun, ...(chosen.mcpServers ?? [])])].filter(Boolean);
  }

  /**
   * Run the phase until it either finishes or the error policy says to stop.
   * Every disposition from `classify` is handled here and nowhere else.
   */
  private async attempt(
    phase: number, prompt: string, model: string, owner: string, lane: Lane,
    chosen: PhaseOptions = {}, opts: { maxTurns?: number; mcp?: McpResolution } = {},
  ): Promise<{ carryOn: boolean; completed: boolean }> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const spawn = this.deps.spawn ?? spawnClaude;
    let currentModel = model;
    // A freeze that was checkpointed left a session behind. Picking it up costs
    // one flag here and saves however long the phase had already been working;
    // cleared immediately, because offering the same id to a second attempt is
    // the "Session ID … is already in use" refusal.
    let resume: string | undefined = record.resumeSessionId;
    if (resume) {
      record.resumeSessionId = undefined;
      this.record('phase.resume-checkpoint', { sessionId: resume }, phase);
      // The checkpointed transcript lives in the config dir of the account
      // that WROTE it. Resuming under a different one only works if the file
      // is carried over first; when it cannot be, a fresh boot prompt (which
      // is self-contained by design) beats a `--resume` that finds nothing.
      if ((record.sessionAccountId ?? 'default') !== (state.accountId ?? 'default')) {
        const ported = this.deps.portTranscript?.(resume, record.sessionAccountId, state.accountId) ?? false;
        this.record('phase.transcript-port', {
          sessionId: resume, from: record.sessionAccountId ?? 'default',
          to: state.accountId ?? 'default', ported,
        }, phase);
        if (!ported) resume = undefined;
      }
    }
    let budget = state.phaseBudgetUsd;
    let maxTurns: number | null = opts.maxTurns ?? null;
    // The per-model walls this phase met, first first: when the whole chain
    // is limited, the FIRST model's reset is the one worth waiting for. Once
    // per phase — a second exhaustion after that wait halts as it always did.
    const modelWalls: { model: string; at: Date }[] = [];
    let modelWindowWaited = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A per-lane stop can land between attempts — during a retry backoff, a
      // usage-window sleep, or before the first spawn. Consume it here or the
      // next iteration starts a session for a phase the operator already ended.
      if (lane.stopped) return this.settleStoppedLane(lane, phase, 'spawn');
      record.attempts++;
      // A stale outcome file from a previous attempt must never speak for
      // this one — deleted here, AND rejected by `written_at` on read.
      consumeOutcome(this.outcomePath(phase));
      const outcome = await spawn({
        prompt,
        cwd: state.root,
        model: currentModel,
        effort: record.effort ?? state.effort,
        // Fail over in-place, keeping the session. The `switch-model`
        // disposition below can only restart the phase from its boot prompt,
        // discarding however long it had been working — so it is the second
        // line of defence, not the first.
        fallbackModels: fallbackChain(currentModel),
        // Legible in `/resume` and `claude agents`, which matters when the
        // question is "what is this hours-old session on my machine?".
        name: `${state.slug} p${phase}`,
        // Deliberately not `record.sessionId`. That is the id of a session that
        // has already run; handing it back as `--session-id` asks the CLI to
        // create a session that exists, and it refuses — "Session ID … is
        // already in use", which is what killed two real retries. A new attempt
        // gets a new id; continuing an existing one goes through `resume`.
        resume,
        budgetUsd: budget,
        maxTurns,
        settings: this.settingsPath ?? undefined,
        // A mechanical phase can run with a small tool set and no MCP servers:
        // less blast radius, and a smaller system prompt to pay for every turn.
        tools: chosen.tools?.length ? chosen.tools : undefined,
        // Rewritten per attempt, not per run: a credential changed between
        // attempts has to reach the retry, and the file costs a JSON write.
        // Absent means "attach nothing", which leaves the machine's own MCP
        // configuration in place — what every run did before this existed.
        //
        // WHICH servers, though, is the boarding's answer and not re-derived
        // here: the set was probed once, named to the model once, and a second
        // resolution could silently hand the session a server its prompt says
        // is unavailable.
        mcpConfig: (await this.armMcp(phase, chosen, opts.mcp)) ?? undefined,
        // Only when the phase asked for servers and got none of them. See
        // `resolveMcp`: an emptied set still has to be a CLOSED set.
        ...(opts.mcp?.strict ? { strictMcp: true } : {}),
        permissionMode: chosen.permissionMode as never,
        // Read fresh each attempt, so a profile changed mid-run is in force for
        // the next phase rather than for the next run.
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { lane.handle = handle; this.syncMirror(); },
        // The child must know it IS the lock holder. Without this the runner
        // claims the phase as `autopilot/<runId>`, the session it spawns reads
        // a lock owned by a stranger, and — correctly, per the skill's own
        // guardrail — refuses to touch the phase rather than force it. The
        // supervisor deadlocks against its own worker. Sharing PE_OWNER makes
        // phase-lock.sh report the lock as the session's own, so it refreshes
        // instead of stopping, while everyone else still sees it held.
        //
        // PE_SCOPE rides along for the same reason one level up: the session
        // claims its own lock, and a claim that names no scope writes a lock
        // every other reader has to treat as colliding with everything.
        env: await this.sessionEnv({
          PE_OWNER: owner,
          PE_SCOPE: formatScope(lane.grant?.scope ?? await this.scopeFor(phase)),
          // Where `phase-outcome.sh` writes the session's declared outcome —
          // the machine-readable record the runner reads on exit instead of
          // guessing from prose.
          PE_OUTCOME_FILE: this.outcomePath(phase),
          // Where a decision goes. Separate from the outcome file on purpose:
          // an outcome is read once and consumed, a ruling is appended and
          // kept, and a session must be able to record the second without
          // touching the first.
          PE_RULINGS_FILE: rulingsFile(this.state!.root, this.state!.slug),
        }),
        signal: this.abort?.signal,
        onPid: (pid) => {
          lane.pid = pid;
          // Writes `children[phase]` AND the single-lane `state.child` mirror.
          // Both, always: see `syncMirror`.
          this.syncMirror();
          this.persist();
        },
        onEvent: (event) => this.onStream(phase, event),
      });

      lane.pid = null;
      lane.handle = null;
      this.syncMirror();
      state.spentUsd += outcome.costUsd;
      record.costUsd += outcome.costUsd;
      // See the other attempt-end sites: the rung is charged what its own
      // attempt spent, and settled later by whoever learns how it ended.
      chargeRung(state.recoveries?.[String(record.phase)], outcome.costUsd);
      record.turns = (record.turns ?? 0) + outcome.turns;
      // Wall-clock minus whatever the operator held it for. A phase frozen over
      // lunch did not take an extra hour to think. Read off THIS lane: with
      // several running, `state.freeze` may be describing a different phase,
      // and subtracting its held time here would credit one phase with a pause
      // that happened to another.
      const frozenNow = lane.frozen ? Math.max(0, this.now().getTime() - Date.parse(lane.frozen.at)) : 0;
      if (frozenNow) record.frozenMs = (record.frozenMs ?? 0) + frozenNow;
      record.durationMs = (record.durationMs ?? 0) + Math.max(0, outcome.durationMs - frozenNow);
      if (outcome.sessionId) record.sessionId = outcome.sessionId;
      // Kept on the record, not only in the journal. When a phase exits clean
      // and changes nothing this is the only account of why, and the halt that
      // reports it needs to be able to quote it without re-reading NDJSON.
      record.said = outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200);
      this.record('phase.session', {
        attempt, model: currentModel, effort: record.effort ?? state.effort ?? null,
        costUsd: outcome.costUsd, turns: outcome.turns,
        ...(outcome.injected ? { injected: outcome.injected } : {}),
        subtype: outcome.signal.subtype, ms: outcome.durationMs, argv: outcome.argv,
        // The session's own closing words. When a phase exits clean but changes
        // nothing, this is the only place that says why — without it, diagnosing
        // the failure means re-running it and watching.
        said: outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200),
      }, phase);

      // Did this attempt change anything? The answer is the `stalemate`
      // counter, and this is the one moment it can be asked: the session has
      // exited and nothing has re-boarded yet.
      await this.settleIdleAttempt(phase, lane);

      // A checkpoint ended this child on purpose. The phase record is already
      // `pending` with a session to resume, and reading exit 143 as a crash
      // here would overwrite both. Two kinds: the freeze escalation pauses the
      // run for a person; an account switch carries on driving, because the
      // whole point was to keep going on the account that can pay.
      if (lane.checkpointed) {
        lane.checkpointed = false;
        lane.frozen = null;
        state.freeze = null;
        const note = lane.checkpointNote;
        lane.checkpointNote = null;
        if (note) return { carryOn: note.carryOn, completed: false };
        state.finishedReason = record.resumeSessionId
          ? `phase ${phase} was frozen past ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes and `
            + 'checkpointed. Continue resumes the same session.'
          : `phase ${phase} was frozen past ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes and `
            + 'checkpointed. Continue starts it again from its boot prompt.';
        return { carryOn: false, completed: false };
      }

      // A per-lane stop ended this child on purpose. Settle it and hand the
      // loop back — the whole point of the verb is that the rest of the run
      // does not stop with it. Before the run-level check below: that one
      // pauses the whole run, which is exactly what this stop is not.
      if (lane.stopped) return this.settleStoppedLane(lane, phase);

      // An operator stop is not a failure to diagnose — we caused it. A
      // console SHUTDOWN lands here too (`checkpointForShutdown` aborts the
      // lanes), and must not be written as the operator's: the note takes the
      // killed-lane shape the convergence loop resumes at boot, the session
      // id is kept for the `--resume`, and `stoppedBy` says which it was.
      if (this.stopRequested || this.abort?.signal.aborted) {
        record.status = 'interrupted';
        if (this.shuttingDown) {
          record.note = consoleStoppedNote(phase);
          record.resumeSessionId ??= record.sessionId;
          state.stoppedBy = 'system';
        } else {
          record.note = 'stopped by the operator';
          state.stoppedBy = 'operator';
        }
        state.status = 'paused';
        return { carryOn: false, completed: false };
      }

      const disposition = classify(outcome.signal, this.now());
      this.record('phase.disposition', { attempt, kind: disposition.kind, reason: reasonOf(disposition) }, phase);
      this.emit('phase', { phase, disposition: disposition.kind, reason: reasonOf(disposition) });

      switch (disposition.kind) {
        case 'ok':
          return { carryOn: true, completed: true };

        case 'retry':
          if (attempt === MAX_ATTEMPTS) break;
          await this.sleep(disposition.afterMs);
          // Same stand-down as the usage-window wake: a halt from another lane
          // during the backoff means no attempt N+1.
          if (state.halt) {
            record.status = 'interrupted';
            record.note = 'the run halted while this phase waited to retry';
            return { carryOn: false, completed: false };
          }
          continue;

        case 'wait-until': {
          // The usage window belongs to the ACCOUNT, not to this run. Both
          // marks land whatever the policy does next: the scheduler holds back
          // this account's other admissions, and the registry remembers the
          // wall so meters, pre-flight and `pickAccount` all agree.
          const window = limitBucket(outcome.signal.text ?? '');
          this.deps.onAccountLimited?.(state.accountId, window, disposition.at, disposition.reason);
          this.deps.scheduler?.throttle(disposition.at.getTime(), state.accountId ?? 'default');

          // The SAME rule as the long-window wall below, and it has to be the
          // same one: `switch` always moves; under `wait` — the stored default,
          // and the policy a run started by anything but the launch form gets —
          // `autoAccountSwitch` (on by default) moves it rather than sleeping
          // on a clock while another registered account sits idle; `pause`
          // keeps its word. These two sites used to disagree, so whether a wall
          // auto-switched depended on which of them happened to notice it.
          const policy = state.onLimit ?? 'wait';
          const wantSwitch =
            policy === 'switch' || (policy === 'wait' && this.deps.autoAccountSwitch?.() !== false);
          if (wantSwitch && this.trySwitchAccount(phase, record, disposition.reason, currentModel)) {
            // Continue NOW, on the account that can pay — same session when
            // its transcript came along, a fresh boot prompt when it did not.
            resume = record.sessionId && this.transcriptFollows(record) ? record.sessionId : undefined;
            this.persist();
            continue;
          }
          // `pause` checkpoints for a person; `wait` sleeps on the clock —
          // one helper, shared with the walls below.
          if (await this.waitOutWindow(phase, record, disposition.at, disposition.reason) === 'continue') continue;
          return { carryOn: false, completed: false };
        }

        case 'switch-model': {
          // A QUOTA hit (as opposed to a 529 capacity blip) names its bucket —
          // file the per-model wall against the account, so the meters agree
          // with what just happened and `pickAccount` steers a same-model run
          // elsewhere. No scheduler throttle: every other model is still fine.
          if (disposition.bucket && disposition.at) {
            this.deps.onAccountLimited?.(state.accountId, disposition.bucket, disposition.at, disposition.reason);
          }
          // Remember the wall per model. A capacity blip (529) names no reset
          // and is not remembered: there is nothing to wait for.
          if (disposition.at && !modelWalls.some((wall) => wall.model === currentModel)) {
            modelWalls.push({ model: currentModel, at: disposition.at });
          }
          const next = nextModel(currentModel);
          if (!next) {
            // Every model is limited. The model wall's one rung: when the
            // FIRST model's reset is known and near enough to sleep on, wait
            // for it and retry the same session on that model — the strongest
            // one the phase was given, not the weakest it fell to. Once per
            // phase; without a reset (or past the ceiling) this halts as it
            // always did.
            const first = modelWalls[0];
            const until = first && !modelWindowWaited ? resetWaitUntil(first.at, this.now()) : null;
            if (first && until) {
              modelWindowWaited = true;
              this.record('phase.model-window-wait', {
                model: first.model, until: until.toISOString(), reason: disposition.reason,
              }, phase);
              const verdict = await this.waitOutWindow(
                phase, record, until,
                `every model is limited; ${first.model}'s window reopens ${until.toLocaleString()}`,
                { policy: 'wait' },
              );
              if (verdict !== 'continue') return { carryOn: false, completed: false };
              currentModel = first.model;
              record.model = first.model;
              modelWalls.length = 0;
              // The same session, when its transcript is where this account
              // looks — the phase keeps whatever it had done.
              resume = record.sessionId && this.transcriptFollows(record) ? record.sessionId : undefined;
              this.record('phase.model-window-retry', { model: first.model, resume: resume ?? null }, phase);
              continue;
            }
            this.halt(`every model is exhausted or at capacity (${disposition.reason})`, phase, 'models-exhausted');
            return { carryOn: false, completed: false };
          }
          this.record('phase.model-switch', { from: currentModel, to: next, reason: disposition.reason }, phase);
          currentModel = next;
          record.model = next;
          // Fresh start on the new model: the prompt is self-contained, which is
          // the whole point of a boot prompt.
          resume = undefined;
          continue;
        }

        case 'resume': {
          if (!record.sessionId) { this.halt('the session hit a cap but reported no session id to resume', phase, 'phase-crashed'); return { carryOn: false, completed: false }; }
          resume = record.sessionId;
          if (disposition.raise === 'budget') budget = Math.max(1, (budget ?? 5) * 2);
          else maxTurns = (maxTurns ?? 60) * 2;
          this.record('phase.resume', { raise: disposition.raise, budget, maxTurns }, phase);
          continue;
        }

        case 'needs-human':
          // One park IS automatable: a usage reset too far away to sleep on,
          // held by a console that has another account. The discriminant makes
          // that decidable without string-matching the reason.
          if (disposition.cause === 'usage-window') {
            const window = limitBucket(outcome.signal.text ?? '');
            this.deps.onAccountLimited?.(state.accountId, window, disposition.at ?? null, disposition.reason);
            if (disposition.at) {
              this.deps.scheduler?.throttle(disposition.at.getTime(), state.accountId ?? 'default');
            }
            // The usage wall's first rung. `switch` always could; under
            // `wait` — which cannot wait this long — `autoAccountSwitch` (on
            // by default) moves the run to an account that can pay instead of
            // stopping for a person. `pause` keeps its word and pauses.
            const policy = state.onLimit ?? 'wait';
            const wantSwitch = policy === 'switch' || (policy === 'wait' && this.deps.autoAccountSwitch?.() !== false);
            if (wantSwitch && this.trySwitchAccount(phase, record, disposition.reason, currentModel)) {
              resume = record.sessionId && this.transcriptFollows(record) ? record.sessionId : undefined;
              this.persist();
              continue;
            }
            if (disposition.at) {
              // No account can pay: the run waits on the window ITSELF —
              // restart-safe, the clock settles it — with the one ask that
              // would end the wait sooner left on it. Not a person's halt.
              const base = errandFor('resource-wall:usage', ['switch-account → no other account has headroom'], phase);
              const errand: Errand = {
                ...base,
                how: `The run waits by itself until ${disposition.at.toLocaleString()}. To continue sooner, `
                  + 'register or sign in another Claude account under Settings ▸ Accounts and switch the run to it.',
              };
              const verdict = await this.waitOutWindow(phase, record, disposition.at, disposition.reason, { errand });
              if (verdict === 'continue') continue;
              return { carryOn: false, completed: false };
            }
          }
          {
            // A credential complaint names WHOSE credential: the classifier is
            // deliberately account-blind, and "sign that account in again" is
            // only actionable when the reason says which one.
            const reason = state.accountId
              && /authentication failed|organization policy|billing/i.test(disposition.reason)
              ? `${disposition.reason} (account: ${state.accountId})`
              : disposition.reason;
            record.status = 'parked';
            record.note = reason;
            this.record('phase.needs-human', { reason }, phase);
            // Anything a person must fix is usually global — an expired login does
            // not get better on the next phase. Stop rather than burn through the
            // rest of the plan failing identically.
            this.halt(reason, phase, 'needs-human');
            return { carryOn: false, completed: false };
          }

        case 'phase-failed':
          record.note = disposition.reason;
          if (attempt < MAX_ATTEMPTS) { await this.sleep(15_000); continue; }
          break;
      }
      break;
    }

    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    state.consecutiveFailures++;
    this.record('phase.failed', { attempts: record.attempts, note: record.note }, phase);
    if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
      this.halt(`${state.consecutiveFailures} phases failed in a row`, phase, 'failure-streak');
      return { carryOn: false, completed: false };
    }
    return { carryOn: state.autonomy === 'keep-going', completed: false };
  }

  /**
   * Score the attempt that just ended, and re-evaluate the lane.
   *
   * `stalemate` is the one signal that cannot be seen from the stream: an
   * attempt that produces nothing looks, second by second, exactly like an
   * attempt that is about to. It is only knowable at the end, and only by
   * asking the tree — which is why the counter lives on the RECORD (it spans
   * attempts, each with its own lane) and why the window is `attemptStartedAt`
   * rather than the phase's first start: once attempt 1 has committed
   * anything, a window anchored at the phase start would call every later
   * attempt productive whatever it did.
   *
   * "I could not read the tree" is not "nothing happened". An unreadable
   * working tree leaves the counter exactly where it was — three attempts
   * against a repository the console cannot see is a console problem, and
   * announcing it as a stalemate would send a person to look at the wrong
   * thing.
   */
  private async settleIdleAttempt(phase: number, lane: Lane): Promise<void> {
    const record = phaseRecord(this.state!, phase);
    const work = await workEvidence(
      (args) => this.gitOrNull(args),
      record.attemptStartedAt ?? record.startedAt ?? null,
      await this.scopeDirs(phase),
    ).catch(() => null);
    if (!work || work.did === null) return;
    record.idleAttempts = work.did ? 0 : (record.idleAttempts ?? 0) + 1;
    lane.signals.idleAttempts = record.idleAttempts;
    // `dirty` has no time component, so this reading is as good as the
    // ticker's. `commitsSinceStart` deliberately is NOT taken from here — it
    // counts from the phase's start and this call counted from the attempt's.
    lane.signals.treeDirty = (work.dirty ?? 0) > 0;
    await this.evaluateLane(lane, stallThresholds(this.deps.stallThresholds?.()), this.now().getTime());
  }

  /**
   * `confirm`, with the verifying clock retired however it returns.
   *
   * A wrapper rather than a `try/finally` inside `confirm` itself: that method
   * returns from a dozen places across several hundred lines, and a clock left
   * set by one of them would suppress the stall detector for the rest of the
   * run.
   */
  private async confirmed(phase: number): Promise<boolean> {
    const record = phaseRecord(this.state!, phase);
    try {
      return await this.confirm(phase);
    } finally {
      delete record.verifyingSince;
    }
  }

  /**
   * The three independent checks. All must agree before a phase counts as done.
   * Nothing here asks the session what happened.
   */
  private async confirm(phase: number): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    record.status = 'verifying';
    // Two readers, one clock. The live detector suppresses every stall signal
    // while this is set, because the session has exited and the §Verification
    // commands own the next several minutes; the inbox's `verify-hanging` row
    // measures the wait from it. `confirmed` is the only writer, and it clears
    // it however this returns.
    record.verifyingSince = this.now().toISOString();
    this.emit('phase', { phase, status: 'verifying' });

    /* The session's declared outcome, read once and journalled. The board
     * outranks it — a done board with a waiting outcome means the wait was
     * about nothing — so `closed()` consults it only when the board is not
     * done. Its absence means what it always meant: the session declared
     * nothing, and every legacy path below is unchanged. */
    const declared = this.takeOutcome(phase);

    /* 0. the board, re-read from disk — never the session's word for it.
     *
     * First, because it is free and it is decisive. It used to run last, after
     * the verification commands and after up to twelve hours of waiting for a
     * person to hand-confirm the fragments the runner would not execute — and
     * then threw their answer away, because the phase had never written a
     * handoff at all. Nobody should be asked to vouch for a phase that produced
     * nothing, and no test suite should be run to prove one. */
    const closed = await this.closed(phase, declared);
    if (closed === 'waiting') return true; // parked or re-queued; the run carries on
    if (closed === 'halted') return false;

    /* 1. the plan's own verification commands */
    const text = await this.deps.verificationText(state.slug, phase);
    const verify = this.deps.verify ?? verifyPhase;
    const cwd = await this.verifyCwd(phase);
    const verification = await verify(text, {
      cwd,
      preflightSkip: this.verifyEnv().preflightSkip,
      // Explicit, and longer than the 15-minute default: a real phase's
      // verification is a full suite, sometimes a container build, and the
      // default turned a slow-but-passing check into a red one that proved
      // nothing. Still bounded — a wedged command must end.
      timeoutMs: VERIFY_TIMEOUT_MS,
      signal: this.abort?.signal ?? undefined,
      onStart: (command, index, total) => {
        this.emit('verify', { phase, command, index, total });
      },
    });
    record.verification = verification;
    // Against the RESOLVED root, the same base `verifyCwd` measured from.
    // `state.root` can be a symlinked path (`/var/…` → `/private/var/…` on
    // macOS), and relating a resolved path to an unresolved one yields a string
    // of `../..` that names the right directory and reads as an escape.
    record.verifiedIn = relative(resolve(state.root), cwd) || '.';
    this.record('phase.verify', {
      ok: verification.ok, reason: verification.reason,
      // Where they ran. A verification that passed in the wrong directory and
      // one that passed in the right one are indistinguishable without this.
      cwd: record.verifiedIn,
      ran: verification.ran.map((r) => ({ command: r.command, code: r.code, ms: r.ms })),
      notRun: verification.notRun,
      ...(verification.skipped?.length ? { skipped: verification.skipped } : {}),
    }, phase);

    // Every command's lead is missing from this machine: nothing ran, nothing
    // was proven either way. Boarding parks on exactly this fact before a
    // session is spent (`preflightVerification`); when it is only discovered
    // here — a harness-injected verifier, a PATH that changed mid-phase — the
    // disposition is the SAME park, with the same sentence, not a twelve-hour
    // card asking a person to vouch for checks a machine simply lacks.
    if (!verification.ran.length && verification.skipped?.length) {
      const leads = [...new Set(verification.skipped.map((entry) => entry.lead))].join(', ');
      record.status = 'parked';
      record.note = `phase ${phase}'s §Verification cannot run on this machine — every command's lead `
        + `is missing from the PATH (${leads}). Fix the PATH (re-run deploy/agent.sh install from a `
        + 'full shell), rewrite the bullet with what exists, or Repair with AI, then Retry.';
      record.endedAt = new Date().toISOString();
      this.record('phase.verify-unrunnable', { leads: leads.split(', '), skipped: verification.skipped.length }, phase);
      this.emit('phase', { phase, status: 'parked', note: record.note });
      // The RUN parks too, as the card's timeout does: the board already reads
      // done (the session wrote its handoff), so a parked record left in a
      // driving loop would be reconciled to done on the very next tick — an
      // unverified phase passing silently. A person (or a PATH fix and a
      // Retry) settles it; Continue afterwards lets the board's word stand.
      this.park(record.note, phase);
      return false;
    }

    // A command that ran and failed is a verdict. A verification that could not
    // be run is not — it is an unanswered question, and answering it with
    // "failed" is how this run ended up stopped on a phase nothing had actually
    // found fault with, showing a Retry button that could only ever reproduce
    // the same non-result. The two are now told apart.
    const broke = verification.ran.filter((r) => !r.ok);
    if (broke.length) {
      record.status = 'failed';
      state.consecutiveFailures++;
      this.halt(
        `phase ${phase} did not verify: ${broke.length} of ${verification.ran.length} command(s) failed `
        + `— ${broke.map((r) => r.command).join(', ')}`
        + await this.verifyHint(phase),
        phase,
        'verify-failed',
      );
      return false;
    }

    /* 2. the plan still lints */
    const lint = readLint(await this.script('validate.sh', [state.slug]));
    record.lint = { ok: lint.ok, summary: lint.summary };
    if (!lint.ok) {
      record.status = 'failed';
      state.consecutiveFailures++;
      this.halt(`phase ${phase} left the plan failing validate.sh: ${lint.summary}`, phase, 'plan-lint');
      return false;
    }

    /* 3. and only now, a person — for whatever no machine could settle.
     *
     * Last on purpose. Every check above is free or cheap and answers on its
     * own; a question to a human costs the one resource that does not scale, and
     * an operator asked to confirm things the runner could have checked itself
     * learns to answer without reading. Under `keep-going` a verification that
     * otherwise passed does not stop for this; under the cautious default it
     * always does, which is what that setting means. */
    if (verification.notRun.length && (!verification.ok || state.autonomy === 'halt-on-everything')) {
      if (!await this.askHuman(phase, verification)) return false;
    } else if (!verification.ok) {
      record.status = 'failed';
      state.consecutiveFailures++;
      this.halt(`phase ${phase} did not verify: ${verification.reason}`, phase, 'verify-failed');
      return false;
    }

    record.status = 'done';
    record.endedAt = new Date().toISOString();
    this.lastDonePhase = phase;
    // The honest verdict travels with the record: a phase that passed with
    // checks skipped is not the same fact as one whose every check ran.
    if (verification.skipped?.length) {
      record.note = `verified with ${verification.skipped.length} check(s) skipped — unrunnable `
        + `on this machine (${[...new Set(verification.skipped.map((s) => s.lead))].join(', ')})`;
    }
    state.consecutiveFailures = 0;
    // Not a flat `null`: with another lane still running, clearing the pointer
    // here would tell the console the run was between phases while a session
    // was mid-edit. `syncMirror` moves it to whatever is still live, and only
    // clears it when nothing is.
    if (this.lanes.size > 1) this.syncMirror();
    else state.activePhase = null;
    this.record('phase.done', {
      costUsd: record.costUsd, attempts: record.attempts,
      ...(verification.skipped?.length ? { skippedChecks: verification.skipped.length } : {}),
    }, phase);
    this.emit('phase', { phase, status: 'done' });
    return true;
  }

  /** The verification-command vocabulary — scripts/verify.env, the same file
   * the bash engine sources (F5 single-source discipline), with a hardcoded
   * fallback for older scripts dirs. Cached by the loader. */
  private verifyEnv(): VerifyEnv {
    return loadVerifyEnv(this.deps.scriptsDir);
  }

  private static readonly VERIFICATION_PARK = VERIFICATION_PARK_NOTE;

  /** The program a command starts with — the shared extractor in verify.ts,
   * so the boarding preflight and the verify-time skip can never disagree. */
  private leadToken(command: string): string | null {
    return resolveLead(command);
  }

  /**
   * Read the phase's §Verification BEFORE a session is paid for.
   *
   * A real phase spent $45 and 68 minutes, then failed in 92 ms: its
   * §Verification named a compose file two directories away and test paths
   * that never existed. Every one of those facts was readable before the
   * spawn. So this reads them — with the same extractor the real verification
   * will use — and:
   *
   *  · returns a PARK reason when nothing would run at all (today that
   *    "passes" vacuously into person-checks, after the expensive part);
   *  · journals warnings for everything else — refused fragments, cwd-
   *    sensitive commands with no `Verify in:`, leads missing from the
   *    verification PATH — because a warning that blocked would make every
   *    plan author fight the runner, and one that stays silent repeats the
   *    $45 lesson.
   *
   * A custom `verify` dep owns the question entirely: predicting the default
   * extractor against a substitute verifier would judge a different machine.
   */
  /**
   * Can this phase's MCP servers actually be reached, BEFORE a session is paid for?
   *
   * The same lesson as the verification preflight, from the other direction. An
   * unattended `-p` run cannot fix a server that needs signing in: there is no
   * `/mcp` panel, `claude mcp login` wants a browser, and what the CLI does
   * instead is tell the MODEL that the tools are unavailable — so the session
   * improvises around a missing server for an hour and hands back work that
   * used none of what the plan chose it for.
   *
   * Three outcomes, three sentences, each naming what a person would do:
   *
   *  · an id nobody registered → the plan and the machine disagree; register it
   *    or drop it from the plan (this is F15's advisory, arriving as a fact);
   *  · a registered server switched off → the operator already said no, so say
   *    that rather than reconnecting it behind their back;
   *  · a server that will not connect → sign it in, or fix its credential.
   *
   * A probe that could not RUN never parks. "I could not check" and "they are
   * down" are different facts, and turning a flaky subprocess into a stopped
   * plan would be the worse of the two failures.
   */
  private async resolveMcp(phase: number, chosen: PhaseOptions): Promise<McpResolution> {
    const state = this.state!;
    const ids = this.mcpFor(phase, chosen);
    const clean = (): McpResolution => ({ usable: ids, degraded: [], park: null, strict: false });
    if (!ids.length) return { usable: [], degraded: [], park: null, strict: false };
    if (!this.deps.mcp) {
      // No registry wired in (a harness, or a console built before this): the
      // phase runs on whatever MCP configuration the machine already has, which
      // is exactly what every run did before this existed.
      this.record('phase.mcp-unmanaged', { servers: ids }, phase);
      return clean();
    }

    const result = await this.deps.mcp.preflight(ids, state.root);

    if (result.probeError) {
      // Could not check ≠ they are down — for the servers the probe was ABOUT.
      // Turning a flaky subprocess into a stopped plan, or into a session told
      // its tools are missing when they are not, is the worse of the two
      // failures, and that was true before the policy existed.
      //
      // An id the registry does not hold is a different fact: nothing was
      // probed to learn it and the probe failing does not put it back in doubt.
      this.record('phase.mcp-preflight-skipped', { reason: result.probeError, servers: ids }, phase);
      if (!result.unknown.length && !result.disabled.length) return clean();
    }

    const degraded: McpDegradation[] = [
      ...result.unknown.map((id): McpDegradation => ({ id, reason: 'unregistered' })),
      ...result.disabled.map((id): McpDegradation => ({ id, reason: 'switched-off' })),
      ...result.blocking.map((row): McpDegradation => ({
        id: row.id,
        reason: row.status === 'needs-auth' ? 'needs-auth' : 'failed',
        ...(row.error?.message ? { detail: row.error.message } : {}),
      })),
    ];

    if (!degraded.length) {
      this.record('phase.mcp', { servers: ids }, phase);
      return clean();
    }

    const policy = this.mcpPolicyFor(phase, chosen);
    // The park carries what it parked on: the clock that times it out names
    // those servers to the session and in the errand.
    if (policy === 'require') return { usable: [], degraded, park: this.mcpParkNote(phase, degraded), strict: false };

    const lost = new Set(degraded.map((row) => row.id));
    const usable = ids.filter((id) => !lost.has(id));
    // Every server this phase asked for is unreachable, so there is no config
    // file to pass — but the set must still be closed. `--mcp-config` is what
    // normally carries `--strict-mcp-config`, and without it the CLI unions in
    // whatever `~/.claude.json` and the project's `.mcp.json` hold. A degraded
    // phase silently gaining the machine's own servers is not a degradation
    // anyone asked for, and determinism here is a safety property.
    return { usable, degraded, park: null, strict: usable.length === 0 };
  }

  /**
   * The park sentence, under `require`. Three shapes, each naming the errand.
   *
   * Unchanged wording from when this was the only outcome, because
   * `MCP_PARK_NOTE` and `MCP_AUTH_PARK_NOTE` match against it and the service's
   * heal path reads it. Change one, change all three.
   */
  private mcpParkNote(phase: number, degraded: McpDegradation[]): string {
    const only = (reason: McpDegradation['reason']) =>
      degraded.filter((row) => row.reason === reason).map((row) => row.id);

    const unregistered = only('unregistered');
    if (unregistered.length === degraded.length) {
      return `phase ${phase} names MCP server${unregistered.length === 1 ? '' : 's'} this console has `
        + `not registered: ${unregistered.join(', ')}. Register ${unregistered.length === 1 ? 'it' : 'them'} `
        + 'in Phase Console → MCP, or drop the name from the plan, then Retry.';
    }
    const off = only('switched-off');
    if (off.length === degraded.length) {
      return `phase ${phase} needs MCP server${off.length === 1 ? '' : 's'} that ${off.length === 1 ? 'is' : 'are'} `
        + `switched off here: ${off.join(', ')}. Turn ${off.length === 1 ? 'it' : 'them'} back on `
        + 'in Phase Console → MCP, or drop the name from the plan, then Retry.';
    }
    const named = degraded.map((row) => `${row.id} (${row.detail ?? mcpReasonText(row.reason)})`);
    return `phase ${phase} cannot start: MCP server${named.length === 1 ? '' : 's'} ${named.join(', ')}. `
      + 'An unattended session cannot sign a server in — do it from Phase Console → MCP '
      + '(or `claude mcp login <name>`), then Retry.';
  }

  /**
   * What this phase does when a server will not connect, from the four places
   * that may say — most specific first.
   *
   * The plan outranks the RUN on purpose, and this is the one resolution in the
   * runner where it does. `model` and `effort` let the operator's choice for a
   * run win because they are preferences about how to spend money. This is not
   * that: a phase whose plan says `require` is making a claim about the work
   * itself, and an operator's run-wide "carry on regardless" — usually clicked
   * for an unrelated reason — must not quietly overrule it. They can still say
   * so for that ONE phase, which is the level where they know what they mean.
   */
  private mcpPolicyFor(phase: number, chosen: PhaseOptions): McpPolicy {
    const state = this.state!;
    return chosen.mcpPolicy
      ?? this.deps.planMcpPolicy?.(state.slug, phase)
      ?? state.mcpPolicy
      ?? 'continue';
  }

  /**
   * Write this phase's `--mcp-config`, or null when it attaches nothing.
   *
   * Per attempt rather than per run, unlike the settings file: a server the
   * operator signed in between two attempts must be usable by the second, and
   * the file costs a JSON write. It carries secrets, so it is 0600 and passed
   * as a path — argv is world-readable in `ps`.
   */
  private async armMcp(
    phase: number, chosen: PhaseOptions, resolved?: McpResolution,
  ): Promise<string | null> {
    if (!this.deps.mcp) return null;
    const state = this.state!;
    // The boarding's answer when there is one — see the call site. The fallback
    // is for the paths that arm without boarding (and for older tests).
    const ids = resolved ? resolved.usable : this.mcpFor(phase, chosen);
    if (!ids.length) return null;
    try {
      return await this.deps.mcp.configFor(state.id, ids);
    } catch (error) {
      // Never fatal. The preflight has already said the servers are reachable;
      // failing to WRITE the file is our problem, and a phase that runs without
      // its servers is worse only than one that runs with them — not worse than
      // one that never runs at all.
      log.error('runner.mcp-config', { error, servers: ids });
      this.record('phase.mcp-config-failed', { error: (error as Error).message, servers: ids }, phase);
      return null;
    }
  }

  private async preflightVerification(phase: number): Promise<string | null> {
    const state = this.state!;
    if (this.deps.verify) return null;
    const text = await this.deps.verificationText(state.slug, phase);
    const { commands, notRun } = extractCommands(text);

    if (!commands.length) {
      const specimen = notRun[0];
      if (text?.trim()) {
        // "0 entries refused" was reachable and read like a bug: a §Verification
        // holding only an environment preamble refuses nothing and runs nothing,
        // so it needs the sentence that says exactly that.
        return `phase ${phase}'s §Verification contains nothing the runner can execute — `
          + (notRun.length
            ? `${notRun.length} entr${notRun.length === 1 ? 'y' : 'ies'} refused`
              + (specimen ? ` (first: ${specimen.reason})` : '')
            : 'it sets up an environment but never runs a check')
          + '. Fix the plan bullet into whole, copy-runnable commands, then Retry.';
      }
      // The parser handed over nothing — but a plan that DECLARES the bullet
      // deserves a different sentence than one that omits it: the first sends
      // the author to their formatting, the second to their keyboard. Blaming
      // "the plan states no verification" for a shape the parser lost once
      // sent an operator hunting a bug in a plan that had none.
      if (await this.deps.verificationDeclared?.(state.slug, phase)) {
        return `phase ${phase}'s §Verification exists in the plan but the console could not read `
          + 'a runnable command out of it — check the bullet\'s shape against '
          + 'references/plan-format.md §6, or Repair with AI, then Retry.';
      }
      return `the plan states no verification for phase ${phase} — nothing would prove the work. `
        + 'Add a §Verification command to the plan, then Retry.';
    }

    const warnings: string[] = [];
    const detail: PreflightWarning[] = [];
    for (const held of notRun) {
      warnings.push(`a person will be asked: ${held.text} — ${held.reason}`);
      detail.push({ kind: 'human-check', command: held.text, message: `a person will be asked: ${held.text} — ${held.reason}` });
    }

    const declared = (await this.deps.verifyIn?.(state.slug, phase))?.trim();
    if (!declared) {
      const sensitive = commands.filter((command) => {
        if (/^cd\s/.test(command.trim())) return false; // names its own directory
        const lead = this.leadToken(command);
        return lead ? this.verifyEnv().cwdSensitive.has(lead) : false;
      });
      if (sensitive.length) {
        const message = `${sensitive.length} command(s) are cwd-sensitive and the plan declares no `
          + '**Verify in:** — they will run at the repository root';
        warnings.push(message);
        detail.push({ kind: 'cwd-unpinned', message });
      }
    }

    const missing = unresolvableLeads(commands, process.env.PATH, this.verifyEnv().preflightSkip);
    for (const lead of missing.keys()) {
      // The consequence named matches what the runner will actually DO now:
      // skip and record, never run to a 127 halt. `python` gets its errand.
      const hint = lead === 'python' && !missing.has('python3')
        ? ' — this machine has python3; write python3' : '';
      const message = `\`${lead}\` is not on the verification PATH — its command will be `
        + `SKIPPED at verification (recorded, not failed)${hint}`;
      warnings.push(message);
      detail.push({ kind: 'missing-lead', lead, message });
    }
    if (missing.size) {
      // When EVERY command's lead is missing, boarding would buy a session
      // whose verification cannot run at all — the same park F14/F17 promise.
      const anyRunnable = commands.some((command) => {
        const lead = resolveLead(command);
        return !lead || !missing.has(lead);
      });
      if (!anyRunnable) {
        return `phase ${phase}'s §Verification cannot run on this machine — every command's lead `
          + `is missing from the PATH (${[...missing.keys()].join(', ')}). Fix the PATH (re-run `
          + 'deploy/agent.sh install from a full shell), rewrite the bullet with what exists, '
          + 'or Repair with AI, then Retry.';
      }
    }

    // On the record too, not just the journal: the journal is rendered by
    // nothing, and these warnings' first visible symptom used to be the
    // verification failing after the money was spent.
    const record = phaseRecord(state, phase);
    if (warnings.length) {
      record.preflight = warnings;
      record.preflightDetail = detail;
      this.record('phase.verify-preflight', { warnings, detail }, phase);
      this.emit('phase', { phase, preflight: warnings, preflightDetail: detail });
    } else {
      delete record.preflight;
      delete record.preflightDetail;
    }
    return null;
  }

  /**
   * Where this phase's verification commands mean to be run.
   *
   * The root unless the plan says otherwise. `**Verify in:**` exists because
   * verification runs `bash -c` with the cwd the console was opened on, and in
   * a monorepo that is the superproject: a plan whose phase lives in one
   * submodule had its suite run against the whole tree, and one real plan's
   * `docker compose run … -v "$PWD:/app"` mounted the entire monorepo into a
   * container and hung there.
   *
   * Two ways to be refused, both falling back to the root rather than failing
   * the phase — a plan with a typo in one bullet should still get verified:
   *
   *  · It escapes the root. `../../etc` is not a directory this console gets to
   *    run commands in, whatever the plan says. The plan file is editable by
   *    anyone who can open the repo, so this is a boundary, not a typo check.
   *  · It is not there. A path that named a directory when the plan was written
   *    and does not now is exactly the case where running in it silently would
   *    be worst — bash would inherit the parent's cwd and nobody would be told.
   *
   * Both journal `phase.verify-in-missing`, because a verification that ran
   * somewhere other than where the plan said must never be silent.
   */
  private async verifyCwd(phase: number): Promise<string> {
    const state = this.state!;
    const root = resolve(state.root);
    const declared = (await this.deps.verifyIn?.(state.slug, phase))?.trim();
    if (!declared) return root;

    const target = resolve(root, declared);
    const inside = target === root || target.startsWith(`${root}/`);
    if (!inside) {
      this.record('phase.verify-in-missing', {
        declared, reason: 'it resolves outside the repository root', usedRoot: true,
      }, phase);
      return root;
    }

    try {
      if (!statSync(target).isDirectory()) throw new Error('not a directory');
    } catch {
      this.record('phase.verify-in-missing', {
        declared, reason: 'no such directory under the repository root', usedRoot: true,
      }, phase);
      return root;
    }
    return target;
  }

  /**
   * A sentence to add to a verification halt when the plan looks like it meant
   * a different directory — or `''`, which is the usual answer.
   *
   * Deliberately a HINT and never an automatic cwd. A silently-chosen directory
   * that happens to be wrong verifies the wrong tree and reports green, which is
   * strictly worse than the failure it would be papering over: the phase would
   * be marked done on the strength of a suite that never looked at its code.
   * So the console says what it noticed and lets a person write it into the
   * plan, where it is reviewable and where the next run will read it too.
   *
   * All three conditions have to hold, and each one is a way of not guessing:
   *  · the plan does not already say (otherwise this is contradicting it);
   *  · the Repos cell names exactly ONE repo (with two, the plan must choose);
   *  · exactly one directory near the root has that name (with two, so is this).
   */
  private async verifyHint(phase: number): Promise<string> {
    const state = this.state!;
    if ((await this.deps.verifyIn?.(state.slug, phase))?.trim()) return '';

    const repos = (await this.deps.phaseRepos?.(state.slug, phase)) ?? [];
    if (repos.length !== 1) return '';

    const matches = this.subdirsNamed(basename(repos[0]));
    if (matches.length !== 1) return '';

    return `. This phase's Repos column names \`${repos[0]}\`, and the commands ran in `
      + `\`${relative(resolve(state.root), await this.verifyCwd(phase)) || '.'}\` — if they should run `
      + `in \`${matches[0]}\`, add \`- **Verify in:** ${matches[0]}\` to the plan's §Phase ${phase}`;
  }

  /**
   * Directories at most two levels below the root with this name, relative to
   * the root. Two levels because that is where a submodule of a monorepo lives
   * (`packages/cart-api`) — deeper is a `node_modules` crawl, and a match found
   * six levels down would not be what a Repos column meant anyway.
   */
  private subdirsNamed(name: string): string[] {
    const root = resolve(this.state!.root);
    const found: string[] = [];
    const scan = (dir: string, depth: number): void => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.name === name) found.push(relative(root, full));
        if (depth > 0) scan(full, depth - 1);
      }
    };
    scan(root, 1);
    return found;
  }

  /**
   * Is this phase closed on disk — and if not, can the session that ran it be
   * made to close it?
   *
   * `phase-graph.sh` reads one thing: `status:` in the phase's handoff. So "the
   * board still reads ready" always means the same thing — the handoff was never
   * written, or not marked complete. That is a fact about paperwork, and a
   * session that did the work and stopped one step short of recording it should
   * be asked to finish rather than have the run halted under it.
   */
  private async closed(phase: number, declared: PhaseOutcome | null): Promise<'done' | 'waiting' | 'halted'> {
    const state = this.state!;
    const record = phaseRecord(state, phase);

    let board = await this.board();
    if (board.states[phase] === 'done') {
      if (declared && declared.status !== 'complete') {
        // The board wins: whatever the session thought it was waiting on, the
        // handoff exists and reads complete. Journalled, never acted on.
        this.record('phase.outcome-superseded', { declared: declared.status }, phase);
      }
      return 'done';
    }

    // The declared outcome routes BEFORE the closeout nudge. A session that
    // said "waiting on CI" must not be nudged to finish paperwork the external
    // clock still blocks — on the live run this replaces, the nudge was
    // answered in the same holding pattern, thirty seconds later, and halted.
    if (declared) {
      const routed = await this.routeOutcome(phase, declared, board);
      if (routed) return routed;
    }

    // A board that reads `stuck` is a handoff that EXISTS and says `blocked` —
    // a fact, not missing paperwork. Twelve real halts called this "no handoff
    // was written" while sessions wrote three-paragraph rebuttals into the
    // reason, and four closeout resumes looped on phases whose brief forbade
    // the work that would unblock them. It is not an immediate halt either:
    // the situation decides (`blocked-declared` and its sub-kind) — a lock
    // queues, a credential or a gate parks with an errand at once, an unknown
    // blocker gets ONE bounded unblock session, and only a ladder with nothing
    // left for this runner halts the old way.
    if (board.states[phase] === 'stuck') {
      return this.closedBlocked(phase, board, null);
    }

    const attempt = await this.closeout(phase, board.states[phase] ?? 'unknown');
    if (attempt.ran) {
      // The closeout session may have filed an outcome instead of a handoff —
      // the phase-8 shape exactly: "still waiting on the image build". Honor
      // it the same way.
      const late = this.takeOutcome(phase);
      if (late) {
        const routed = await this.routeOutcome(phase, late, board);
        if (routed) return routed;
      }
      board = await this.board();
      if (board.states[phase] === 'done') return 'done';
      if (board.states[phase] === 'stuck') return this.closedBlocked(phase, board, null);
    }

    record.status = 'failed';
    state.consecutiveFailures++;
    this.halt(
      `the session for phase ${phase} ended cleanly but the board still reads `
      + `"${board.states[phase] ?? 'unknown'}" — no handoff was written, or it is not marked complete`
      + (attempt.note ? `. ${attempt.note}` : '')
      // The session's own account of why. Without it the halt names the symptom
      // and buries the cause in NDJSON: the run this was written for died on a
      // refusal to write into its own config directory, and said so, and the
      // console repeated only "no handoff was written".
      + (record.said ? `. It signed off: "${condenseSaid(record.said)}"` : ''),
      phase,
      'no-handoff',
    );
    return 'halted';
  }

  /**
   * Act on a session's declared outcome when the board does not read done.
   * Returns the disposition `closed()` should report, or null to fall through
   * (a `complete` declaration is advisory — the board decides).
   */
  private async routeOutcome(
    phase: number, declared: PhaseOutcome, board: Board,
  ): Promise<'waiting' | 'halted' | null> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    switch (declared.status) {
      case 'waiting-external':
        return this.parkWaiting(phase, declared) ? 'waiting' : 'halted';
      case 'blocked': {
        const lockRef = declared.watch.find((ref) => ref.startsWith('lock:'));
        if (lockRef) {
          // Not a defect: a foreign lock the session correctly refused to
          // force. Back to the queue — admission waits on the holder with the
          // same wake sources as any lock conflict.
          record.status = 'pending';
          record.note = declared.reason ?? `blocked on ${lockRef}`;
          record.lockWaitSince ??= new Date().toISOString();
          this.record('phase.outcome-lock-blocked', {
            reason: declared.reason ?? null, watch: declared.watch,
          }, phase);
          this.emit('phase', { phase, status: 'pending', note: record.note });
          return 'waiting';
        }
        // The declaration is evidence for the situation — its reason and
        // watch refs decide the sub-kind — and the ladder decides what
        // happens: one unblock session, a queue, or an errand.
        return this.closedBlocked(phase, board, declared);
      }
      case 'needs-human': {
        record.status = 'parked';
        record.note = declared.reason ?? 'the session asked for a person';
        record.endedAt = new Date().toISOString();
        this.record('phase.outcome-needs-human', { reason: declared.reason ?? null }, phase);
        // The one card: the session named the errand itself, so it is
        // recorded as one — what is needed, in its words, and how to move on.
        const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: record.endedAt });
        slot.errand = {
          phase, situation: 'blocked-declared:unknown', at: record.endedAt,
          tried: (slot.rungs ?? []).map((r) => `${r.rung}${r.outcome ? ` → ${r.outcome}` : ''}`),
          need: record.note,
          how: 'Settle it, then Retry the phase (or resume its session with an instruction).',
        };
        this.record('phase.errand', { ...slot.errand }, phase);
        this.emit('phase', { phase, status: 'parked', note: record.note, errand: slot.errand });
        // The approvals-timeout vocabulary: nothing is wrong with the work,
        // the question is open, and the phase retries the moment someone
        // answers. Not counted against the failure budget.
        this.park(`phase ${phase} needs a person: ${record.note}`, phase);
        return 'halted';
      }
      case 'partial': {
        // "Work remains; resume me." The session said so in the one channel
        // the supervisor reads, so the situation is `work-in-progress` AT
        // ONCE — no evidence gathering, no closeout nudge, no halt — and the
        // ladder's first rung for it is the phase's own session, continued.
        // Bounded like every climb: the caps turn a session that declares
        // partial forever into an errand, never an infinite loop.
        const why = [
          `the session declared partial${declared.reason ? ` (${declared.reason})` : ''} — work remains, resume it`,
        ];
        const climbed = await this.climb(record, board, 'outcome', {
          situation: situationOf('work-in-progress', why),
          sessionId: record.sessionId,
        });
        this.record('phase.outcome-partial', { reason: declared.reason ?? null, climbed }, phase);
        // Climbed: pending + hint, boards next tick. Not climbed: the ladder
        // parked it with an errand (or deferred it as failed); either way the
        // run carries on with its other candidates.
        if (!climbed && record.status !== 'parked') {
          record.status = 'failed';
          record.note = `declared partial${declared.reason ? ` (${declared.reason})` : ''}, and the ladder has nothing left for this runner`;
          record.endedAt = new Date().toISOString();
        }
        return 'waiting';
      }
      case 'complete':
        return null;
    }
  }

  /**
   * A phase whose handoff (or declared outcome) says it is blocked. The
   * situation classifier reads the blocker STATEMENT — the Outstanding text,
   * the declared reason, the watch refs, the session's words — and the ladder
   * answers: `blocked-declared:lock` re-queues, `:credential`/`:gate` park
   * with an errand at once (no session spent), `:unknown` gets ONE bounded
   * unblock session, and a ladder with nothing left for this runner falls to
   * the old `phase-blocked` halt, which the service's healer can still act on
   * with a vehicle this loop does not have.
   */
  private async closedBlocked(
    phase: number, board: Board, declared: PhaseOutcome | null,
  ): Promise<'waiting' | 'halted'> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const climbed = await this.climb(record, board, 'closed', {
      declared: declared
        ? { status: declared.status, reason: declared.reason, watch: declared.watch, writtenAt: declared.written_at }
        : null,
    });
    if (climbed) return 'waiting';
    // Parked with an errand, or re-queued behind a lock: the run carries on.
    if (record.status === 'parked' || record.status === 'pending' || record.status === 'queued') return 'waiting';

    record.status = 'failed';
    record.note = declared?.reason ?? (record.said ? condenseSaid(record.said) : 'the handoff declares this phase blocked');
    record.endedAt = new Date().toISOString();
    state.consecutiveFailures++;
    this.halt(
      declared
        ? `phase ${phase} declared itself blocked: ${declared.reason ?? 'no reason recorded'}`
          + (declared.watch.length ? ` (watching ${declared.watch.join(', ')})` : '')
        : `phase ${phase}'s handoff declares it blocked`
          + (record.said ? ` — it signed off: "${condenseSaid(record.said)}"` : '')
          + '. Its Outstanding section says what is missing; clear that, then Retry '
          + '(or resume the session with an instruction once the blocker is gone).',
      phase,
      'phase-blocked',
    );
    return 'halted';
  }

  /**
   * Park a phase on the external clock its session declared. True when
   * parked; false when the wait budget is spent and the park became an
   * honest halt instead.
   */
  private parkWaiting(phase: number, declared: PhaseOutcome): boolean {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const waits = record.waits ?? 0;
    const parkedMs = record.parkedMs ?? 0;
    if (waits >= WAIT_MAX_PER_PHASE || parkedMs >= WAIT_BUDGET_MS) {
      record.status = 'failed';
      record.note = declared.reason;
      state.consecutiveFailures++;
      this.halt(
        `phase ${phase} is still waiting on external work after ${waits} wait(s) and `
        + `${Math.round(parkedMs / 60_000)} minutes parked`
        + ` (${declared.reason ?? 'no reason recorded'}`
        + `${declared.watch.length ? `; watching ${declared.watch.join(', ')}` : ''})`
        + ' — the wait budget is spent. Retry when the external work lands, or split the '
        + 'phase behind a Gate-check.',
        phase,
        'waiting-external-timeout',
      );
      return false;
    }
    const now = Date.now();
    const floor = this.deps.waitFloorMs ?? 60_000;
    const requested = declared.resume_after ? Date.parse(declared.resume_after) : NaN;
    // A requested window that has already lapsed (the closeout itself took
    // longer than the wait) means "as soon as sensible", never the 30-minute
    // default the session did not ask for — floored so a resume never chases
    // its own tail.
    const wanted = Number.isFinite(requested) ? Math.max(requested, now + floor) : now + WAIT_DEFAULT_MS;
    const until = new Date(Math.min(
      wanted,
      // Never park past the remaining budget — the timeout must be reachable.
      now + Math.max(floor, WAIT_BUDGET_MS - parkedMs),
    )).toISOString();
    record.status = 'waiting';
    record.parkedUntil = until;
    record.parkReason = declared.reason;
    record.watch = declared.watch.length ? declared.watch : undefined;
    record.waits = waits + 1;
    // When the park began — what the resume accrues `parkedMs` from.
    record.endedAt = new Date(now).toISOString();
    record.resumeSessionId ??= record.sessionId;
    this.record('phase.waiting', {
      until, reason: declared.reason ?? null, watch: declared.watch, waits: record.waits,
    }, phase);
    this.emit('phase', { phase, status: 'waiting', note: record.parkReason, parkedUntil: until });
    this.armParkPoke(phase, until);
    return true;
  }

  /**
   * The one continuation a phase gets when it did the work and did not record it.
   *
   * Deliberately narrow. It resumes the phase's OWN session — the console never
   * writes the repo itself (`engine.ts` and `writes.ts` both refuse `--git`), and
   * a handoff invented by the supervisor would be a document nobody wrote
   * describing work it did not do. And it only runs when there is something to
   * record: a session that produced nothing is a session that failed, and
   * spending another one on it buys a second identical failure. That is the case
   * this was written for — a phase blocked before its first edit, which no amount
   * of resuming would have closed.
   */
  private async closeout(phase: number, boardState: string): Promise<{ ran: boolean; note?: string }> {
    const state = this.state!;
    const record = phaseRecord(state, phase);

    if (record.closeout) return { ran: false, note: 'a closeout was already attempted for this phase' };
    if (!record.sessionId) {
      return { ran: false, note: 'there is no session left to resume, so the runner could not ask it to finish' };
    }

    const worked = await this.producedWork(phase, boardState);
    if (!worked.did) {
      return { ran: false, note: `${worked.why}, so there was nothing to close out` };
    }

    const spawn = this.deps.spawn ?? spawnClaude;
    const started = new Date().toISOString();
    this.record('phase.closeout', { sessionId: record.sessionId, boardState, because: worked.why }, phase);
    this.emit('phase', { phase, status: 'verifying', closeout: true });
    // The closeout may file an outcome instead of a handoff; a stale file
    // must not be mistaken for it.
    consumeOutcome(this.outcomePath(phase));

    let outcome;
    try {
      outcome = await spawn({
        prompt: closeoutPrompt(state.slug, phase, boardState,
          state.gitMode === 'new-branch' ? `pe/${state.slug}` : undefined),
        cwd: state.root,
        model: record.model ?? state.model,
        effort: record.effort ?? state.effort,
        name: `${state.slug} p${phase} closeout`,
        resume: record.sessionId,
        // A closeout is paperwork, not the phase. Capping it keeps a confused
        // session from re-opening the work it was asked only to record.
        budgetUsd: state.phaseBudgetUsd === null ? null : Math.max(1, state.phaseBudgetUsd / 4),
        maxTurns: CLOSEOUT_MAX_TURNS,
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        env: await this.sessionEnv({
          PE_OWNER: autopilotOwner(state.id),
          PE_SCOPE: formatScope(this.lanes.get(phase)?.grant?.scope ?? await this.scopeFor(phase)),
          PE_OUTCOME_FILE: this.outcomePath(phase),
          // Where a decision goes. Separate from the outcome file on purpose:
          // an outcome is read once and consumed, a ruling is appended and
          // kept, and a session must be able to record the second without
          // touching the first.
          PE_RULINGS_FILE: rulingsFile(this.state!.root, this.state!.slug),
        }),
        signal: this.abort?.signal,
        // As in `attempt` and `resumeWithInstruction`: a closeout is a live
        // session like any other, and one the console could not freeze or stop
        // because nothing recorded its child.
        onPid: (pid) => {
          this.attachPid(phase, pid);
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      });
    } catch (error) {
      return { ran: false, note: `the closeout session could not be started: ${(error as Error)?.message ?? error}` };
    } finally {
      this.attachPid(phase, null);
      this.attachHandle(phase, null);
    }

    state.spentUsd += outcome.costUsd;
    record.costUsd += outcome.costUsd;
    // The same dollars, booked a second time against the ladder rung that
    // caused this attempt — a no-op unless the ladder is what reboarded it.
    chargeRung(state.recoveries?.[String(record.phase)], outcome.costUsd);
    record.turns = (record.turns ?? 0) + outcome.turns;
    // The closeout's words live on the closeout, never over `record.said`: the
    // halt that follows a failed closeout quotes the PHASE session — the words
    // that explain why no handoff was written — and the closeout's "I could
    // not" used to overwrite them before the halt read them.
    const closeoutSaid = outcome.resultText ? outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200) : undefined;
    record.closeout = {
      at: started,
      ok: classify(outcome.signal).kind === 'ok',
      sessionId: record.sessionId,
      note: worked.why,
      ...(closeoutSaid ? { said: closeoutSaid } : {}),
    };
    this.record('phase.closeout-done', {
      ok: record.closeout.ok, costUsd: outcome.costUsd, turns: outcome.turns,
      said: closeoutSaid,
    }, phase);

    return { ran: true, note: 'the runner asked its session to finish the closeout' };
  }

  /**
   * Did this session leave anything worth recording?
   *
   * Two signals, either of which is enough: the board says a handoff exists but
   * is not complete, or the working tree moved. Neither is a guess about intent —
   * both are things on disk that were not there when the phase started.
   */
  private async producedWork(phase: number, boardState: string): Promise<{ did: boolean; why: string }> {
    const state = this.state!;

    // `in-progress` and `stuck` both mean a handoff file is there, saying
    // something other than complete.
    if (boardState === 'in-progress' || boardState === 'stuck') {
      return { did: true, why: `a handoff exists for phase ${phase} but reads "${boardState}"` };
    }

    // The tree's answer, asked per directory in the phase's SCOPE and with
    // submodule pointers ignored (`situation.ts` `workEvidence`). The root's
    // own `git status` was a false witness on a docs hub: permanently dirty
    // with submodule pointers, its log full of other phases' handoff commits
    // — a never-started phase read as "uncommitted changes" and bought a
    // $3.32 closeout for work that did not exist (measured, P12).
    const record = phaseRecord(state, phase);
    const work = await workEvidence(
      (args) => this.gitOrNull(args), record.startedAt ?? null, await this.scopeDirs(phase));
    if (work.did === true) return { did: true, why: work.why };
    if (work.did === false) return { did: false, why: `the session changed nothing on disk (${work.why})` };
    // Unreadable is not "nothing": but a closeout only runs on POSITIVE
    // evidence — a session resumed to record work that may not exist is the
    // loop this guard was written against. The ladder reads the same fact as
    // `work-in-progress` / `done-unrecorded` and decides with more context.
    return { did: false, why: work.why };
  }

  /* ---------------------------------------------------------------- *
   * The outcome protocol, the reconcile pass, and the park machinery
   * ---------------------------------------------------------------- */

  /** Where this run+phase's outcome file lives — the value of `PE_OUTCOME_FILE`. */
  private outcomePath(phase: number): string {
    const state = this.state!;
    return outcomeFileFor(state.root, state.slug, state.id, phase);
  }

  /**
   * Read, journal and consume the session's declared outcome. Null means the
   * session declared nothing (or the file was stale/invalid), which degrades
   * to every legacy path unchanged.
   */
  private takeOutcome(phase: number): PhaseOutcome | null {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const path = this.outcomePath(phase);
    const declared = readOutcome(path, {
      // THIS attempt's start, never the phase's first: a file written by an
      // earlier attempt must not speak for the one that just ended.
      slug: state.slug, phase, notBefore: record.attemptStartedAt ?? record.startedAt,
    });
    consumeOutcome(path);
    if (declared) {
      this.record('phase.outcome', {
        status: declared.status, reason: declared.reason ?? null,
        resumeAfter: declared.resume_after ?? null, watch: declared.watch,
      }, phase);
    }
    return declared;
  }

  /**
   * The drive loop's record-truth pass, run at the top of every tick: apply
   * resolutions recoveries queued while this loop owned the state, then close
   * whatever the board has overtaken. This is what lets a phase finished by a
   * manual session flip to done mid-run, and a halt about it dissolve, without
   * anyone pressing anything.
   */
  private applyReconcile(board: Board): void {
    const state = this.state;
    if (!state) return;
    let touched = false;
    const now = new Date().toISOString();
    for (const resolution of this.pendingResolutions.splice(0)) {
      const record = phaseRecord(state, resolution.phase);
      const slot = ((state.recoveries ??= {})[String(resolution.phase)] ??= { attempts: 0, lastAt: now });
      slot.lastAt = now;
      if (resolution.outcome === 'done') {
        if (record.status !== 'done' && !PHASE_IN_FLIGHT.includes(record.status)) {
          record.status = 'done';
          record.endedAt ??= now;
          record.note = `closed by ${resolution.by}`;
        }
        slot.fixed = true;
        slot.lastOutcome = 'fixed';
        delete slot.lastReason;
      } else {
        slot.lastOutcome = 'no-defect';
        state.resolved ??= {
          at: now, auto: true,
          reason: `a recovery by ${resolution.by} found nothing wrong`,
        };
      }
      if (state.halt?.phase === resolution.phase) {
        state.halt = null;
        state.consecutiveFailures = 0;
      }
      this.record('phase.reconciled', { by: resolution.by, outcome: resolution.outcome }, resolution.phase);
      touched = true;
    }
    const { changed, closed } = reconcileRecordsAgainstBoard(state, board.states);
    if (changed) {
      for (const phase of closed) {
        this.clearParkPoke(phase);
        this.record('phase.reconciled', { by: 'the board', outcome: 'done' }, phase);
        this.emit('phase', { phase, status: 'done' });
      }
      touched = true;
    }
    if (touched) {
      this.persist();
      this.emit('run', { state });
    }
  }

  /**
   * A phase parked at the two-hour lock cap re-arms by itself once the lock it
   * waited on is gone.
   *
   * The park was honest — a dead-but-unexpired claim must not hold a lane for
   * ever — but it used to be TERMINAL: `parked` is settled, so the phase never
   * boarded again for the life of the run, and the only remedy was a person's
   * Retry long after the holder had released. The holder releasing is exactly
   * the event the wait was for, and the docs watcher already wakes this loop
   * on it. The stopped-run half of the same promise — the loop ended with the
   * park as the last word — lives in the convergence loop (`converge.ts`,
   * `lock-cap-rearm`).
   */
  private async rearmLockCapParks(board: Board): Promise<void> {
    const state = this.state!;
    const own = autopilotOwner(state.id);
    for (const record of Object.values(state.phases)) {
      if (record.status !== 'parked' || !LOCK_CAP_PARK_NOTE.test(record.note ?? '')) continue;
      if (board.states[record.phase] === 'done') continue;
      let free = false;
      try {
        const status = await this.script('phase-lock.sh', [state.slug, 'status', String(record.phase)]);
        const expired = status.stdout.includes('EXPIRED');
        const holder = expired ? undefined : /held by (\S+)/.exec(status.stdout)?.[1];
        free = !holder || holder === own;
      } catch { free = false; }
      if (!free) continue;
      const was = record.note;
      resetForRetry(record);
      this.record('phase.lock-cap-rearmed', { was, note: 'the lock it waited on is gone — the wait starts over' }, record.phase);
      this.emit('phase', { phase: record.phase, status: record.status });
      this.persist();
    }
  }

  /** Poke the drive loop when a park's window elapses, so the resume is on time. */
  private armParkPoke(phase: number, untilIso: string): void {
    this.clearParkPoke(phase);
    const delay = Math.max(0, Date.parse(untilIso) - Date.now());
    const timer = setTimeout(() => {
      this.parkPokes.delete(phase);
      this.wake.resolve();
    }, delay);
    timer.unref?.();
    this.parkPokes.set(phase, timer);
  }

  private clearParkPoke(phase: number): void {
    const timer = this.parkPokes.get(phase);
    if (timer) clearTimeout(timer);
    this.parkPokes.delete(phase);
  }

  /** Start the lane's lease keepalive. See `Lane.leaseTimer`. */
  private armLeaseTimer(lane: Lane, owner: string): void {
    this.clearLeaseTimer(lane);
    const cadence = this.deps.leaseRefreshMs ?? LEASE_REFRESH_MS;
    const timer = setInterval(() => { void this.refreshLease(lane, owner); }, cadence);
    timer.unref?.();
    lane.leaseTimer = timer;
  }

  private clearLeaseTimer(lane: Lane): void {
    if (lane.leaseTimer) clearInterval(lane.leaseTimer);
    lane.leaseTimer = null;
  }

  /**
   * Refresh the lane's phase lock under the shared owner. Same-owner `claim`
   * moves the lease forward (phase-lock.sh treats it as a refresh); `--scope`
   * must ride along or the rewrite drops the `scope=` line and the lock starts
   * colliding with everything. A refusal means a foreign `--force` takeover:
   * journal it and stand down — the console never fights a person for a lock.
   */
  private async refreshLease(lane: Lane, owner: string): Promise<void> {
    const state = this.state;
    if (!state || !this.lanes.has(lane.phase)) return;
    // One tick at a time. A starved event loop delivers interval callbacks
    // back-to-back, and two overlapping ticks would BOTH pass this point,
    // both get refused by a foreign takeover, and journal one stand-down
    // twice. The timer check catches the queued tick that arrives after a
    // refusal already cleared the interval.
    if (lane.leaseBusy || !lane.leaseTimer) return;
    lane.leaseBusy = true;
    try {
      const scope = formatScope(lane.grant?.scope ?? await this.scopeFor(lane.phase));
      // The session id rides along when the record knows it, so the refreshed
      // lock keeps naming the session the registry answers presence for (a
      // refresh that names none keeps the line anyway — this is belt and braces).
      const sessionId = phaseRecord(state, lane.phase).sessionId;
      const result = await this.script('phase-lock.sh', [
        state.slug, 'claim', String(lane.phase), '--owner', owner, '--scope', scope,
        ...(sessionId ? ['--session', sessionId] : []),
      ]);
      const text = (result.stdout + result.stderr).trim();
      if (result.code === 0) {
        this.record('phase.lock-refreshed', { detail: text.slice(0, 120) }, lane.phase);
      } else {
        this.record('phase.lock-lost', { detail: text.slice(0, 200) }, lane.phase);
        this.clearLeaseTimer(lane);
      }
    } catch (error) {
      log.warn('runner.lease-refresh', { phase: lane.phase, error });
    } finally {
      lane.leaseBusy = false;
    }
  }

  /** Read-only git against the run's root. Empty string on any failure. */
  private git(args: string[]): Promise<string> {
    const state = this.state!;
    return new Promise((resolve) => {
      execFile('git', args, {
        cwd: state.root,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
    });
  }

  /**
   * A question nobody can answer any more is not a question — it is a phantom.
   *
   * When the loop ends, the approval broker is disarmed, so any card still up is
   * unanswerable. The phase record kept saying `awaiting-verification` anyway,
   * and the dashboard kept rendering it as "Waiting on you" against a run that
   * had halted hours earlier.
   */
  private settleAwaitingVerification(): void {
    const state = this.state;
    if (!state) return;
    // Only where there was a broker to disarm. A console configured without one
    // never raised a card, so its `awaiting-verification` is not a phantom — it
    // is the honest statement that this phase needs a person and there was no
    // way to ask. Rewriting that would erase the reason the run stopped.
    if (!this.deps.approvals) return;
    for (const record of Object.values(state.phases)) {
      if (record.status !== 'awaiting-verification') continue;
      record.status = 'interrupted';
      record.note ??= 'the run ended while this was waiting to be verified, so the question went away with it';
      record.endedAt ??= new Date().toISOString();
      record.resumeSessionId ??= record.sessionId;
      this.emit('phase', { phase: record.phase, status: record.status });
    }
  }

  /**
   * Put the checks the runner could not make in front of a person, and wait.
   *
   * Refusing to execute prose out of a markdown file is correct — a plan that
   * says "run those commands" is not a command, and executing what a document
   * tells you to is how a document becomes an exploit. But refusing and then
   * stopping with no way to say "I have checked it" left the run wedged: the
   * only controls offered were Retry, which re-runs a session that was never
   * the problem, and Skip, which discards a phase that had in fact succeeded.
   *
   * So the fragments become a card carrying the plan's own words, and a person
   * decides. Allow records the verification as satisfied by hand — attributed,
   * not silently rewritten. Deny halts, which is what Retry was pretending to
   * offer. Returns false when the run must stop.
   */
  private async askHuman(phase: number, verification: VerifySummary): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const { approvals } = this.deps;

    record.status = 'awaiting-verification';
    this.record('phase.awaiting-verification', { notRun: verification.notRun }, phase);
    this.emit('phase', { phase, status: 'awaiting-verification', notRun: verification.notRun.length });
    this.persist();

    if (!approvals) {
      record.note = `${verification.notRun.length} verification step(s) need a person, and this console has no `
        + 'approval broker to ask with.';
      this.halt(`phase ${phase} needs a person to verify it, and there is no way to ask`, phase, 'needs-human');
      return false;
    }

    const { decided } = approvals.request({
      runId: state.id,
      slug: state.slug,
      phase,
      kind: 'verify',
      title: `Phase ${phase}: ${verification.notRun.length} check${verification.notRun.length === 1 ? '' : 's'} only you can make`,
      detail: verification.ran.length
        ? `${verification.ran.length} command(s) ran and passed. The rest is written as prose in the plan, so the runner will not execute it.`
        : 'Nothing in this phase\'s verification is a command the runner can execute, so nothing has been proven either way.',
      evidence: [
        ...verification.notRun.map((n, i) => ({
          label: `Check ${i + 1} — ${n.reason}`,
          body: n.text,
        })),
        ...(verification.ran.length ? [{
          label: `${verification.ran.length} command(s) that did run`,
          body: verification.ran.map((r) => `$ ${r.command}\n${r.output || '(no output)'}`).join('\n\n'),
        }] : []),
      ],
    }, this.deps.verifyAnswerMs ?? VERIFY_ANSWER_MS);

    const outcome = await decided;
    this.record('phase.human-verified', { decision: outcome.decision, by: outcome.by, reason: outcome.reason }, phase);

    // Nobody answered, or the run ended under the card. Neither is a person
    // saying the checks failed — it is the same "nobody is awake" the tool
    // card's timeout means, and it takes the same disposition (`Service.
    // decideToolUse` → `park`): the phase parks with the question standing,
    // the streak is untouched, and the run parks for a person instead of
    // counting an unanswered card as a failure. It used to be `failed` plus a
    // streak increment, so two quiet evenings halted a plan with
    // `failure-streak` about work nobody had found fault with.
    if (outcome.by === 'timeout' || outcome.by === 'run ended') {
      record.status = 'parked';
      record.note = `${verification.notRun.length} verification check(s) need a person and the card `
        + `${outcome.by === 'timeout' ? 'went unanswered' : 'was still up when the run ended'} — `
        + 'confirm them on the phase page (Verify), then Retry.';
      record.endedAt = new Date().toISOString();
      this.record('phase.verify-unanswered', { by: outcome.by, notRun: verification.notRun.length }, phase);
      this.emit('phase', { phase, status: 'parked', note: record.note });
      this.park(`phase ${phase}'s verification card went unanswered: ${verification.notRun.length} `
        + 'check(s) only a person can make', phase);
      return false;
    }

    if (outcome.decision === 'allow') {
      record.verification = {
        ...verification,
        ok: true,
        reason: `${verification.notRun.length} manual check(s) confirmed by ${outcome.by}`
          + (outcome.reason ? ` — ${outcome.reason}` : ''),
      };
      return true;
    }

    record.status = 'failed';
    state.consecutiveFailures++;
    this.halt(
      `phase ${phase} was not verified: ${outcome.reason || `${outcome.by} marked the manual checks as failed`}`,
      phase,
      'needs-human',
    );
    return false;
  }

  /* ---------------------------------------------------------------- *
   * The ladder in the loop — classify, climb, brief
   *
   * The runner's own vehicles for the remediation ladder (`runner/ladder.ts`):
   * a fresh re-board, a re-board with a RESUMING or UNBLOCK brief appended to
   * the engine's boot prompt, the phase's own session continued, the phase's
   * own session asked to close out, and the queue behind a lock. Every other
   * rung (a fresh briefed agent, a plan-repair script, the resource walls) is
   * the service's — this loop skips them and leaves the record for the healer
   * that runs when the run stops. One ladder, one history
   * (`recoveries[phase].rungs`), whichever of the two climbs.
   * ---------------------------------------------------------------- */

  /**
   * The drive loop's ladder pass. Which phases: records the last boarding
   * settled badly (`interrupted`, `failed`), and phases whose handoff exists
   * but is not complete (`stuck`, `in-progress` on the board) that this run
   * has not boarded. Not: anything in flight, anything already hinted, a
   * phase the board reads done (reconcile closed it) or waiting (its deps are
   * not done), and not the same unchanged record twice in a row.
   */
  private async climbLadder(board: Board, asked: Set<number> | null): Promise<void> {
    const state = this.state!;
    const wordOf = (p: number) => board.states[p] ?? 'unknown';
    const phases = new Set<number>();
    for (const record of Object.values(state.phases)) {
      if (LADDER_STATUSES.includes(record.status)) phases.add(record.phase);
    }
    for (const p of [...board.stuck, ...board.inProgress]) {
      const record = state.phases[String(p)];
      if (!record || record.status === 'pending') phases.add(p);
    }
    for (const phase of [...phases].sort((a, b) => a - b)) {
      if (asked && !asked.has(phase)) continue;
      if (wordOf(phase) === 'done' || wordOf(phase) === 'waiting') continue;
      if (this.lanes.has(phase)) continue;
      const record = phaseRecord(state, phase);
      if (record.boardingHint) continue;
      if (record.status === 'pending' && !['stuck', 'in-progress'].includes(wordOf(phase))) continue;
      if (record.status !== 'pending' && !LADDER_STATUSES.includes(record.status)) continue;
      const fingerprint = [record.status, wordOf(phase), record.attempts, record.endedAt ?? '', record.note ?? ''].join('|');
      if (this.ladderSeen.get(phase) === fingerprint) continue;
      this.ladderSeen.set(phase, fingerprint);
      try {
        await this.climb(record, board, 'drive');
      } catch (error) {
        log.warn('runner.ladder', { slug: state.slug, phase, error });
      }
    }
  }

  /**
   * Classify one phase and climb its ladder one rung, through this runner's
   * own vehicles. True when the record was reset to `pending` with a boarding
   * hint (it is a candidate now); false when the ladder parked it with an
   * errand, deferred it (a rung remains that only the service can drive), or
   * had nothing to climb.
   *
   * `preset.situation` skips the evidence gathering — a declared `partial`
   * outcome IS the evidence; `preset.declared` feeds a declaration into it.
   */
  private async climb(
    record: PhaseRecord, board: Board, by: string,
    preset: { situation?: Situation; declared?: PhaseEvidence['declared']; sessionId?: string } = {},
  ): Promise<boolean> {
    const state = this.state!;
    const phase = record.phase;
    const now = new Date().toISOString();
    const evidence = preset.situation ? null : await this.evidenceOf(phase, board, preset.declared ?? null);
    const situation = preset.situation ?? classifySituation(evidence!);
    record.situation = { key: situation.key, at: now, why: situation.why };
    this.record('phase.situation', {
      situation: situation.key, sub: situation.sub ?? null, label: situation.label, why: situation.why, by,
    }, phase);

    if (situation.actor === 'wait' || situation.actor === 'none') return false;
    // The ladder is the run's healing opt-in (the launch dialog's "heal halts"
    // switch, on by default), with ONE exemption: a never-started phase
    // boarding fresh is not healing, it is the run doing its job — and it is
    // the measured dead end this pass exists for.
    if (!state.autoRecover && situation.id !== 'never-started') {
      this.record('phase.ladder-skipped', { situation: situation.key, reason: 'auto-recovery is off for this run' }, phase);
      return false;
    }

    const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: now });
    const history = slot.rungs ?? [];
    const runHistory = Object.values(state.recoveries).flatMap((entry) => entry.rungs ?? []);
    const caps = this.deps.ladderCaps?.() ?? {};
    const unblockOk = this.deps.unblockAttempts?.() !== false;
    const sessionId = preset.sessionId ?? record.sessionId ?? record.resumeSessionId;
    const hintOf = (rung: Rung) => this.hintFor(phase, rung, situation, evidence, sessionId, now, by);
    // Two questions: is there ANY rung left (caps, history, the table), and is
    // there one THIS runner can drive. Only the first being "no" is exhaustion.
    const dayHistory = this.deps.dayHistory?.();
    const any = nextRung({ situation: situation.key, history, runHistory, dayHistory, caps });
    const mine = nextRung({
      situation: situation.key, history, runHistory, dayHistory, caps,
      available: (rung) => hintOf(rung) !== null,
    });

    if (mine.ok) {
      const hint = hintOf(mine.rung)!;
      // Recorded BEFORE the spend, so a console that dies mid-boarding still
      // remembers it climbed — `attempts`/`lastAt` move with it for the
      // readers that predate rungs.
      accountRung(slot, {
        situation: situation.key, rung: mine.rung.vehicle, params: mine.rung.params, at: now, note: mine.rung.label,
      });
      this.reboardWith(record, hint);
      this.record('phase.rung', {
        situation: situation.key, rung: mine.rung.vehicle, params: mine.rung.params ?? null,
        brief: hint.brief, vehicle: 'runner', attempt: slot.attempts, by,
        ...(hint.sessionId ? { sessionId: hint.sessionId } : {}),
      }, phase);
      this.emit('phase', { phase, status: record.status, situation: situation.key, rung: mine.rung.vehicle, brief: hint.brief });
      this.persist();
      return true;
    }

    const table = rungsFor(situation.key);
    const tried = new Set(history.map((r) => rungKey(r.situation, { vehicle: r.rung as Rung['vehicle'], params: r.params })));
    const untried = table.filter((rung) => !tried.has(rungKey(situation.key, rung)));
    const switchedOff = (rung: Rung) => rung.vehicle === 'unblock-session' && !unblockOk;
    const exhausted = !any.ok || situation.actor === 'person' || (untried.length > 0 && untried.every(switchedOff));
    if (exhausted) {
      const reason = !any.ok ? any.reason
        : situation.actor === 'person' ? `${situation.label} is a person's to settle`
          : 'the unblock session is switched off on this console';
      this.parkWithErrand(record, situation, slot, reason, by);
      return false;
    }
    // Deferred: a rung remains for a vehicle this loop does not have (a fresh
    // briefed agent, a repair script). The record stands as it is; the
    // service's healer climbs it when the run stops.
    this.record('phase.ladder-deferred', {
      situation: situation.key, reason: mine.reason, remaining: untried.map((rung) => rung.vehicle),
    }, phase);
    return false;
  }

  /** Park a phase with the ONE ask for a person the ladder leaves behind. */
  private parkWithErrand(
    record: PhaseRecord, situation: Situation,
    slot: NonNullable<RunState['recoveries']>[string], reason: string, by: string,
  ): void {
    const errand: Errand = errandFor(situation.key, slot.rungs ?? [], record.phase);
    slot.errand = errand;
    record.status = 'parked';
    record.note = `${situation.label} — ${errand.need}`;
    record.endedAt ??= errand.at;
    // Not counted against the failure budget: a phase that needs a person is
    // not a phase that failed twice.
    this.record('phase.errand', { ...errand, label: situation.label, reason, by }, record.phase);
    this.emit('phase', { phase: record.phase, status: 'parked', note: record.note, errand });
    this.persist();
  }

  /** Which of this runner's vehicles a rung maps to, as the hint boarding reads — or null. */
  private hintFor(
    phase: number, rung: Rung, situation: Situation, evidence: PhaseEvidence | null,
    sessionId: string | undefined, at: string, by: string,
  ): BoardingHint | null {
    const base = { situation: situation.key, rung: rung.vehicle, at, by };
    switch (rung.vehicle) {
      case 'reboard-fresh':
        return { ...base, brief: 'fresh' };
      case 'queue':
        // Back to the queue behind the lock; a handoff on disk means the
        // session that boards should read it as a resume.
        return { ...base, brief: evidence?.handoff.exists ? 'resume' : 'fresh' };
      case 'reboard-resume-brief':
        return { ...base, brief: 'resume', ...(rung.params?.escalate === 'model' ? { escalate: 'model' as const } : {}) };
      case 'resume-own-session':
        if (!sessionId) return null;
        return {
          ...base, brief: 'continue', sessionId,
          ...(rung.params?.mode === 'fix-verification' ? { instruction: fixVerificationInstruction(phase) } : {}),
        };
      case 'unblock-session':
        if (this.deps.unblockAttempts?.() === false) return null;
        return { ...base, brief: 'unblock', ...(sessionId ? { sessionId } : {}) };
      case 'closeout-own-session':
        if (!sessionId) return null;
        return { ...base, brief: 'closeout', sessionId };
      default:
        // Agent rungs, the repair script, the resource walls: not this loop's.
        return null;
    }
  }

  /** Reset a record for the boarding the ladder chose, and leave the hint on it. */
  private reboardWith(record: PhaseRecord, hint: BoardingHint): void {
    resetForRetry(record);
    record.boardingHint = hint;
    // The queue rung is a lock wait: the two-hour cap measures from here.
    if (hint.rung === 'queue') record.lockWaitSince ??= hint.at;
    this.ladderSeen.delete(record.phase);
  }

  /**
   * The facts the situation classifier weighs, gathered from what this runner
   * has: the board already read, the store's handoff (through `handoffFor`,
   * else the board's own word about it), the lock as `phase-lock.sh status`
   * prints it, the working tree per scope directory, and the record.
   */
  private async evidenceOf(
    phase: number, board: Board, declared: PhaseEvidence['declared'],
  ): Promise<PhaseEvidence> {
    const state = this.state!;
    const own = autopilotOwner(state.id);
    const ours = (owner: string) => owner === own || /^(autopilot|console)\//.test(owner);
    const deps: EvidenceDeps = {
      root: state.root,
      handoff: (slug, p) => {
        const stored = this.deps.handoffFor?.(slug, p);
        if (stored && stored.exists !== false) return { status: stored.status, outstanding: stored.outstanding };
        // Without the store — or when it lags the engine — the board's word
        // still says whether a handoff exists and what it reads.
        const word = board.states[p];
        if (word === 'stuck') return { status: 'blocked' };
        if (word === 'in-progress') return { status: 'in-progress' };
        return null;
      },
      lock: async (slug, p) => {
        try {
          const out = await this.script('phase-lock.sh', [slug, 'status', String(p)]);
          return parseLockStatus(out.stdout, ours);
        } catch { return null; }
      },
      repos: (_slug, p) => this.scopeDirs(p),
      git: (args) => this.gitOrNull(args),
      declared: () => declared,
      now: () => this.now(),
    };
    return collectEvidence(deps, state.slug, phase, state, board.states);
  }

  /**
   * The directories under the root the phase's Repos column names and that
   * exist — where the working tree is asked about THIS phase's work. `all`,
   * or names that are not here, fall back to the root itself.
   */
  private async scopeDirs(phase: number): Promise<string[]> {
    const state = this.state!;
    let names: string[] = [];
    try { names = [...((await this.deps.phaseRepos?.(state.slug, phase)) ?? [])]; } catch { names = []; }
    if (!names.length || names.includes('all')) return ['.'];
    const dirs = names.filter((name) =>
      name && name !== '.' && !name.includes('..') && !name.startsWith('/') && existsSync(join(state.root, name)));
    return dirs.length ? dirs : ['.'];
  }

  /** The first uncommitted paths across the scope directories, for a brief. */
  private async dirtyPaths(dirs: string[], limit = 12): Promise<string[]> {
    const paths: string[] = [];
    for (const dir of dirs) {
      const prefix = dir === '.' ? [] : ['-C', dir];
      const out = await this.gitOrNull([...prefix, 'status', '--porcelain', '--ignore-submodules=all']);
      if (!out) continue;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const path = line.slice(3).trim();
        paths.push(dir === '.' ? path : `${dir}/${path}`);
        if (paths.length >= limit) return paths;
      }
    }
    return paths;
  }

  /** Everything a re-board brief may quote about this phase. */
  private async briefFacts(phase: number, board: Board): Promise<BriefFacts> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const evidence = await this.evidenceOf(phase, board, null);
    const paths = evidence.work.did ? await this.dirtyPaths(await this.scopeDirs(phase)) : [];
    return {
      phase,
      slug: state.slug,
      scriptsDir: this.deps.scriptsDir,
      attempts: record.attempts,
      verification: record.verification,
      lint: record.lint,
      said: record.said,
      halt: state.halt?.phase === phase ? state.halt.reason : null,
      handoff: evidence.handoff,
      work: { ...evidence.work, ...(paths.length ? { paths } : {}) },
    };
  }

  /**
   * Assemble the prompt a hinted boarding sends. `fresh` is the engine's text
   * alone; `resume`/`unblock` append their brief to it; `continue`/`closeout`
   * resume the phase's own session and carry no engine text — unless that
   * session cannot be resumed here, in which case they DEGRADE to the
   * self-contained `resume` rather than sending a continuation to a session
   * that has no context to continue from.
   */
  private async composeBrief(
    phase: number, board: Board, hint: BoardingHint, engineText: string,
  ): Promise<{ prompt: string; brief: BoardingBrief; resume?: string; maxTurns?: number; degraded?: string }> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const facts = await this.briefFacts(phase, board);
    const wantsSession = hint.brief === 'continue' || hint.brief === 'closeout' || (hint.brief === 'unblock' && Boolean(hint.sessionId));
    const resume = wantsSession ? this.resumableSession(record, hint.sessionId) : undefined;
    let brief = hint.brief;
    let degraded: string | undefined;
    if ((hint.brief === 'continue' || hint.brief === 'closeout') && !resume) {
      degraded = hint.sessionId
        ? `session ${hint.sessionId} cannot be resumed under this account — boarding fresh with the resume brief`
        : 'no session to resume — boarding fresh with the resume brief';
      brief = 'resume';
      this.record('phase.brief-degraded', { asked: hint.brief, reason: degraded }, phase);
    }
    switch (brief) {
      case 'fresh':
        return { prompt: engineText, brief };
      case 'resume':
        return { prompt: `${engineText}\n\n${resumeBrief(facts)}`, brief, ...(degraded ? { degraded } : {}) };
      case 'unblock':
        return resume
          ? { prompt: unblockBrief(facts), brief, resume }
          : { prompt: `${engineText}\n\n${unblockBrief(facts)}`, brief };
      case 'continue':
        return { prompt: resumeBrief(facts, hint.instruction ?? resumeInstruction(facts)), brief, resume };
      case 'closeout':
        return {
          prompt: closeoutPrompt(state.slug, phase, board.states[phase] ?? 'unknown',
            state.gitMode === 'new-branch' ? `pe/${state.slug}` : undefined),
          brief, resume, maxTurns: CLOSEOUT_MAX_TURNS,
        };
    }
  }

  /**
   * The session id `--resume` can actually reach under the run's account, or
   * undefined. The transcript lives in the config dir of the account that
   * WROTE it; under a different one it is carried over first, and when it
   * cannot be, a self-contained boot beats a resume that finds nothing.
   */
  private resumableSession(record: PhaseRecord, sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    const state = this.state!;
    if ((record.sessionAccountId ?? 'default') === (state.accountId ?? 'default')) return sessionId;
    const ported = this.deps.portTranscript?.(sessionId, record.sessionAccountId, state.accountId) ?? false;
    this.record('phase.transcript-port', {
      sessionId, from: record.sessionAccountId ?? 'default', to: state.accountId ?? 'default', ported,
    }, record.phase);
    return ported ? sessionId : undefined;
  }

  /** Read-only git against the run's root; null when git could not answer (the evidence reader's contract). */
  private gitOrNull(args: string[]): Promise<string | null> {
    const state = this.state!;
    return new Promise((resolve) => {
      execFile('git', args, {
        cwd: state.root,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', GIT_OPTIONAL_LOCKS: '0' },
      }, (error, stdout) => resolve(error ? null : String(stdout)));
    });
  }

  /* ---------------------------------------------------------------- *
   * Plumbing
   * ---------------------------------------------------------------- */

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /* ---------------------------------------------------------------- *
   * Liveness: is the lane that is nominally working actually working?
   * ---------------------------------------------------------------- */

  /**
   * Start the ticker if it is not already running.
   *
   * Armed by lane creation and retired by the first tick that finds no lanes,
   * rather than by the drive loop's own lifecycle — because a recovery session
   * gets a lane without one, and because a runner that halts mid-phase leaves
   * its `finally` blocks to unwind at their own pace. Self-limiting: at most
   * one idle tick is ever paid for.
   *
   * `unref` so it is never what keeps the process alive. A console shutting
   * down must not wait a minute for a heartbeat.
   */
  private armLivenessTicker(): void {
    if (this.livenessTimer) return;
    this.livenessTimer = setInterval(() => { void this.tickLiveness(); }, LIVENESS_TICK_MS);
    this.livenessTimer.unref?.();
  }

  private disarmLivenessTicker(): void {
    if (!this.livenessTimer) return;
    clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  /**
   * Evaluate every live lane once.
   *
   * Public because the ticker is the only thing that calls it in production
   * and a test must be able to call it instead: the whole point of
   * `liveness.ts` being pure is that the interesting behaviour — an episode
   * opening, an episode clearing, an episode not re-announcing itself — is
   * driven by a fake clock plus explicit ticks rather than by waiting a
   * minute per assertion.
   *
   * Never throws: a `git` that will not run, a journal that will not write and
   * a listener that throws are all worth less than the run.
   */
  async tickLiveness(): Promise<void> {
    if (!this.lanes.size) { this.disarmLivenessTicker(); return; }
    const state = this.state;
    if (!state) return;
    const thresholds = stallThresholds(this.deps.stallThresholds?.());
    const now = this.now().getTime();
    let changed = false;
    for (const lane of [...this.lanes.values()]) {
      try {
        changed = await this.evaluateLane(lane, thresholds, now) || changed;
      } catch (error) {
        log.warn('runner.liveness', { phase: lane.phase, error: (error as Error)?.message ?? String(error) });
      }
    }
    if (changed) this.persist();
  }

  /**
   * One lane: refresh what is cheap, refresh what is not on its own cadence,
   * decide, and journal only the transitions.
   *
   * Returns whether the checkpoint is worth rewriting — the liveness snapshot
   * itself moves every tick and is not, on its own, a reason to fsync a run
   * file once a minute per lane.
   */
  private async evaluateLane(lane: Lane, thresholds: StallThresholds, now: number): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, lane.phase);

    // The suppression that keeps this feature from crying wolf on every plan
    // with a real test suite: while the phase's own §Verification is running
    // the session has exited and nothing will be produced until the commands
    // finish, which is exactly what `silent` looks like.
    lane.signals.verifying = record.status === 'verifying' || Boolean(record.verifyingSince);

    if (lane.gitAt === undefined || now - lane.gitAt >= LIVENESS_GIT_EVERY_MS) {
      lane.gitAt = now;
      const work = await workEvidence(
        (args) => this.gitOrNull(args), record.startedAt ?? null, await this.scopeDirs(lane.phase),
      ).catch(() => null);
      if (work) {
        lane.signals.commitsSinceStart = work.commits ?? 0;
        lane.signals.treeDirty = (work.dirty ?? 0) > 0;
      }
    }

    const before = lane.signals.stall;
    const after = evaluateStall(lane.signals, thresholds, now);
    lane.signals.stall = after;
    record.liveness = livenessOf(lane.phase, lane.signals);

    // Only TRANSITIONS are news. A lane that was fine and is still fine is the
    // overwhelmingly common tick and must cost nothing but the snapshot above;
    // a signal that is simply still true is one episode, one journal line and
    // one announcement — the dedupe on the announcing side is keyed the same
    // way, so a console restart mid-episode is the only thing that can say it
    // twice, and saying it once more after a restart is right.
    if (!after && !before) return false;
    if (after && before?.signal === after.signal) return false;

    if (after) {
      record.stall = after;
      this.record('phase.stall', { ...after, attempt: record.attempts ?? 0 }, lane.phase);
    } else {
      delete record.stall;
      this.record('phase.liveness', {
        cleared: before?.signal ?? null,
        turnsSinceLastTool: lane.signals.turnsSinceLastTool,
        commitsSinceStart: lane.signals.commitsSinceStart,
        treeDirty: lane.signals.treeDirty,
      }, lane.phase);
    }
    this.emit('liveness', {
      phase: lane.phase,
      liveness: record.liveness,
      stall: after ?? null,
      attempt: record.attempts ?? 0,
    });
    return true;
  }

  private engine(args: string[], env?: Record<string, string>) {
    const state = this.state!;
    // No cache key on purpose. The board is read moments after a child wrote a
    // handoff, and the watcher that invalidates the cache may not have fired
    // yet — a cached "not done" here would fail a phase that succeeded.
    return engineRun(
      { scriptsDir: this.deps.scriptsDir, root: state.root, mcpServers: this.deps.mcpIds?.() },
      'phase-graph.sh', [state.slug, ...args],
      undefined, env ? { env } : undefined,
    );
  }

  private script(script: string, args: string[]) {
    const state = this.state!;
    return engineRun(
      { scriptsDir: this.deps.scriptsDir, root: state.root, mcpServers: this.deps.mcpIds?.() },
      script, args,
    );
  }

  private async board(): Promise<Board> {
    return readMemoryBlock(await this.engine(['--memory-block']));
  }

  /**
   * Release the phase lock the session took. A session that finished cleanly
   * has usually released it already, so a refusal here is normal rather than a
   * fault — it is only worth a line in the log when the lock turns out to
   * belong to somebody else entirely.
   */
  private async release(phase: number, owner: string): Promise<void> {
    // `--git` is never passed: the console does not commit, here or anywhere.
    const result = await this.script('phase-lock.sh', [this.state!.slug, 'release', String(phase), '--owner', owner]);
    if (result.code !== 0 && !/no lock|not held|free/i.test(result.stdout + result.stderr)) {
      log.warn('runner.release', { phase, detail: (result.stdout || result.stderr).trim().slice(0, 200) });
    }
  }

  private onStream(phase: number, event: StreamEvent): void {
    // Liveness first and unconditionally: every event is evidence the session
    // is alive, including the ones nothing below cares about.
    const lane = this.lanes.get(phase);
    if (lane) applyEvent(lane.signals, event, this.now().getTime());

    if (event.kind === 'retry') this.record('phase.api-retry', { ...event }, phase);

    // Which attached servers this phase actually reached for. Counted here
    // because the stream is already being read and the name is already parsed;
    // the alternative is asking the operator to guess, which is how a run ends
    // up paying for six servers it used two of.
    if (event.kind === 'tool' && event.name.startsWith('mcp__') && this.state) {
      const rest = event.name.slice(5);
      const split = rest.indexOf('__');
      if (split > 0) {
        const record = phaseRecord(this.state, phase);
        const id = rest.slice(0, split);
        record.mcpCalls = { ...record.mcpCalls, [id]: (record.mcpCalls?.[id] ?? 0) + 1 };
      }
    }

    // What the session says it is running on, which is not always what we
    // asked for: `--fallback-model` demotes in-place and tells nobody. A
    // journal that records the request rather than the reality is a journal
    // that cannot explain why a phase went badly.
    if (event.kind === 'init' && this.state) {
      const record = phaseRecord(this.state, phase);
      let changed = false;
      // The session id used to be learned only when the spawn resolved, which
      // is far too late for anything that acts on a session while it is alive:
      // a freeze checkpointed mid-phase had nothing to hand to `--resume`, and
      // the checkpoint on disk carried an empty id. The `init` message has it
      // within the first second, so take it there.
      if (event.sessionId && record.sessionId !== event.sessionId) {
        record.sessionId = event.sessionId;
        // Which account's config dir this transcript is being written into —
        // the fact a cross-account resume needs to find the file later.
        if (this.state.accountId) record.sessionAccountId = this.state.accountId;
        else delete record.sessionAccountId;
        // Rewrites `children[phase]` and the mirror together, so a checkpoint
        // taken a moment later can hand this id to `--resume` whichever of the
        // two a reader consults.
        if (this.lanes.has(phase)) this.syncMirror();
        else if (this.state.child?.phase === phase) this.state.child.sessionId = event.sessionId;
        changed = true;
      }
      if (event.model && record.actualModel !== event.model) {
        record.actualModel = event.model;
        if (record.model && !event.model.includes(record.model)) {
          this.record('phase.model-differs', { asked: record.model, running: event.model }, phase);
        }
        changed = true;
      }
      if (changed) this.persist();
    }

    if (event.kind === 'limits' && this.state) {
      this.state.limits = {
        status: event.status,
        window: event.window,
        utilization: event.utilization,
        resetsAt: event.resetsAt,
        at: new Date().toISOString(),
      };
      // Worth a journal line only when the account is being warned, not on
      // every routine "you are fine" heartbeat.
      if (event.status !== 'allowed') this.record('run.usage-window', { ...event });
      this.persist();
    }

    this.emit('stream', { phase, ...event });
  }

  /**
   * The status a lane restores after a wait it initiated (queue, usage window,
   * thaw). Derived from the durable records — `halt` and `pause` — never
   * assumed: writing `running` unconditionally after a wait is how a halt from
   * another lane got erased on a real run (status `running` WITH a halt set,
   * phase admitted 206 ms after the stop).
   */
  private resumedStatus(): RunStatus {
    const state = this.state!;
    if (state.halt) return 'halting';
    return state.pause ? 'pausing' : 'running';
  }

  /**
   * Why this phase must not board right now, or `null`.
   *
   * Boarding is three subprocesses and possibly a queue wait; every await in it
   * is a window where a pause, a halt from another lane, or a stop can arrive.
   * One predicate, asked at each of those boundaries, so the answer cannot
   * drift between them.
   */
  private boardingBlocked(): 'stopped' | 'halted' | 'pause' | null {
    const state = this.state!;
    if (this.abort?.signal.aborted || this.stopRequested) return 'stopped';
    if (state.halt) return 'halted';
    if (state.status === 'pausing') return 'pause';
    return null;
  }

  private halt(reason: string, phase?: number, kind?: HaltKind): void {
    const state = this.state!;
    // With lanes still live the run is DRAINING, not stopped: `halting` keeps
    // it in IN_FLIGHT (a dead console mid-drain must still pid-check those
    // children) and the drive loop flips it to `halted` when the last lane
    // settles. A verified live run once read `running` WITH a halt attached —
    // admission bookkeeping overwrote `halted` — and this is the honest shape:
    // the halt is a fact the moment it happens, the "stopped" claim only when
    // nothing is running any more.
    state.status = this.lanes.size ? 'halting' : 'halted';
    state.stoppedBy = 'system';
    // `kind` is the machine-readable class the auto-recovery classifier reads;
    // the sentence stays for people, and old records simply never have one.
    state.halt = { at: new Date().toISOString(), reason, phase, ...(kind ? { kind } : {}) };
    // Wake any lane sleeping on a retry backoff or a usage window: each
    // re-checks `state.halt` on waking and stands down instead of spawning
    // another attempt hours later on a run that has already stopped.
    this.haltSignal.dispatchEvent(new Event('halt'));
    // A new halt is a new fact: a resolution recorded about an EARLIER stop must
    // not dismiss this one's card. `reopenedAt` deliberately stays — it is a
    // person's veto on auto-resolution, and an override a person made is never
    // re-inferred away.
    state.resolved = null;
    // One field the console can always read for "why did this stop", whichever
    // of the several endings it was.
    state.finishedReason = reason;
    this.record('run.halt', { reason, phase, ...(kind ? { kind } : {}) });
    this.emit('run', { state });
    log.warn('runner.halt', { slug: state.slug, runId: state.id, reason, phase });
  }

  private record(event: string, data?: Record<string, unknown>, phase?: number): void {
    this.journal?.append(event, data, phase);
    this.emit('journal', { event, phase, data });
  }

  private emit(event: string, data: Record<string, unknown>): void {
    // Broadcast and record are the same act. A console opened after the fact,
    // or reloaded mid-phase, replays this file and sees what a console that had
    // been watching all along would have seen.
    try { this.transcript?.append(event, data); } catch { /* never at the cost of the run */ }
    try { this.deps.onEvent?.(`run:${event}`, { runId: this.state?.id, slug: this.state?.slug, ...data }); }
    catch { /* the UI channel must never break the run */ }
  }

  private persist(): void {
    if (!this.state) return;
    try { saveRun(this.state); } catch (error) { log.warn('runner.persist', { error }); }
  }

  /** A sleep that a stop — or a halt from another lane — can cut short. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    // A halt that landed BEFORE this sleep began would otherwise be waited out
    // in full — the wake event below fires once, at halt time, and a listener
    // attached after that hears nothing.
    if (this.state?.halt) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      const halts = this.haltSignal;
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        halts.removeEventListener('halt', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
      // Without this, a run could read `halting` for hours behind a lane that
      // holds no session at all — just a timer waiting for a usage window.
      halts.addEventListener('halt', done, { once: true });
      // And an account switch must not wait out the OLD account's reset: the
      // wake ends the sleep, the loop re-checks, the next spawn pays with the
      // account that can.
      halts.addEventListener('wake', done, { once: true });
    });
  }

  /**
   * Shutdown: write the checkpoint and let the child settle. The console's
   * shutdown budget is generous for exactly this reason — a phase killed
   * halfway through leaves a repo nobody can reason about.
   */
  private async checkpointForShutdown(): Promise<void> {
    if (!this.state) return;
    this.record('run.console-shutdown', {
      pids: this.livePhases().map((phase) => this.lanes.get(phase)?.pid).filter(Boolean),
      phases: this.livePhases(),
    });
    this.persist();
    if (!this.livePhases().length && !this.childPid) return;
    this.shuttingDown = true;
    this.abort?.abort();
    await this.driving;
    this.persist();
  }
}

/**
 * The settings an operator may change on a run that has already started.
 *
 * Deliberately a closed set: a general "patch the checkpoint" endpoint would
 * let a browser rewrite `spentUsd`, `phases` or `status`, which are records of
 * what happened rather than choices anyone gets to make.
 */
export type RunSettingsPatch = {
  model?: string;
  effort?: string;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  maxConsecutiveFailures?: number;
  onlyPhases?: number[] | null;
  phaseOptions?: Record<string, PhaseOptions> | null;
  skills?: string[] | null;
  /**
   * The run's MCP servers, changeable mid-run. Lands on the NEXT phase: the
   * config file is written per attempt, and the child already running loaded
   * its own at startup and cannot reload it — the same honesty the settings
   * file is documented with.
   */
  mcpServers?: string[] | null;
  /**
   * The run's answer to an unreachable server, changeable mid-run — which is
   * the point. The "Continue without these servers" button on a halt card is
   * this patch plus a Retry, so a run parked at boarding can be released
   * without editing the plan or signing anything in.
   */
  mcpPolicy?: McpPolicy;
  permissionProfile?: PermissionProfile;
  gitMode?: 'default-branch' | 'new-branch';
  openPr?: boolean;
  /**
   * Translated by the Service before this patch reaches `applySettings`
   * (into a concrete `skills` list); never stored on the run itself.
   */
  attachDefaultSkills?: boolean;
  /**
   * The on-limit policy, changeable mid-run: it is read at the moment a wall
   * is hit, so a flip lands on the very next limit without any checkpoint.
   * (Changing the ACCOUNT mid-run is the `switch-account` verb — that one
   * checkpoints the live session first.)
   */
  onLimit?: OnLimitPolicy;
};

/**
 * Apply a settings patch to a run state. Shared by the live runner and the
 * on-disk path so the two cannot drift — the whole reason Pause was broken is
 * that one of them existed and the other did not.
 */
export function applySettings(state: RunState, patch: RunSettingsPatch): RunState {
  if (patch.model) state.model = patch.model;
  if (patch.effort !== undefined) {
    if (patch.effort) state.effort = patch.effort;
    else delete state.effort;
  }
  if (patch.autonomy) state.autonomy = patch.autonomy;
  if (patch.phaseBudgetUsd !== undefined) state.phaseBudgetUsd = patch.phaseBudgetUsd;
  if (patch.runBudgetUsd !== undefined) state.runBudgetUsd = patch.runBudgetUsd;
  if (patch.maxConsecutiveFailures !== undefined && patch.maxConsecutiveFailures > 0) {
    state.maxConsecutiveFailures = patch.maxConsecutiveFailures;
  }
  if (patch.onlyPhases !== undefined) {
    if (patch.onlyPhases?.length) state.onlyPhases = [...patch.onlyPhases];
    else delete state.onlyPhases;
  }
  if (patch.phaseOptions !== undefined) {
    if (patch.phaseOptions) state.phaseOptions = { ...patch.phaseOptions };
    else delete state.phaseOptions;
  }
  if (patch.skills !== undefined) {
    if (patch.skills?.length) state.skills = [...patch.skills];
    else delete state.skills;
  }
  if (patch.mcpServers !== undefined) {
    if (patch.mcpServers?.length) state.mcpServers = [...patch.mcpServers];
    else delete state.mcpServers;
  }
  // `continue` is stored as an omission, like every other shipped default, so a
  // run switched back to it reads the same as a run that never left it.
  if (patch.mcpPolicy !== undefined) {
    if (patch.mcpPolicy === 'require') state.mcpPolicy = 'require';
    else delete state.mcpPolicy;
  }
  if (patch.permissionProfile) {
    if (patch.permissionProfile === 'guarded') delete state.permissionProfile;
    else state.permissionProfile = patch.permissionProfile;
  }
  if (patch.gitMode) {
    // Default-branch is the absent state on disk (see `newRun`), so switching
    // back is a delete — and takes the PR flag with it, which has no meaning
    // without a branch to open a PR from.
    if (patch.gitMode === 'new-branch') {
      state.gitMode = 'new-branch';
      if (state.openPr === undefined) state.openPr = patch.openPr ?? true;
    } else {
      delete state.gitMode;
      delete state.openPr;
    }
  }
  if (patch.openPr !== undefined && state.gitMode === 'new-branch') state.openPr = patch.openPr;
  if (patch.onLimit !== undefined) {
    // `wait` is the absent state on disk, same convention as everything above.
    if (patch.onLimit === 'wait') delete state.onLimit;
    else state.onLimit = patch.onLimit;
  }
  return state;
}

/**
 * Wrap an operator's question so it cannot be mistaken for a new instruction.
 *
 * A phase is mid-task and holds a plan of its own. Text arriving from the user
 * outranks almost everything in that context, so an unframed "why did you skip
 * the cache?" is read as a change of direction. The frame says what this is,
 * asks for brevity, and — the part that matters — says to carry on afterwards.
 *
 * The tag is not decoration either. Going in it is what lets the CLI's own echo
 * be recognised as *this* message rather than by counting echoes, which is
 * wrong on every resumed session. Coming back it is what turns the reply into
 * an answer the console can put beside the question, instead of two sentences
 * lost in the middle of an hour of build output.
 */
export function frameQuestion(question: string, mark: string): string {
  return `${mark} An out-of-band question from the operator watching this run. It is NOT a change to `
    + 'the phase: answer it briefly, in a sentence or two, then continue exactly where you left '
    + 'off. Do not alter your plan, your task list, or what you were about to do — unless the '
    + `question itself explicitly asks you to.\n\nBegin your answer with the tag ${mark} so the `
    + `console can show it beside the question.\n\nQuestion: ${question}`;
}

/**
 * Steer: the other thing an operator wants to say to a running phase, and the
 * opposite of a question.
 *
 * Ask is framed to be inert — "this is NOT a change to the phase" — because a
 * question that quietly redirects the work is worse than no question at all.
 * That framing makes it useless for the case it kept being reached for: seeing
 * a phase head somewhere wrong and wanting to say so. Sending an instruction
 * through the question frame either got politely ignored or, worse, half
 * followed.
 *
 * So this is the honest version, and it says out loud what it costs: the phase
 * still has to satisfy the plan's exit criteria and the runner still verifies
 * it independently afterwards. An instruction that talks a phase out of its
 * verification does not get it past the gate — it just fails later.
 */
export function frameSteer(instruction: string, mark: string): string {
  return `${mark} A course correction from the operator watching this run. Unlike an out-of-band `
    + 'question, this IS an instruction: fold it into what you are doing and carry on. It does not '
    + 'replace the phase — the plan\'s exit criteria and its verification commands still decide '
    + 'whether this phase passes, and they are checked independently after you finish. If this '
    + 'instruction conflicts with the plan, say so in one line and follow the plan.'
    + `\n\nAcknowledge with the tag ${mark} in one sentence, then continue.\n\nInstruction: ${instruction}`;
}

function reasonOf(disposition: Disposition): string {
  return 'reason' in disposition ? disposition.reason : 'completed';
}

/**
 * Worded for the person who has to fix it. "Authentication failed" describes
 * the machine's experience; what the operator needs is which command, where.
 */
/** The budget wall's default raise, when no preference reaches the runner. */
const DEFAULT_BUDGET_RAISE_PCT = 25;

/**
 * The PR block — what a session is told when it is the one to publish the
 * work branch. One author, two readers: `gitStrategy` appends it to the
 * plan's last phase, and `openPrFromLastLeaf` hands it to the last leaf's
 * session when two leaves finished together and neither read as last.
 */
function prBlockText(branch: string, title: string): string {
  return `Opening the pull request — this is the plan's LAST remaining phase. After the\n`
    + `handoff is written and verification is green, in EACH scoped repository where\n`
    + `\`${branch}\` has commits:\n`
    + `  1. Push the branch: git push -u origin ${branch}\n`
    + `  2. Open a PR with \`gh pr create\` — base: the repository's default branch,\n`
    + `     head: ${branch}, title: "${title}", body: a short per-phase summary of\n`
    + `     what this plan changed (from the handoffs).\n`
    + `  3. If a PR for \`${branch}\` already exists, do not open a second one — say so\n`
    + `     instead.\n`
    + `Record each PR URL in the phase handoff. If pushing or \`gh\` is refused or\n`
    + `unavailable, do not look for another route: write the exact commands you would\n`
    + `have run into the handoff and your final message, and finish the phase normally.`;
}

function authRefusal(detail?: string): string {
  return 'Claude Code is not signed in for this console, so every phase would spend a turn '
    + 'and report success without doing anything. Sign in — the Autopilot page has a button '
    + 'that opens a terminal on it, or run `claude auth login` yourself — then start the run again.'
    + (detail ? ` (${detail})` : '');
}

export type { PhaseStatus, RunState, VerifySummary };
