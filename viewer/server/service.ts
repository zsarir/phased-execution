/**
 * The service layer: one open source directory, everything the API serves.
 *
 * It owns the store, the engine cache, the search index and the live watcher,
 * and it is the only place that decides what is cached and for how long — a
 * plan's cached engine answers are keyed by its revision, which the watcher
 * bumps whenever one of its files changes.
 */

import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, watch, type FSWatcher } from 'node:fs';

import { instanceId } from '../shared/instances.mjs';
import {
  INSTANCE, INSTANCE_STATE_DIR, SKILL_DIR, STATE_DIR, agentEnabled, checkRoot, distRev, rememberRoot, loadPrefs, savePrefs,
  serverIsStale, staticRoot,
  type Flags, type Prefs, type RootCheck,
} from './config.ts';
import {
  SessionRegistry, correlate, parseHookPayload,
  type SessionEventName, type SessionRecord, type SessionView,
} from './sessions/registry.ts';
import { hooksStatus, installHooks, uninstallHooks, type HooksStatus, type HooksWrite } from './hooks-install.ts';
import { Store, handoffFor, lockFor, qaFor, readLock, type PlanRecord } from './store.ts';
import {
  ConvergeScheduler, convergePlan, HALT_DELAY_MS, type ConvergeDeps, type ConvergeReport, type ConvergeTrigger, convergeView, type ConvergeView } from './converge.ts';
import { planWrite, runWrite } from './writes.ts';
import {
  run, invalidate, readMemoryBlock, readQaMode, readSessionPlan, readLint, readGateStatus,
  readText, readBoardText, type Board, type QaMode, type SessionPlan, type LintResult,
  type GateStatus,
} from './engine.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import { listSkills, type SkillInfo } from './skills.ts';
import { DocsWatcher } from './watch.ts';
import {
  degradedState, hasShutdownWork, onDegraded, requestRestart, requestShutdown, stopPlan, supervisor,
} from './lifecycle.ts';
import { log } from './log.ts';
import {
  CATEGORIES, Push, isPlanProgress, routeFor, sanitiseCategories, tagFor, type CategoryId,
} from './push/index.ts';
import { Notifications, type NotificationQuery, type NotificationRecord } from './notifications.ts';
import { repoInfo, lastCommit, commitsTouching, type GitRepoInfo, type GitFileInfo } from './git.ts';
import { findMemory, memoryIndexLines } from './memory.ts';
import {
  loadSizing, indexGraph, routeLayout, analysePhases, criticalPath, remainingWork,
  resolveBudget, weightOf, type Sizing, type PhaseAnalysis,
} from './analysis/graph.ts';
import { loadGateVocab, gateKindOf, type GateVocab, type GateKind } from './analysis/gates.ts';
import { rungsToday, spendSummary, type SpendRunView, type SpendView } from './analysis/spend.ts';
import {
  buildInbox, inboxIds, pruneAcks, readAcks, removeAck, writeAck,
  INBOX_ACKS_DIR, type InboxAck, type InboxFacts, type InboxView,
} from './inbox.ts';
import { STALL_SIGNAL_META, inboxItemId, parseInboxItemId } from '../shared/attention-model.js';
import { deriveEvidence } from '../shared/evidence-model.js';
import {
  planStats, portfolio, etaSamples, etaFrom, rateFor, phaseEtaFor, healthIssues, isClosedStatus, splitRepos,
  type PlanStats, type Portfolio, type PlanContext, type EtaEstimate, type EtaSample,
  type PhaseEta, type RateReading,
} from './analysis/stats.ts';
import type { PhaseDetail, PhaseRow } from './parse/plan.ts';
import {
  Runner, applySettings, VERIFICATION_PARK_NOTE, MCP_PARK_NOTE,
  type AskResult, type RecoverMode, type RunSettingsPatch, type StartOptions,
} from './runner/runner.ts';
import { Scheduler, type LockView } from './runner/scheduler.ts';
import { offeredModels } from './runner/models.ts';
import {
  continueMcpParkedRecord, mcpParkDueAt, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult,
} from './runner/mcp-park.ts';
import {
  classifySituation, collectEvidence, summariseEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './runner/situation.ts';
import {
  accountRung, errandFor, ladderCaps, nextRung, rungsFor, settleRung, type Rung,
} from './runner/ladder.ts';
import type { PhaseRecord as RunPhaseRecord } from './runner/state.ts';
import { formatScope, scopeOfRow, scopesIntersect } from '../shared/scope.js';
import {
  KIND_PROFILE, NO_HANDOFF_AUTO_RE, VERIFICATION_AUTO_RE, isRecoveryClass, recoveryActionsFor,
} from '../shared/recovery-model.js';
import { environmentReport, type EnvIssue } from './env-doctor.ts';
import { Terminals, type SessionEvent, type SessionInfo, type SessionKind } from './terminal.ts';
import { Journal } from './runner/journal.ts';
import type { LaneLiveness } from './runner/liveness.ts';
import { appendAck as appendRulingAck, ingestRulings, readRulings, rulingsFile, type Ruling } from './runner/rulings.ts';
import {
  autoResolveRun, childrenOf, latestRun, listRuns, loadRun, newRun, phaseRecord, pidAlive,
  reconcileRecordsAgainstBoard, resetForRetry, resolveRunsAgainst, saveRun,
  slugsNeedingBoard, runDir, IN_FLIGHT, PHASE_IN_FLIGHT, RESOLVABLE, isMcpPolicy, mcpReasonText,
  type BoardingBrief, type Errand, type McpPolicy, type PreflightWarning, type RungRecord, type RunState, type VerifySummary,
} from './runner/state.ts';
import {
  consumeOutcome, inboxOutcomePhase, outcomeFileFor, outcomeInboxDir, readOutcome, type PhaseOutcome,
} from './runner/outcome.ts';
import { readTranscript, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './runner/verify.ts';
import { loadVerifyEnv } from './runner/verify-env.ts';
import { checkAuth, checkAuthFor, forgetAuth, openLoginTerminal, openCommandTerminal, shellQuote, type AuthStatus } from './runner/auth.ts';
import { Accounts, DEFAULT_ACCOUNT_ID, profileConfigDir, type AccountView } from './accounts/index.ts';
import { Mcp, type McpServerView } from './mcp/index.ts';
import { portTranscript } from './accounts/transcripts.ts';
import { FULL_FLAGS, installDesktopLauncher, launcherPlan } from './launcher.ts';
import {
  RECOVERY_TITLES, recoveryKey,
  type RecoveryClass, type RecoveryFacts, type RecoveryRequest,
} from './recovery.ts';
import { buildAgentLaunch, phasedExecutionSkillId } from './agent.ts';
import {
  isVerdict, qaKey, type QaFacts, type QaRequest,
} from './qa-session.ts';
import {
  Approvals, classifyTool, matchedDenyRule, loadPolicy, loadPolicyFor, policyExtras, addPolicyRules,
  editPolicy, planPolicyPath, effectivePlanPolicyPath, notifyOutOfBand, carvedPolicy, suggestedRule,
  parseRule, inertRules, HOOK_TOOLS, WRAPPERS_NOT_STRIPPED,
  PERMISSION_PROFILES, PROFILE_LABELS,
  DEFAULT_DENY, DEFAULT_ASK, DEFAULT_ALLOW, POLICY_PATH,
  type Evidence, type PolicyScope, type PermissionProfile,
} from './runner/approvals.ts';

/** The longest delay `setTimeout` can hold (2^31 − 1 ms ≈ 24.8 days); past it a clock waits for the next boot. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One live update, with the id a reconnecting client replays from. */
export type LiveEvent = { id: number; event: string; data: unknown };
export type LiveListener = (event: string, data: unknown, id: number) => void;

/** Enough backlog to cover a browser reconnect, not a history. */
const EVENT_BUFFER = 200;

export type PlanSummary = PlanStats & {
  engineError?: string;
  issueCounts: { error: number; warning: number; info: number };
  hasHandoffs: boolean;
  /**
   * How long this plan has left, cheap enough to send for every plan at once.
   *
   * The whole estimate rather than a pre-rendered string, so the ONE decision
   * about how an estimate reads — the range, and the hedge its `basis` earns —
   * stays in the one client formatter every surface calls. Absent on a plan with
   * nothing left to do; never absent for want of evidence, which is what `basis`
   * is for.
   */
  eta?: EtaEstimate;
};

/**
 * A claim on a phase, as a page needs to read it.
 *
 * Everything `parseLock` recovers from the lock file except its path — the
 * narrower shape this used to be (`owner`/`expired`/`leaseUntil`) could say
 * that a phase was held but never who by, on what machine, since when, or over
 * what scope, which is exactly the set of questions someone asks before
 * deciding whether to take a claim away from another session.
 */
export type PhaseLockView = {
  owner: string;
  expired: boolean;
  leaseUntil?: number;
  claimedAt?: number;
  host?: string;
  scope?: string[];
};

/**
 * The one place a parsed lock becomes a lock a page can read.
 *
 * Two call sites used to narrow it by hand and had already drifted — the
 * per-phase one dropped `host`, the plan-level one kept it — so the same claim
 * described itself differently depending on which list you found it in.
 */
function lockView(lock: {
  owner: string; expired: boolean; leaseUntil?: number;
  claimedAt?: number; host?: string; scope?: string[];
} | null | undefined): PhaseLockView | undefined {
  if (!lock) return undefined;
  return {
    owner: lock.owner,
    expired: lock.expired,
    leaseUntil: lock.leaseUntil,
    claimedAt: lock.claimedAt,
    host: lock.host,
    scope: lock.scope,
  };
}

export type PhaseView = {
  phase: number;
  title: string;
  state: string;
  size: string;
  weight: number;
  gated: boolean;
  gates?: string;
  gateCheck?: string;
  /** The gate's category — who can clear it. Mirrors `--gate-kind`. */
  gateKind: GateKind;
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
  lock?: PhaseLockView;
  handoff?: {
    file: string; status: string; completed?: string; title: string;
    outstanding?: string; skillsUsed: string[]; prompts: number;
  };
  /**
   * Claimed versus evidenced (`shared/evidence-model.js`).
   *
   * The plan page's whole job is to say what is done, and `done` here has only
   * ever meant "a handoff says so". This carries the second half of that
   * sentence — what, if anything, actually ran — so a phase table can show the
   * difference instead of implying there is none.
   */
  proof?: EvidenceView;
};

export type RouteView = {
  nodes: {
    phase: number; layer: number; row: number; state: string; size: string; gated: boolean;
    title: string;
    /**
     * Whether a station is claimed, and whether that claim still holds.
     *
     * A marker rather than the lock itself: the map draws a ring, and shipping
     * the whole lock object to every node would put an owner string on the wire
     * for a shape that has nowhere to render one.
     */
    locked?: 'live' | 'stale';
  }[];
  edges: { from: number; to: number }[];
  layers: number;
  rows: number;
};

export type PlanDetail = {
  summary: PlanSummary;
  plan: {
    slug: string; title: string; provenance?: string; context?: string; architecture?: string;
    endToEnd?: string; sessionBudget: unknown; graph: PhaseRow[]; callouts: string[];
    sections: { title: string; body: string }[];
    path?: string;
  } | null;
  phases: PhaseView[];
  route: RouteView;
  batches: SessionPlan | null;
  boardText: string;
  lint: LintResult | null;
  handoffs: {
    phase: number; file: string; title: string; status: string; completed?: string;
    bytes: number; mtime: number; prompts: number; skillsUsed: string[];
  }[];
  index: { phase: number; title: string; status: string; link?: string }[];
  /**
   * How long the plan has left, and how long each phase would take on its own.
   *
   * `perPhase` is an array rather than a map keyed by phase because it is
   * derived render data, not run state: the pages that read it want it in plan
   * order, and a `.find` is the only lookup anything does. Both halves come from
   * ONE `RateReading`, so a phase row and the header above it can never disagree
   * about how fast this plan goes.
   */
  eta: { plan: EtaEstimate | null; perPhase: PhaseEta[] };
  qa: { phase: number; result: string; report?: string }[];
  locks: (PhaseLockView & { phase: number })[];
  git: GitFileInfo & { dirty?: boolean };
  memory: { key: string; path: string; text: string; indexLines: string[] } | null;
};

/**
 * A phase someone else is holding right now.
 *
 * Its own class because the answer is 409, not 500: the request is well formed
 * and the caller did nothing wrong — the phase is simply being worked. Thrown
 * by every verb that would START a session on a named phase, so the refusal
 * cannot be an accident of which endpoint you happened to call.
 *
 * This used not to exist, and the consequence was worse than a missing error
 * type: `POST /api/run/<slug>/start` on a claimed phase answered 200, minted a
 * run, and only degraded to `parked` several subprocesses later inside the
 * runner. The console said a run had started; nothing ran.
 */
/** `POST /hooks/session` answered 400: the body is not a session event. */
export class HookPayloadError extends Error {}
/** `POST /hooks/session` answered 429: the bucket is empty. */
export class HookRateError extends Error {}

/** Session events accepted per minute — a person's sessions produce a few; a runaway loop must not write a storm. */
export const HOOK_EVENTS_PER_MINUTE = 300;
/** Per-file debounce for the unsupervised-outcome inbox watcher. */
const OUTCOME_INBOX_DEBOUNCE_MS = 250;
/** An inbox declaration older than this is history, not news. */
const OUTCOME_INBOX_MAX_AGE_MS = 24 * 60 * 60_000;
/** A `waiting-external` that names no window waits this long — the runner's own default. */
const UNSUPERVISED_WAIT_DEFAULT_MS = 30 * 60_000;

export class PhaseClaimedError extends Error {
  /* Plain fields, assigned in the body. Constructor parameter properties are
     TypeScript that Node's strip-only loader cannot erase, and this server runs
     straight off its `.ts` — one `readonly slug: string` in a constructor
     signature refuses to start the whole console. */
  slug: string;
  phase: number;
  lock: { owner: string; host?: string; leaseUntil?: number };

  constructor(
    slug: string,
    phase: number,
    lock: { owner: string; host?: string; leaseUntil?: number },
  ) {
    super(
      `Phase ${phase} of ${slug} is claimed by ${lock.owner}`
      + (lock.host ? ` on ${lock.host}` : '')
      + (lock.leaseUntil ? ` — the lease runs until ${new Date(lock.leaseUntil).toISOString()}` : '')
      + '. Wait for that session, or release the claim.',
    );
    this.name = 'PhaseClaimedError';
    this.slug = slug;
    this.phase = phase;
    this.lock = lock;
  }
}

/** What became of one release attempt. Bulk releases return one per lock. */
export type LockRelease = {
  slug: string;
  phase: number;
  ok: boolean;
  /** The owner read from the lock file — null when there was no lock to read. */
  owner: string | null;
  detail?: string;
};

/**
 * What became of a run control that can refuse for a reason worth showing.
 *
 * `RunState | null` could say "it did not happen" and never why, so the route
 * had a single sentence for every refusal — "nothing is running for this plan"
 * — printed just as readily when something WAS running and the operator had
 * simply aimed at a phase that finished while their tap was in flight.
 */
export type ControlResult =
  | { ok: true; run: RunState | null }
  | { ok: false; reason: string };

/** A forward action the console can offer on a phase that is not done. */
export type RecoveryAction = {
  id: 'recheck' | 'closeout' | 'resume' | 'retry' | 'skip' | 'fix-agent'
    | 'mcp-continue' | 'continue-run' | 'release' | 'force-release' | 'dismiss';
  label: string;
  /** What it costs — the thing that was never stated on the old Retry button. */
  detail: string;
  /** How it acts: check | own-session | new-agent | run-control | claim | mcp. */
  mechanism?: string;
  /** Which console capability gates it (run | agent | writes), when one does. */
  flag?: string | null;
  /** Set on `fix-agent`: which agent briefing to launch. */
  recoveryClass?: string;
};

/**
 * Thrown when a run-verb targets a phase a live agent recovery session is
 * already editing. Routes answer it as the same 409-with-sessionId shape
 * `resolveRecovery` refusals use, so the client navigates to the session
 * instead of erroring.
 */
export class RecoveryBusyError extends Error {
  readonly sessionId: string;
  constructor(message: string, sessionId: string) {
    super(message);
    this.name = 'RecoveryBusyError';
    this.sessionId = sessionId;
  }
}

/**
 * What `shared/evidence-model.js` answers: the claim, and whether anything
 * backs it. Declared here rather than imported from the client, because the
 * shared module is JS with JSDoc and the server has no typecheck pass to read
 * it — the client mirrors this in `lib/evidence.ts` and the identity test in
 * `test/evidence-model.test.ts` is what stops the two drifting.
 */
export type EvidenceView = {
  board: string;
  handoff: string;
  verification: string;
  qa: string;
  /** Whether the claim is backed. Never named `done`. */
  evidenced: boolean;
  why: string[];
};

/**
 * Event prefixes that can change what needs a person.
 *
 * A list rather than "everything", because `emit` is also how terminal bytes
 * and pty resizes travel, and a keystroke is not a reason to recompute the
 * inbox.
 */
const INBOX_SOURCES = [
  'run:', 'approval', 'lock', 'account', 'mcp', 'health', 'plan', 'gate', 'qa', 'environment',
];

export type PhaseDiagnosis = {
  runId: string;
  phase: number;
  status: string;
  /** Which of the three checks is standing in the way, when one is. */
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
  /**
   * The classifier's word for the phase (`runner/situation.ts`) — what the
   * unattended healer would act on — with the sentences that decided it.
   */
  situation: Situation | null;
  /** The evidence it was decided from, as short lines (`summariseEvidence`). */
  evidence: string[];
  /**
   * Claimed versus evidenced (`shared/evidence-model.js`).
   *
   * Named `proof` and not `evidence` because `evidence` above is already the
   * situation classifier's reasoning lines, and the two answer different
   * questions: those say why the healer chose a rung, this says whether the
   * phase's own "done" is backed by anything that ran. Never named `done`.
   */
  proof: EvidenceView;
  /**
   * What sessions DECIDED on this phase (`runner/rulings.ts`), oldest first.
   *
   * On the diagnosis rather than only on the run because this is the panel
   * somebody opens when a phase did not go the way the plan said it would, and
   * "the session read the instruction the other way, and here is why" is the
   * answer more often than anything the verification output holds.
   */
  rulings: Ruling[];
};

/**
 * What a finished QA session left behind.
 *
 * `recorded` is the whole point: it is false for a session that ended without
 * writing a row, and `result` is then absent rather than inherited from
 * whatever the phase happened to read before.
 */
export type QaOutcome = {
  recorded: boolean;
  result?: string;
  report?: string;
  headline: string;
  detail: string;
};

/** The phase's title from the plan graph, when the table has one. */
function titleOf(rows: PhaseRow[], phase?: number): string | undefined {
  if (phase == null) return undefined;
  return rows.find((row) => row.phase === phase)?.title || undefined;
}

/**
 * The owner a recovery session claims a phase as.
 *
 * Legible in a lock file and in `phase-lock.sh list`, which is the point: the
 * next person to find a claim needs to know a console opened it, not decode an
 * id. Same `<who>/<what>` shape the conventions use.
 */
function recoveryOwner(request: RecoveryRequest): string {
  return request.phase != null ? `console/recover-p${request.phase}` : 'console/recover';
}

/**
 * What can still be done about a phase in this state.
 *
 * The invariant this exists to hold: **a phase that is not done always offers at
 * least one way forward.** A run that halted with its approval card expired had
 * none — the card could not be answered, the phase could not be closed, and the
 * only controls on the page re-ran or discarded work that was probably fine.
 * `test/recovery.test.ts` walks every terminal status and asserts this is never
 * empty.
 */
export function recoveryActions(
  status: string, resumable: boolean, situation?: { id: string; sub?: string } | null,
): RecoveryAction[] {
  // The words, the mechanisms and the ordering all come from the shared model
  // — this wrapper only keeps the wire shape the diagnosis payload has always
  // had (`detail`, not `blurb`). Flag gating is deliberately absent here: the
  // client holds the console's flags and computes its own disabled states.
  // The situation, when known, leads the ordering (additive — see the model).
  return recoveryActionsFor({ record: { status, resumable }, ...(situation ? { situation } : {}) }).map((action) => ({
    id: action.id as RecoveryAction['id'],
    label: action.label,
    detail: action.blurb,
    mechanism: action.mechanism,
    flag: action.flag,
    ...(action.recoveryClass ? { recoveryClass: action.recoveryClass } : {}),
  }));
}

/** `git status --porcelain`, or empty when it cannot be read. */
function gitPorcelain(root: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], {
      cwd: root, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
  });
}

type Cached<T> = { revision: number; value: T };

/** The one line of a tool call that tells you what it is about to do. */
function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'query', 'pattern']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').slice(0, 300);
  }
  return '';
}

/**
 * The model named inside a plan's `**Model:**` bullet.
 *
 * Plans write these as prose — "`claude-opus-5` (1M window)", "Opus for the
 * hard reasoning", "Haiku — mechanical". Passing that whole string to `--model`
 * would fail, so only a recognised name is taken and anything else is left to
 * the run's default rather than guessed at.
 *
 * The match keeps the whole model token, not just the family word. It used to
 * collapse to a bare alias, which meant a plan that carefully asked for
 * `claude-opus-5[1m]` ran on plain `opus`: the one part of the name the
 * operator wrote on purpose — the window — was the part thrown away, and the
 * board then sized the plan's sessions against a window it was not running on.
 */
export function modelAlias(text?: string): string | undefined {
  const match = /\b(?:claude-)?(?:fable|opus|sonnet|haiku)(?:-[0-9a-z.]+)*(?:\[1m\])?/i.exec(text ?? '');
  return match ? match[0].toLowerCase() : undefined;
}

/** The same, for `**Effort:**` — one of the five the CLI accepts, or nothing. */
export function effortOf(text?: string): string | undefined {
  const match = /\b(low|medium|high|xhigh|max)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * How a session ended, in the words a notification can carry.
 *
 * A signal is the interesting case and the one a bare exit code loses: a pty
 * killed by the OOM killer reports code 0 with `signal: 9`, and "exited
 * cleanly" would be a lie about the most important thing that happened.
 */
function describeExit(session: SessionInfo): string {
  const { code = 0, signal } = session.exited ?? {};
  if (signal) return `on signal ${signal}`;
  return `with code ${code}`;
}

/** Read-only git, for approval evidence. Never fails the request it decorates. */
function gitRead(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout).trim().slice(0, 4_000));
    });
  });
}

/**
 * Every plan's finished-phase evidence, read once. See `Service.etaPool`.
 *
 * `all` is the portfolio fallback and is sorted by when each phase ENDED rather
 * than grouped by plan: it feeds an EMA, whose entire behaviour is the order of
 * its input, so stacking one plan's history after another's would make the
 * newest evidence whatever plan happened to sort last.
 */
type EtaPool = { bySlug: Map<string, EtaSample[]>; all: EtaSample[] };

/**
 * How long a read of every plan's runs stays good for.
 *
 * Not the plan `generation`, which is the right key for anything derived from
 * files in `docs/` and the wrong one here: run records change when a PHASE
 * finishes, which moves no document and bumps no generation — so a
 * generation-keyed estimate would freeze for the whole of a long run, exactly
 * when it is being watched. Short enough that a finished phase shows up before
 * anyone reloads, long enough that a burst of list requests reads the disk once.
 */
const ETA_POOL_MS = 5_000;

/**
 * The skills a NEW run starts with: what was asked for, else the machine's.
 *
 * `??` and deliberately not `||`. An explicit empty list is the operator having
 * unchecked every box, and that has to mean "none" rather than "you did not
 * say" — with `||` the default would reassert itself and there would be no way
 * to turn it off for a run at all. Absent means the request never mentioned
 * skills (a `curl`, an older client), and then the machine's default applies.
 *
 * Seeded ONCE, here. From this point the run's own `skills[]` is the single
 * truth and nothing re-reads the flag — so changing the flag cannot retroactively
 * alter a run in flight, and unchecking survives every later write.
 */
export function seedSkills(chosen: string[] | undefined, defaults: string[]): string[] | undefined {
  if (chosen !== undefined) return chosen;
  return defaults.length ? [...defaults] : undefined;
}

/**
 * Which recovery class a halt can be healed by WITHOUT a person — or null.
 *
 * Deliberately narrower than the client's `classifyRun`: the client offers a
 * button and a person decides; this decides by itself, so anything ambiguous,
 * human-shaped or resource-shaped answers null. The named `kind` written at
 * the halt site is the contract; the sentences below only cover records
 * written before kinds existed, and only the unmistakable ones — the client's
 * generic "assess and carry on" fallback is exactly what an unattended loop
 * must not press.
 */
export function autoRecoveryClass(
  halt: { reason: string; kind?: string } | null,
  status: string,
  record?: { verification?: { ok: boolean } | null } | null,
): RecoveryClass | null {
  // An interrupted run is the crash this console is booting back from — the
  // one case where the status alone is the whole diagnosis.
  if (status === 'interrupted') return 'interrupted-resume';
  // The one PARKED shape an agent can clear: every ready phase held by an
  // unrunnable §Verification, named as such by the drive loop. plan-repair is
  // the class whose briefing knows the fix (author the bullet from the exit
  // criteria); a parked run with any other kind — or none, like a lock park
  // or a live-orphan adoption — stays a person's.
  if (status === 'parked') {
    return halt?.kind === 'verification-preflight' ? 'plan-repair' : null;
  }
  if (status !== 'halted' || !halt) return null;

  // The named kind through the ONE profile table (shared/recovery-model.js) —
  // the same table the halt banner and the human classifiers read, so the
  // three can never disagree about a kind again.
  if (halt.kind) {
    const profile = (KIND_PROFILE as Record<string, { autoClass: string | null; park?: boolean }>)[halt.kind];
    if (!profile) return null; // a named kind not in the table is not healable
    // A park kind on a HALTED run is a contradiction — the drive loop writes
    // these on parks only, so meeting one here means something else is wrong.
    if (profile.park) return null;
    // A no-handoff halt whose record shows RED verification is a verification
    // failure wearing paperwork clothes — the closeout brief forbids the work
    // that would fix it (the observed four-session loop on one phase).
    if (halt.kind === 'no-handoff' && record?.verification && !record.verification.ok) {
      return 'halted-verification';
    }
    // A LADDER class is not a briefing: the situation classifier and the
    // remediation ladder own that kind now (`runner/situation.ts`, `ladder.ts`).
    // This legacy reader answers only with an agent class it could launch.
    return isRecoveryClass(profile.autoClass) ? profile.autoClass as RecoveryClass : null;
  }

  // Records written before kinds existed: only the runner's own unmistakable
  // sentences, and only the two an unattended loop may act on.
  if (VERIFICATION_AUTO_RE.test(halt.reason)) return 'halted-verification';
  if (NO_HANDOFF_AUTO_RE.test(halt.reason)) return 'halted-missing-handoff';
  return null;
}

/** A rung, translated to what this console can launch today. */
type DriveVehicle =
  | { kind: 'retry' }
  | { kind: 'session'; mode: RecoverMode; instruction?: string }
  | { kind: 'agent'; cls: RecoveryClass }
  /** The runner's own re-board with a brief (`start({resumeRunId, reboard})`). */
  | { kind: 'reboard'; brief: BoardingBrief; escalate?: 'model' }
  /** A `require` MCP park past its clock: continue without the servers, errand recorded. */
  | { kind: 'mcp-continue' };

/** What `maybeAutoRecover` answers — launched or not, and what it read. */
export type AutoRecoverResult = {
  launched: boolean;
  reason?: string;
  phase?: number;
  /** The `id:sub` situation key of the anchor phase. */
  situation?: string;
  label?: string;
  rung?: string;
  vehicle?: 'retry' | 'session' | 'agent' | 'reboard' | 'mcp-continue';
};

/**
 * The situation a phase-less stop most plausibly is — for the one errand the
 * recover verb answers with when no record can be classified.
 */
function situationOfHalt(halt: RunState['halt']): string {
  switch (halt?.kind) {
    case 'plan-lint': case 'plan-unreadable': case 'verification-preflight': return 'plan-broken';
    case 'run-preflight': return 'resource-wall:auth';
    case 'budget': return 'resource-wall:budget';
    case 'models-exhausted': return 'resource-wall:model';
    case 'mcp-preflight': return 'mcp-unavailable';
    case 'needs-human': case 'phase-blocked': return 'blocked-declared';
    case 'verify-failed': return 'verify-red';
    case 'no-handoff': return 'done-unrecorded';
    default: return 'unknown';
  }
}

export class Service {
  readonly flags: Flags;
  prefs: Prefs;
  /** The environment doctor's findings; push health appends at runtime. */
  readonly environment: { issues: EnvIssue[] };
  /** Push-health announcements already made this process, per service|reason. */
  private readonly pushHealthAnnounced = new Set<string>();
  root: RootCheck | null = null;
  store: Store | null = null;
  readonly search = new SearchIndex();
  readonly sizing: Sizing;
  readonly gateVocab: GateVocab;
  generation = 0;

  private watcher: DocsWatcher;
  private boards = new Map<string, Cached<Board>>();
  private qaModes = new Map<string, Cached<QaMode>>();
  private lints = new Map<string, Cached<LintResult>>();
  private sessionPlans = new Map<string, Cached<SessionPlan>>();
  private portfolioCache: { generation: number; value: Portfolio } | null = null;
  private etaPoolCache: { at: number; value: EtaPool } | null = null;
  /** Short-TTL cache behind `runsForSpend()` — see the note there. */
  private spendPool: { at: number; runs: SpendRunView[] } | null = null;
  private listeners = new Set<LiveListener>();
  private repo: GitRepoInfo = { available: false, dirty: [] };

  /** Monotonic id per emitted event, so a client can say what it already saw. */
  eventCursor = 0;
  private eventLog: LiveEvent[] = [];
  /**
   * The last status announced per run, so a halt is not announced on every poll.
   *
   * Keyed by run id rather than a single slot: with two runs live, one halting
   * and the other merely persisting would take turns overwriting the slot, and
   * every write would look like a change worth waking somebody for.
   */
  private notifiedRun = new Map<string, string>();
  /** Per phase, the last status pushed — a re-render is not a second event. */
  private notifiedPhase = new Map<string, string>();
  /**
   * Errands already pushed, keyed `runId:phase:errand.at`.
   *
   * Keyed on the errand's own timestamp and not on the phase, because an
   * errand is re-derived every time the ladder parks the phase again: the same
   * phase asking the same person for the same thing must push ONCE, but a
   * genuinely new ask — a later `at` — is a new notification.
   */
  private notifiedErrand = new Set<string>();
  /**
   * Stall episodes already announced, keyed `runId:phase:signal:attempt`.
   *
   * The attempt is in the key on purpose. One episode is one card: a lane that
   * stays silent for an hour ticks sixty times and is announced once, because
   * the runner only journals a transition and this only fires on what the
   * runner journalled. But the SAME phase going silent again on its next
   * attempt is a different fact — the first one ended, something re-boarded
   * it, and it has stopped again — and an operator needs to hear that.
   */
  private notifiedStall = new Set<string>();
  /** Debounce behind `nudgeInbox` — see the note there. */
  private inboxTimer: ReturnType<typeof setTimeout> | null = null;
  /** Which phases were ready last time, so "became ready" means became. */
  private readySnapshot: Set<string> | null = null;
  /**
   * Every tool this console has been asked about, this process.
   *
   * The rule editor's most useful list is not the taxonomy — it is "the things
   * that actually interrupted you", because those are the rules a person came
   * to write. In memory on purpose: it is a convenience, and a file that
   * accumulated every tool name ever seen would outlive its usefulness.
   */
  private toolsSeen = new Set<string>();

  /**
   * One runner per plan, created on demand and kept.
   *
   * Keyed by slug because that is what every control is addressed by, and
   * because it is the guard: a second run of the SAME plan is the one kind of
   * concurrency that is never safe — two loops driving one phase graph, both
   * reading the same handoffs — so it answers 409, while a second run of a
   * DIFFERENT plan is exactly what the scheduler exists to allow.
   *
   * Kept after the run ends rather than deleted: the runner holds the last
   * `RunState` it drove, which is what the console reads between runs.
   */
  private runners = new Map<string, Runner>();
  /**
   * `<runId>:<serverId>` pairs already announced as degraded. See
   * `announceMcpDegraded` — the fact is worth saying once and not once per
   * phase. Process-lifetime only, deliberately: a console restart is a fair
   * moment to be told again about a server that is still missing.
   */
  private degradedAnnounced = new Set<string>();
  /** Admission control shared by every runner in the pool. See `scheduler.ts`. */
  readonly scheduler: Scheduler;
  /** The convergence loop's clock — boot, change, timer, halt, button. See `converge.ts`. */
  readonly converger: ConvergeScheduler;
  /**
   * Settles when this `open()`'s boot work is done: queued runs re-adopted and
   * the convergence loop's boot pass over every plan complete. What a harness
   * awaits instead of guessing how long the console takes to look around.
   */
  bootSettled: Promise<void> = Promise.resolve();
  readonly approvals: Approvals;
  readonly push: Push;
  readonly notifications: Notifications;
  readonly terminals: Terminals;
  /**
   * Who is in this repository right now — every Claude session the user-scope
   * hook reports (a person's `claude`, a console agent, an autopilot lane),
   * with its presence. See `sessions/registry.ts`. Per instance, like the
   * accounts: two consoles on one machine are two projects.
   */
  readonly sessions: SessionRegistry;
  /** `POST /hooks/session` token bucket — the hook fires per turn of every session on the machine. */
  private hookBucket = { tokens: HOOK_EVENTS_PER_MINUTE, at: Date.now() };
  /** The unsupervised-outcome inbox: `runs/<instance>/<slug>/outcomes/` under watch while a root is open. */
  private outcomeWatcher: FSWatcher | null = null;
  private outcomeTimers = new Map<string, NodeJS.Timeout>();
  /**
   * What sessions nobody here spawned declared, by `slug:phase` — the
   * classifier's `declared` evidence for a hand-run phase (a `blocked` or
   * `needs-human` from a person's session drives the same ladder as a lane's).
   */
  private declaredOutcomes = new Map<string, NonNullable<PhaseEvidence['declared']> & { sessionId?: string }>();
  /** This instance's Claude accounts — registry, meters, per-run environments. */
  readonly accounts: Accounts;
  private accountsEmitTimer: NodeJS.Timeout | null = null;
  /** This instance's MCP servers — registry, credentials, health, per-run configs. */
  readonly mcp: Mcp;
  private mcpEmitTimer: NodeJS.Timeout | null = null;

  constructor(flags: Flags) {
    this.flags = flags;
    this.prefs = loadPrefs();
    this.sizing = loadSizing(flags.scriptsDir);
    this.gateVocab = loadGateVocab(flags.scriptsDir);
    // A new shell opens where you are working, not in `$HOME` — the source
    // directory is what every command you were about to type is relative to.
    this.terminals = new Terminals({
      allowed: flags.allowTerminal,
      agentAllowed: agentEnabled(flags),
      // Signing an account in needs a pty for exactly one fixed command; the
      // accounts flag is that permission without opening free-form sessions.
      loginAllowed: flags.allowAccounts,
      cwd: () => this.root?.path,
      // Every pty session — agent, QA, plan wizard, a plain shell — learns the
      // MCP registry, so `validate.sh` run by hand fires F15 instead of
      // silently skipping it (the advisory was dead in production because
      // launchd's env never carried it).
      baseEnv: () => ({ PE_MCP_SERVERS: this.mcp.enabledIds().join(' ') }),
      onSession: (event) => this.onSessionEvent(event),
    });
    this.push = new Push(flags.remoteUsers);
    // The console's own alarm channel must not fail silently: 29 real sends
    // died on BadJwtToken/BadWebPushTopic with nothing but log lines. A
    // classified streak lands on the environment card and the out-of-band leg
    // — never on push itself (the channel under suspicion cannot carry its
    // own obituary). Once per service|reason per process.
    this.push.onPersistentReject = ({ service: pushService, reason, streak, devices }) => {
      const key = `${pushService}|${reason}`;
      if (this.pushHealthAnnounced.has(key)) return;
      this.pushHealthAnnounced.add(key);
      const fix = reason === 'BadJwtToken'
        ? 'Usual causes: the machine clock is skewed, or the device subscribed under a different '
          + 'VAPID key. Fix the clock, or remove and re-subscribe the device in Settings → Notifications.'
        : reason === 'BadWebPushTopic'
          ? 'Subscriptions predating the hashed-topic fix keep failing — remove and re-subscribe the device.'
          : 'Remove and re-subscribe the device in Settings → Notifications, and check the network.';
      this.environment.issues.push({
        kind: 'push-broken',
        detail: `${pushService} is rejecting this console's pushes (${reason}, ${streak} in a row, `
          + `${devices.length} device${devices.length === 1 ? '' : 's'})`,
        fix,
      });
      log.warn('push.health', { service: pushService, reason, streak, devices });
      notifyOutOfBand('Phase Console: push delivery is broken',
        `${pushService} rejects with ${reason} — see Settings → Notifications`);
    };
    this.notifications = new Notifications();
    // The environment doctor: computed once (this process's env cannot
    // change), carried on state(), and — for the one finding that means the
    // unit was installed as somebody else — announced on the health channel.
    this.environment = { issues: environmentReport() };
    if (this.environment.issues.length) log.warn('env.doctor', { issues: this.environment.issues });
    const foreign = this.environment.issues.find((issue) => issue.kind === 'path-foreign-home');
    // The announce is suppressed under a test runner: the doctor reads the
    // AMBIENT machine env, and a developer whose own shell PATH carries the
    // defect would otherwise leak a health notification into every suite that
    // pins exact announcement sets. The report itself still computes — tests
    // assert on state().environment, not on the ambient push.
    const testing = process.env.NODE_TEST_CONTEXT || process.env.VITEST;
    if (foreign && !testing) {
      this.announce('health', {
        title: 'Console environment needs attention',
        body: `${foreign.detail}. ${foreign.fix}`,
        tag: tagFor('health', 'env-doctor'),
      });
    }
    this.watcher = new DocsWatcher((paths) => this.onChange(paths));
    // The session registry: loaded from disk (records + whatever the hook
    // dropped in the inbox while no console was up), then watching the inbox.
    this.sessions = new SessionRegistry({
      dir: join(INSTANCE_STATE_DIR, 'sessions'),
      onChange: (record, event) => this.onPresenceChange(record, event),
      onWarn: (what, detail) => log.warn(what, detail),
    }).load().start();
    this.approvals = new Approvals({
      notify: (approval) => {
        this.emit('approval', approval);
        const where = `${approval.slug}${approval.phase != null ? ` phase ${approval.phase}` : ''}`;
        this.announce('approval', {
          title: approval.kind === 'verify' ? 'A check only you can make' : 'Permission needed',
          body: `${where} — ${approval.title}`,
          tag: tagFor('approval', approval.id),
          detail: approval.detail,
        }, { slug: approval.slug, phase: approval.phase, runId: approval.runId, approvalId: approval.id });
      },
      // A decision made anywhere is now true everywhere. Every ending arrives
      // here — a click, a tap on a phone, the timeout, `disarm()` when the run
      // ends — because the hook is inside the settle closure itself.
      resolved: (approval) => {
        this.emit('approval:resolved', {
          id: approval.id,
          status: approval.status,
          decidedBy: approval.decidedBy,
          decidedAt: approval.decidedAt,
          reason: approval.reason,
          runId: approval.runId,
          slug: approval.slug,
          phase: approval.phase,
          title: approval.title,
        });
      },
    });
    this.scheduler = new Scheduler({
      max: () => this.flags.maxSessions,
      // Every lock on disk, across every plan the store has scanned — which is
      // how a session this console never started (a human in a terminal, a
      // bash worker) gets a say in what the autopilot is allowed to begin.
      locks: () => this.allLocks(),
      // The entry's OWN phase, read live off disk: the one holder the store's
      // watcher-debounced view can lag on (a same-phase claim written seconds
      // ago). Without it admission granted, the boarding belt-check refused,
      // and the loop re-boarded ~1 Hz until the store caught up.
      liveLock: (slug, phase) => {
        const handoffsDir = this.root?.handoffsDir;
        if (!handoffsDir || this.store?.get(slug)?.plan?.closed) return null;
        const lock = readLock(handoffsDir, slug, phase);
        return lock ? {
          slug, phase: lock.phase, owner: lock.owner, expired: lock.expired, scope: lock.scope,
          ...(lock.leaseUntil != null ? { leaseUntil: lock.leaseUntil } : {}),
          ...(lock.session ? { session: lock.session } : {}),
        } : null;
      },
      // A lock with no `scope=` line: recover what the plan says that phase
      // touches rather than reading it as `all`. See `SchedulerDeps.scopeFor`.
      scopeFor: (slug, phase) => this.scopeOf(slug, phase),
      // Presence beats the lease: a lock whose session the registry shows
      // ended stops blocking NOW; a live one is named as live on the queue.
      presence: (lock) => this.sessions.presenceOfLock(lock),
      // The repository guard is a preference, read per call so a flip in the
      // settings page lands on the very next poll. Off never means unguarded
      // within one run — see `SchedulerDeps.guard`.
      guard: () => this.prefs.repoGuard !== false,
      onChange: (snapshot) => this.emit('run:queue', {
        max: snapshot.max,
        live: snapshot.live,
        queued: snapshot.queued,
        throttledUntil: snapshot.throttledUntil,
        throttledAccounts: snapshot.throttledAccounts,
      }),
    });
    // The convergence loop. Its passes go through `convergeNow` (which builds
    // the deps from this service's own store, board cache, runner pool and
    // healer); its clock is the real one unless a harness swaps it first.
    this.converger = new ConvergeScheduler({
      run: (slug, trigger, lastNoop) => this.convergeNow(slug, trigger, lastNoop),
      slugs: () => this.convergeSlugs(),
      everyMs: () => this.prefs.convergeEveryMs,
      // The full flattened view rides the event (`convergeView`) — the Pulse
      // writes it straight into its cache, phase by phase, no refetch.
      onReport: (report) => this.emit('run:converge', convergeView(report)),
    });
    this.accounts = new Accounts({
      onChange: () => this.emitAccounts(),
      // The meters warn before the wall: 80 is "plan your afternoon", 95 is
      // "the next long phase will not finish". Its own category, off by
      // default — the wall itself (and everything a run does about one) stays
      // under `limits`, so muting the climb never mutes the crash.
      onThreshold: (view, bucket, level, utilization, resetsAt) => {
        const name = view.email ?? view.name ?? view.id;
        const when = new Date(resetsAt);
        const reset = Number.isNaN(when.getTime()) ? resetsAt : when.toLocaleString();
        this.announce('usage-climbing', {
          title: level === 'alert'
            ? `Usage window nearly spent — ${bucketLabel(bucket)}`
            : `Usage climbing — ${bucketLabel(bucket)}`,
          body: `${name}: ${Math.round(utilization)}% of the ${bucketLabel(bucket)} window used · resets ${reset}`,
          tag: tagFor('usage-climbing', view.id, bucket, resetsAt),
        });
      },
      // A login that went from known-good to broken. Rides the `limits`
      // category (its catalogue copy claims sign-in failures), fires once per
      // transition — the poller's own refresh has already been tried.
      onAuthChange: (view, state) => {
        const name = view.email ?? view.name ?? view.id;
        this.announce('limits', {
          title: `Sign in again — ${name}`,
          body: state === 'expired'
            ? `${name}'s Claude login has expired and could not be refreshed. Sessions on it will `
              + 'fail until someone signs in again — Settings → Claude accounts has the button.'
            : `${name} is signed out. Sign in again from Settings → Claude accounts before running `
              + 'work as it.',
          tag: tagFor('limits', 'auth', view.id),
        });
      },
    });
    this.mcp = new Mcp({
      onChange: () => this.emitMcp(),
      // A server's advertised tools changed under a plan that already trusted
      // it. This is the documented MCP supply-chain attack — a server that was
      // safe when it was attached, republished with a tool that is not — and a
      // client's only defence is to have written down what it used to be. Rides
      // `limits`, whose catalogue copy already covers "something needs you".
      onToolsChanged: (view, added, removed) => {
        const parts = [
          added.length ? `added ${added.join(', ')}` : '',
          removed.length ? `removed ${removed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        this.announce('limits', {
          title: `MCP server changed its tools — ${view.label}`,
          body: `${view.label} now advertises different tools (${parts}). Review it before the next `
            + 'run attaches it: a server whose tools change under you is how a trusted integration '
            + 'becomes an untrusted one.',
          tag: tagFor('limits', 'mcp-drift', view.id),
        });
      },
      // A server changed state in a way somebody would want to know about.
      // Transitions only — the poller has already tried; this is the point at
      // which a person could act.
      onStatusChange: (view, status) => {
        if (status === 'connected') {
          this.announce('limits', {
            title: `MCP server back — ${view.label}`,
            body: `${view.label} is connected again and available to runs on this console.`,
            tag: tagFor('limits', 'mcp', view.id, status),
          });
          // Whatever parked on it can go. This is the trigger that was missing:
          // a sign-in through the console's own terminal already called this,
          // but a server that recovered any other way did not.
          void this.healMcpParks(view.id);
          return;
        }
        this.announce('limits', {
          title: `MCP server unavailable — ${view.label}`,
          body: status === 'needs-auth'
            ? `${view.label} needs signing in, and an unattended run cannot do it. Phases that name this `
              + 'server will run without it and say so, unless the plan requires it — Settings ▸ MCP has '
              + 'the button.'
            : `${view.label} will not connect${view.issue ? `: ${view.issue}` : ''}. Phases that name it `
              + 'will run without it and say so, unless the plan requires it.',
          tag: tagFor('limits', 'mcp', view.id, status),
        });
      },
    });
    // Meters run for the life of the process, not the life of a source dir —
    // accounts are an instance fact, and the header shows them on every page.
    this.accounts.startPolling();
    // A fault anywhere in the process reaches the browser as a health event,
    // so a degraded console announces itself instead of looking healthy.
    onDegraded((state) => {
      this.emit('health', { ...state, watcher: this.watcher.status() });
      // The supervisor failing quietly is the worst case here: every other
      // surface still looks exactly like a console that is working.
      this.announce('health', {
        title: 'Phase Console is degraded',
        body: `${state.kind}: ${state.message}`,
        tag: tagFor('health', state.kind, state.message),
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * The runner pool
   * ---------------------------------------------------------------- */

  /** The runner for a plan, made on first use. See `runners`. */
  runnerFor(slug: string): Runner {
    const existing = this.runners.get(slug);
    if (existing) return existing;
    const made = this.makeRunner();
    this.runners.set(slug, made);
    return made;
  }

  /** The runner DRIVING this plan right now, or null. */
  private liveRunner(slug: string): Runner | null {
    const runner = this.runners.get(slug);
    return runner?.busy() ? runner : null;
  }

  /** Every runner with a loop behind it, in no particular order. */
  private liveRunners(): Runner[] {
    return [...this.runners.values()].filter((runner) => runner.busy());
  }

  /**
   * Every run this process is genuinely driving.
   *
   * A Set rather than an id, because that is what it now is. Every read of a
   * run passes through it: a `running` status on disk is a claim by a process
   * that may have been killed since, and this is the only thing that says
   * whether anything is behind it.
   */
  private liveRunIds(): Set<string> {
    const ids = new Set<string>();
    for (const runner of this.liveRunners()) {
      const id = runner.current()?.id;
      if (id) ids.add(id);
    }
    return ids;
  }

  /** Every live run's state, first-started first. */
  runStates(): RunState[] {
    return this.liveRunners()
      .map((runner) => runner.current())
      .filter((state): state is RunState => Boolean(state))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * The run a verified hook token belongs to.
   *
   * Null when the token names nothing this console drives — a run that ended
   * between the child's call and this lookup. Answering `guarded` in that case
   * is the fail-safe direction: the strictest profile, never a neighbour's.
   */
  private runBytoken(runId?: string | null): RunState | null {
    if (!runId) return null;
    for (const runner of this.liveRunners()) {
      const state = runner.current();
      if (state?.id === runId) return state;
    }
    return null;
  }

  /** The runner driving a given run id, for controls that arrive by id. */
  private runnerByRunId(runId: string): Runner | null {
    for (const runner of this.liveRunners()) {
      if (runner.current()?.id === runId) return runner;
    }
    return null;
  }

  /** How full the console is: the header's answer, and `/api/queue`'s summary. */
  concurrency(): {
    max: number; live: number; queued: number; throttledUntil: number | null;
    throttledAccounts: { accountId: string; until: number }[];
  } {
    const snapshot = this.scheduler.snapshot();
    return {
      max: snapshot.max,
      // Lanes, not runs. One run driving three phases is three sessions on this
      // machine, and the cap is about sessions.
      live: snapshot.live,
      queued: snapshot.queued,
      throttledUntil: snapshot.throttledUntil,
      throttledAccounts: snapshot.throttledAccounts,
    };
  }

  /**
   * The queue, in full — what is holding a scope and what is waiting on it.
   *
   * `waitingOn` carries the holder of each collision, because "queued" on its
   * own is the same unhelpful non-answer `status: pausing` used to be: it says
   * a thing is not happening without saying what would have to change.
   */
  queueSnapshot(): ReturnType<Scheduler['snapshot']> {
    return this.scheduler.snapshot();
  }

  /**
   * Each phase of a plan, its declared scope, and what that scope collides with.
   *
   * Read straight off the same two sources admission uses — the Repos column
   * and the live locks — so the page cannot show one answer while the
   * scheduler acts on another.
   */
  phaseScopes(slug: string): { phase: number; scope: string[]; conflicts: string[] }[] {
    const rows = this.store?.get(slug)?.plan?.graph ?? [];
    const locks = this.allLocks().filter((lock) => !lock.expired);
    const grants = this.scheduler.snapshot().grants;
    return rows.map((row) => {
      const scope = scopeOfRow(row.repos);
      const conflicts: string[] = [];
      for (const lock of locks) {
        if (lock.slug === slug && lock.phase === row.phase) continue;
        const other = lock.scope?.length ? lock.scope : this.scopeOf(lock.slug, lock.phase) ?? ['all'];
        if (scopesIntersect(other, scope)) conflicts.push(`${lock.slug} phase ${lock.phase} (${lock.owner})`);
      }
      for (const grant of grants) {
        if (grant.slug === slug && grant.phase === row.phase) continue;
        if (scopesIntersect(grant.scope, scope)) {
          conflicts.push(`${grant.slug}${grant.phase == null ? '' : ` phase ${grant.phase}`} (running)`);
        }
      }
      return { phase: row.phase, scope, conflicts: [...new Set(conflicts)] };
    });
  }

  /** Every lock on disk, across every plan — the scheduler's view of the world. */
  private allLocks(): LockView[] {
    const out: LockView[] = [];
    for (const record of this.store?.list() ?? []) {
      // Parity with `phase-lock.sh conflicts`, which skips closed plans: a
      // closed plan's leftover locks are debris, not holders.
      if (record.plan?.closed) continue;
      for (const lock of record.locks) {
        out.push({
          slug: record.slug, phase: lock.phase, owner: lock.owner,
          expired: lock.expired, scope: lock.scope,
          // The lease clock, so the scheduler can judge expiry live instead
          // of trusting the bit frozen at scan time — and arm a wake at it.
          ...(lock.leaseUntil != null ? { leaseUntil: lock.leaseUntil } : {}),
          // The holding session, so the registry can say whether it is still there.
          ...(lock.session ? { session: lock.session } : {}),
        });
      }
    }
    return out;
  }

  /** What a phase's Repos column says it touches. Undefined for an unknown plan. */
  private scopeOf(slug: string, phase: number): string[] | undefined {
    const row = this.store?.get(slug)?.plan?.graph.find((r) => r.phase === phase);
    return row ? scopeOfRow(row.repos) : undefined;
  }

  private makeRunner(): Runner {
    const flags = this.flags;
    return new Runner({
      scriptsDir: flags.scriptsDir,
      approvals: this.approvals,
      scheduler: this.scheduler,
      maxParallel: () => this.flags.maxSessions,
      // The registry's word on a lock's session, for the boarding belt-check:
      // an ended session's claim is released and boarding goes on.
      lockPresence: (lock) => this.sessions.presenceOfLock(lock),
      // The store's handoff for a phase — status and Outstanding — for the
      // loop's own situation classifier and the re-board briefs. The board's
      // word already says `stuck`/`in-progress`; this is what it SAYS.
      handoffFor: (slug, phase) => {
        const record = this.store?.get(slug);
        const handoff = record ? handoffFor(record, phase) : undefined;
        return handoff
          ? { exists: true, status: handoff.status, outstanding: handoff.outstanding }
          : { exists: false };
      },
      // The ladder's caps and the unblock switch — the same preferences the
      // healer reads, so the loop's climbs and the healer's count against one
      // budget.
      ladderCaps: () => ladderCaps(this.prefs),
      // The per-day cap's denominator. The runner cannot compute it — it sees
      // one run, and the cap is about the machine.
      dayHistory: () => this.dayRungs(),
      unblockAttempts: () => this.prefs.unblockAttempts !== false,
      origin: `http://${flags.host}:${flags.port}`,
      // The registry ids, so the runner's own engine calls (its validate.sh in
      // confirm(), its board reads) carry PE_MCP_SERVERS like the service's do.
      mcpIds: () => this.mcp.enabledIds(),
      // The plan is the only source for what proves a phase worked, exactly as
      // it is the only source for what the phase should do.
      verificationText: (slug, phase) => this.store?.get(slug)?.plan?.phases[phase]?.verification,
      // Raw-text presence check, distinct from the parsed field above: it is
      // what lets the park message tell "the plan omits it" apart from "the
      // plan states it in a shape the parser lost".
      verificationDeclared: (slug, phase) =>
        /\*\*\s*Verification\b/i.test(this.store?.get(slug)?.plan?.phases[phase]?.raw ?? ''),
      // …and where they mean to be run. Same store, same reason.
      verifyIn: (slug, phase) => this.store?.get(slug)?.plan?.phases[phase]?.verifyIn,
      // Read only to SUGGEST a `Verify in:` on a failure — never to pick a
      // directory. The Repos column has always been there; nothing read it.
      phaseRepos: (slug, phase) => {
        const row = this.store?.get(slug)?.plan?.graph.find((r) => r.phase === phase);
        return row ? splitRepos(row.repos) : undefined;
      },
      // The same cell, read as SCOPE: what admission decides on and what the
      // child is told it holds. Kept separate from `phaseRepos` above so a
      // cosmetic hint can never become the thing concurrency rests on.
      phaseScope: (slug, phase) => this.scopeOf(slug, phase),
      // …and for what it should run as. These bullets have been in the plan
      // format from the start; until now nothing read them.
      phaseDefaults: (slug, phase) => {
        const detail = this.store?.get(slug)?.plan?.phases[phase];
        if (!detail) return undefined;
        return { model: modelAlias(detail.model), effort: effortOf(detail.effort) };
      },
      // What the PLAN says this phase needs — its §Session budget line unioned
      // with its own `**MCP:**` bullet. Read from the parsed plan rather than
      // shelled per phase: the runner asks for this on every boarding, and
      // `engine-parity.test.ts` is what keeps the two readings honest.
      planMcp: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        if (!plan) return [];
        return [...new Set([...(plan.sessionBudget.mcpServers ?? []), ...(plan.phases[phase]?.mcpServers ?? [])])];
      },
      // What the PLAN says to do when one of them will not connect — the
      // phase's own bullet first, then the §Session budget line. Absent means
      // the plan has no opinion and the run's setting answers; it is the ONE
      // resolution where the plan outranks the run, because a phase that says
      // it requires a server is describing the work rather than a preference.
      planMcpPolicy: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        return plan?.phases[phase]?.mcpPolicy ?? plan?.sessionBudget.mcpPolicy;
      },
      // A phase boarded without servers it asked for. The runner has no
      // notification vocabulary; this is where the fact becomes something an
      // operator hears, once per run per server rather than once per phase.
      onMcpDegraded: (state, phase, degraded) => this.announceMcpDegraded(state, phase, degraded),
      // Absent when the flag is off: a console that may not REGISTER servers
      // still resolves plans that name them, because reading is not the gated
      // act — but with an empty registry every such name is unreachable, which
      // is the honest outcome and exactly what the session is told.
      mcp: {
        preflight: (ids, cwd) => this.mcp.preflight(ids, { cwd }),
        configFor: (runId, ids) => this.mcp.configFor(runId, ids),
      },
      // The plan's Branch prose and title, for the git-strategy block: the
      // prose is read only to WARN on a mismatch, the title names the PR.
      planBranch: (slug) => this.store?.get(slug)?.plan?.sessionBudget.branch,
      planTitle: (slug) => this.store?.get(slug)?.plan?.title,
      // The account seam. `envFor` makes a child run AS the run's account;
      // `pickAccount` is the switch policy's cached answer; the limited hook
      // remembers the wall on the account and tells the operator which one.
      accountEnv: (accountId) => this.accounts.envFor(accountId),
      pickAccount: (excluding, forModel) => this.accounts.pickAccount(excluding, forModel),
      // The resource ladder: the ranked candidates the auth preflight probes
      // one by one, and the three knobs, read live from prefs so Settings
      // applies to the next wall rather than the next run.
      rankAccounts: (excluding, forModel) => this.accounts.rankAccounts(excluding, forModel),
      autoAccountSwitch: () => this.prefs.autoAccountSwitch !== false,
      budgetAutoRaisePct: () => this.prefs.budgetAutoRaisePct ?? 25,
      mcpRequireTimeoutMs: () => this.prefs.mcpRequireTimeoutMs ?? DEFAULT_MCP_REQUIRE_TIMEOUT_MS,
      // Read on every evaluation, not captured at construction: a number
      // changed in Settings ▸ Automation applies to the lane already running.
      stallThresholds: () => ({
        stallSilentMs: this.prefs.stallSilentMs,
        stallSpinTurns: this.prefs.stallSpinTurns,
        stallStalemateAttempts: this.prefs.stallStalemateAttempts,
      }),
      onMcpRequireTimeout: (state, phase, result) => this.announceMcpTimeout(state, phase, result),
      // The preflight probe, under the RUN's account env. Signed out, the
      // refusal names the account and the exact command that fixes it —
      // composed here, where the config dir is known, never in the browser.
      checkAuth: async (accountId) => {
        const env = await this.accounts.envFor(accountId);
        const root = this.root?.ok ? this.root.path : process.cwd();
        const status = await checkAuthFor(root, env, accountId ?? 'default', true);
        if (!status.loggedIn && accountId && accountId !== DEFAULT_ACCOUNT_ID) {
          const meta = this.accounts.meta(accountId);
          const fix = meta?.kind === 'profile'
            ? `sign it in with \`CLAUDE_CONFIG_DIR=${profileConfigDir(accountId)} claude auth login\`, `
              + 'or from Settings → Claude accounts'
            : 'paste a fresh `claude setup-token` for it in Settings → Claude accounts';
          return {
            ...status,
            detail: `the run is set to pay as ${this.accounts.labelFor(accountId)} and that login is `
              + `expired or signed out — ${fix}.${status.detail ? ` (${status.detail})` : ''}`,
          };
        }
        return status;
      },
      onAccountLimited: (accountId, window, resetsAt, detail) => {
        if (resetsAt) this.accounts.markLimited(accountId, window, resetsAt.toISOString());
        const name = this.accounts.labelFor(accountId);
        this.announce('limits', {
          title: `Usage limit hit — ${name}`,
          body: detail,
          tag: tagFor('limits', accountId ?? 'default', window, resetsAt?.toISOString() ?? 'unknown'),
        });
      },
      portTranscript: (sessionId, fromAccount, toAccount) => portTranscript(
        sessionId,
        this.accounts.configDirFor(fromAccount),
        this.accounts.configDirFor(toAccount),
      ),
      onEvent: (event, data) => this.onRunnerEvent(event, data),
    });
  }

  /* ---------------------------------------------------------------- *
   * Announcing — the one choke point
   * ---------------------------------------------------------------- */

  /**
   * Say something, once, through every leg — and write it down first.
   *
   * Everything that wants to tell the operator anything goes through here, and
   * the order matters. The record is written **before** delivery is attempted,
   * so it exists in the cases that used to lose the event entirely: no tab
   * open, no device subscribed, `Push.announce()` returning at its first line
   * because the register is empty. The inbox is therefore complete by
   * construction — if it is not in the store, it was not announced.
   *
   * Three legs leave from here and they fail independently: the SSE event (a
   * tab, if one is open), the operator's own notifier (`PHASE_CONSOLE_NOTIFY`,
   * if one is set), and web push (each subscribed device, reporting back what
   * became of it). None of them can throw into a run.
   *
   * And one gate stands in front of all four, which is the point of doing this
   * here rather than per leg. A category the operator has turned off produces
   * *nothing*: no record, no SSE, no out-of-band command, no push. That has to
   * happen before `record()` or the inbox keeps filling with the very thing the
   * switch was thrown to stop — which is exactly how a console accumulates 182
   * unread notifications for a category that is off by default. Suppression
   * before recording is what keeps the unread count honest.
   *
   * Push keeps its own per-device categories underneath this: the global switch
   * decides whether the console speaks at all, the device switch decides whether
   * this phone is one of the places it speaks to.
   */
  private announce(
    category: CategoryId,
    message: { title: string; body: string; tag: string; detail?: string },
    context: {
      slug?: string | null; phase?: number | null; runId?: string; approvalId?: string;
      sessionId?: string | null; sessionKind?: 'shell' | 'claude' | null;
    } = {},
  ): NotificationRecord | null {
    // The one gate. `notify` is a complete map by construction (`loadPrefs`), so
    // a category missing from a stored config took its catalogue default on load
    // rather than arriving here as `undefined` and silencing itself.
    if (!this.prefs.notify[category]) return null;

    // And the second: a closed plan does not report progress. Here rather than at
    // each announcer for the same reason as the first gate — a suppression that
    // has to be remembered in five places is a suppression that will be missed in
    // one. Only the plan-progress categories are affected; see the catalogue for
    // why a live process keeps its voice whatever the plan's front matter says.
    if (isPlanProgress(category) && this.isClosedPlan(context.slug)) return null;

    const url = routeFor(category, context);
    const record = this.notifications.record({
      category,
      title: message.title,
      body: message.body,
      url,
      slug: context.slug ?? undefined,
      phase: context.phase ?? undefined,
      runId: context.runId,
      // Carried onto the record, not only into the URL: this is what lets a
      // page mark its own notifications read when you open it.
      sessionId: context.sessionId ?? undefined,
    });

    // The inbox badge and any open inbox follow the store live rather than
    // polling it.
    this.emit('notification', record);

    // The path that reaches an operator who is asleep with no browser in the
    // picture at all — which is the case the whole unattended design exists for.
    notifyOutOfBand(`Phase Console: ${message.title}`, message.detail ?? message.body);

    this.push.announce(
      category,
      {
        title: message.title,
        body: message.body,
        tag: message.tag,
        url,
        ...(context.approvalId ? { approvalId: context.approvalId } : {}),
        notificationId: record.id,
      },
      Date.now(),
      (report) => {
        this.notifications.delivery(record.id, { ...report, at: new Date().toISOString() });
        this.emit('notification:delivery', { id: record.id, ...report });
      },
    );
    return record;
  }

  /**
   * Has the operator closed this plan?
   *
   * Read from the store's already-parsed front matter rather than by shelling to
   * `phase-graph.sh --closed`: this is asked on the notification path, which must
   * not wait on a subprocess, and the predicate is a pure function of a string
   * the store already has. `stats.ts` owns the reading; the bash side owns its
   * own, and `engine-parity` is what keeps the two honest.
   */
  isClosedPlan(slug?: string | null): boolean {
    if (!slug) return false;
    return isClosedStatus(this.store?.get(slug)?.plan?.status);
  }

  /* ---------------------------------------------------------------- *
   * Sessions — the other thing this console is running
   * ---------------------------------------------------------------- */

  /**
   * Every lifecycle moment of every pty, turned into the two things the rest of
   * the system needs: a live event, and — for the ones worth interrupting
   * someone over — a notification.
   *
   * The stream first. A terminal deliberately had no SSE event: the socket IS
   * its live channel, and a list that refetched on every unrelated `changed`
   * would be noise. That reasoning holds for the *session's own page* and fails
   * everywhere else — the dashboard's list of what is running, the nav badge,
   * and the second browser you opened all need to know a session appeared or
   * ended, and none of them is holding that socket. So one event, carrying the
   * whole list, on the six moments the list can change.
   *
   * Then the notification, and the restraint is the design. Three cases earn
   * one, and everything else is silence:
   *
   *  - **it ended while you were not attached** — the case the whole feature
   *    exists for: you closed the tab, went to lunch, and something finished;
   *  - **it ended badly** (a nonzero code), attached or not — a failure you
   *    would otherwise find by scrolling back through a dead terminal;
   *  - **it was a recovery session** (P4's linkage), always — you asked the
   *    console to fix something and its outcome is the answer.
   *
   * A session you closed yourself is never announced. `kill()` reports `killed`
   * rather than `exited` precisely so that stays true.
   */
  private onSessionEvent(event: SessionEvent): void {
    const { type, session } = event;
    this.emit('sessions', {
      type,
      session,
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
      foreign: this.sessionViews(),
    });

    if (type !== 'exited') return;
    const code = session.exited?.code ?? 0;
    const failed = code !== 0 || session.exited?.signal != null;

    // A verify-command terminal's exit is the whole point of the mint: the
    // code lands back on the run record, and green settles via recheck.
    if (session.meta?.verify) {
      this.reflectVerifyCommand(session.meta.verify, code, this.terminals.outputTail(session.id));
      return;
    }

    // A login session's exit is answered by reading back who the profile
    // became — email, plan — never by announcing that a process ended. The
    // probe also covers "they closed it without finishing": completeLogin
    // simply finds no credentials and the card keeps saying "not signed in".
    const loginAccount = session.meta?.intent === 'login' ? session.meta.accountId : undefined;
    if (loginAccount) {
      void this.accounts.completeLogin(loginAccount).then((view) => {
        if (view?.signedIn && view.email) {
          this.announce('limits', {
            title: 'Account signed in',
            body: `${view.email} is now available to runs on this console.`,
            tag: tagFor('limits', 'login', loginAccount),
          });
        }
      }).catch((error) => log.warn('accounts.login.complete-failed', { account: loginAccount, error }));
      return;
    }

    // An MCP sign-in's exit is answered the same way: by re-probing rather than
    // by trusting that the terminal closing meant success. Somebody who gave up
    // halfway leaves the server exactly as it was, and the card keeps saying so.
    const loginMcp = session.meta?.intent === 'login' ? session.meta.mcpServer : undefined;
    if (loginMcp) {
      void this.refreshMcp(true).then(async (servers) => {
        const view = servers.find((server) => server.id === loginMcp);
        if (view?.status === 'connected') {
          this.announce('limits', {
            title: 'MCP server signed in',
            body: `${view.label} is connected and available to runs on this console.`,
            tag: tagFor('limits', 'mcp-login', loginMcp),
          });
          // A run parked waiting for exactly this can now be re-armed.
          await this.healMcpParks(loginMcp);
        }
      }).catch((error) => log.warn('mcp.login.complete-failed', { server: loginMcp, error }));
      return;
    }

    const recovery = session.meta?.recovery;
    const qa = session.meta?.qa;
    if (!event.detached && !failed && !recovery && !qa) return;

    // A recovery session was opened to change something specific, so its exit
    // is answered by re-reading that thing rather than by reporting that a
    // process ended. Async, and deliberately not awaited: the registry is
    // emitting an event, not waiting for a verdict.
    if (recovery) { void this.announceRecoveryOutcome(session, recovery, failed); return; }

    // A QA session was opened to produce a verdict, so its exit is answered by
    // re-reading test-status.md — never by reporting that a process ended, and
    // never by assuming the review reached a conclusion because it stopped.
    if (qa) { void this.announceQaOutcome(session, qa, failed); return; }

    // A stop the operator asked for is not news — the exit IS the outcome they
    // requested. The recovery/QA branches above deliberately still ran: a
    // stopped verdict session must still be read against the board.
    if (session.stopping) return;

    const what = session.kind === 'claude' ? 'Agent session' : 'Terminal';
    this.announce('session', {
      title: failed ? `${what} failed` : `${what} finished`,
      body: `${session.label} — ${failed ? `exited ${describeExit(session)}` : 'exited cleanly'}`
        + (event.detached ? ' · nothing was attached' : ''),
      tag: tagFor('session', session.id, String(code)),
      detail: session.cwd,
    }, {
      sessionId: session.id,
      sessionKind: session.kind,
    });
  }

  /**
   * What the recovery achieved, checked against the board — then said.
   *
   * "Your recovery session ended" is the notification this feature exists to
   * not send. The console knows what the session was for, so it can re-read
   * the board and answer the actual question: is the phase done now?
   *
   * A session that crashed is still checked, because a session can commit the
   * fix and then fall over on its way out, and the board is the evidence
   * either way.
   */
  private async announceRecoveryOutcome(
    session: SessionInfo,
    link: { kind: string; slug?: string; phase?: number; runId?: string },
    failed: boolean,
  ): Promise<void> {
    let outcome: { fixed: boolean; headline: string; detail: string };
    try {
      outcome = await this.recoveryOutcome(link);
    } catch (error) {
      // Never let a failed board read swallow the notification — the operator
      // still needs to know the session ended.
      outcome = {
        fixed: false,
        headline: `Recovery for ${link.slug ?? 'a plan'} finished`,
        detail: `The console could not re-read the board: ${(error as Error).message}`,
      };
    }

    // The verdict becomes the record before anyone is told about it: a fixed
    // board flips the phase to done, clears the halt and parks the run; a miss
    // annotates the attempt. For a while the verdict went only into the
    // notification below, and the run it was about stayed `halted` forever.
    let synced: RunState | null = null;
    try {
      synced = this.syncRecoveredRun(link, outcome);
    } catch (error) {
      log.warn('recovery.sync-failed', { slug: link.slug, phase: link.phase, error });
    }

    this.announce('session', {
      title: outcome.fixed ? `Recovered · ${outcome.headline}` : `Still needs you · ${outcome.headline}`,
      body: `${outcome.detail}${failed ? ` (the session itself exited ${describeExit(session)})` : ''}`,
      tag: tagFor('session', session.id, outcome.fixed ? 'fixed' : 'unfixed'),
      detail: session.label,
    }, {
      sessionId: session.id,
      sessionKind: session.kind,
      ...(link.slug ? { slug: link.slug } : {}),
      ...(link.phase != null ? { phase: link.phase } : {}),
      ...(link.runId ? { runId: link.runId } : {}),
    });

    // The surfaces that offered the recovery re-read themselves off this.
    this.emit('sessions', {
      type: 'recovery-outcome',
      session,
      recovery: { ...link, ...outcome, synced: Boolean(synced) },
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
      foreign: this.sessionViews(),
    });

    // A fixed run carries on by itself — the same resume `retryPhase` and the
    // limit clock make, under the automation pref that governs everything else
    // unattended. `parked` is the only post-sync state worth continuing; a
    // not-fixed outcome left the halt standing on purpose.
    if (outcome.fixed && synced?.status === 'parked' && link.slug
      && this.prefs.autoContinueRecovery !== false
      && this.flags.allowRun && !this.liveRunner(link.slug)) {
      try {
        log.info('run.recovery-continue', { slug: link.slug, runId: synced.id });
        await this.startRun(link.slug, {
          resumeRunId: synced.id,
          ...(synced.onlyPhases?.length ? { onlyPhases: synced.onlyPhases } : {}),
          skills: synced.skills ?? [],
        });
      } catch (error) {
        log.warn('run.recovery-continue-failed', { slug: link.slug, runId: synced.id, error });
      }
    }
  }

  /**
   * What the QA session actually recorded — read back, never assumed.
   *
   * The asymmetry with a recovery is deliberate. A recovery is judged by the
   * board, which moves for many reasons; a review is judged by the one row it
   * was sent to write, and a review that wrote no row produced no verdict
   * however long it ran. So "no verdict recorded" is a first-class outcome
   * here, and it is never softened into a pass.
   */
  private async announceQaOutcome(
    session: SessionInfo,
    link: { slug: string; phase: number; before?: string; beforeReport?: string },
    failed: boolean,
  ): Promise<void> {
    let outcome: QaOutcome;
    try {
      outcome = await this.qaOutcome(link);
    } catch (error) {
      outcome = {
        recorded: false,
        headline: `QA for ${link.slug} P${link.phase} finished`,
        detail: `The console could not re-read test-status.md: ${(error as Error).message}`,
      };
    }

    this.announce('session', {
      title: outcome.recorded
        ? `QA ${outcome.result} · ${link.slug} P${link.phase}`
        : `No verdict · ${link.slug} P${link.phase}`,
      body: `${outcome.detail}${failed ? ` (the session itself exited ${describeExit(session)})` : ''}`,
      tag: tagFor('session', session.id, outcome.result ?? 'none'),
      detail: session.label,
    }, {
      sessionId: session.id,
      sessionKind: session.kind,
      slug: link.slug,
      phase: link.phase,
    });

    // The surfaces that offered the review re-read themselves off this.
    this.emit('sessions', {
      type: 'qa-outcome',
      session,
      qa: { ...link, ...outcome },
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
      foreign: this.sessionViews(),
    });
  }

  /**
   * What a shutdown or a restart is about to stop, as a fact rather than a
   * warning in the abstract.
   *
   * Both dialogs render this: "stops 2 agent sessions and a terminal" is a
   * different decision from "stops nothing", and until now neither button said
   * which it was — Restart has always killed every pty and never mentioned it.
   */
  sessionInventory(): {
    live: number; agent: number; terminal: number; ended: number;
    sessions: { id: string; label: string; kind: SessionKind }[];
  } {
    const all = this.terminals.state().sessions;
    const live = all.filter((session) => !session.exited);
    return {
      live: live.length,
      agent: live.filter((session) => session.kind === 'claude').length,
      terminal: live.filter((session) => session.kind !== 'claude').length,
      ended: all.length - live.length,
      sessions: live.map((session) => ({ id: session.id, label: session.label, kind: session.kind })),
    };
  }

  /* ---------------------------------------------------------------- *
   * Opening a source directory
   * ---------------------------------------------------------------- */

  /**
   * Why this console will not be repointed, or `null` if it will.
   *
   * A non-default instance exists *because* someone wanted a console for one
   * project: it has that project's id, its state directory, its port and (from
   * P6) its own unit. Letting the browser swap its root would leave every one
   * of those describing a project it is no longer serving — the instance would
   * still be named `alpha`, still be writing to alpha's log, and be showing
   * beta's plans. So it refuses, and names the verb that does what the operator
   * actually wants: start beta's own console.
   *
   * The default instance keeps the picker. It is the console someone opens with
   * no project in mind, and taking that away to buy consistency would remove
   * the only entry point a first-time user has.
   */
  pinnedRefusal(path: string): string | null {
    if (!INSTANCE.pinned || !INSTANCE.root) return null;
    if (instanceId(path) === INSTANCE.id) return null;
    return `This console is pinned to ${INSTANCE.root} (instance ${INSTANCE.name}). `
      + 'Run `phase-console start` in the other project to open its own console.';
  }

  open(path: string): RootCheck {
    const check = checkRoot(path);
    if (!check.ok) return check;

    this.root = check;
    this.store = new Store(check);
    this.store.scan();
    this.search.rebuild(this.store.list());
    this.boards.clear();
    this.qaModes.clear();
    this.lints.clear();
    this.sessionPlans.clear();
    this.portfolioCache = null;
    invalidate();
    this.generation++;

    this.prefs = rememberRoot(this.prefs, check.path);
    this.watcher.start([check.plansDir, check.handoffsDir]);
    this.armSessionInbox(check.path);
    void this.refreshRepoInfo();
    void this.warm();
    // The convergence loop: the boot pass once the queued re-adoption is done (a
    // queued run must be live before the loop reads it), then the sweep clock.
    this.bootSettled = this.readoptQueued()
      .catch((error) => log.warn('run.readopt-failed', { error }))
      .then(async () => {
        if (!this.convergeAutomatic()) return;
        this.converger.start();
        await this.converger.boot(this.convergeSlugs());
      })
      .catch((error) => log.warn('converge.boot-failed', { error }));
    return check;
  }

  /**
   * Pick up runs that were waiting for a scope when the console went away.
   *
   * The ONE status this is safe for, and the reason `queued` is not in
   * `IN_FLIGHT`: a queued run has spawned nothing, edited nothing and holds no
   * lock — it was a pending promise in a process that no longer exists. There
   * is no half-finished work to reason about, so continuing it is the same act
   * as having started it a moment later, which is what the operator asked for.
   *
   * Anything else stays exactly as `reconcileRun` left it. A run that was
   * mid-phase gets `interrupted` or `parked` and waits for a person, because
   * the thing that makes those unsafe to resume automatically — a session that
   * may still be running, a tree that may be half-edited — is precisely what a
   * queued run does not have.
   */
  private async readoptQueued(): Promise<void> {
    if (!this.flags.allowRun || !this.root?.ok) return;
    for (const record of this.store?.list() ?? []) {
      const state = latestRun(this.root.path, record.slug, this.liveRunIds());
      // A `require` MCP park outlives the console that parked it: its clock
      // re-arms here for the remainder, or fires at once when it is overdue.
      if (state) this.armMcpRequireTimersFor(state);
      if (state?.status === 'queued') {
        try {
          log.info('run.readopt-queued', { slug: record.slug, runId: state.id });
          await this.startRun(record.slug, {
            resumeRunId: state.id,
            // Resume clears a scope it is not handed, and an omitted skills list
            // would let machine defaults overwrite the run's sticky one — the
            // same passthrough retryPhase makes, for the same reason.
            ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
            skills: state.skills ?? [],
          });
        } catch (error) {
          log.warn('run.readopt-failed', { slug: record.slug, runId: state.id, error });
        }
        continue;
      }
      // The second readoptable shape: a run reconciled off a wait
      // (`reconcileRun` turned waiting→paused, keeping `waitUntil`). Two wait
      // kinds share that clock — the usage window, and a park on external
      // work some phase declared — and phase records tell them apart: a
      // `waiting` record exists only for the park. A park is always re-armed
      // (it is not a limit, so `onLimit: 'pause'` does not speak for it); a
      // limit honors the run's own policy.
      if (state?.status === 'paused' && state.waitUntil) {
        const parked = Object.values(state.phases).some((r) => r.status === 'waiting');
        if (parked || (state.onLimit ?? 'wait') !== 'pause') {
          this.armLimitResume(record.slug, state);
          continue;
        }
      }
      // The third readoptable shape: a run that halted — or was interrupted by
      // the very crash this boot is recovering from — with auto-recovery on.
      // The attempts counter was bumped at every launch and persisted, so the
      // relaunch is bounded by whatever the budget still allows; everything
      // else is re-checked by `maybeAutoRecover` when the timer fires.
      // A verification-preflight park rides the same door: it is the one
      // parked shape whose halt names a machine-clearable kind.
      if (state && state.autoRecover
        && (state.status === 'halted' || state.status === 'interrupted'
          || (state.status === 'parked' && state.halt?.kind === 'verification-preflight'))) {
        this.scheduleAutoRecover(record.slug);
      }
    }
  }

  /** One armed clock per plan: the newest reset time wins, restarts survive. */
  private limitResumeTimers = new Map<string, NodeJS.Timeout>();

  /**
   * A stop asks the convergence loop for a pass a minute out, per plan.
   *
   * The delay is the point, not an implementation detail: the halt event fires
   * while the run is still draining its lanes, the operator may be watching
   * and about to act themselves, and a console that spawns an agent the same
   * second something breaks is a console nobody can get ahead of. When the
   * pass runs it re-reads everything — the run may have been continued,
   * stopped or fixed by hand in the meantime, and every one of those wins.
   * (The healer this used to arm directly, `maybeAutoRecover`, is now the
   * loop's `heal` step; `converge.ts` has the trigger matrix.)
   */
  private scheduleAutoRecover(slug: string, delayMs = HALT_DELAY_MS): void {
    if (!this.convergeAutomatic()) return;
    this.converger.request(slug, 'halt', delayMs);
  }

  /**
   * May the loop run without being asked? The capability that makes any of it
   * real (`--allow-run`), and the switch (`--no-converge`, or a harness that
   * never set it). The operator's press is not gated here.
   */
  private convergeAutomatic(): boolean {
    return this.flags.converge === true && this.flags.allowRun;
  }

  private armLimitResume(slug: string, state: RunState): void {
    const at = Date.parse(state.waitUntil ?? '');
    if (!Number.isFinite(at)) return;
    const delay = at - Date.now();
    // Whatever clock the run recorded is honoured. The 12-hour ceiling that
    // used to live here belonged to the runner's old verdict — "a reset half
    // a day out is a recovery card for a person" — and the runner now makes
    // that call itself: it switches accounts when one can pay and otherwise
    // WAITS with the errand on the run, so a weekly window recorded as
    // `waitUntil` must re-arm, or the restart turns a self-resuming run into
    // one waiting for a person. Only a delay `setTimeout` cannot hold (24.8
    // days) is left to the next boot.
    if (delay > MAX_TIMER_MS) return;
    const existing = this.limitResumeTimers.get(slug);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void this.resumeLimitPaused(slug, state.id); }, Math.max(0, delay));
    timer.unref?.();
    this.limitResumeTimers.set(slug, timer);
    log.info('run.rearmed-wait', { slug, runId: state.id, until: state.waitUntil });
  }

  private async resumeLimitPaused(slug: string, runId: string): Promise<void> {
    this.limitResumeTimers.delete(slug);
    if (!this.flags.allowRun || !this.root?.ok) return;
    // Re-read before acting: the operator may have continued it by hand,
    // stopped it, or started something else in the hours this timer slept.
    const state = latestRun(this.root.path, slug, this.liveRunIds());
    // `paused` is the reconciled shape; `waiting` is the same run read off a
    // console that never restarted (the pooled state was never reconciled).
    // Both mean "resume me at the clock".
    if (!state || state.id !== runId || !state.waitUntil) return;
    if (state.status !== 'paused' && state.status !== 'waiting') return;
    if (this.liveRunner(slug)) return;
    try {
      log.info('run.limit-resume', { slug, runId });
      await this.startRun(slug, {
        resumeRunId: runId,
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
      });
    } catch (error) {
      log.warn('run.limit-resume-failed', { slug, runId, error });
    }
  }

  close(): void {
    this.accounts.stop();
    if (this.accountsEmitTimer) clearTimeout(this.accountsEmitTimer);
    for (const timer of this.limitResumeTimers.values()) clearTimeout(timer);
    this.limitResumeTimers.clear();
    for (const timer of this.mcpRequireTimers.values()) clearTimeout(timer);
    this.mcpRequireTimers.clear();
    this.converger.close();
    this.watcher.stop();
    this.disarmSessionInbox();
    this.sessions.close();
    // Nothing is admitted after this point, and every pending admission is
    // rejected rather than left holding a promise nobody will settle.
    this.scheduler.close();
    // Every pty is a child process of this one. Leaving them behind would leave
    // orphaned login shells holding the source directory open.
    this.terminals.close();
    // Read markers and delivery outcomes are collapsed behind a debounce; this
    // is the one moment they would otherwise be lost.
    this.notifications.flush();
  }

  /* ---------------------------------------------------------------- *
   * The inbox
   * ---------------------------------------------------------------- */

  /**
   * History, plus the two facts that explain a notification you never got.
   *
   * `devices` being empty means nothing can arrive out of band no matter how
   * many categories are on, and `outOfBand` being unconfigured means the same
   * for a machine with no browser at all. Both were previously discoverable
   * only by reading source.
   */
  inbox(query: NotificationQuery = {}) {
    return {
      ...this.notifications.list(query),
      categories: CATEGORIES,
      devices: this.push.list().length,
      outOfBand: { configured: Boolean(process.env.PHASE_CONSOLE_NOTIFY) },
    };
  }

  /* ---------------------------------------------------------------- *
   * Restarting the console from the console
   * ---------------------------------------------------------------- */

  /**
   * Everything the button needs to render itself honestly, before it is
   * pressed. Two independent reasons it may refuse, and they read differently:
   * a run in flight is "not now", an unsupervised process is "not from here".
   */
  restartReadiness(): {
    ok: boolean; reason?: string; supervisor: ReturnType<typeof supervisor>;
    busy: boolean; run: { slug: string; status: string; phase?: number } | null;
    sessions: ReturnType<Service['sessionInventory']>;
  } {
    // Restart has always killed every pty — `shutdown()` calls `service.close()`
    // — and has never said so. The inventory rides along so its dialog can.
    const sessions = this.sessionInventory();
    // Every busy plan, not "the" one: a restart aborts all of them, and a
    // dialog that named one while three were running would understate what
    // pressing it costs by two.
    const running = this.runStates();
    const state = running[0] ?? null;
    // `hasShutdownWork()` is the real test rather than a status on disk: the
    // runner registers its handler exactly while it is driving, and drops it
    // the moment the loop returns. A `running` row left by a killed process
    // does not register anything, and must not block a restart forever.
    const busy = hasShutdownWork();
    const supervision = supervisor();
    if (busy) {
      return {
        ok: false,
        reason: running.length > 1
          ? `${running.length} plans are mid-run (${running.map((r) => `${r.slug} ${r.status}`).join(', ')}) `
            + '— restarting would abort every session they are driving and expire every card they are '
            + 'waiting on, unanswerably'
          : state
            ? `${state.slug} is mid-run (${state.status}) — restarting would abort the session it is driving `
              + 'and expire every card it is waiting on, unanswerably'
            : 'a run is checkpointing — restarting now would cut it in half',
        supervisor: supervision, busy, run: state ? { slug: state.slug, status: state.status } : null,
        sessions,
      };
    }
    if (!supervision.supervised) {
      return {
        ok: false,
        reason: `${supervision.detail}. Stopping it here would leave nothing serving this page — `
          + 'start it again from a terminal, or install it as an agent (deploy/agent.sh install).',
        supervisor: supervision, busy, run: null, sessions,
      };
    }
    return { ok: true, supervisor: supervision, busy, run: null, sessions };
  }

  /* ---------------------------------------------------------------- *
   * Stopping the console from the console
   * ---------------------------------------------------------------- */

  /**
   * What pressing Shut down will actually stop — everything the confirm dialog
   * needs to be an inventory rather than a warning.
   *
   * Unlike `restartReadiness()` this never refuses. A restart while a run is
   * driving is a mistake (it aborts the child and expires its cards
   * unanswerably); a *shutdown* while a run is driving is a decision — the
   * runner checkpoints on the way out and the run resumes when the console
   * comes back. Refusing to turn something off because it is busy is how you
   * get a machine with no off switch, which is the bug this is fixing.
   */
  shutdownReadiness(): {
    supervisor: ReturnType<typeof supervisor>;
    stop: ReturnType<typeof stopPlan>;
    busy: boolean;
    run: { slug: string; status: string } | null;
    sessions: ReturnType<Service['sessionInventory']>;
    restartHint: string;
  } {
    const state = this.runStates()[0] ?? null;
    const supervision = supervisor();
    const stop = stopPlan(supervision);
    return {
      supervisor: supervision,
      stop,
      busy: hasShutdownWork(),
      run: state ? { slug: state.slug, status: state.status } : null,
      sessions: this.sessionInventory(),
      // Where a person has to go to get it back. Under launchd the job is
      // unloaded, so the page they are looking at is about to be the last thing
      // this console says to them.
      restartHint: stop.via === 'launchctl'
        ? `launchctl kickstart -k gui/$(id -u)/${stop.label} — or reinstall it with viewer/run --install-agent`
        : stop.via === 'systemctl'
          ? `systemctl --user start ${stop.label} — or reinstall it with phase-console --install-agent`
          : 'start it again with `bash <skill>/start` (or viewer/run)',
    };
  }

  /**
   * Stop this console and everything it owns.
   *
   * The order is the same as any other exit — `shutdown()` in `index.ts` closes
   * the server, calls `service.close()` (which kills every pty), then drains the
   * registered handlers so a run checkpoints. What differs is that under launchd
   * the job is unloaded first, so nothing brings it back.
   */
  shutdown(by: string): { ok: boolean; reason?: string; stop?: ReturnType<typeof stopPlan> } {
    const readiness = this.shutdownReadiness();
    log.warn('shutdown.requested', {
      by, supervisor: readiness.supervisor.kind, via: readiness.stop.via,
      sessions: readiness.sessions.live, busy: readiness.busy,
    });
    // Announced before it happens, because afterwards there is nothing here to
    // announce anything — and a push that arrives on a phone is the only record
    // an operator elsewhere will get that the console went down on purpose.
    this.announce('health', {
      title: 'Phase Console is shutting down',
      body: `asked for by ${by} · ${readiness.stop.detail}`,
      tag: tagFor('health', 'shutdown', String(Date.now())),
    });
    if (!requestShutdown(`shutdown (${by})`)) {
      return { ok: false, reason: 'this build has no shutdown verb registered — stop it by hand' };
    }
    return { ok: true, stop: readiness.stop };
  }

  /**
   * Exit cleanly and let the supervisor bring it back.
   *
   * There is no other way to load new server code: Node reads `server/` once,
   * at startup, so a fix on disk is invisible to the running process however
   * many times the page is reloaded. That is what the stale banner has always
   * said and what it has never been able to do anything about.
   *
   * `force` skips only the supervision check — never the in-flight one. A
   * restart that aborts a live child and expires its cards unanswerably is not
   * something a flag should be able to talk you into.
   */
  restart(by: string, force = false): { ok: boolean; reason?: string; supervisor?: ReturnType<typeof supervisor> } {
    const readiness = this.restartReadiness();
    if (!readiness.ok && (readiness.busy || !force)) {
      return { ok: false, reason: readiness.reason, supervisor: readiness.supervisor };
    }
    log.warn('restart.requested', { by, supervisor: readiness.supervisor.kind, force });
    this.announce('health', {
      title: 'Phase Console is restarting',
      body: `asked for by ${by} · ${readiness.supervisor.detail}`,
      tag: tagFor('health', 'restart', String(Date.now())),
    });
    if (!requestRestart(`restart (${by})`)) {
      return { ok: false, reason: 'this build has no restart verb registered — restart it by hand' };
    }
    return { ok: true, supervisor: readiness.supervisor };
  }

  markNotificationsRead(ids?: string[] | null): { changed: number; unread: number } {
    const changed = this.notifications.markRead(ids);
    if (changed) this.emit('notification:read', { ids: ids ?? null, unread: this.notifications.unread() });
    return { changed, unread: this.notifications.unread() };
  }

  /**
   * Mark read only what a scope matches — the verb behind auto-read-on-view.
   *
   * The event carries `ids: null` like the bulk read does; a client that has
   * the inbox open refetches rather than trying to patch a list it cannot know
   * the shape of.
   */
  markNotificationsReadFor(
    scope: { slug?: string; category?: string; runId?: string; sessionId?: string; phase?: number },
  ): { changed: number; unread: number } {
    const changed = this.notifications.markReadWhere(scope);
    if (changed) this.emit('notification:read', { ids: null, scope, unread: this.notifications.unread() });
    return { changed, unread: this.notifications.unread() };
  }

  clearNotifications(what: 'all' | 'read' | { id: string }): { removed: number; unread: number } {
    const removed = this.notifications.clear(what);
    if (removed) this.emit('notification:cleared', { removed, unread: this.notifications.unread() });
    return { removed, unread: this.notifications.unread() };
  }

  private async refreshRepoInfo(): Promise<void> {
    if (!this.root) return;
    this.repo = await repoInfo(this.root.path, this.root.docsDir);
  }

  /** Pre-compute every board so the first list render is instant. */
  private async warm(): Promise<void> {
    const slugs = this.store?.list().map((r) => r.slug) ?? [];
    await Promise.all(slugs.map((slug) => this.board(slug).catch(() => undefined)));
    this.emit('warm', { plans: slugs.length });
  }

  /* ---------------------------------------------------------------- *
   * Live updates
   * ---------------------------------------------------------------- */

  onEvent(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Events a reconnecting client missed. Browsers resend `Last-Event-ID`
   * automatically, so a dropped SSE connection no longer loses updates — which
   * stops mattering only as long as nothing important flows through here, and
   * run progress will.
   */
  eventsSince(id: number): LiveEvent[] {
    return this.eventLog.filter((entry) => entry.id > id);
  }

  emit(event: string, data: unknown): void {
    const id = ++this.eventCursor;
    this.eventLog.push({ id, event, data });
    if (this.eventLog.length > EVENT_BUFFER) this.eventLog.shift();
    for (const listener of this.listeners) {
      try { listener(event, data, id); } catch { /* a dead client must not stop the others */ }
    }
    this.nudgeInbox(event);
  }

  /**
   * Tell the client its attention inbox may have changed — at most once a beat.
   *
   * The inbox is computed on read from a dozen sources, so it has no single
   * event of its own: an approval, a park, a lock, a sign-in and a health
   * flip all change it. Rather than teach each of them, anything that could
   * change it schedules ONE `inbox` tick, which the client answers with a
   * single fetch. Debounced because a boarding run emits a burst and an inbox
   * that refetched per event would be the noisiest thing on the wire.
   */
  private nudgeInbox(event: string): void {
    if (event === 'inbox' || !INBOX_SOURCES.some((prefix) => event.startsWith(prefix))) return;
    if (this.inboxTimer) return;
    this.inboxTimer = setTimeout(() => {
      this.inboxTimer = null;
      this.emit('inbox', { at: new Date().toISOString() });
    }, 400);
    this.inboxTimer.unref?.();
  }

  /**
   * Everything the runner emits, plus the two moments worth waking someone for.
   *
   * A run that halts at 2am and a run that finishes are the only states where
   * nothing further happens until a person acts, so they are the only ones that
   * earn an out-of-band notification. Announcing every phase would train the
   * habit of ignoring them, which costs exactly the halt that mattered.
   */
  private onRunnerEvent(event: string, data: unknown): void {
    this.emit(event, data);
    if (event === 'run:phase') {
      // A `require` MCP park starts its clock here — the service owns the
      // timer because only the service can restart a run the park stopped.
      const parked = data as { slug?: string; runId?: string; phase?: number; mcpPark?: { at: string } } | undefined;
      if (parked?.slug && parked.runId && typeof parked.phase === 'number' && parked.mcpPark?.at) {
        const due = mcpParkDueAt(
          { status: 'parked', mcpPark: { at: parked.mcpPark.at, degraded: [] } } as never,
          this.mcpRequireTimeoutMs(),
        );
        if (due !== null) this.armMcpRequireTimer(parked.slug, parked.phase, due);
      }
      this.announcePhase(data);
      // `parkWithErrand` puts the errand on this same event; announcing here
      // rather than at the park keeps the one dedupe in one place.
      this.announceErrand(data);
      return;
    }
    if (event === 'run:liveness') { this.announceStall(data); return; }
    if (event !== 'run:run') return;

    const state = (data as { state?: RunState } | undefined)?.state;
    if (!state) return;
    // A halt that DISSOLVED retracts its urgent card. Reconcile closing the
    // records, a continue, a recovery — whatever moved the run past the halt
    // makes the earlier "halted" notification stale, and 5 of 9 real urgent
    // halts were superseded within 60 seconds. Before the dedupe check on
    // purpose: the retraction must fire exactly when the status changes.
    if (!state.halt && this.notifiedRun.get(state.id) === 'halted') {
      this.retractHalt(state, 'the board moved past the halt', { push: false });
    }
    // A stop is also the convergence trigger — a pass a minute out, decided
    // entirely by the loop when it runs: the run may have been continued,
    // fixed by hand or opted out by then. Every stopped shape, not only the
    // halted and verification-parked ones — the loop reads the situation and
    // leaves alone what it must (an operator's stop, a resolved run).
    if (state.status === 'halted' || state.status === 'parked' || state.status === 'interrupted') {
      this.scheduleAutoRecover(state.slug);
    }
    // Dedupe on the run *and* its status. Keying on the run alone — which this
    // did — meant a run announced once as parked could later halt, or finish,
    // in silence.
    // Per RUN, not one slot for the console. With two runs live, a single slot
    // makes each announcement erase the other's memory of itself — so the same
    // halt is announced again on the next event, and again, for as long as its
    // neighbour keeps persisting.
    if (this.notifiedRun.get(state.id) === state.status) return;

    const push = (category: 'halted' | 'parked' | 'finished', title: string, body: string) => {
      this.notifiedRun.set(state.id, state.status);
      this.announce(category, {
        title, body, tag: tagFor('run', state.id, state.status),
      }, { slug: state.slug, runId: state.id });
    };

    switch (state.status) {
      case 'halted':
        push('halted', `${state.slug} halted`, state.halt?.reason ?? 'the run stopped and needs a person');
        break;
      case 'interrupted':
        // Nothing is driving it and nothing said why — the failure mode that
        // otherwise looks exactly like a run still working.
        push('halted', `${state.slug} interrupted`, 'nothing is driving this run any more');
        break;
      case 'parked':
        push('parked', `${state.slug} parked`, state.halt?.reason ?? 'every remaining phase needs a person');
        break;
      case 'waiting': {
        const parked = Object.values(state.phases).some((p) => p.status === 'waiting');
        push('parked', `${state.slug} is waiting`,
          parked
            ? state.finishedReason ?? 'waiting on external work; resumes on its own'
            : 'asleep until a usage window reopens');
        // A run that ended its loop waiting re-arms its own resume — the same
        // clock machinery as the usage-window sleep. Armed unconditionally
        // (this emit can fire while the loop is still tearing down);
        // `resumeLimitPaused` re-checks liveness and status when it fires.
        if (state.waitUntil) this.armLimitResume(state.slug, state);
        break;
      }
      case 'finished': {
        const done = Object.values(state.phases).filter((p) => p.status === 'done').length;
        push('finished', `${state.slug} finished`,
          `${done} phase(s) done · $${state.spentUsd.toFixed(2)} spent`);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Stand a stale "halted" notification down: its subject dissolved.
   *
   * The inbox half annotates (`resolved` + read) — never deletes. The push
   * half sends ONE quiet corrective riding the SAME tag, so the service
   * worker replaces the displayed alarm and an undelivered pending push is
   * superseded by web-push topic — and only when a changed record is younger
   * than 30 minutes (older history must not buzz anew). No new inbox record:
   * a correction annotates, it does not add. `notifiedRun` is cleared so the
   * next REAL halt announces fresh.
   */
  private retractHalt(state: RunState, reason: string, opts: { push: boolean }): void {
    const changed = this.notifications.resolveWhere({ runId: state.id, category: 'halted' }, reason);
    this.notifiedRun.delete(state.id);
    if (!changed.length) return;
    for (const record of changed) this.emit('notification', record);
    const young = changed.some((record) => Date.now() - Date.parse(record.at) < 30 * 60_000);
    if (opts.push && young) {
      this.push.announce('halted', {
        title: `${state.slug}: resolved on its own`,
        body: reason,
        tag: tagFor('run', state.id, 'halted'),
        url: routeFor('halted', { slug: state.slug, runId: state.id }),
      }, Date.now(), undefined, { urgent: false });
    }
    log.info('run.halt-retracted', { slug: state.slug, runId: state.id, reason, records: changed.length });
  }

  /**
   * Each phase as it lands — and the one that lands on a question.
   *
   * `awaiting-verification` reached neither announcer before: `announcePhase`
   * returned early on anything but `done|failed`, and `announceRun` only ever
   * looks at the run. So the single state where a phase has done its work and
   * stopped dead on a check nobody but a person can make was the one state that
   * told nobody. It is not a failure and not a success, so it gets its own
   * category rather than being smuggled into either.
   */
  /**
   * The one ask for a person the ladder leaves behind, pushed once.
   *
   * This is the gap the 2.3.0 ladder shipped with: a phase would exhaust its
   * rungs, park with a perfectly good `Errand {need, how, tried}`, and the
   * operator would find out by opening the console. The errand was written to
   * the record, journalled and rendered — and never pushed. A ladder whose
   * whole promise is "a person is asked once, with an errand" has to do the
   * asking.
   *
   * `needs-you` and not `phase`: this is not progress, it is a request. The
   * category is the one an operator keeps on when they have turned the rest
   * off.
   */
  private announceErrand(data: unknown): void {
    const event = data as {
      slug?: string; runId?: string; phase?: number;
      errand?: { at?: string; need?: string; how?: string; tried?: string[]; situation?: string };
    } | undefined;
    const { slug, runId, phase, errand } = event ?? {};
    if (!slug || typeof phase !== 'number' || !errand?.need) return;

    const key = `${runId ?? slug}:${phase}:${errand.at ?? ''}`;
    if (this.notifiedErrand.has(key)) return;
    this.notifiedErrand.add(key);
    // The set is per-process and unbounded only in theory; a console that ran
    // long enough to matter has restarted for other reasons first. Trimmed all
    // the same, oldest-first, so a very long-lived instance cannot grow it.
    if (this.notifiedErrand.size > 500) {
      const oldest = this.notifiedErrand.values().next().value;
      if (oldest) this.notifiedErrand.delete(oldest);
    }

    const title = this.store?.get(slug)?.plan?.phases[phase]?.title;
    this.announce('needs-you', {
      title: `${slug} · phase ${phase} needs you`,
      body: errand.need.slice(0, 200),
      // The how is the actionable half; a push that says only "it is stuck"
      // makes the operator open the console to learn what to do.
      ...(errand.how ? { detail: `${errand.how}${title ? ` — ${title}` : ''}`.slice(0, 400) } : {}),
      tag: tagFor('needs-you', slug, phase),
    }, { slug, phase, ...(runId ? { runId } : {}) });
  }

  /**
   * A lane that is still running and has stopped being work.
   *
   * Deliberately NOT urgent (`push/catalogue.ts`): nothing is blocked on the
   * operator and the run has not stopped — this is the money question, not the
   * permission question, and a card that buzzed a wrist for it would be turned
   * off inside a week, taking the signal with it.
   *
   * Fires only on a transition, because the runner only emits a stall on one:
   * the ticker evaluates every lane every minute and journals nothing when the
   * answer has not changed. The dedupe here is the belt — a console restarted
   * mid-episode has an empty map and will say it once more, which is right.
   */
  private announceStall(data: unknown): void {
    const event = data as {
      slug?: string; runId?: string; phase?: number; attempt?: number;
      stall?: { signal?: string; detail?: string } | null;
    } | undefined;
    const { slug, runId, phase, stall } = event ?? {};
    if (!slug || typeof phase !== 'number' || !stall?.signal) return;

    const key = `${runId ?? ''}:${phase}:${stall.signal}:${event?.attempt ?? 0}`;
    if (this.notifiedStall.has(key)) return;
    this.notifiedStall.add(key);
    // The same bound the errand set keeps, for the same reason: a set that only
    // ever grows is a leak in a console that runs for weeks.
    if (this.notifiedStall.size > 500) {
      const oldest = this.notifiedStall.values().next().value;
      if (oldest) this.notifiedStall.delete(oldest);
    }

    const meta = STALL_SIGNAL_META[stall.signal as keyof typeof STALL_SIGNAL_META];
    const title = this.store?.get(slug)?.plan?.phases[phase]?.title;
    this.announce('stalled', {
      title: `${slug} · phase ${phase} — ${meta?.label.toLowerCase() ?? stall.signal}`,
      body: stall.detail ?? meta?.blurb ?? 'the session has stopped producing work',
      ...(title ? { detail: title.slice(0, 200) } : {}),
      tag: tagFor('stalled', slug, phase, stall.signal),
    }, { slug, phase, ...(runId ? { runId } : {}) });
  }

  private announcePhase(data: unknown): void {
    const event = data as { slug?: string; phase?: number; status?: string; notRun?: number } | undefined;
    const { slug, phase, status } = event ?? {};
    if (!slug || typeof phase !== 'number') return;
    if (status !== 'done' && status !== 'failed' && status !== 'awaiting-verification') return;

    const key = `${slug}:${phase}`;
    if (this.notifiedPhase.get(key) === status) return;
    this.notifiedPhase.set(key, status);

    const title = this.store?.get(slug)?.plan?.phases[phase]?.title;
    if (status === 'awaiting-verification') {
      const checks = Number(event?.notRun) || 0;
      this.announce('needs-you', {
        title: `${slug} · phase ${phase} needs you`,
        body: checks
          ? `${checks} check${checks === 1 ? '' : 's'} the runner will not make for you — ${title ?? 'the phase is waiting'}`
          : `${title ?? 'the phase'} is waiting to be verified`,
        tag: tagFor('needs-you', slug, phase),
      }, { slug, phase });
      return;
    }

    this.announce('phase', {
      title: `${slug} · phase ${phase} ${status}`,
      body: title ?? (status === 'done' ? 'the phase landed' : 'the phase did not land'),
      tag: tagFor('phase', slug, phase, status),
    }, { slug, phase });
  }

  /**
   * Drop every cached answer about one plan.
   *
   * Shared by the watcher and by `reread()`, because "the files changed" and
   * "something we cannot see changed the files" have to forget exactly the
   * same things — a caller that forgets one map serves a stale board from it
   * forever, and the revision key hides the mistake.
   */
  private forget(slug: string): void {
    invalidate(slug);
    this.boards.delete(slug);
    this.qaModes.delete(slug);
    this.lints.delete(slug);
    for (const key of [...this.sessionPlans.keys()]) if (key.startsWith(`${slug}::`)) this.sessionPlans.delete(key);
    const record = this.store?.get(slug);
    if (record) this.search.update(record);
  }

  /**
   * Re-read one plan from disk right now, without waiting for the watcher.
   *
   * The watcher is debounced and a session's last commit lands milliseconds
   * before its process exits, so "check what the recovery achieved" cannot
   * trust the cache. Emits `changed` (so open pages re-render) but deliberately
   * does NOT announce it: a re-read the console asked for is not news, and the
   * outcome notification is sent separately with something to say.
   */
  private reread(slug: string): void {
    const record = this.store?.get(slug);
    if (this.store && record?.planPath) this.store.refresh([record.planPath]);
    this.forget(slug);
    this.portfolioCache = null;
    this.generation++;
    this.emit('changed', { slugs: [slug], generation: this.generation });
  }

  private onChange(paths: string[]): void {
    if (!this.store) return;
    const slugs = this.store.refresh(paths);
    for (const slug of slugs) this.forget(slug);
    this.portfolioCache = null;
    this.generation++;
    void this.refreshRepoInfo();
    this.emit('changed', { slugs, generation: this.generation });

    // The watcher is the one place external actors become visible, so both
    // consumers that used to be blind to them are poked here. The scheduler:
    // lock churn lives under docs/handoffs/**/.locks, and a foreign release
    // is exactly the admission the queue may be waiting on. The live loops:
    // a handoff written by a manual session used to go unseen until a lane
    // settled — hours, on a one-lane run.
    if (paths.some((p) => p.includes('/.locks/'))) this.scheduler.poll();
    for (const slug of slugs) this.runners.get(slug)?.noteDocsChanged();
    // …and the convergence loop, debounced: a handoff written by hand, a lock
    // released, a plan edited — any of them may be what a stopped run waited on.
    if (this.convergeAutomatic()) for (const slug of slugs) this.converger.request(slug, 'change');

    if (!slugs.length) return;
    this.announce('changed', {
      title: 'Plans changed',
      body: slugs.length === 1 ? `${slugs[0]} was written` : `${slugs.length} plans were written`,
      tag: tagFor('changed', ...slugs),
      // One plan lands on that plan; several have nowhere better than the list.
    }, slugs.length === 1 ? { slug: slugs[0] } : {});
    void this.announceReady(slugs);
  }

  /**
   * A phase that became startable because what it was waiting on finished.
   *
   * Worth its own category because it is the one notification that is not about
   * a run: it fires just as readily for work you finished yourself in a
   * terminal, which is exactly when nothing else would tell you the graph moved.
   *
   * The first pass after a restart only takes a snapshot. Everything looks new
   * to a console that has just started, and announcing all of it would be a
   * notification per ready phase in the library.
   */
  private async announceReady(slugs: string[]): Promise<void> {
    if (!this.store) return;
    try {
      const boards = await Promise.all(
        this.store.list().map(async (r) => [r.slug, await this.board(r.slug).catch(() => null)] as const),
      );
      const now = new Set<string>();
      for (const [slug, board] of boards) {
        for (const phase of board?.ready ?? []) now.add(`${slug}:${phase}`);
      }

      const before = this.readySnapshot;
      this.readySnapshot = now;
      if (!before) return;

      // Only phases in plans that actually changed — a board recomputed for an
      // unrelated reason is not news. And never a closed plan: the announce gate
      // cannot catch the many-phases case, which carries no slug at all, so a
      // closed plan would still be counted into "4 phases became ready".
      const touched = new Set(slugs);
      const fresh = [...now].filter((key) => {
        const [slug] = key.split(':');
        return !before.has(key) && touched.has(slug) && !this.isClosedPlan(slug);
      });
      if (!fresh.length) return;

      const [first] = fresh;
      const [slug, phase] = first.split(':');
      this.announce('ready', {
        title: fresh.length === 1 ? `${slug} · phase ${phase} is ready` : `${fresh.length} phases became ready`,
        body: fresh.length === 1
          ? (this.store.get(slug)?.plan?.phases[Number(phase)]?.title ?? 'nothing is blocking it now')
          : fresh.join(', '),
        tag: tagFor('ready', ...fresh),
      }, fresh.length === 1 ? { slug, phase: Number(phase) } : {});
    } catch (error) {
      log.warn('push.ready-failed', { error });
    }
  }

  /* ---------------------------------------------------------------- *
   * Stale claims
   * ---------------------------------------------------------------- */

  /**
   * Release a claim, using the owner the lock file already records.
   *
   * The console has always *had* this verb — `writes.ts` `lock-release` — and
   * has never been able to offer it usefully, because `phase-lock.sh release`
   * refuses unless `--owner` matches, and the only place that owner was written
   * down was the lock file the operator could not see. So the UI asked a person
   * to retype `sam.doe@example.com/opus-p2` from a dashboard card that did
   * not show it, and offered "Claim phase" instead — which takes the phase
   * rather than freeing it.
   *
   * Reading the owner from the file closes that, and it is not a weakening of
   * the check: the owner still has to match at release time, so a phase
   * re-claimed between the read and the write fails exactly as it should.
   *
   * A live lease is refused unless `force` is set. A lease that has not run out
   * is someone working, and no card on this dashboard is worth interrupting
   * them for — but a live claim now BLOCKS a run, so refusing with no way past
   * it would strand an operator whose holder is a session that died without
   * releasing. `force` is that way past, and it is never a default: the caller
   * confirms it explicitly, and the audit line below records that it was used.
   */
  async releaseLock(slug: string, phase: number, force = false): Promise<LockRelease> {
    if (!this.flags.allowWrites) throw new Error('Writes are disabled. Restart with --allow-writes to enable them.');
    const handoffsDir = this.root?.handoffsDir;

    // Already gone is a success, not an error — including a source with no
    // handoff folder at all, which cannot be holding a claim. On a bulk release
    // two clients can both be right about a lock only one of them removed.
    const lock = handoffsDir ? readLock(handoffsDir, slug, phase) : null;
    if (!lock) return { slug, phase, ok: true, owner: null, detail: 'already free' };
    if (!lock.expired && !force) {
      return {
        slug,
        phase,
        ok: false,
        owner: lock.owner,
        detail: `${lock.owner} is still working this phase — the lease runs until `
          + `${lock.leaseUntil ? new Date(lock.leaseUntil).toISOString() : 'an unrecorded time'}. `
          + 'Stop that session, or release it from a terminal with --force.',
      };
    }

    const outcome = await runWrite(
      planWrite(
        { action: 'lock-release', slug, phase, owner: lock.owner, ...(force ? { force: true } : {}) },
        { root: this.root!.path },
      ),
      { scriptsDir: this.flags.scriptsDir, root: this.root!.path },
    );
    // Every release is audited. A claim vanishing with no record of who removed
    // it is indistinguishable from a lock file that was never written — and a
    // FORCED one, taken from a session that had not finished, is the line
    // someone will come looking for.
    log.info('lock.released', {
      slug, phase, owner: lock.owner, ok: outcome.ok, code: outcome.code,
      claimedAt: lock.claimedAt, leaseUntil: lock.leaseUntil,
      ...(force ? { forced: true, wasLive: !lock.expired } : {}),
    });
    if (outcome.ok) this.invalidateAll();
    return {
      slug,
      phase,
      ok: outcome.ok,
      owner: lock.owner,
      detail: (outcome.ok ? outcome.stdout : outcome.stderr).trim() || undefined,
    };
  }

  /**
   * Every expired claim, in one action, reporting each one separately.
   *
   * Serial rather than concurrent on purpose: each release shells out to a
   * script that pulls, removes a file and may sync — and the whole point of the
   * per-lock result is that one failure does not obscure the others.
   */
  async releaseExpiredLocks(): Promise<LockRelease[]> {
    const expired = (this.store?.list() ?? []).flatMap((record) =>
      record.locks.filter((lock) => lock.expired).map((lock) => ({ slug: record.slug, phase: lock.phase })));

    const results: LockRelease[] = [];
    for (const { slug, phase } of expired) {
      try {
        results.push(await this.releaseLock(slug, phase));
      } catch (error) {
        results.push({ slug, phase, ok: false, owner: null, detail: (error as Error).message });
      }
    }
    return results;
  }

  /** Invalidate everything after a write the console itself performed. */
  invalidateAll(): void {
    if (!this.store) return;
    this.store.scan();
    this.search.rebuild(this.store.list());
    this.boards.clear();
    this.qaModes.clear();
    this.lints.clear();
    this.sessionPlans.clear();
    this.portfolioCache = null;
    invalidate();
    this.generation++;
    this.emit('changed', { slugs: this.store.list().map((r) => r.slug), generation: this.generation });
  }

  /* ---------------------------------------------------------------- *
   * Engine-backed reads (the only source of truth for status)
   * ---------------------------------------------------------------- */

  private engineOpts() {
    return {
      scriptsDir: this.flags.scriptsDir,
      root: this.root!.path,
      // What the engine needs for F15, which it cannot read for itself. Always
      // passed — an empty registry is a real answer and must warn, while an
      // ABSENT one (a bare skill install, with no console) turns the check off.
      mcpServers: this.mcp.enabledIds(),
    };
  }

  private async cached<T>(
    map: Map<string, Cached<T>>, key: string, revision: number, produce: () => Promise<T>,
  ): Promise<T> {
    const hit = map.get(key);
    if (hit && hit.revision === revision) return hit.value;
    const value = await produce();
    map.set(key, { revision, value });
    return value;
  }

  async board(slug: string): Promise<Board> {
    const record = this.store?.get(slug);
    if (!record || !this.root) {
      return readMemoryBlock({ code: 1, stdout: '', stderr: 'no such plan', ms: 0, timedOut: false });
    }
    if (!record.plan?.phased) {
      return { phased: false, states: {}, done: [], inProgress: [], stuck: [], ready: [], waiting: [] };
    }
    return this.cached(this.boards, slug, record.revision, async () =>
      readMemoryBlock(await run(this.engineOpts(), 'phase-graph.sh', [slug, '--memory-block'], { slug, revision: record.revision })));
  }

  async qaMode(slug: string): Promise<QaMode> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return { mode: 'off' };
    return this.cached(this.qaModes, slug, record.revision, async () =>
      readQaMode(await run(this.engineOpts(), 'phase-graph.sh', [slug, '--qa-mode'], { slug, revision: record.revision })));
  }

  async lint(slug: string): Promise<LintResult | null> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return null;
    return this.cached(this.lints, slug, record.revision, async () =>
      readLint(await run(this.engineOpts(), 'validate.sh', [slug], { slug, revision: record.revision })));
  }

  async sessionPlan(slug: string, model?: string): Promise<SessionPlan | null> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return null;
    const alias = model || record.plan.sessionBudget.targetModel || '';
    return this.cached(this.sessionPlans, `${slug}::${alias}`, record.revision, async () =>
      readSessionPlan(await run(
        this.engineOpts(), 'phase-graph.sh',
        alias ? [slug, '--session-plan', alias] : [slug, '--session-plan'],
        { slug, revision: record.revision },
      )));
  }

  async boardText(slug: string): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readBoardText(await run(this.engineOpts(), 'phase-graph.sh', [slug], { slug, revision: record.revision }));
  }

  /** The boot prompt for a phase, copied verbatim from the engine. */
  async bootPrompt(slug: string, phase: number): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readText(await run(
      this.engineOpts(), 'phase-graph.sh', [slug, '--boot-prompt', String(phase)],
      { slug, revision: record.revision },
    ));
  }

  /** The end-of-phase banner: board, batching advice and every ready prompt. */
  async nextPhasePrompt(slug: string, completed: string): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readText(await run(
      this.engineOpts(), 'next-phase-prompt.sh', [slug, completed],
      { slug, revision: record.revision },
    ));
  }

  async gateStatus(slug: string, phase: number) {
    const record = this.store?.get(slug);
    if (!record) return null;
    return readGateStatus(await run(
      this.engineOpts(), 'phase-graph.sh', [slug, '--gate-status', String(phase)],
      { slug, revision: record.revision },
    ));
  }

  /**
   * Approve (or revoke) a phase's gate — the clearance record every gate kind
   * honours (`gate-approve.sh` → docs/handoffs/<slug>/gate-status.md). The
   * verdict is the POSTCONDITION read back from the engine, not the script's
   * exit code, the same shape as activateQa. With `continueRun`, a run that
   * parked on this gate is retried at once — approving from the phase page is
   * one action, not two. Revoking reports the write's own outcome: an auto
   * gate may legitimately still read clear on its own merits afterwards.
   */
  async approveGate(
    slug: string,
    phase: number,
    opts: { approve: boolean; by?: string; note?: string; continueRun?: boolean },
  ): Promise<{ ok: boolean; gate: GateStatus | null; detail: string; resumed?: boolean }> {
    if (!this.flags.allowWrites) {
      return { ok: false, gate: null, detail: 'Writes are disabled. Restart with --allow-writes to enable them.' };
    }
    const record = this.store?.get(slug);
    if (!record || !this.root) return { ok: false, gate: null, detail: `No plan named ${slug}.` };

    let outcome;
    try {
      outcome = await runWrite(
        planWrite(
          { action: 'gate-approve' as const, slug, phase, by: opts.by, reason: opts.note, revoke: !opts.approve },
          { root: this.root.path, docsDir: this.root.docsDir },
        ),
        { scriptsDir: this.flags.scriptsDir, root: this.root.path },
      );
    } catch (error) {
      return { ok: false, gate: null, detail: (error as Error).message };
    }

    this.reread(slug);
    const gate = await this.gateStatus(slug, phase);
    const ok = opts.approve ? Boolean(gate?.clear) : outcome.ok;
    log.info('gate.approve', { slug, phase, approve: opts.approve, ok, by: opts.by, code: outcome.code });
    if (ok) this.invalidateAll();

    let resumed = false;
    if (ok && opts.approve && opts.continueRun) {
      try {
        resumed = Boolean(await this.retryPhase(slug, phase));
      } catch (error) {
        return {
          ok, gate, detail: `Gate approved, but the run did not continue: ${(error as Error).message}`,
        };
      }
    }
    return {
      ok,
      gate,
      ...(resumed ? { resumed } : {}),
      detail: ok
        ? (opts.approve
          ? `Gate approved for ${slug} phase ${phase}${resumed ? ' — the run is continuing' : ''}.`
          : `Gate approval revoked for ${slug} phase ${phase} — the gate is back in force.`)
        : (outcome.stderr || outcome.stdout).trim() || 'The write did not change the gate.',
    };
  }

  async qaPrompt(slug: string, phase: number): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readText(await run(
      this.engineOpts(), 'phase-graph.sh', [slug, '--qa-prompt', String(phase)],
      { slug, revision: record.revision },
    ));
  }

  async memoryBlock(slug: string): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readText(await run(
      this.engineOpts(), 'phase-graph.sh', [slug, '--memory-block'],
      { slug, revision: record.revision },
    ));
  }

  /* ---------------------------------------------------------------- *
   * Composed views
   * ---------------------------------------------------------------- */

  private async context(record: PlanRecord): Promise<PlanContext> {
    const [board, qaMode] = await Promise.all([this.board(record.slug), this.qaMode(record.slug)]);
    // The plan's runs ride along for the record-vs-board check (`healthIssues`
    // `record-ahead-of-board`): a run file is the only place a phase can read
    // done while the board does not.
    const runs = this.root && record.plan?.phased
      ? listRuns(this.root.path, record.slug, this.liveRunIds()).map((run) => ({ id: run.id, status: run.status, phases: run.phases }))
      : [];
    return { record, board, qaMode, runs };
  }

  private toSummary(ctx: PlanContext): PlanSummary {
    const stats = planStats(ctx, this.sizing);
    const issueCounts = { error: 0, warning: 0, info: 0 };
    for (const issue of stats.issues) issueCounts[issue.severity]++;
    // `remainingWork` already excludes done phases by weight; the phase count
    // beside it is only metadata on the estimate, so it is derived rather than
    // recomputed from the graph a second time.
    const eta = etaFrom(this.planRate(stats.slug), {
      weight: stats.remainingWeight,
      phases: Math.max(0, stats.phases - stats.done),
    });
    return {
      ...stats,
      engineError: ctx.board.error,
      issueCounts,
      hasHandoffs: ctx.record.handoffs.length > 0,
      ...(eta ? { eta } : {}),
    };
  }

  async summaries(): Promise<PlanSummary[]> {
    const records = this.store?.list() ?? [];
    const contexts = await Promise.all(records.map((r) => this.context(r)));
    return contexts.map((ctx) => this.toSummary(ctx)).sort((a, b) => b.activity - a.activity);
  }

  async portfolio(): Promise<Portfolio> {
    if (this.portfolioCache?.generation === this.generation) return this.portfolioCache.value;
    const records = this.store?.list() ?? [];
    const contexts = await Promise.all(records.map((r) => this.context(r)));
    // `rateFor([], pool)` and not `rateFor(pool)`: the number IS the pool, so it
    // has to be labelled `portfolio` — reading it as one plan's own evidence
    // would put "(estimate)" under a figure that is an average of everything.
    const value = portfolio(contexts, this.sizing, rateFor([], this.etaPool().all));
    this.portfolioCache = { generation: this.generation, value };
    return value;
  }

  async detail(slug: string, model?: string): Promise<PlanDetail | null> {
    const record = this.store?.get(slug);
    if (!record || !this.root) return null;

    const ctx = await this.context(record);
    const summary = this.toSummary(ctx);
    const plan = record.plan;
    const rows = plan?.graph ?? [];
    const sizes = new Map(rows.map((r) => [r.phase, plan?.phases[r.phase]?.size ?? 'M' as const]));
    const budget = resolveBudget(plan?.sessionBudget.targetModel, this.sizing);
    const index = indexGraph(rows);
    const critical = criticalPath(index, ctx.board, sizes, this.sizing, budget);
    const analyses = analysePhases(rows, ctx.board, sizes, this.sizing, critical.phases);
    const layout = routeLayout(index);

    // One rate for the whole page. The plan total and every phase row are the
    // same reading applied to different weights, so they cannot drift apart —
    // and the `basis` each carries is the same basis, which is what lets the
    // header and a row hedge in the same words.
    const rate = this.planRate(slug);
    const eta = {
      plan: etaFrom(rate, remainingWork(rows, ctx.board, sizes, this.sizing, budget)),
      perPhase: rows.map((row) =>
        phaseEtaFor(row.phase, weightOf(plan?.phases[row.phase]?.size, this.sizing), rate)),
    };

    const [batches, lint, boardText, gitInfo] = await Promise.all([
      this.sessionPlan(slug, model),
      this.lint(slug),
      plan?.phased ? this.boardText(slug) : Promise.resolve(''),
      record.planPath ? lastCommit(this.root.path, record.planPath) : Promise.resolve({}),
    ]);

    // Verification is recorded on a RUN, not on a plan, so the page that says
    // "done" has to go and look for the proof. One scan for the whole detail,
    // not one per phase — and the newest record wins, because a phase that was
    // retried is evidenced by its latest attempt, not its first.
    const latestRecords = new Map<number, { verification?: unknown; status?: string; attempts?: number; verifiedIn?: string; runId?: string }>();
    for (const run of listRuns(this.root.path, slug, this.liveRunId())) {
      for (const [key, rec] of Object.entries(run.phases ?? {})) {
        const n = Number(key);
        if (!Number.isInteger(n) || !rec) continue;
        const prev = latestRecords.get(n);
        const at = rec.endedAt ?? rec.startedAt ?? '';
        if (!prev || at >= ((prev as { at?: string }).at ?? '')) {
          latestRecords.set(n, {
            verification: rec.verification, status: rec.status, attempts: rec.attempts,
            verifiedIn: rec.verifiedIn, runId: run.id, ...({ at } as object),
          });
        }
      }
    }
    const qaModeNow = (await this.qaMode(slug)).mode;

    const phases: PhaseView[] = rows.map((row) => {
      const detail: PhaseDetail | undefined = plan?.phases[row.phase];
      const handoff = handoffFor(record, row.phase);
      const lock = lockFor(record, row.phase);
      const qa = qaFor(record, row.phase);
      const rec = latestRecords.get(row.phase);
      const proof = deriveEvidence({
        phase: row.phase,
        board: ctx.board.states?.[row.phase],
        ...(ctx.board.error ? { boardError: ctx.board.error } : {}),
        // `handoffFor` answers undefined for a phase with no handoff file at
        // all, which is most of a young plan — the missing `?.` here crashed
        // every plan detail that had one.
        handoff: handoff?.exists
          ? { exists: true, status: handoff.status, ...(handoff.outstanding ? { outstanding: handoff.outstanding } : {}) }
          : { exists: false },
        ...(rec?.verification ? { verification: rec.verification as never } : {}),
        qa: { mode: qaModeNow, ...(qa?.result ? { result: qa.result } : {}) },
        ...(rec ? { record: {
          ...(rec.status ? { status: rec.status } : {}),
          ...(rec.attempts != null ? { attempts: rec.attempts } : {}),
          ...(rec.verifiedIn ? { verifiedIn: rec.verifiedIn } : {}),
          ...(rec.runId ? { runId: rec.runId } : {}),
        } } : {}),
      });
      return {
        phase: row.phase,
        title: detail?.title || row.title,
        state: ctx.board.states[row.phase] ?? 'waiting',
        proof,
        size: detail?.size ?? 'M',
        weight: weightOf(detail?.size, this.sizing),
        gated: detail?.gated ?? false,
        gates: detail?.gates,
        gateCheck: detail?.gateCheck,
        gateKind: gateKindOf(detail?.gateCheck, detail?.gated ?? false, this.gateVocab),
        model: detail?.model,
        effort: detail?.effort,
        goal: detail?.goal,
        readFirst: detail?.readFirst,
        files: detail?.files,
        steps: detail?.steps,
        exitCriteria: detail?.exitCriteria,
        verification: detail?.verification,
        mcpServers: detail?.mcpServers,
        handoffMustRecord: detail?.handoffMustRecord,
        bullets: detail?.bullets ?? [],
        row,
        analysis: analyses.find((a) => a.phase === row.phase),
        qa: qa ? { result: qa.result, report: qa.report } : undefined,
        lock: lockView(lock),
        handoff: handoff ? {
          file: handoff.file, status: handoff.status, completed: handoff.completed,
          title: handoff.title, outstanding: handoff.outstanding,
          skillsUsed: handoff.skillsUsed, prompts: handoff.prompts.length,
        } : undefined,
      };
    });

    const memoryKey = plan?.memoryKey ?? `project_${slug}`;
    const memoryEntry = findMemory(memoryKey);

    return {
      summary,
      plan: plan ? {
        slug, title: plan.title, provenance: plan.provenance, context: plan.context,
        architecture: plan.architecture, endToEnd: plan.endToEnd, sessionBudget: plan.sessionBudget,
        graph: plan.graph, callouts: plan.callouts,
        sections: plan.sections.map((s) => ({ title: s.title, body: s.body })),
        path: record.planPath,
      } : null,
      phases,
      route: {
        nodes: layout.map((node) => {
          const detail = plan?.phases[node.phase];
          const nodeLock = lockFor(record, node.phase);
          return {
            phase: node.phase, layer: node.layer, row: node.row,
            state: ctx.board.states[node.phase] ?? 'waiting',
            size: detail?.size ?? 'M',
            gated: detail?.gated ?? false,
            title: detail?.title || rows.find((r) => r.phase === node.phase)?.title || `Phase ${node.phase}`,
            locked: nodeLock ? (nodeLock.expired ? 'stale' as const : 'live' as const) : undefined,
          };
        }),
        edges: rows.flatMap((row) => (index.deps.get(row.phase) ?? []).map((dep) => ({ from: dep, to: row.phase }))),
        layers: layout.reduce((max, n) => Math.max(max, n.layer + 1), 0),
        rows: layout.reduce((max, n) => Math.max(max, n.row + 1), 0),
      },
      batches,
      boardText,
      lint,
      handoffs: record.handoffs.map((h) => ({
        phase: h.phase, file: h.file, title: h.title, status: h.status, completed: h.completed,
        bytes: h.bytes, mtime: h.mtime, prompts: h.prompts.length, skillsUsed: h.skillsUsed,
      })),
      index: record.index,
      eta,
      qa: record.qa,
      locks: record.locks.map((l) => ({ phase: l.phase, ...lockView(l)! })),
      git: { ...gitInfo, dirty: record.planPath ? this.repo.dirty.some((d) => record.planPath!.endsWith(d)) : undefined },
      memory: memoryEntry
        ? { key: memoryKey, path: memoryEntry.path, text: memoryEntry.text, indexLines: memoryIndexLines(memoryKey) }
        : null,
    };
  }

  handoff(slug: string, phase: number) {
    const record = this.store?.get(slug);
    const handoff = record ? handoffFor(record, phase) : undefined;
    if (!handoff) return null;
    return {
      ...handoff,
      frontMatter: handoff.frontMatter.values,
      sections: handoff.sections.map((s) => ({ title: s.title, body: s.body })),
    };
  }

  searchAll(query: string): SearchResult { return this.search.search(query); }

  /**
   * Every skill a phase of this plan could invoke.
   *
   * Read from the Claude home the spawned session will use, not from wherever
   * this file happens to live — the console can be started from any of several
   * homes and the child inherits its environment.
   */
  skills(): SkillInfo[] { return listSkills(this.root?.path); }

  /**
   * The rules an unattended session runs under, and — the part that matters —
   * which layer actually enforces each one.
   *
   * `deny` is evaluated inside the CLI and was measured holding with this
   * console unreachable. `ask` goes through the HTTP hook, and that hook FAILS
   * OPEN: with nothing listening the tool call simply proceeds. Presenting the
   * two as one list would be the most dangerous thing this page could do.
   */
  policy(slug?: string | null) {
    const rules = [
      ...DEFAULT_DENY, ...DEFAULT_ASK, ...DEFAULT_ALLOW,
      ...policyExtras().deny, ...policyExtras().ask, ...policyExtras().allow,
    ];
    return {
      defaults: { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: DEFAULT_ALLOW },
      extra: policyExtras(),
      // The plan's own file, so the editor can show which scope a rule is at
      // rather than presenting one merged list nobody can edit confidently.
      // `path` is where an edit would be WRITTEN (always keyed to this
      // instance); `extra` is what is currently in force, which on a machine
      // that predates instances is still the unkeyed file. They differ exactly
      // once per plan — until the first edit rewrites it to the keyed path.
      plan: slug ? { slug, path: planPolicyPath(slug), extra: policyExtras(effectivePlanPolicyPath(slug)) } : null,
      effective: loadPolicyFor(slug ?? null),
      file: POLICY_PATH,
      profiles: PERMISSION_PROFILES.map((id) => ({ id, label: PROFILE_LABELS[id] })),
      // What the syntax accepts but nothing honours, named rather than left to
      // be discovered at 3am.
      inert: inertRules(loadPolicyFor(slug ?? null)),
      // Which of these this console can enforce itself, and which are the CLI's
      // job — the distinction that decides whether a rule you just wrote will
      // hold at the hook.
      support: [...new Set(rules)]
        .map((rule) => parseRule(rule))
        .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
        .map(({ raw, tool, form, support, note }) => ({ raw, tool, form, support, note })),
      hookTools: HOOK_TOOLS,
      wrappersNotStripped: WRAPPERS_NOT_STRIPPED,
      /** Every tool this console has actually seen a call for. */
      seen: [...this.toolsSeen].sort(),
    };
  }

  addPolicy(rules: { deny?: string[]; ask?: string[] }) {
    addPolicyRules(rules);
    return this.policy();
  }

  /**
   * Add or remove rules at one scope. The widening direction is deliberate —
   * see `editPolicy` — and every call says who asked.
   */
  editPolicy(edit: {
    scope?: PolicyScope;
    slug?: string | null;
    add?: { deny?: string[]; ask?: string[]; allow?: string[] };
    remove?: { deny?: string[]; ask?: string[]; allow?: string[] };
    /** Return these parts to stock at the chosen scope — see `approvals.editPolicy`. */
    reset?: ('deny' | 'ask' | 'allow')[];
    /** Forgive individual strikes against shipped defaults — deny included. */
    restore?: { deny?: string[]; ask?: string[]; allow?: string[] };
    by?: string;
  }) {
    const scope: PolicyScope = edit.scope === 'plan' ? 'plan' : 'global';
    if (scope === 'plan' && !edit.slug) throw new Error('a plan-scoped rule needs a plan');
    const file = scope === 'plan' ? planPolicyPath(edit.slug as string) : POLICY_PATH;
    editPolicy({
      add: edit.add, remove: edit.remove, reset: edit.reset, restore: edit.restore,
      by: edit.by ?? 'console',
    }, file);
    this.journalPolicy(scope, edit);
    return this.policy(edit.slug ?? null);
  }

  /**
   * Answer one card, optionally writing the rule that stops it coming back.
   *
   * The rule is written *before* the decision is settled, so the session's very
   * next call is already classified under it. The other order has a real gap:
   * the session resumes the instant it is answered, and a fast phase can reach
   * the same command before the file lands — which looks exactly like "Always
   * allow didn't work".
   *
   * A rule that will not parse is refused and nothing is written, but the card
   * is still answered: the operator's decision about *this* call stands on its
   * own, and swallowing it because the remembering failed would be the worse
   * half to lose.
   */
  decideApproval(
    id: string,
    decision: 'allow' | 'deny',
    by: string,
    reason: string | undefined,
    remember?: { scope: PolicyScope; rule: string },
  ): { ok: boolean; decision?: string; wrote?: string; scope?: PolicyScope; error?: string } {
    const approval = this.approvals.all().find((entry) => entry.id === id);
    let wrote: string | undefined;
    let failed: string | undefined;

    if (remember?.rule) {
      const rule = remember.rule.trim();
      if (!parseRule(rule)) {
        failed = `"${rule}" is not a rule this syntax accepts — nothing was written`;
      } else if (remember.scope === 'plan' && !approval?.slug) {
        failed = 'this card is not attached to a plan, so it cannot write a plan-scoped rule';
      } else {
        // An allow decision writes an allow rule; a deny writes an ask rule
        // rather than a deny one. Widening from a card is deliberate and
        // reversible; *narrowing* to the wall from a card is not offered at
        // all — `deny` is what holds when this console is dead, and it should
        // take more than a tap to put something there.
        const list = decision === 'allow' ? 'allow' : 'ask';
        this.editPolicy({
          scope: remember.scope,
          slug: approval?.slug ?? null,
          add: { [list]: [rule] },
          by,
        });
        wrote = rule;
      }
    }

    const settled = this.approvals.settle(id, decision, by, reason);
    if (!settled) return { ok: false, error: 'no such pending approval' };
    return {
      ok: true,
      decision,
      ...(wrote ? { wrote, scope: remember?.scope } : {}),
      ...(failed ? { error: failed } : {}),
    };
  }

  /**
   * Write the rule change into the live run's journal.
   *
   * A policy file records what the rules ARE. It cannot record that the run
   * which was interrupted at 02:14 is the reason one of them exists — and that
   * is the question anyone reviewing an unattended run actually asks.
   */
  private journalPolicy(scope: PolicyScope, edit: {
    add?: { deny?: string[]; ask?: string[]; allow?: string[] };
    remove?: { deny?: string[]; ask?: string[]; allow?: string[] };
    by?: string;
  }): void {
    const flatten = (part?: { deny?: string[]; ask?: string[]; allow?: string[] }) => [
      ...(part?.deny ?? []).map((rule) => `deny ${rule}`),
      ...(part?.ask ?? []).map((rule) => `ask ${rule}`),
      ...(part?.allow ?? []).map((rule) => `allow ${rule}`),
    ];
    const added = flatten(edit.add);
    const removed = flatten(edit.remove);
    if (!added.length && !removed.length) return;
    // Every live run's journal. A policy edit changes what each of them is
    // allowed to do from its very next tool call, so recording it in one run's
    // journal and not the others would leave the rest unexplainable.
    for (const runner of this.liveRunners()) {
      runner.note('policy.edited', {
        scope, by: edit.by ?? 'console',
        ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}),
      });
    }
  }

  state() {
    return {
      root: this.root,
      prefs: this.prefs,
      // What the doctor found about this process's own environment (PATH rot,
      // and — appended at runtime — broken push delivery). Additive; the
      // client renders it on the dashboard's console-health block.
      environment: this.environment,
      // Which console this is. The client needs all three: the name for the tab
      // title (two consoles are indistinguishable in a tab strip otherwise),
      // `pinned` to know whether the source picker can do anything, and the id
      // because it is what every message and lifecycle verb identifies it by.
      instance: { id: INSTANCE.id, name: INSTANCE.name, pinned: INSTANCE.pinned },
      allowWrites: this.flags.allowWrites,
      // Present only on a server that has the run endpoints at all. The client
      // is read from disk per request but the server is whatever Node loaded at
      // startup, so upgrading the skill under a running console leaves a new UI
      // talking to an old API. Without something to test, that shows up as a
      // wall of 404s and error toasts instead of "restart me".
      autopilot: true,
      // True once the server files on disk are newer than this process. The
      // browser reloads from disk; this process cannot.
      serverStale: serverIsStale(),
      // Which client this server would serve right now — `dist` once a build
      // exists, else the legacy `web/`. Picked per request, so it can change
      // under a long-lived process; Settings reports it rather than leaving the
      // answer in a startup log written hours ago.
      staticRoot: staticRoot(),
      // Which commit `dist` was built from — the Settings Interface row
      // compares this against the tab's own baked rev to say whether the page
      // someone is looking at is the page this server serves.
      distRev: distRev(),
      // Whether a clean exit comes back. The Restart button is only honest if
      // it knows this before it is pressed — under `./run` there is nothing to
      // restart it, and a button that ends the console is not a Restart button.
      supervisor: supervisor(),
      unread: this.notifications.unread(),
      allowRun: this.flags.allowRun,
      // The shell gate, so the nav can offer a Terminal only where there is one
      // to offer. `/api/terminal` carries the richer answer (whether node-pty
      // actually loaded, and what is open); this is the one bit the shell needs
      // on every page.
      allowTerminal: this.flags.allowTerminal,
      // The agent gate, same shape — the nav-level fact; the richer answer
      // still lives on `/api/terminal` (`agentAllowed` beside `allowed`).
      allowAgent: agentEnabled(this.flags),
      // The account-registration gate. The meters and the account LIST are not
      // behind it — watching your own quota is display — this only decides
      // whether the Add/Sign-in/Remove verbs exist.
      allowAccounts: this.flags.allowAccounts,
      // The MCP-registration gate. The registry LIST, the catalog and the
      // connection statuses are not behind it — seeing what your own sessions
      // connect to is display — this only decides whether Add/Remove/Sign-in exist.
      allowMcp: this.flags.allowMcp,
      // Every live run. The old singular `run` — "the FIRST live run of any
      // plan" — was dropped once the pool made it a lie: with two plans
      // driving, any consumer of it read plan B's run while looking at plan A.
      // Grep found zero readers, and a stale tab is carried over the gap by
      // the console's own reload machinery (`generation`/`serverStale`).
      runs: this.runStates(),
      // What the scheduler is doing, so a header can say "2 of 3 running, 1
      // queued" instead of leaving a queued phase looking like a stalled one.
      concurrency: this.concurrency(),
      scriptsDir: this.flags.scriptsDir,
      // Which hostnames this console answers to besides localhost, and who may
      // arrive through them. Both are on the state rather than only on
      // `/api/tailscale` because the interesting question is a *disagreement*
      // between two places: `tailscale serve` can be publishing this port with
      // no `--remote` flag set (every request 421s), or the flags can name a
      // host nothing is serving (the URL never resolves). Either way the
      // console looks broken from the phone and fine from here, so Settings
      // needs both halves to say which one it is.
      remoteHosts: this.flags.remoteHosts,
      remoteUsers: this.flags.remoteUsers,
      // The port this console is actually on, because the setup commands the
      // Settings card prints embed it. A card that hard-codes 4123 tells
      // somebody on `--port 5000` to publish a port nothing is listening on,
      // and the resulting 502 looks like a Tailscale problem.
      port: this.flags.port,
      // For the same setup cards: which OS this server runs on (the commands
      // differ), and the home dir so absolute paths render as "$HOME/…" —
      // portable to paste, and free of the username in a screenshot.
      platform: process.platform,
      home: homedir(),
      // What a NEW run would start with, so the picker can pre-check them and
      // say where they came from. Not what any existing run has — that is on
      // the run.
      defaultSkills: this.flags.defaultSkills,
      // The model lineup, from the one file that defines it. The client used
      // to carry its own copy of this list, which is a second source of truth
      // for a vocabulary the server 400s on — so the form now asks.
      models: offeredModels(),
      sizing: this.sizing,
      generation: this.generation,
      repo: this.repo,
      recentRoots: this.prefs.recentRoots.map((path) => ({ path, label: basename(path) })),
      searchDocs: this.search.size,
      // Health, so the UI can say "stale" instead of quietly showing an old
      // board: a deaf watcher and a crashed subsystem both look fine otherwise.
      watcher: this.watcher.status(),
      health: degradedState(),
    };
  }

  /* ---------------------------------------------------------------- *
   * Runs
   * ---------------------------------------------------------------- */

  /**
   * Refuse to start work on a phase somebody else is holding.
   *
   * Only for NAMED phases. A whole-plan run that meets a claimed phase should
   * park that one and get on with the other fourteen — refusing the run would
   * let one stale-looking claim stop a plan. But "run only this phase", a
   * retry, a recovery session and a QA session all name exactly one phase, and
   * for those the claim is the whole answer.
   *
   * An EXPIRED lease is not a holder: nobody is working a phase whose claim
   * lapsed, and treating debris as an owner is the bug this rail was built
   * around (see the runner's boarding check).
   */
  private assertNotClaimed(slug: string, phases: readonly number[] | undefined): void {
    const handoffsDir = this.root?.handoffsDir;
    if (!handoffsDir || !phases?.length) return;
    for (const phase of phases) {
      const lock = readLock(handoffsDir, slug, phase);
      // A claim whose session the registry shows ended is debris, not a holder.
      if (lock && !lock.expired && this.sessions.presenceOfLock(lock) !== 'ended') throw new PhaseClaimedError(slug, phase, lock);
    }
  }

  /**
   * The boarding preflight's answer for every open phase, at the moment the
   * operator presses Start — advisory only, computed with the SAME extractor
   * boarding will use. The runner still parks per phase; this exists because
   * that park used to be the operator's first sight of a defect that was
   * readable before the run was created.
   */
  async verificationPreflight(slug: string, onlyPhases?: number[]): Promise<string[]> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return [];
    const board = await this.board(slug).catch(() => null);
    const done = new Set(board?.done ?? []);
    const out: string[] = [];
    for (const row of record.plan.graph) {
      if (done.has(row.phase)) continue;
      if (onlyPhases?.length && !onlyPhases.includes(row.phase)) continue;
      const detail = record.plan.phases[row.phase];
      if (extractCommands(detail?.verification).commands.length) continue;
      const declared = /\*\*\s*Verification\b/i.test(detail?.raw ?? '');
      out.push(declared
        ? `phase ${row.phase}'s §Verification yields nothing the runner can execute — it will park at boarding`
        : `phase ${row.phase} has no §Verification — it will park at boarding`);
    }
    return out;
  }

  /**
   * The boarding preflight's findings for every open phase, STRUCTURED — the
   * same predicates boarding uses (one extractor, one lead resolver, one
   * verify.env), computed on demand so a plan page can badge "N commands
   * cannot run here" BEFORE any money is spent. The journal-only string twin
   * of this data predicted the dominant halt class 44 times and was rendered
   * by nothing.
   */
  async verifyPreflightReport(slug: string): Promise<
    { phases: { phase: number; warnings: PreflightWarning[] }[]; computedAt: string } | null
  > {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return null;
    const board = await this.board(slug).catch(() => null);
    const done = new Set(board?.done ?? []);
    const verifyEnv = loadVerifyEnv(this.flags.scriptsDir);
    const phases: { phase: number; warnings: PreflightWarning[] }[] = [];
    for (const row of record.plan.graph) {
      if (done.has(row.phase)) continue;
      const detail = record.plan.phases[row.phase];
      const { commands, notRun } = extractCommands(detail?.verification);
      const warnings: PreflightWarning[] = [];
      if (!commands.length) {
        const declared = /\*\*\s*Verification\b/i.test(detail?.raw ?? '');
        warnings.push({
          kind: 'nothing-runnable',
          message: declared
            ? 'its §Verification yields nothing the runner can execute — it will park at boarding'
            : 'it has no §Verification — it will park at boarding',
        });
      } else {
        for (const held of notRun) {
          warnings.push({
            kind: 'human-check', command: held.text,
            message: `a person will be asked: ${held.text} — ${held.reason}`,
          });
        }
        for (const lead of unresolvableLeads(commands, process.env.PATH, verifyEnv.preflightSkip).keys()) {
          warnings.push({
            kind: 'missing-lead', lead,
            message: `\`${lead}\` is not installed here — its command will be SKIPPED at verification`,
          });
        }
        if (!/\*\*\s*Verify in:?\*\*/i.test(detail?.raw ?? '')) {
          const sensitive = commands.filter((command) => {
            if (/^cd\s/.test(command.trim())) return false;
            const lead = resolveLead(command);
            return lead ? verifyEnv.cwdSensitive.has(lead) : false;
          });
          if (sensitive.length) {
            warnings.push({
              kind: 'cwd-unpinned',
              message: `${sensitive.length} command(s) are cwd-sensitive and the phase declares no `
                + '**Verify in:** — they run at the repository root',
            });
          }
        }
      }
      if (warnings.length) phases.push({ phase: row.phase, warnings });
    }
    return { phases, computedAt: new Date().toISOString() };
  }

  /**
   * Start or continue a run. Whether the plan is fresh or half-finished is not
   * a distinction the caller has to make — the engine derives ready phases from
   * the done-set, so both are the same code path.
   */
  async startRun(slug: string, options: Partial<StartOptions> = {}): Promise<RunState> {
    if (!this.flags.allowRun) throw new Error('Runs are disabled. Restart with --allow-run to enable them.');
    if (!this.root?.ok) throw new Error('No source directory is open.');
    const record = this.store?.get(slug);
    if (!record) throw new Error(`No plan named ${slug}.`);
    if (!record.plan?.phased) throw new Error(`${slug} has no phase graph — there is nothing to run.`);
    // The one concurrency that is never safe: two loops driving one phase
    // graph. `Runner.start` throws on its own second call, so this is the
    // message rather than the guard — but a bare "a run is already in
    // progress" would now be read as "the console is busy", which is exactly
    // the thing that stopped being true.
    if (this.liveRunner(slug)) {
      throw new Error(
        `${slug} is already running in this console. Pause or stop it first — `
        + 'another plan can start beside it, but one plan cannot run twice.');
    }
    // Before anything is written or minted. A claimed phase used to be
    // discovered inside the runner, after a run existed and the console had
    // already reported success.
    this.assertNotClaimed(slug, options.onlyPhases);

    // `auto` resolves here, once, against the cached meters — the run then
    // carries a concrete id, so the journal and the header say which account
    // is paying rather than "whatever looked best at some point".
    if (options.accountId === 'auto') {
      options = { ...options, accountId: this.accounts.pickAccount(null, options.model) ?? DEFAULT_ACCOUNT_ID };
    }
    this.preflightAccount(options.accountId);

    // QA on launch, resolved BEFORE the runner starts so the run's first board
    // read already sees gating. The preference speaks only for a fresh run — a
    // resume is not a new launch decision — and an explicit `qa: false` beats
    // the preference, so unticking the box means what it says.
    const wantQa = options.qa ?? (options.resumeRunId ? false : this.prefs.qaByDefault ?? false);
    if (wantQa && (await this.qaMode(slug)).mode === 'off') {
      if (!this.flags.allowWrites) {
        throw new Error(
          'QA on launch needs --allow-writes: turning QA on writes test-status.md. '
          + 'Start without QA, or restart the console with --allow-writes.');
      }
      // Anchor on the latest phase that has a handoff — that is the
      // `new-handoff.sh --qa` path, which backfills every completed phase as
      // waived. A fresh plan with no handoffs takes its first phase instead,
      // which records "a review was asked for and not yet answered".
      const phases = record.plan.graph.map((r) => r.phase);
      const withHandoff = phases.filter((p) => handoffFor(record, p));
      const anchor = withHandoff.length ? Math.max(...withHandoff)
        : phases.length ? Math.min(...phases) : 1;
      const turned = await this.activateQa(slug, anchor);
      if (!turned.ok) throw new Error(`Could not turn QA on for ${slug}: ${turned.detail}`);
    }

    // The machine's default skills are an opt-in now, not a side effect. On a
    // fresh run the attach choice (per-launch, else the preference) decides
    // whether they ride along with whatever was picked; a resume passes the
    // picked list through untouched — the run's sticky list rules, and prefs
    // never re-seed a half-finished run. `seedSkills`' contract is unchanged
    // for its other callers: an explicit empty list still means none.
    const attach = options.attachDefaultSkills
      ?? (options.resumeRunId ? false : this.prefs.attachDefaultSkills ?? false);
    const skills = attach
      ? [...new Set([...this.flags.defaultSkills, ...(options.skills ?? [])])]
      : options.skills;

    // Auto-recovery seeds like QA above: the preference speaks only for a
    // fresh run — a resume keeps the run's own sticky choice — and an explicit
    // false beats it, so unticking the box means what it says.
    const autoRecover = options.autoRecover
      ?? (options.resumeRunId ? undefined : this.prefs.autoRecoverByDefault !== false);

    // And the MCP policy the same way again: the preference is where a fresh
    // run starts, a resume keeps whatever the run already decided (including a
    // `continue` set from a halt card, which must not be undone by a restart),
    // and an explicit choice in the dialog beats both.
    const mcpPolicy = options.mcpPolicy
      ?? (options.resumeRunId ? undefined : this.prefs.mcpPolicy ?? 'continue');

    const state = await this.runnerFor(slug).start({
      ...options,
      autoRecover,
      mcpPolicy,
      skills,
      slug,
      root: this.root.path,
    });
    this.emit('run:state', { state });
    return state;
  }

  /**
   * The id the loop is actually driving right now, or null.
   *
   * Every read of a run passes through this. A status of `running` on disk is a
   * claim by a process that may have been killed since; only this answers
   * whether anything is behind it, and reads that skip it report corpses as
   * live runs — which is precisely what a Stop button then fails to stop.
   */
  private liveRunId(): Set<string> {
    return this.liveRunIds();
  }

  /**
   * The run driving THIS plan right now, or null.
   *
   * Every caller was written against "the run for this slug" rather than "the
   * run" precisely so the pool could replace the body without touching one of
   * them. This is that replacement.
   */
  private drivingRun(slug: string): RunState | null {
    return this.liveRunner(slug)?.current() ?? null;
  }

  /** The live run if there is one, otherwise the last one recorded on disk. */
  /**
   * The run read paths, board-aware.
   *
   * `loadRun` already reconciles a run whose writer died (`reconcileRun`); this
   * is the second half of the same idea — a stopped run whose phases the board
   * has since finished stops asking for a person. Both corrections happen on
   * read and are written back once, so nothing has to remember to do it later.
   *
   * The board read is why these are async: the classification comes from the
   * engine, which is a process. It is cached per plan revision, so a fleet of
   * two hundred runs across twelve plans costs twelve cache hits.
   */
  async runFor(slug: string): Promise<RunState | null> {
    const live = this.runners.get(slug)?.current();
    if (live && live.slug === slug) return live;
    if (!this.root) return null;
    const state = latestRun(this.root.path, slug, this.liveRunId());
    return state ? (await this.resolveAgainstBoard([state]))[0] : null;
  }

  /**
   * What every in-flight lane of this plan looks like right now.
   *
   * A live runner answers from its own lanes; without one, the records' own
   * snapshots are the honest fallback — stale by construction, and labelled as
   * such by the status they sit beside. Answering with nothing instead would
   * make a lane a console restart killed indistinguishable from a phase that
   * never started, which is the one thing this feature exists to prevent.
   */
  runLiveness(slug: string, state: RunState | null): LaneLiveness[] {
    const live = this.liveRunner(slug);
    if (live) return live.liveness();
    return Object.values(state?.phases ?? {})
      .filter((record) => record.liveness && PHASE_IN_FLIGHT.includes(record.status))
      .map((record) => record.liveness!)
      .sort((a, b) => a.phase - b.phase);
  }

  /**
   * The plan's whole ruling ledger, oldest first.
   *
   * Read from the FILE rather than from a run, so it answers before any run
   * exists and keeps answering after every run of the plan has been deleted: a
   * decision made in phase 3 is still the reason phase 9 looks the way it does.
   */
  runRulings(slug: string): Ruling[] {
    if (!this.root?.ok) return [];
    return readRulings(rulingsFile(this.root.path, slug));
  }

  /**
   * Fold what the ledger holds into the plan's run, and journal what is new.
   *
   * With the plan's runner live it is the runner's act, for the same reason
   * every other write to a live run is: two writers on one checkpoint is how a
   * run file loses a phase. Without one, the newest run on disk takes it —
   * and if there is no run at all, the ledger simply stands on its own, which
   * is the common case for a plan somebody is driving by hand.
   */
  private ingestRulingsFor(slug: string): void {
    if (!this.root?.ok) return;
    const ledger = this.runRulings(slug);
    if (!ledger.length) return;
    const live = this.liveRunner(slug);
    if (live) {
      if (live.ingestRulings(ledger)) this.emit('run:rulings', { slug });
      return;
    }
    const state = latestRun(this.root.path, slug, this.liveRunIds());
    if (!state) return;
    const mine = ledger.filter((ruling) => !state.createdAt || ruling.at >= state.createdAt);
    const { rulings, added } = ingestRulings(state.rulings, mine);
    if (!added.length) return;
    state.rulings = rulings;
    const journal = new Journal(this.root.path, slug, state.id);
    for (const ruling of added) {
      journal.append('phase.ruling', {
        id: ruling.id, kind: ruling.kind, what: ruling.what,
        ...(ruling.why ? { why: ruling.why } : {}),
        ...(ruling.costIfWrong ? { costIfWrong: ruling.costIfWrong } : {}),
        ...(ruling.sessionId ? { sessionId: ruling.sessionId } : {}),
        at: ruling.at, by: 'unsupervised',
      }, ruling.phase);
    }
    saveRun(state);
    this.emit('run:rulings', { slug });
  }

  async runsFor(slug: string): Promise<RunState[]> {
    if (!this.root) return [];
    return this.resolveAgainstBoard(listRuns(this.root.path, slug, this.liveRunId()));
  }

  /**
   * The most recent run's id, without the board read.
   *
   * Journals and transcripts are addressed by run id and do not care whether
   * the run still wants attention — spending an engine call to find out would
   * be paying for an answer nobody asked for.
   */
  runIdFor(slug: string): string | undefined {
    const live = this.runners.get(slug)?.current();
    if (live && live.slug === slug) return live.id;
    return this.root ? latestRun(this.root.path, slug, this.liveRunId())?.id : undefined;
  }

  /**
   * Apply the board resolver to a batch of runs, writing back what changed.
   *
   * One board read per plan, and only for runs that could actually be resolved
   * by one — a fleet that is entirely `finished` costs nothing at all.
   */
  private async resolveAgainstBoard(runs: RunState[]): Promise<RunState[]> {
    const slugs = slugsNeedingBoard(runs);
    if (!slugs.length) return runs;

    const boards = new Map<string, Record<number, string>>();
    for (const slug of slugs) {
      // An engine failure leaves the slug out of the map, so its runs keep
      // their cards. Uncertainty must not resolve anything.
      try { boards.set(slug, (await this.board(slug)).states); } catch { /* keep the card */ }
    }

    for (const state of resolveRunsAgainst(runs, boards)) {
      // Same contract as `settle()`: the correction sticks, but a read must not
      // fail because the disk did.
      try { saveRun(state); } catch { /* the annotation is worth less than the read */ }
      log.info('run.resolved', { slug: state.slug, runId: state.id, reason: state.resolved?.reason });
    }
    return runs;
  }

  /**
   * Dismiss a stopped run by hand, or put it back.
   *
   * The manual half of the resolver, and the reason `RunResolution.auto`
   * exists: this one is a person's judgement, so it survives a board that
   * disagrees and it can be taken back. Goes through `editStoredRun`, so it
   * works on a run no loop is driving — which is every run this is used on.
   */
  resolveRun(slug: string, runId: string, opts: { note?: string; by?: string } = {}): RunState | null {
    return this.editStoredRunById(slug, runId, (state) => {
      state.resolved = {
        at: new Date().toISOString(),
        auto: false,
        reason: 'dismissed by the operator',
        by: opts.by ?? 'console',
        ...(opts.note ? { note: opts.note } : {}),
      };
      // A dismissal replaces an earlier "put it back" — otherwise the veto
      // would outlive the decision it was vetoing.
      state.reopenedAt = null;
    });
  }

  unresolveRun(slug: string, runId: string): RunState | null {
    return this.editStoredRunById(slug, runId, (state) => {
      // Null rather than `delete`: the field is written out, so a re-read
      // cannot resurrect the old annotation from a stale copy on disk.
      state.resolved = null;
      // And the board resolver is told to leave it alone — see `reopenedAt`.
      // Without this the card comes back and vanishes again on the next read.
      state.reopenedAt = new Date().toISOString();
    });
  }

  /**
   * How much longer this plan has, from evidence it already has.
   *
   * Computed here rather than in the browser for the same reason the board is:
   * the numbers it rests on — a phase's size, the sizing constants, which
   * phases the engine calls done — all live on this side, and a second
   * implementation of them would eventually disagree with the first.
   *
   * The samples come from **every** run of the plan, not just this one, which
   * is what lets an estimate exist before the current run's first phase has
   * finished. Null whenever nothing has finished at all, which is the honest
   * answer to "how long will this take" the first time anyone asks.
   */
  async runEta(slug: string): Promise<EtaEstimate | null> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased || !this.root) return null;

    const plan = record.plan;
    const sizes = new Map(plan.graph.map((r) => [r.phase, plan.phases[r.phase]?.size ?? 'M' as const]));
    const board = await this.board(slug);

    // A scoped run is not going to do the rest of the plan, and saying it will
    // is the same defect as not showing the scope in the header at all.
    const run = await this.runFor(slug);
    const scope = run?.onlyPhases?.length ? new Set(run.onlyPhases) : null;
    const rows = scope ? plan.graph.filter((r) => scope.has(r.phase)) : plan.graph;

    const budget = resolveBudget(plan.sessionBudget.targetModel, this.sizing);
    const remaining = remainingWork(rows, board, sizes, this.sizing, budget);
    return etaFrom(this.planRate(slug), remaining);
  }

  /**
   * Every plan's finished phases, as evidence — this plan's own, and the pool.
   *
   * Read in one pass because the fallback chain needs both halves and because a
   * per-plan read repeated from the plans list would be 86 directory scans per
   * request. Runs live under `STATE_DIR`, not in the repo, so nothing here is
   * derived from a document and none of it invalidates on `generation` — hence
   * the time-based cache. See `ETA_POOL_MS`.
   */
  private etaPool(): EtaPool {
    const now = Date.now();
    if (this.etaPoolCache && now - this.etaPoolCache.at < ETA_POOL_MS) return this.etaPoolCache.value;

    const bySlug = new Map<string, EtaSample[]>();
    const all: EtaSample[] = [];
    const root = this.root?.ok ? this.root.path : null;

    if (root) {
      const live = this.liveRunIds();
      for (const record of this.store?.list() ?? []) {
        const plan = record.plan;
        if (!plan?.phased) continue;
        const weights = new Map(
          plan.graph.map((r) => [r.phase, weightOf(plan.phases[r.phase]?.size, this.sizing)]),
        );
        // `listRuns` rather than `runsFor`: the board resolver answers "does this
        // stopped run still want a person", which changes no finished phase's
        // duration — and asking it here would cost an engine read per plan.
        const samples = etaSamples(listRuns(root, record.slug, live), weights);
        if (samples.length) bySlug.set(record.slug, samples);
        all.push(...samples);
      }
      all.sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
    }

    const value: EtaPool = { bySlug, all };
    this.etaPoolCache = { at: now, value };
    return value;
  }

  /** The rate to estimate this plan with, and how much of a claim it is. */
  private planRate(slug: string): RateReading {
    const pool = this.etaPool();
    return rateFor(pool.bySlug.get(slug) ?? [], pool.all);
  }

  /**
   * How long each phase this run has a session on was expected to take.
   *
   * One entry per LANE, not one for "the" active phase: a run may be driving
   * three disjoint-scope phases, and a single figure would silently be whichever
   * of them the mirror happens to name. `remaining` is deliberately NOT computed
   * here — the elapsed clock ticks in the browser, so a server-side remainder
   * would be stale the moment it was serialised. The server owns the estimate;
   * the client owns the clock.
   */
  runPhaseEta(slug: string, run: RunState | null): PhaseEta[] {
    const plan = this.store?.get(slug)?.plan;
    if (!plan?.phased || !run) return [];

    const lanes = childrenOf(run).map((child) => child.phase);
    const phases = lanes.length ? lanes : run.activePhase != null ? [run.activePhase] : [];
    if (!phases.length) return [];

    const rate = this.planRate(slug);
    return [...new Set(phases)]
      .sort((a, b) => a - b)
      .map((phase) => phaseEtaFor(phase, weightOf(plan.phases[phase]?.size, this.sizing), rate));
  }

  /**
   * Everything the session printed, replayed from disk.
   *
   * The live console used to exist only in whichever browser tab happened to be
   * open when the phase ran. This is the same events, kept, so a reload or a
   * console restart does not erase the only record of what a session did.
   */
  runTranscript(slug: string, id: string | undefined, limit = 400): TranscriptEntry[] {
    const runId = id ?? this.runIdFor(slug);
    if (!runId || !this.root?.ok) return [];
    return readTranscript(transcriptFile(this.root.path, slug, runId), limit);
  }

  /* ---- controls that must work whether or not a loop is behind them ---- */

  /**
   * Apply a change to a run the loop is not driving.
   *
   * Stop, Retry and Skip all used to begin `if (!this.state) return` inside the
   * Runner, which is true of every run after a console restart. The buttons
   * stayed on screen, the API answered 200, and nothing happened — the worst of
   * the three possible behaviours, because it is indistinguishable from working.
   */
  private editStoredRun(slug: string, apply: (state: RunState) => void): RunState | null {
    if (!this.root?.ok) throw new Error('No source directory is open.');
    return this.writeStoredRun(latestRun(this.root.path, slug, this.liveRunId()), apply);
  }

  /**
   * The same, on a named run rather than the latest.
   *
   * Every control above acts on "the run of this plan", which is the newest one
   * — but dismissing a card is about the run that raised it, and on a plan that
   * has run since, that is not the newest. Addressing it by id is the whole
   * difference between resolving the card you pressed and resolving a different
   * run that happens to share its slug.
   */
  private editStoredRunById(slug: string, runId: string, apply: (state: RunState) => void): RunState | null {
    if (!this.root?.ok) throw new Error('No source directory is open.');
    return this.writeStoredRun(loadRun(this.root.path, slug, runId, this.liveRunId()), apply);
  }

  private writeStoredRun(state: RunState | null, apply: (state: RunState) => void): RunState | null {
    if (!state) return null;
    apply(state);
    saveRun(state);
    this.emit('run:state', { state });
    return state;
  }

  async stopRun(slug: string, phase?: number | null, by = 'console'): Promise<RunState | null> {
    const runner = this.liveRunner(slug);
    if (runner) {
      // A named phase stops that lane only, and the loop carries on. The
      // runner rules on queued/verifying/unknown itself — it can see the
      // lanes; its refusal keeps the 409 shape a mismatch always had.
      if (phase != null) {
        const result = runner.stopPhase(phase, by);
        if (!result.ok) throw new Error(result.reason);
        return runner.current();
      }
      await runner.stop();
      return runner.current();
    }
    if (phase != null) {
      // No loop behind it. A recorded child still alive belongs to a console
      // that is gone — signalling a pid we do not own is not a fallback, it is
      // a different and much worse action (the same posture as freeze). A dead
      // or absent child settles the one record.
      return this.editStoredRun(slug, (state) => {
        const child = state.children?.[String(phase)]
          ?? (state.child?.phase === phase ? state.child : undefined);
        if (child && pidAlive(child.pid)) {
          throw new Error(`phase ${phase}'s session (pid ${child.pid}) belongs to an earlier `
            + `console — let it finish, or stop it yourself with \`kill ${child.pid}\`.`);
        }
        const record = state.phases[String(phase)];
        if (!record || !PHASE_IN_FLIGHT.includes(record.status)) {
          throw new Error(`phase ${phase} of ${slug} is not running`);
        }
        record.status = 'interrupted';
        record.note = `stopped by ${by}`;
        record.endedAt = new Date().toISOString();
        record.resumeSessionId ??= record.sessionId;
        if (state.children) {
          delete state.children[String(phase)];
          if (!Object.keys(state.children).length) delete state.children;
        }
        if (state.child?.phase === phase) state.child = null;
      });
    }
    return this.editStoredRun(slug, (state) => {
      if (!IN_FLIGHT.includes(state.status)) return;
      state.status = 'interrupted';
      state.stoppedBy = 'operator';
      state.child = null;
      state.pause = null;
      state.halt ??= { at: new Date().toISOString(), reason: 'stopped by the operator', phase: state.activePhase ?? undefined };
    });
  }

  /**
   * Pause after the current phase.
   *
   * This used to call `runner.pause()` straight from the route, and that method
   * begins `if (!this.driving) return` — true of every run after a console
   * restart, and of any run this process is not the one driving. The button
   * stayed on screen, the API answered 200, and nothing happened at all: the
   * worst of the three possible behaviours, because it is indistinguishable
   * from working. Stop, Retry and Skip were fixed for exactly this; Pause was
   * left behind. It goes through the same door they do now.
   */
  pauseRun(slug: string, by = 'console'): RunState | null {
    const runner = this.liveRunner(slug);
    // A recovery is driving one session with no phase loop behind it, so there
    // is no boundary to pause at. Falling through to the checkpoint edit here
    // would write `pausing` to disk for a run that will never read it — the
    // same button-that-does-nothing this method was rewritten to eliminate,
    // arrived at from the other direction.
    if (runner?.recoveringNow()) return null;
    // A LIVE runner that says no (recovering, or a halt already draining) is
    // an answer, not an invitation to edit the checkpoint underneath it — the
    // disk copy would say `pausing` while the loop drains a halt, and the next
    // persist would overwrite it anyway. The fallback is only for a run no
    // loop drives.
    if (runner) return runner.pause(by) ? runner.current() : null;
    return this.editStoredRun(slug, (state) => {
      if (!IN_FLIGHT.includes(state.status)) return;
      state.status = 'pausing';
      state.stoppedBy = 'operator';
      state.pause = { requestedAt: new Date().toISOString(), afterPhase: state.activePhase, by };
    });
  }

  /** Take back a pause that has not been reached yet. */
  resumePause(slug: string): RunState | null {
    const runner = this.liveRunner(slug);
    if (runner?.resumePause()) return runner.current();
    return this.editStoredRun(slug, (state) => {
      if (state.status !== 'pausing') return;
      state.status = 'running';
      state.pause = null;
    });
  }

  /**
   * Put a question to the session running this plan's current phase.
   *
   * Unlike every other control here there is no on-disk fallback, and there
   * should not be: a question needs something listening. A run this console is
   * not driving has a session belonging to another console — or to nothing at
   * all — and the honest answer is to say so rather than to write the question
   * somewhere it will never be read.
   */
  askRun(slug: string, question: string, by = 'console', key?: string, phase?: number | null): AskResult {
    const runner = this.liveRunner(slug);
    if (!runner) {
      return { ok: false, reason: `nothing is running for ${slug} in this console` };
    }
    const mismatch = runner.phaseMismatch(phase);
    if (mismatch) return { ok: false, reason: mismatch };
    // The phase goes through to the lane, so a question typed under one
    // running phase cannot be answered by a different one's session.
    return runner.ask(question, by, key, phase);
  }

  /** The same channel, said as an instruction rather than a question. */
  steerRun(
    slug: string, instruction: string, by = 'console', key?: string, phase?: number | null,
  ): AskResult {
    const runner = this.liveRunner(slug);
    if (!runner) {
      return { ok: false, reason: `nothing is running for ${slug} in this console` };
    }
    const mismatch = runner.phaseMismatch(phase);
    if (mismatch) return { ok: false, reason: mismatch };
    return runner.steer(instruction, by, key, phase);
  }

  /**
   * Freeze and thaw the session mid-phase.
   *
   * No on-disk fallback, and for the same reason `askRun` has none: both act on
   * a live child. A run this console is not driving has a child belonging to
   * another console or to nothing, and signalling a pid we do not own is not a
   * fallback, it is a different and much worse action.
   */
  freezeRun(slug: string, by = 'console', phase?: number | null): ControlResult {
    const runner = this.liveRunner(slug);
    if (!runner) return { ok: false, reason: `nothing is running for ${slug} in this console` };
    const mismatch = runner.phaseMismatch(phase);
    if (mismatch) return { ok: false, reason: mismatch };
    if (!runner.freeze(by, phase)) {
      return { ok: false, reason: `nothing is running for ${slug} in this console that could be frozen` };
    }
    return { ok: true, run: runner.current() };
  }

  thawRun(slug: string, phase?: number | null): ControlResult {
    const runner = this.liveRunner(slug);
    if (!runner) return { ok: false, reason: `nothing is running for ${slug} in this console` };
    const mismatch = runner.phaseMismatch(phase);
    if (mismatch) return { ok: false, reason: mismatch };
    if (!runner.thaw(phase)) {
      return { ok: false, reason: `nothing is frozen for ${slug} in this console` };
    }
    return { ok: true, run: runner.current() };
  }

  /** Change model, autonomy or budgets on a run in flight; applies next phase. */
  configureRun(slug: string, patch: RunSettingsPatch, by = 'console'): RunState | null {
    // `attachDefaultSkills` is a request, not a field: it is translated here
    // into the concrete skills list against the run's CURRENT one, because the
    // patch that reaches `applySettings` must say what the list is, not how to
    // derive it. On means the machine defaults ride along with what the run
    // already has; off means they come out and everything picked by hand stays.
    const translate = (state: RunState | null): RunSettingsPatch => {
      if (patch.attachDefaultSkills === undefined) return patch;
      const { attachDefaultSkills: attach, ...rest } = patch;
      const defaults = this.flags.defaultSkills;
      const base = rest.skills != null ? rest.skills : (state?.skills ?? []);
      return {
        ...rest,
        skills: attach
          ? [...new Set([...base, ...defaults])]
          : base.filter((skill) => !defaults.includes(skill)),
      };
    };
    const runner = this.liveRunner(slug);
    if (runner?.configure(translate(runner.current()), by)) return runner.current();
    return this.editStoredRun(slug, (state) => { applySettings(state, translate(state)); });
  }

  /**
   * The operator's mid-run account switch. Live loop: checkpoint-and-continue
   * inside the runner. No loop: edit the checkpoint, so the next Continue
   * spawns under the new account. `auto` resolves against the meters here,
   * exactly as it does at start.
   */
  switchAccountRun(slug: string, accountId: string | undefined, by = 'console'):
    { ok: boolean; reason?: string; run?: RunState | null } {
    const current = this.liveRunner(slug)?.current() ?? null;
    const resolved = accountId === 'auto'
      ? this.accounts.pickAccount(current?.accountId ?? undefined, current?.model) ?? undefined
      : accountId;
    if (accountId === 'auto' && !resolved) {
      return { ok: false, reason: 'no other account has headroom right now' };
    }
    const runner = this.liveRunner(slug);
    if (runner) {
      const outcome = runner.switchAccount(resolved, by);
      return outcome.ok
        ? { ok: true, run: runner.current() }
        : { ok: false, reason: outcome.reason };
    }
    const edited = this.editStoredRun(slug, (state) => {
      if (resolved && resolved !== DEFAULT_ACCOUNT_ID) state.accountId = resolved;
      else delete state.accountId;
    });
    return edited
      ? { ok: true, run: edited }
      : { ok: false, reason: 'no run of that plan to move — start one with the account instead' };
  }

  /**
   * "Continue without these servers" — the door out of an MCP park.
   *
   * The park says an unattended session cannot sign a server in, which is true
   * and was the whole of the advice. But it is not the only remedy: the other
   * one is deciding the phase does not need that server after all, and until
   * now the only way to say that was to edit the plan or the run's settings and
   * then retry every parked phase by hand.
   *
   * Sets the run to `continue` and retries exactly the phases the MCP preflight
   * parked — not `failed` phases, not gated ones, not a phase parked for an
   * unrunnable §Verification. A button that says it is about MCP has to do only
   * that; the phases it releases will re-board through the same preflight and
   * simply be told to run without what they cannot reach.
   *
   * Note this cannot beat a plan that says `require`: `mcpPolicyFor` reads the
   * plan ahead of the run, deliberately. Such a phase re-parks, which is the
   * correct answer — the escape hatch for it is per-phase, where an operator
   * is overruling a versioned statement knowingly rather than in bulk.
   */
  async continueWithoutMcp(slug: string): Promise<RunState | null> {
    const state = this.liveRunner(slug)?.current()
      ?? (this.root ? latestRun(this.root.path, slug, this.liveRunIds()) : null);
    if (!state) throw new Error(`no run of ${slug} to continue`);
    const parked = Object.values(state.phases ?? {})
      .filter((record) => record.status === 'parked' && MCP_PARK_NOTE.test(record.note ?? ''))
      .map((record) => record.phase)
      .sort((a, b) => a - b);
    if (!parked.length) throw new Error('no phase of this run is parked on an MCP server');

    this.configureRun(slug, { mcpPolicy: 'continue' }, 'console');
    this.runners.get(slug)?.note('run.mcp-continue', { phases: parked });
    let run: RunState | null = null;
    // Sequential, not `Promise.all`: the FIRST retry is what restarts a stopped
    // run, and the rest have to land on the loop it started rather than racing
    // three `startRun` calls at one plan (which the pool answers 409 to).
    for (const phase of parked) run = await this.retryPhase(slug, phase);
    log.info('mcp.continue-without', { slug, phases: parked });
    return run ?? this.liveRunner(slug)?.current() ?? null;
  }

  async retryPhase(slug: string, phase: number): Promise<RunState | null> {
    // Named phase, so the claim is the whole answer — and checked before the
    // live-runner branch too, since `runner.retry` queues work the boarding
    // check would only refuse much later, after the button had said yes.
    this.assertNotClaimed(slug, [phase]);
    // Same both-directions guard as `recoverPhase`: a retry restarts the run
    // on a phase a live agent recovery may be mid-edit on.
    const busyOn = this.liveRecoveryFor({ slug, phase });
    if (busyOn) {
      throw new RecoveryBusyError(
        `A recovery session is already working on ${slug} phase ${phase} — a retry would start a `
        + 'second session on the same tree. Open it, or stop it first.',
        busyOn.id);
    }
    const runner = this.liveRunner(slug);
    if (runner) { runner.retry(phase); return runner.current(); }
    // No loop behind it: resetting the record used to be the WHOLE action —
    // the button answered 200, the halt banner cleared, and nothing anywhere
    // was going to run the phase. Retry on a stopped run now means what the
    // operator means by it: clear the failure AND continue the run, under
    // normal admission.
    const edited = this.editStoredRun(slug, (state) => {
      // The ONE reset, shared with `Runner.retry` — the two had drifted twice.
      resetForRetry(phaseRecord(state, phase));
      state.consecutiveFailures = 0;
      state.halt = null;
    });
    if (!edited) return null;
    return this.startRun(slug, {
      resumeRunId: edited.id,
      // Resume CLEARS a scope it is not handed ("Continue never silently
      // inherits"), so a scoped run's retry must carry its own forward —
      // otherwise retrying one phase silently widens the run to the whole plan.
      ...(edited.onlyPhases?.length ? { onlyPhases: edited.onlyPhases } : {}),
      // Same for skills: an omission lets machine defaults overwrite the run's
      // sticky list on resume.
      skills: edited.skills ?? [],
    });
  }

  skipPhase(slug: string, phase: number): RunState | null {
    const runner = this.liveRunner(slug);
    if (runner) { runner.skip(phase); return runner.current(); }
    return this.editStoredRun(slug, (state) => {
      const record = phaseRecord(state, phase);
      record.status = 'skipped';
      record.note = 'skipped by the operator';
      state.halt = null;
    });
  }

  /**
   * Move a stuck phase forward without starting it over.
   *
   * Retry and Skip were the whole vocabulary, and both discard something: the
   * session that may have been minutes from done, or the phase itself. These
   * three are the middle — re-check what is already on disk, ask the phase's own
   * session to finish its closeout, or resume it with an instruction. See
   * `Runner.recover`.
   */
  async recoverPhase(
    slug: string, phase: number, mode: RecoverMode, opts: { instruction?: string; by?: string } = {},
  ): Promise<RunState | null> {
    // Asked of THIS plan. Another plan being mid-run is no longer a reason to
    // refuse — the scheduler admits the recovery against its scope, and holds
    // it if the trees actually overlap.
    if (this.liveRunner(slug)) {
      throw new Error(`${slug} is in progress. Pause or stop it before recovering a phase.`);
    }
    // A recovery spawns a session on this exact phase — the same collision a
    // second run would be, so the same refusal.
    this.assertNotClaimed(slug, [phase]);
    // The mirror of `resolveRecovery`'s guard 3, in the OTHER direction: an
    // agent recovery holds no runner, so `liveRunner` above cannot see it —
    // without this, "Fix with a new agent" plus "Finish in its own session"
    // was two sessions editing one tree at once.
    const busyOn = this.liveRecoveryFor({ slug, phase });
    if (busyOn) {
      throw new RecoveryBusyError(
        `A recovery session is already working on ${slug} phase ${phase} — open it instead.`,
        busyOn.id);
    }
    const root = this.root?.path;
    if (!root) throw new Error('No repository is open.');

    // The most recent run that actually reached this phase — recovery acts on a
    // real record, never on an invented one.
    const target = listRuns(root, slug, this.liveRunIds())
      .find((run) => run.phases[String(phase)]);
    if (!target) throw new Error(`No run of ${slug} has a record for phase ${phase}.`);

    // Resolve-first, the same gate the unattended path runs: when the board
    // already reads this phase done, reconcile and answer with the records
    // closed — never spawn a session to "finish" finished work. A standing
    // `resolved` does NOT refuse here: an explicit click is a new instruction.
    const gate = await this.preRecoveryGate(slug, target, phase);
    if (gate === 'superseded') return target;

    return this.runnerFor(slug).recover({
      slug, root, runId: target.id, phase, mode,
      instruction: opts.instruction,
      by: opts.by ?? 'console',
    });
  }

  /**
   * One press, the whole honest sequence — the plan-level "Recover & continue".
   *
   * Step 1 CONFIRMS the root issue instead of trusting the record: the board
   * is re-read and anything it has moved past is stood down (records closed,
   * halt dissolved, the stale alarm retracted). Step 2: nothing actually
   * wrong → the run simply continues under normal admission. Step 3: a REAL
   * halt → bounded auto-recovery is armed on the run and the healer runs NOW
   * — the same `maybeAutoRecover` the unattended path uses, budget, vehicle
   * choice, resolve-first gate and announcements included, so this button
   * cannot corrupt the orchestration it rides. Anything only a person can
   * settle comes back named, never blindly retried.
   */
  async recoverPlan(slug: string): Promise<{
    outcome: 'running' | 'resumed' | 'recovering' | 'errand' | 'nothing-to-do';
    detail: string;
    steps: string[];
    run: RunState | null;
    /** The one ask for a person, when the outcome is `errand`. */
    errand?: Errand;
  }> {
    const steps: string[] = [];
    const root = this.root?.path;
    if (!root) throw new Error('No source directory is open.');
    const live = this.liveRunner(slug);
    if (live) {
      return {
        outcome: 'running', steps,
        detail: `${slug} is already running — nothing to recover.`,
        run: live.current(),
      };
    }
    const state = latestRun(root, slug, this.liveRunIds());
    if (!state) {
      return {
        outcome: 'nothing-to-do', steps,
        detail: 'No run of this plan exists yet — Start is the verb you want.',
        run: null,
      };
    }

    /* 1. Confirm against the board — the root issue must be real. */
    const board = await this.boardStates(slug);
    const journal = new Journal(root, slug, state.id);
    const result = reconcileRecordsAgainstBoard(state, board);
    if (result.changed) {
      steps.push(`the board had moved past phase${result.closed.length === 1 ? '' : 's'} `
        + `${result.closed.join(', ')} — stale record${result.closed.length === 1 ? '' : 's'} closed`);
      journal.append('run.plan-recover', { step: 'reconciled', closed: result.closed });
    }
    if (!state.resolved) autoResolveRun(state, board);
    if (result.changed || state.resolved) {
      try { saveRun(state); } catch { /* the verdict matters more than the write */ }
      this.emit('run:state', { state });
      this.retractHalt(state, 'Recover pressed — the board shows the stop settled', { push: false });
    }

    /* 2. Nothing wrong any more → continue, or say it is finished. */
    if (!state.halt) {
      const remaining = Object.entries(board).filter(([, phaseState]) => phaseState !== 'done');
      if (!remaining.length) {
        journal.append('run.plan-recover', { step: 'clean', note: 'every phase reads done' });
        return {
          outcome: 'nothing-to-do', steps,
          detail: 'Every phase reads done on the board — nothing to recover or continue.',
          run: state,
        };
      }
      steps.push(`continuing the run — ${remaining.length} phase(s) remain`);
      journal.append('run.plan-recover', { step: 'resume', remaining: remaining.length });
      const run = await this.startRun(slug, {
        resumeRunId: state.id,
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
      });
      return {
        outcome: 'resumed', steps,
        detail: 'The board had moved past the stop — the run continues from here.',
        run,
      };
    }

    /* 3. A real halt: arm bounded auto-recovery and CONVERGE NOW — the same
     * pass the unattended loop runs (debris, killed lanes, the healer's
     * classify-and-climb), with the pins off because this IS the operator's
     * press. Anything only a person can settle comes back as the one Errand —
     * what is needed and how to give it — never a bare "needs you". */
    if (!state.autoRecover) {
      this.editStoredRun(slug, (stored) => { stored.autoRecover = { attempts: 2 }; });
      steps.push('armed auto-recovery on this run (2 bounded attempts per phase)');
      journal.append('run.plan-recover', { step: 'armed', attempts: 2 });
    }
    const report = await this.converger.converge(slug, 'button');
    // A pass that found the run already live — a boot pass or the halt's own
    // minute beat the press to it — is a run being recovered, not a refusal.
    const nowLive = this.liveRunner(slug);
    if (nowLive && !report?.launched) {
      steps.push('the run is already being driven — the loop got there first');
      journal.append('run.plan-recover', { step: 'already-live' });
      return {
        outcome: 'recovering', steps,
        detail: 'The run is already being recovered by the console. You will be notified with the verdict either way.',
        run: nowLive.current(),
      };
    }
    const after = latestRun(root, slug, this.liveRunIds()) ?? state;
    const heal = report?.outcomes.find((o) => o.action.kind === 'heal')?.heal;
    const relaunch = report?.outcomes.find((o) => o.action.kind === 'relaunch' && o.ok)?.action;
    if (relaunch?.kind === 'relaunch') {
      steps.push(`continuing the run — ${relaunch.why.join('; ') || 'the stop was the console\'s own'}`);
    }
    // The step is named: which phase, what it reads as, which rung — so the
    // answer is never about nothing in particular.
    if (heal?.phase != null && heal.label) {
      const vehicleWords = heal.vehicle === 'retry' ? 're-boarding it fresh through the runner'
        : heal.vehicle === 'reboard' ? 're-boarding it through the runner with a brief'
          : heal.vehicle === 'session' ? 'resuming its own session through the runner'
            : heal.vehicle === 'agent' ? 'briefing a fresh agent'
              : null;
      steps.push(`phase ${heal.phase} reads ${heal.label}`
        + (heal.launched && vehicleWords ? ` — ${vehicleWords}${heal.rung ? ` (rung ${heal.rung})` : ''}` : ''));
    }
    if (report?.launched) {
      steps.push('launched the recovery — the run continues by itself when the board reads fixed');
      journal.append('run.plan-recover', {
        step: 'launched', phase: heal?.phase ?? null, situation: heal?.situation ?? null,
        rung: heal?.rung ?? null, vehicle: heal?.vehicle ?? null, relaunch: Boolean(relaunch),
      });
      return {
        outcome: 'recovering', steps,
        detail: 'A bounded recovery is running. You will be notified with the verdict either way.',
        run: after,
      };
    }
    // Nothing launched: the ONE errand. The pass's own (written or standing),
    // else the healer's anchor phase's, else one composed from what the healer
    // refused on — and, with no phase to hang it on at all, from the halt.
    const phaseErrand = report?.errands[0]
      ?? (heal?.phase != null
        ? (after.recoveries?.[String(heal.phase)]?.errand
          ?? (heal.situation ? errandFor(heal.situation, after.recoveries?.[String(heal.phase)]?.rungs ?? [], heal.phase) : undefined))
        : undefined);
    const errand = phaseErrand ?? after.errand ?? errandFor(situationOfHalt(after.halt), [], after.halt?.phase ?? 0);
    if (!phaseErrand && !after.errand) {
      // A run-level stop with no phase behind it keeps its ask on the run.
      this.editStoredRunById(slug, after.id, (stored) => { stored.errand = errand; });
    }
    journal.append('run.plan-recover', { step: 'errand', reason: heal?.reason ?? null, phase: errand.phase, situation: errand.situation });
    return {
      outcome: 'errand', steps, errand,
      detail: `${heal?.reason ?? 'This stop needs a person'}. Needed: ${errand.need} How: ${errand.how}`,
      run: latestRun(root, slug, this.liveRunIds()) ?? after,
    };
  }

  /* ---------------------------------------------------------------- *
   * The convergence loop — see converge.ts
   * ---------------------------------------------------------------- */

  /** The plans a sweep visits: open, phased, and with at least one run recorded. */
  convergeSlugs(): string[] {
    if (!this.root?.ok || !this.convergeAutomatic()) return [];
    const root = this.root.path;
    return (this.store?.list() ?? [])
      .filter((record) => record.plan?.phased && !record.plan.closed && existsSync(runDir(root, record.slug)))
      .map((record) => record.slug);
  }

  /** One pass of the loop for one plan — what the scheduler calls. Null when it cannot run here. */
  async convergeNow(slug: string, trigger: ConvergeTrigger, lastNoop: string | null = null): Promise<ConvergeReport | null> {
    if (!this.root?.ok) return null;
    // The automatic triggers need the capability that makes any of it real; the
    // operator's own press still gets an answer — its refusals are named.
    if (!this.flags.allowRun && trigger !== 'button') return null;
    return convergePlan(this.convergeDeps(), slug, trigger, lastNoop);
  }

  /** The last pass per plan, for the Pulse. */
  convergeReports(): ConvergeReport[] { return [...this.converger.reports.values()]; }

  /** The last pass per plan, flattened for a reader (`GET /api/converge`, the Pulse). */
  convergeViews(): ConvergeView[] { return this.convergeReports().map(convergeView); }

  /**
   * What the convergence loop is doing: whether its automatic passes are on
   * for this console (`--no-converge` / `--allow-run`), the sweep interval,
   * what is queued and running, and the last report per plan.
   */
  convergeStatus(): {
    automatic: boolean;
    everyMs: number;
    pending: { slug: string; trigger: string; dueAt: number }[];
    running: string[];
    reports: ConvergeView[];
  } {
    const snapshot = this.converger.snapshot();
    return {
      automatic: this.convergeAutomatic(),
      everyMs: this.prefs.convergeEveryMs ?? 0,
      pending: snapshot.pending,
      running: snapshot.running,
      reports: this.convergeViews(),
    };
  }

  private convergeDeps(): ConvergeDeps {
    const journals = new Map<string, Journal>();
    return {
      runs: (slug) => this.runsFor(slug),
      live: () => this.liveRunIds(),
      board: async (slug) => {
        try {
          const board = await this.board(slug);
          return board.error ? null : board.states;
        } catch { return null; }
      },
      locks: (slug) => this.allLocks().filter((lock) => lock.slug === slug),
      prefs: () => ({ resumeAtBoot: this.prefs.resumeAtBoot }),
      presence: (lock) => this.sessions.presenceOfLock(lock),
      heal: (slug) => this.maybeAutoRecover(slug),
      startRun: (slug, options) => this.startRun(slug, options),
      editRun: (slug, runId, apply) => this.editStoredRunById(slug, runId, apply),
      releaseLock: (slug, phase, owner) => this.releaseDebrisLock(slug, phase, owner),
      journal: (slug, runId, event, data, phase) => {
        if (!this.root) return;
        const key = `${slug}/${runId}`;
        let journal = journals.get(key);
        if (!journal) { journal = new Journal(this.root.path, slug, runId); journals.set(key, journal); }
        journal.append(event, data, phase);
      },
      // The third producer of errands. Same channel, same dedupe.
      announceErrand: (slug, runId, phase, errand) => {
        if (typeof phase === 'number') this.announceErrand({ slug, runId, phase, errand });
      },
      locksChanged: (slug) => {
        // The store's lock view lags the disk by a watcher debounce, and the
        // queue may be waiting on exactly this lock. Refresh, then poll.
        const handoffsDir = this.root?.handoffsDir;
        if (handoffsDir) this.store?.refresh([join(handoffsDir, slug, '.locks')]);
        this.scheduler.poll();
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * Session presence (Phase 5): the registry the user-scope hook feeds,
   * the hook installer, and the inbox of outcomes sessions nobody here
   * spawned declare.
   * ---------------------------------------------------------------- */

  /** Every lock the store holds, in the registry's correlation shape. */
  private locksForCorrelation(): { slug: string; phase: number; owner: string; session?: string; claimedAt?: number }[] {
    const out: { slug: string; phase: number; owner: string; session?: string; claimedAt?: number }[] = [];
    for (const record of this.store?.list() ?? []) {
      if (record.plan?.closed) continue;
      for (const lock of record.locks) {
        out.push({
          slug: record.slug, phase: lock.phase, owner: lock.owner,
          ...(lock.session ? { session: lock.session } : {}),
          ...(lock.claimedAt != null ? { claimedAt: lock.claimedAt } : {}),
        });
      }
    }
    return out;
  }

  /** The registry as the API and the Pulse read it: every session with its presence and the plan+phase it works. */
  sessionViews(): SessionView[] {
    return this.sessions.views(this.locksForCorrelation());
  }

  /**
   * `POST /hooks/session`: validate, rate-limit, ingest. The caller is the
   * hook script on this machine — no run token (there is no run), no console
   * header (it is not a browser); the route keeps it to loopback and this
   * keeps it to a body that is a session event and a rate a person's sessions
   * can actually produce.
   */
  ingestSessionEvent(body: unknown): SessionRecord {
    const payload = parseHookPayload(body);
    if (!payload) {
      throw new HookPayloadError('not a session event — session_id, event (SessionStart|SessionEnd|Stop) and an absolute cwd are required');
    }
    const now = Date.now();
    const refill = Math.floor((now - this.hookBucket.at) / 1000) * (HOOK_EVENTS_PER_MINUTE / 60);
    if (refill >= 1) {
      this.hookBucket.tokens = Math.min(HOOK_EVENTS_PER_MINUTE, this.hookBucket.tokens + Math.floor(refill));
      this.hookBucket.at = now;
    }
    if (this.hookBucket.tokens < 1) throw new HookRateError('too many session events — try again in a moment');
    this.hookBucket.tokens -= 1;
    return this.sessions.ingest(payload);
  }

  /**
   * A record in the registry moved. Every move reaches the browser on the
   * `sessions` event (the Pulse lists foreign sessions beside the lanes); an
   * ENDED session is the one that changes what may run — its lock is debris
   * now — so the queue is polled and the convergence loop asked to look at
   * the plan it was working (or every open one, when no lock says which).
   */
  private onPresenceChange(record: SessionRecord, event: SessionEventName | 'prune'): void {
    const presence = this.sessions.presence(record.sessionId);
    this.emit('sessions', {
      type: 'presence',
      event,
      presence: { ...record, presence },
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
      foreign: this.sessionViews(),
    });
    if (event === 'prune' || presence !== 'ended') return;
    this.scheduler.poll();
    const plan = correlate(record, this.locksForCorrelation(), Date.now());
    const slugs = plan ? [plan.slug] : this.convergeSlugs();
    for (const slug of slugs) {
      this.runners.get(slug)?.noteDocsChanged();
      if (this.convergeAutomatic()) this.converger.request(slug, 'change');
    }
  }

  /** The session-presence hook, as `~/.claude/settings.json` has it. */
  hooksStatus(): HooksStatus {
    return hooksStatus({ skillDir: SKILL_DIR });
  }

  /** Write the three entries (behind `--allow-writes` — the file is outside the console's own state). */
  installSessionHook(): HooksWrite {
    if (!this.flags.allowWrites) throw new Error('Installing the session hook edits ~/.claude/settings.json — restart with --allow-writes.');
    const out = installHooks({ skillDir: SKILL_DIR });
    log.info('hooks.installed', { path: out.path, changed: out.changed });
    return out;
  }

  uninstallSessionHook(): HooksWrite {
    if (!this.flags.allowWrites) throw new Error('Removing the session hook edits ~/.claude/settings.json — restart with --allow-writes.');
    const out = uninstallHooks({ skillDir: SKILL_DIR });
    log.info('hooks.uninstalled', { path: out.path, changed: out.changed });
    return out;
  }

  /**
   * Watch `runs/<instance>/` for the two things a session writes there itself.
   *
   *   - `<slug>/outcomes/phase-NN.json` — what `phase-outcome.sh` writes when
   *     no runner injected `PE_OUTCOME_FILE`, i.e. a session nobody here
   *     spawned. Read once, acted on, consumed;
   *   - `<slug>/rulings.ndjson` — the append-only ledger of what sessions
   *     DECIDED. Never consumed; re-read whole and deduped by ruling id, which
   *     is what makes "ingests once" a property rather than a claim about how
   *     often a watcher fires.
   *
   * One recursive watcher for both, because it is the same directory and a
   * second one would double the fd cost to answer the same events. What landed
   * while the console was away is read first; the watcher (debounced per file)
   * takes it from there.
   */
  private armSessionInbox(root: string): void {
    this.disarmSessionInbox();
    const dir = join(STATE_DIR, 'runs', instanceId(root));
    try { mkdirSync(dir, { recursive: true }); } catch { return; }
    for (const slug of this.store?.list().map((r) => r.slug) ?? []) {
      try { this.ingestRulingsFor(slug); } catch (error) { log.warn('rulings.boot-ingest', { slug, error }); }
      let names: string[] = [];
      try { names = readdirSync(outcomeInboxDir(root, slug)); } catch { continue; }
      for (const name of names) this.ingestOutcomeFile(slug, join(outcomeInboxDir(root, slug), name));
    }
    try {
      this.outcomeWatcher = watch(dir, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        const ruling = /^([^/]+)\/rulings\.ndjson$/.exec(name);
        if (ruling) {
          const key = name;
          const prev = this.outcomeTimers.get(key);
          if (prev) clearTimeout(prev);
          const timer = setTimeout(() => {
            this.outcomeTimers.delete(key);
            try { this.ingestRulingsFor(ruling[1]); }
            catch (error) { log.warn('rulings.ingest-failed', { slug: ruling[1], error }); }
          }, OUTCOME_INBOX_DEBOUNCE_MS);
          timer.unref?.();
          this.outcomeTimers.set(key, timer);
          return;
        }
        const m = /^([^/]+)\/outcomes\/(phase-\d{2,}\.json)$/.exec(name);
        if (!m) return;
        const key = `${m[1]}/${m[2]}`;
        const prev = this.outcomeTimers.get(key);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(() => {
          this.outcomeTimers.delete(key);
          this.ingestOutcomeFile(m[1], join(dir, name));
        }, OUTCOME_INBOX_DEBOUNCE_MS);
        timer.unref?.();
        this.outcomeTimers.set(key, timer);
      });
      // Never what keeps the process alive (shutdown, or a harness that never closes).
      this.outcomeWatcher.unref?.();
      this.outcomeWatcher.on('error', (error) => {
        log.warn('outcome-inbox.watcher-error', { dir, error: (error as Error).message });
        try { this.outcomeWatcher?.close(); } catch { /* gone */ }
        this.outcomeWatcher = null;
      });
    } catch (error) {
      log.warn('outcome-inbox.watch-failed', { dir, error: (error as Error).message });
      this.outcomeWatcher = null;
    }
  }

  private disarmSessionInbox(): void {
    for (const timer of this.outcomeTimers.values()) clearTimeout(timer);
    this.outcomeTimers.clear();
    try { this.outcomeWatcher?.close(); } catch { /* gone */ }
    this.outcomeWatcher = null;
  }

  /** Read, validate and consume one inbox file; a stale or invalid one is consumed and dropped. */
  private ingestOutcomeFile(slug: string, file: string): void {
    const phase = inboxOutcomePhase(file);
    if (phase == null || !existsSync(file)) return;
    const declared = readOutcome(file, { slug, phase });
    consumeOutcome(file);
    if (!declared) { log.warn('outcome-inbox.rejected', { slug, phase, file }); return; }
    if (Date.now() - Date.parse(declared.written_at) > OUTCOME_INBOX_MAX_AGE_MS) {
      log.info('outcome-inbox.stale', { slug, phase, writtenAt: declared.written_at });
      return;
    }
    void this.applyUnsupervisedOutcome(slug, phase, declared)
      .catch((error) => log.warn('outcome-inbox.apply-failed', { slug, phase, error: (error as Error)?.message ?? String(error) }));
  }

  /**
   * A declared outcome from a session nobody here spawned — the same
   * vocabulary as a lane's own, read the same way (`Runner.declareOutcome`).
   * With the plan's runner live, it is the runner's act. Otherwise the record
   * is written into the plan's latest run — created, paused and scoped to the
   * phase, when there is none — and the resume is armed: `waiting-external`
   * parks the phase `waiting` and the service's own clock resumes the session
   * at the window (restart-safe, like a usage-window sleep); `partial` boards
   * it now through normal admission. `blocked` / `needs-human` / `complete`
   * are kept as the classifier's `declared` evidence and announced once.
   */
  private async applyUnsupervisedOutcome(slug: string, phase: number, declared: PhaseOutcome): Promise<void> {
    if (!this.root?.ok) return;
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return;
    this.declaredOutcomes.set(`${slug}:${phase}`, {
      status: declared.status,
      ...(declared.reason ? { reason: declared.reason } : {}),
      ...(declared.watch.length ? { watch: declared.watch } : {}),
      writtenAt: declared.written_at,
      ...(declared.session_id ? { sessionId: declared.session_id } : {}),
    });
    log.info('outcome-inbox.declared', { slug, phase, status: declared.status, sessionId: declared.session_id ?? null });
    let verdict: 'parked' | 'boarding' | 'noted' | 'ignored' | null = 'noted';
    const live = this.liveRunner(slug);
    if (live) {
      verdict = live.declareOutcome(phase, declared, 'unsupervised');
    } else if (this.flags.allowRun && (declared.status === 'waiting-external' || declared.status === 'partial')) {
      const board = await this.board(slug).catch(() => null);
      if (board && !board.error && board.states[phase] === 'done') { verdict = 'ignored'; } else {
        let state = latestRun(this.root.path, slug, this.liveRunIds());
        const created = !state;
        if (!state) {
          state = newRun({ slug, root: this.root.path, onlyPhases: [phase], autoRecover: this.prefs.autoRecoverByDefault !== false });
          state.status = 'paused';
          state.stoppedBy = 'system';
          state.activePhase = null;
        }
        const journal = new Journal(this.root.path, slug, state.id);
        const rec = phaseRecord(state, phase);
        if (created) journal.append('run.start', { by: 'unsupervised', reason: `phase ${phase} declared ${declared.status} from a session the console did not start`, onlyPhases: [phase] });
        journal.append('phase.outcome', {
          status: declared.status, reason: declared.reason ?? null, resumeAfter: declared.resume_after ?? null,
          watch: declared.watch, sessionId: declared.session_id ?? null, by: 'unsupervised',
        }, phase);
        if (declared.session_id) { rec.sessionId = declared.session_id; delete rec.sessionAccountId; }
        const now = Date.now();
        if (declared.status === 'waiting-external') {
          const requested = declared.resume_after ? Date.parse(declared.resume_after) : NaN;
          const until = new Date(Number.isFinite(requested) ? Math.max(requested, now + 60_000) : now + UNSUPERVISED_WAIT_DEFAULT_MS).toISOString();
          rec.status = 'waiting';
          rec.parkedUntil = until;
          rec.parkReason = declared.reason;
          rec.watch = declared.watch.length ? declared.watch : undefined;
          rec.waits = (rec.waits ?? 0) + 1;
          rec.endedAt = new Date(now).toISOString();
          rec.resumeSessionId = declared.session_id ?? rec.sessionId;
          delete rec.boardingHint;
          if (state.status !== 'finished') { state.status = 'paused'; state.stoppedBy = 'system'; }
          state.waitUntil = until;
          state.finishedReason = `phase ${phase} declared itself waiting on external work`
            + `${declared.reason ? ` (${declared.reason})` : ''}; its own session resumes at ${until}.`;
          journal.append('phase.waiting', { until, reason: declared.reason ?? null, watch: declared.watch, waits: rec.waits, by: 'unsupervised' }, phase);
          journal.append('run.waiting-external', { phases: [phase], waitUntil: until, by: 'unsupervised' }, phase);
          saveRun(state);
          this.emit('run:state', { state });
          this.armLimitResume(slug, state);
          verdict = 'parked';
        } else {
          resetForRetry(rec);
          const brief = declared.session_id ? 'continue' : 'resume';
          rec.boardingHint = {
            situation: 'work-in-progress', rung: 'resume-own-session', brief,
            ...(declared.session_id ? { sessionId: declared.session_id } : {}),
            at: new Date(now).toISOString(), by: 'unsupervised',
          };
          journal.append('phase.reboard-requested', { situation: 'work-in-progress', rung: 'resume-own-session', brief, by: 'unsupervised' }, phase);
          saveRun(state);
          this.emit('run:state', { state });
          if (this.convergeAutomatic()) {
            try {
              await this.startRun(slug, {
                resumeRunId: state.id,
                ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
                skills: state.skills ?? [],
              });
              verdict = 'boarding';
            } catch (error) {
              log.warn('outcome-inbox.board-failed', { slug, phase, error: (error as Error)?.message ?? String(error) });
            }
          }
        }
      }
    }
    this.announceDeclared(slug, phase, declared, verdict);
    if (this.convergeAutomatic()) this.converger.request(slug, 'change', 0);
  }

  private announceDeclared(slug: string, phase: number, declared: PhaseOutcome, verdict: string | null): void {
    const who = declared.session_id ? `session ${declared.session_id.slice(0, 8)}` : 'a session the console did not start';
    const where = `${slug} phase ${phase}`;
    if (declared.status === 'waiting-external') {
      this.announce('parked', {
        title: 'A hand-run phase is waiting on external work',
        body: `${where} — ${who} declared it is waiting${declared.reason ? `: ${declared.reason}` : ''}`
          + `${verdict === 'parked' ? '; the console resumes that session at the window' : ''}.`,
        tag: tagFor('parked', slug, String(phase), 'unsupervised'),
      }, { slug, phase });
    } else if (declared.status === 'blocked' || declared.status === 'needs-human') {
      this.announce('needs-you', {
        title: declared.status === 'blocked' ? 'A hand-run phase declared itself blocked' : 'A hand-run phase needs you',
        body: `${where} — ${who} declared ${declared.status}${declared.reason ? `: ${declared.reason}` : ''}.`,
        tag: tagFor('needs-you', slug, String(phase), 'unsupervised'),
      }, { slug, phase });
    }
  }

  /**
   * Release a lock as the owner the lock file names — the runner's own release
   * (`phase-lock.sh release --owner autopilot/<runId>`, `--git` never passed),
   * for claims of runs this console knows are dead. Deliberately not
   * `releaseLock`: that is the operator's write-class verb with its force
   * semantics; this frees what the autopilot itself left behind, under the
   * capability that let it claim in the first place.
   */
  private async releaseDebrisLock(slug: string, phase: number, owner: string): Promise<{ ok: boolean; detail?: string }> {
    if (!this.flags.allowRun) return { ok: false, detail: 'releasing autopilot debris needs --allow-run' };
    try {
      const out = await run(this.engineOpts(), 'phase-lock.sh', [slug, 'release', String(phase), '--owner', owner]);
      const text = (out.stdout + out.stderr).trim();
      const ok = out.code === 0 || /no lock|not held|free/i.test(text);
      log.info('lock.debris-released', { slug, phase, owner, ok, code: out.code });
      return { ok, ...(text ? { detail: text.slice(0, 200) } : {}) };
    } catch (error) {
      return { ok: false, detail: (error as Error)?.message ?? String(error) };
    }
  }

  /**
   * Re-run ONE recorded §Verification command in the operator's own shell —
   * the integrated terminal, in the phase's own directory — and reflect the
   * exit back onto the record (`reflectVerifyCommand`, below, on session
   * exit). Only commands the record itself holds may run: the browser names
   * a command, the server checks it against what the runner recorded, and
   * anything else is refused — a page must never become a shell.
   */
  async verifyInTerminal(slug: string, phase: number, command: string): Promise<
    { ok: true; sessionId: string; token: string; expiresAt: number }
    | { ok: false; status: number; error: string }
  > {
    const root = this.root?.path;
    if (!root) return { ok: false, status: 409, error: 'No source directory is open.' };
    const state = this.runners.get(slug)?.current()
      ?? listRuns(root, slug, this.liveRunIds()).find((run) => run.phases[String(phase)]);
    const record = state?.phases[String(phase)];
    const verification = record?.verification;
    if (!state || !record || !verification) {
      return { ok: false, status: 404, error: `No run of ${slug} has a verification record for phase ${phase}.` };
    }
    const recorded = [
      ...verification.ran.map((entry) => entry.command),
      ...(verification.skipped ?? []).map((entry) => entry.command),
    ];
    if (!recorded.includes(command)) {
      return {
        ok: false, status: 400,
        error: 'That command is not one this phase recorded — only recorded §Verification commands can be re-run here.',
      };
    }
    const cwd = record.verifiedIn && record.verifiedIn !== '.'
      ? join(root, record.verifiedIn)
      : root;
    const shell = process.env.SHELL || '/bin/bash';
    const mint = await this.terminals.mint(undefined, undefined, {
      kind: 'shell',
      file: shell,
      // -i loads the operator's interactive config (aliases, functions — the
      // `rg`-is-a-shell-function case is exactly why the runner could not run
      // this and the person can); -l the login PATH; -c runs and exits with
      // the command's own code, which is what the reflection reads.
      args: ['-ilc', command],
      label: `Verify P${phase} · ${command.slice(0, 48)}`,
      cwd,
      meta: { verify: { slug, phase, runId: state.id, command } },
    });
    if (!mint.ok) return mint;
    log.info('verify.terminal', { slug, phase, command: command.slice(0, 120), sessionId: mint.sessionId });
    return { ok: true, sessionId: mint.sessionId, token: mint.token, expiresAt: mint.expiresAt };
  }

  /**
   * The exit of a verify-command terminal, written back where it belongs.
   *
   * The record's entry gains the code, the tail of the session's own output
   * and `via: 'terminal'`; a skipped-lead entry that ran moves into `ran`
   * (the machine could not check it — the person just did). All green with
   * no live runner → the existing `recheck` fires so the board, the lint and
   * the halt machinery settle it the honest way. A live run is never edited
   * under its driver — the exit is announced and the run re-verifies itself.
   */
  private reflectVerifyCommand(
    verify: { slug: string; phase: number; runId?: string; command: string },
    code: number,
    output: string,
  ): void {
    const root = this.root?.path;
    if (!root) return;
    const { slug, phase, command } = verify;
    if (this.liveRunner(slug)) {
      this.announce('phase', {
        title: `P${phase} check ran in the terminal · exit ${code}`,
        body: `${slug} is live — the run re-verifies the phase itself. (${command.slice(0, 80)})`,
        tag: tagFor('phase', slug, `verify-terminal-${phase}`),
      }, { slug, phase });
      return;
    }
    const state = (verify.runId ? loadRun(root, slug, verify.runId, this.liveRunIds()) : null)
      ?? latestRun(root, slug, this.liveRunIds());
    const record = state?.phases[String(phase)];
    const verification = record?.verification;
    if (!state || !record || !verification) return;

    const ok = code === 0;
    const tail = output.slice(-8_000);
    const hit = verification.ran.find((entry) => entry.command === command);
    if (hit) {
      hit.ok = ok; hit.code = code; hit.output = tail; hit.via = 'terminal';
    } else {
      verification.ran.push({ command, ok, code, ms: 0, output: tail, via: 'terminal' });
      if (verification.skipped) {
        verification.skipped = verification.skipped.filter((entry) => entry.command !== command);
        if (!verification.skipped.length) delete verification.skipped;
      }
    }
    const red = verification.ran.filter((entry) => !entry.ok).length;
    verification.ok = red === 0;
    verification.reason = ok
      ? `\`${command.slice(0, 80)}\` confirmed in the terminal (exit 0)`
        + (red ? ` — ${red} command(s) still red` : '')
      : `\`${command.slice(0, 80)}\` still fails in the terminal (exit ${code})`;
    try { saveRun(state); } catch { /* reflected next read */ }
    new Journal(root, slug, state.id).append('phase.verify-command', {
      command: command.slice(0, 240), code, ok, via: 'terminal',
    }, phase);
    this.emit('run:state', { state });

    if (ok && verification.ok && record.status !== 'done') {
      this.announce('phase', {
        title: `P${phase} verification green in the terminal — re-checking`,
        body: 'Every recorded command now reads green; the board, verification and validate.sh run again to settle it.',
        tag: tagFor('phase', slug, `verify-terminal-${phase}`),
      }, { slug, phase, runId: state.id });
      void this.recoverPhase(slug, phase, 'recheck', { by: 'verify-terminal' })
        .catch((error) => {
          this.announce('phase', {
            title: `P${phase} confirmed in the terminal — press Re-check to settle it`,
            body: String((error as Error).message ?? error),
            tag: tagFor('phase', slug, `verify-terminal-${phase}`),
          }, { slug, phase, runId: state.id });
        });
    } else {
      this.announce('phase', {
        title: ok
          ? `P${phase} check green in the terminal — ${red} still red`
          : `P${phase} check still failing in the terminal (exit ${code})`,
        body: `${command.slice(0, 100)} — the phase record now carries this result.`,
        tag: tagFor('phase', slug, `verify-terminal-${phase}`),
      }, { slug, phase, runId: state.id });
    }
  }

  /**
   * Everything known about why a phase is not done, in one payload.
   *
   * All of it was already being captured and none of it was reachable: the
   * output of the command that failed, the session's closing words, the lint
   * summary, whether a handoff exists at all. The page rendered a one-line
   * reason and the rest lived in NDJSON, so diagnosing a stuck phase meant
   * leaving the console — which is the one thing the console exists to prevent.
   */
  async phaseDiagnosis(slug: string, phase: number): Promise<PhaseDiagnosis | null> {
    const root = this.root?.path;
    if (!root) return null;
    const run = this.runners.get(slug)?.current()
      ?? listRuns(root, slug).find((r) => r.phases[String(phase)]);
    if (!run) return null;

    const record = run.phases[String(phase)];
    if (!record) return null;

    const board = await this.boardStates(slug);
    const [dirty, lock, classified] = await Promise.all([
      gitPorcelain(run.root),
      this.phaseLock(slug, phase),
      this.classifyPhase(slug, phase, run, board).catch(() => null),
    ]);
    // The classification is cached on the record for the phase table; the
    // read path writes it only when the run is not being driven (the loop
    // owns the file then) and only when it changed.
    if (classified && !this.liveRunner(slug)) {
      const cached = record.situation;
      if (!cached || cached.key !== classified.situation.key) {
        this.writeStoredRun(run, (stored) => {
          const r = stored.phases[String(phase)];
          if (r) r.situation = { key: classified.situation.key, at: classified.evidence.at, why: classified.situation.why };
        });
      }
    }

    return {
      runId: run.id,
      phase,
      status: record.status,
      // Which of the three checks is the one standing in the way. Named rather
      // than left for the reader to infer from four unrelated fields.
      blockedOn: board[phase] !== 'done' ? 'board'
        : record.verification && !record.verification.ok ? 'verification'
          : record.lint && !record.lint.ok ? 'lint'
            : null,
      boardState: board[phase] ?? 'unknown',
      said: record.said ?? null,
      verification: record.verification ?? null,
      // Where they ran, so "it passes on my machine" can be answered without
      // guessing which directory the console was standing in.
      verifiedIn: record.verifiedIn ?? null,
      lint: record.lint ?? null,
      closeout: record.closeout ?? null,
      sessionId: record.sessionId ?? record.resumeSessionId ?? null,
      resumable: Boolean(record.sessionId ?? record.resumeSessionId),
      note: record.note ?? null,
      workingTree: dirty ? dirty.split('\n').slice(0, 40) : [],
      lock,
      actions: recoveryActions(record.status, Boolean(record.sessionId ?? record.resumeSessionId), classified?.situation ?? null),
      situation: classified?.situation ?? null,
      evidence: classified ? summariseEvidence(classified.evidence) : [],
      // Claimed versus evidenced, from the same four facts the board, the
      // handoff, the run record and the QA table already hold. The panel that
      // says "done" is the one place it matters most that "done" is a claim.
      proof: deriveEvidence({
        phase,
        board: board[phase],
        handoff: (() => {
          const h = handoffFor(this.store?.get(slug), phase);
          return h?.exists
            ? { exists: true, status: h.status, ...(h.outstanding ? { outstanding: h.outstanding } : {}) }
            : { exists: false };
        })(),
        verification: record.verification ?? null,
        qa: { mode: (await this.qaMode(slug)).mode, ...(qaFor(this.store?.get(slug), phase)?.result
          ? { result: qaFor(this.store?.get(slug), phase)!.result } : {}) },
        record: {
          status: record.status,
          ...(record.attempts != null ? { attempts: record.attempts } : {}),
          ...(record.verifiedIn ? { verifiedIn: record.verifiedIn } : {}),
          runId: run.id,
        },
      }),
      // The whole plan's ledger, filtered to this phase — not the run's own
      // slice. A phase re-run three runs later is still answering the ruling
      // its first attempt made.
      rulings: this.runRulings(slug).filter((ruling) => ruling.phase === phase),
    };
  }

  /* ---------------------------------------------------------------- *
   * Situations — what the healer and the diagnosis panel read first
   * ---------------------------------------------------------------- */

  /**
   * The dependencies `collectEvidence` reads through, built from what this
   * service already holds: the store's parsed handoff and lock, the engine for
   * the phase's scope, QA mode and result, the plan's health issues. Nothing
   * here invents a fact; a dependency the console lacks stays absent.
   */
  private evidenceDeps(slug: string): EvidenceDeps {
    const root = this.root?.path ?? '';
    const record = this.store?.get(slug);
    const ours = (owner: string) => /^(autopilot|console)\//.test(owner);
    return {
      root,
      handoff: (_slug, phase) => {
        const h = record ? handoffFor(record, phase) : undefined;
        return h ? { status: h.status, outstanding: h.outstanding } : null;
      },
      lock: async (_slug, phase) => {
        const l = record ? lockFor(record, phase) : undefined;
        if (l) {
          const presence = this.sessions.presenceOfLock(l);
          return {
            holder: l.owner, ours: ours(l.owner), expired: l.expired,
            ...(l.leaseUntil ? { leaseUntil: l.leaseUntil } : {}),
            ...(l.scope?.length ? { scope: l.scope } : {}),
            ...(l.session ? { session: l.session } : {}),
            // Three-valued on purpose: `unknown` leaves the field absent, and
            // the classifier keeps its lease-based reading.
            ...(presence === 'live' ? { live: true } : presence === 'ended' ? { live: false } : {}),
          };
        }
        return null;
      },
      // The registry hit for the phase's lock holder: a live or ended session it names.
      registry: (_slug, phase) => {
        const l = record ? lockFor(record, phase) : undefined;
        if (!l?.session) return null;
        const presence = this.sessions.presenceOfLock(l);
        if (presence === 'unknown') return null;
        return { live: presence === 'live', sessionId: l.session, owner: l.owner };
      },
      // What a session nobody here spawned declared for the phase (the inbox).
      declared: (_slug, phase) => {
        const d = this.declaredOutcomes.get(`${slug}:${phase}`);
        return d ? { status: d.status, ...(d.reason ? { reason: d.reason } : {}), ...(d.watch ? { watch: d.watch } : {}), ...(d.writtenAt ? { writtenAt: d.writtenAt } : {}) } : null;
      },
      qa: async (_slug, phase) => {
        const mode = await this.qaMode(slug).catch((): QaMode => ({ mode: 'off' }));
        if (mode.mode === 'off') return { mode: 'off' };
        const row = record ? qaFor(record, phase) : undefined;
        return { mode: mode.mode, ...(row ? { result: row.result } : {}) };
      },
      health: async () => {
        if (!record) return [];
        try {
          return healthIssues(await this.context(record)).map((issue) => ({
            kind: issue.kind, severity: issue.severity,
            ...(issue.phase != null ? { phase: issue.phase } : {}),
            ...((issue as { message?: string }).message ? { detail: (issue as { message?: string }).message } : {}),
          }));
        } catch { return []; }
      },
      repos: async (_slug, phase) => {
        // The phase's SCOPE, as directories under the root that exist — the
        // repos whose trees say whether the phase did anything. `all`, or a
        // scope naming nothing that is here, falls back to the root itself.
        try {
          const out = await run(this.engineOpts(), 'phase-graph.sh', [slug, '--repos', String(phase)]);
          const names = out.stdout.trim().split(',').map((n) => n.trim()).filter(Boolean);
          if (!names.length || names.includes('all')) return ['.'];
          const dirs = names.filter((n) => n !== '.' && !n.includes('..') && existsSync(join(root, n)));
          return dirs.length ? dirs : ['.'];
        } catch { return ['.']; }
      },
    };
  }

  /** Evidence + situation for ONE phase of a run, against the board already read. */
  async classifyPhase(
    slug: string, phase: number, run: RunState | null, board: Record<number, string>,
  ): Promise<{ evidence: PhaseEvidence; situation: Situation }> {
    const evidence = await collectEvidence(this.evidenceDeps(slug), slug, phase, run, board);
    const live = run ? this.liveRunner(slug)?.current()?.id === run.id && Boolean(childrenOf(run).find((c) => c.phase === phase)) : false;
    if (live && evidence.record) evidence.record.live = true;
    return { evidence, situation: classifySituation(evidence) };
  }

  /**
   * Every open phase of a run, classified — the healer's candidate list. Order
   * is the halt's phase, the active phase, live lanes, then ascending: the
   * first one whose ladder has a rung this console can climb is the anchor.
   * Phases the board reads done are not candidates; their records are closed
   * by the reconcile pass, not diagnosed.
   */
  async classifyOpenPhases(
    slug: string, state: RunState, board: Record<number, string>,
  ): Promise<Array<{ phase: number; evidence: PhaseEvidence; situation: Situation }>> {
    const seen = new Set<number>();
    const order: number[] = [];
    const add = (phase: number | null | undefined) => {
      if (phase == null || seen.has(phase)) return;
      seen.add(phase); order.push(phase);
    };
    add(state.halt?.phase);
    add(state.activePhase);
    for (const child of childrenOf(state)) add(child.phase);
    for (const key of Object.keys(state.phases).map(Number).sort((a, b) => a - b)) add(key);
    const out: Array<{ phase: number; evidence: PhaseEvidence; situation: Situation }> = [];
    for (const phase of order) {
      if (!state.phases[String(phase)]) continue;
      if (board[phase] === 'done') continue;
      try {
        out.push({ phase, ...(await this.classifyPhase(slug, phase, state, board)) });
      } catch (error) {
        log.warn('run.situation-failed', { slug, phase, error });
      }
    }
    return out;
  }

  /**
   * Which of the vehicles THIS console can drive today a rung maps to — or
   * null when the rung's vehicle has not landed yet (the ladder then skips
   * it). Three vehicles exist today: the runner's own re-board (`retryPhase`),
   * the phase's own session through the runner (`recoverPhase`), and a fresh
   * briefed pty agent (`resolveRecovery` + mint).
   */
  private vehicleForRung(
    rung: Rung, situation: Situation, record: RunPhaseRecord | undefined, evidence: PhaseEvidence,
  ): DriveVehicle | null {
    // Capability flags (`--allow-run`, `--allow-agent`, node-pty) are NOT
    // consulted here: a vehicle the console has but may not use is still the
    // right vehicle, and the launch path refuses it BY NAME ("needs
    // --allow-agent") — a rung skipped silently would read as "nothing to
    // climb" and hide the flag that was actually in the way.
    const resumable = Boolean(record?.sessionId ?? record?.resumeSessionId);
    const agent = true;
    const outstanding = evidence.handoff.outstanding?.trim();
    switch (rung.vehicle) {
      case 'reboard-fresh':
      case 'queue':
        return { kind: 'retry' };
      case 'resume-own-session': {
        if (!resumable) return null;
        const mode = String(rung.params?.mode ?? 'continue');
        const instruction = mode === 'fix-verification'
          ? 'Your phase\'s §Verification is RED. Read the failing commands and their output below, fix the cause, '
            + 're-run the verification until it is green, then commit and write the handoff.'
          : 'You are RESUMING this phase — it is not finished. Read `git status` and `git diff` FIRST: anything '
            + 'uncommitted is your own earlier work; never stash, checkout or reset it away. Then carry the phase to '
            + 'its exit criteria (the Outstanding section of your handoff says what is left), verify, commit, and '
            + 'write the handoff as complete.'
            + (outstanding ? `\n\nOutstanding, as you left it:\n${outstanding.slice(0, 4_000)}` : '');
        return { kind: 'session', mode: 'resume', instruction };
      }
      case 'unblock-session': {
        if (this.prefs.unblockAttempts === false) return null;
        // No session left: the runner boards fresh with the unblock brief
        // (the engine's boot prompt + the Outstanding text + "you MAY do the work").
        if (!resumable) return { kind: 'reboard', brief: 'unblock' };
        return {
          kind: 'session', mode: 'resume',
          instruction: 'You declared this phase BLOCKED. This is ONE bounded unblock session: you are explicitly '
            + 'allowed — asked — to do the work that unblocks it yourself where a machine can (build what is '
            + 'unbuilt, fix what is red, finish what is partial). Read `git status` and `git diff` first; never '
            + 'discard earlier work. If the blocker is genuinely outside your reach (a credential nobody holds, a '
            + 'person\'s approval, a third party), say exactly what is needed with `phase-outcome.sh … blocked '
            + '--reason` and stop. Otherwise carry the phase to its exit criteria, verify, commit and hand off.'
            + (outstanding ? `\n\nYour Outstanding section, as you left it:\n${outstanding.slice(0, 4_000)}` : ''),
        };
      }
      case 'closeout-own-session':
        return resumable ? { kind: 'session', mode: 'closeout' } : null;
      case 'closeout-agent':
        return agent ? { kind: 'agent', cls: 'halted-missing-handoff' } : null;
      case 'fix-agent':
        return agent ? { kind: 'agent', cls: 'halted-verification' } : null;
      case 'plan-repair-agent':
        return agent ? { kind: 'agent', cls: 'plan-repair' } : null;
      case 'stale-claim-takeover':
        return agent && this.prefs.staleClaimTakeover !== false ? { kind: 'agent', cls: 'stale-claim-takeover' } : null;
      // The runner's own re-board with a RESUMING brief: the engine's boot
      // prompt plus the evidence (handoff, uncommitted paths, last
      // verification, last words). Through `start({resumeRunId, reboard})`,
      // never a second orchestration.
      case 'reboard-resume-brief':
        return { kind: 'reboard', brief: 'resume', ...(rung.params?.escalate === 'model' ? { escalate: 'model' as const } : {}) };
      // The `require` park's two rungs. The wait is the service's TIMER, not
      // a thing the healer drives (a pass that "waited" would be a no-op the
      // fingerprint then pins); the continue is driven here only once the
      // clock has run out — belt and braces for a timer lost to a crash —
      // and never when the operator set the timeout to 0 (wait indefinitely).
      case 'wait-heal':
        return null;
      case 'mcp-continue': {
        const due = mcpParkDueAt(record, this.mcpRequireTimeoutMs());
        return due !== null && due <= Date.now() ? { kind: 'mcp-continue' } : null;
      }
      // The resource walls the RUNNER climbs inline at the wall (auth and
      // usage → switch-account / wait-window, budget → raise-budget, models
      // → wait-window): by the time a stopped run reaches this healer those
      // rungs were climbed or refused in the loop, and the errand says so.
      // The plan-repair script and the external-wait parks are not drivable yet.
      case 'plan-repair-script':
      case 'switch-account':
      case 'switch-model':
      case 'wait-window':
      case 'raise-budget':
      case 'poll-park':
      case 'timed-park':
      case 'recheck-watch':
        return null;
      default:
        return null;
    }
  }

  private async phaseLock(slug: string, phase: number): Promise<string | null> {
    try {
      const out = await run(this.engineOpts(), 'phase-lock.sh', [slug, 'status', String(phase)]);
      return out.stdout.trim() || null;
    } catch { return null; }
  }

  private async boardStates(slug: string): Promise<Record<number, string>> {
    try {
      return readMemoryBlock(await run(this.engineOpts(), 'phase-graph.sh', [slug, '--memory-block'])).states;
    } catch { return {}; }
  }

  /* ---------------------------------------------------------------- *
   * Recovery sessions
   * ---------------------------------------------------------------- */

  /**
   * The live recovery session already working on a target, if there is one.
   *
   * Keyed by `(slug, phase)` rather than by class: two sessions repairing the
   * same phase from different angles would edit the same files, and the second
   * one is never what anybody meant to press. The client reads the same fact
   * off the sessions list it already holds, so the button becomes a chip
   * without a round trip.
   */
  liveRecoveryFor(link: { slug?: string; phase?: number }): SessionInfo | undefined {
    const key = recoveryKey(link);
    return this.terminals.state().sessions.find((session) =>
      !session.exited && session.meta?.recovery && recoveryKey(session.meta.recovery) === key);
  }

  /**
   * Turn "recover this" into the briefing a session can act on — or say why not.
   *
   * The browser names the target; every fact in the prompt is read here, from
   * the board, the run record, the phase diagnosis, the lock file and the
   * health issues. That split is the security property (a page cannot dictate
   * what an agent session is told) and the honesty property: a prompt cannot
   * claim a phase failed verification unless the recorded verification failed.
   *
   * Three refusals, all of them 409s that say what to do instead.
   */
  async resolveRecovery(
    request: RecoveryRequest,
  ): Promise<
    { ok: true; facts: RecoveryFacts }
    | { ok: false; status: number; error: string; sessionId?: string }
  > {
    const refuse = (status: number, error: string, sessionId?: string) =>
      ({ ok: false as const, status, error, ...(sessionId ? { sessionId } : {}) });

    const root = this.root?.path;
    if (!root) return refuse(409, 'No source directory is open.');

    const record = this.store?.get(request.slug);
    if (!record) return refuse(404, `No plan named ${request.slug}.`);

    // 1. The autopilot owns the working tree while it drives. A recovery
    //    session editing the same files under it is the one failure mode that
    //    corrupts work that was going to be fine.
    //
    //    Asked of the TARGET plan first. "Is anything running" was the same
    //    question while there was one runner; with the pool it stops being one,
    //    and a check written as "is the current run busy" would then refuse a
    //    recovery on plan A because plan B was mid-phase — or, worse, allow one
    //    because `current()` happened to answer about a third plan.
    const own = this.drivingRun(request.slug);
    if (own) {
      return refuse(409,
        `${own.slug} is mid-run (${own.status}) — pause or stop it before starting a recovery session.`);
    }
    //    A run on ANOTHER plan is a refusal only when it shares this one's
    //    tree. That used to be unconditional — one console, one working tree —
    //    and it is the arm phase 4 replaced with a scope intersection: two
    //    plans in different repositories have no way to collide, and refusing
    //    them bought nothing but a serialised operator.
    const wanted = request.phase != null
      ? this.scopeOf(request.slug, request.phase) ?? ['all']
      : ['all'];
    for (const other of this.runStates()) {
      const held = this.scheduler.granted(other.id);
      // A run holding no grant yet is between phases: nothing is editing
      // anything, so there is nothing to collide with.
      const overlapping = held.filter((grant) => scopesIntersect(grant.scope, wanted));
      if (!overlapping.length) continue;
      return refuse(409,
        `${other.slug} is mid-run (${other.status}) in ${formatScope(overlapping[0].scope)}, which a `
        + `recovery session for ${request.slug} would edit under. Pause or stop it first.`);
    }

    // 2. Signing in is the fix for an auth halt; an AI session would spend a
    //    turn discovering it cannot authenticate and report success anyway.
    //    Probed as the RUN's account — the machine login being healthy says
    //    nothing about the profile the halted run was paying with.
    if (request.class === 'auth-interrupted') {
      const haltedAccount = request.runId && this.root?.ok
        ? loadRun(this.root.path, request.slug, request.runId, this.liveRunId())?.accountId
        : this.runStates().find((run) => run.slug === request.slug)?.accountId;
      const auth = haltedAccount
        ? await checkAuthFor(root, await this.accounts.envFor(haltedAccount), haltedAccount, true)
        : await this.authStatus(true);
      if (!auth.loggedIn) {
        return refuse(409,
          `${haltedAccount ? `${this.accounts.labelFor(haltedAccount)} is` : 'Claude is'} signed out `
          + '— sign in first, then continue the run. A recovery session cannot authenticate for you.');
      }
    }

    // 3. One recovery per target.
    const already = this.liveRecoveryFor(request);
    if (already) {
      return refuse(409,
        `A recovery session for ${request.slug}${request.phase != null ? ` phase ${request.phase}` : ''} `
        + 'is already running.', already.id);
    }

    const [board, runState, diagnosis] = await Promise.all([
      this.board(request.slug),
      request.runId
        ? Promise.resolve(loadRun(root, request.slug, request.runId, this.liveRunId()))
        : this.runFor(request.slug),
      request.phase != null ? this.phaseDiagnosis(request.slug, request.phase) : Promise.resolve(null),
    ]);

    const rows = record.plan?.graph ?? [];
    const facts: RecoveryFacts = {
      ...request,
      scriptsDir: this.flags.scriptsDir,
      skillId: phasedExecutionSkillId(this.skills()),
      newOwner: recoveryOwner(request),
      ...(titleOf(rows, request.phase) ? { phaseTitle: titleOf(rows, request.phase) } : {}),
      ...(runState?.status ? { runStatus: runState.status } : {}),
      ...(runState?.halt?.reason ? { haltReason: runState.halt.reason } : {}),
      // A recovery of a branched run must commit where the run commits — the
      // discipline block flips its branch bullet on this.
      ...(runState?.gitMode === 'new-branch'
        ? { gitStrategy: { branch: `pe/${request.slug}` } }
        : {}),
      // When the interruption WAS a usage limit, say so: the session must know
      // the stop was quota, not the work. `waitUntil` on a paused/interrupted
      // run is that fact's fingerprint.
      ...(runState?.waitUntil && /usage limit/i.test(runState.finishedReason ?? runState.halt?.reason ?? 'usage limit')
        ? {
          limit: {
            account: this.accounts.labelFor(runState.accountId),
            resetsAt: new Date(runState.waitUntil).toLocaleString(),
          },
        }
        : {}),
      board: rows.length
        ? rows.map((row) => ({
          phase: row.phase,
          state: board.states[row.phase] ?? 'unknown',
          ...(row.title ? { title: row.title } : {}),
        }))
        : Object.entries(board.states).map(([phase, state]) => ({ phase: Number(phase), state })),
      ...(diagnosis
        ? {
          diagnosis: {
            blockedOn: diagnosis.blockedOn,
            boardState: diagnosis.boardState,
            said: diagnosis.said,
            verification: diagnosis.verification,
            lint: diagnosis.lint,
            workingTree: diagnosis.workingTree,
            sessionId: diagnosis.sessionId,
            resumable: diagnosis.resumable,
          },
        }
        : {}),
    };

    if (request.class === 'stale-claim-takeover') {
      // The FILE, not the store's scan — a claim re-taken since the last scan
      // must read as live, exactly as `releaseLock` insists.
      const handoffsDir = this.root?.handoffsDir;
      const lock = handoffsDir ? readLock(handoffsDir, request.slug, request.phase!) : null;
      if (lock) {
        facts.lockOwner = lock.owner;
        facts.lockDetail = lock.expired
          ? 'the lease has expired'
          : `the lease is still live until ${lock.leaseUntil ? new Date(lock.leaseUntil).toISOString() : 'an unrecorded time'}`;
      }
      const detail = await this.phaseLock(request.slug, request.phase!);
      if (detail) facts.lockDetail = detail;
    }

    if (request.class === 'plan-repair') {
      // Refused outright, and said plainly. Closure already demotes this plan's
      // issues to `info`, so the scan below would find nothing and answer "the
      // board and its artefacts agree" — true of the severities, misleading about
      // the plan. Repairing a closed plan is a real thing to want; it just starts
      // with reopening it.
      if (this.isClosedPlan(request.slug)) {
        return refuse(409,
          `${request.slug} is closed — reopen it before repairing it, or its board will go quiet again the moment it is fixed.`);
      }
      const issues = healthIssues(await this.context(record))
        .filter((issue) => issue.severity === 'error' || issue.severity === 'warning')
        // A phase-scoped repair only wants that phase's issues; a plan-wide one
        // takes them all.
        .filter((issue) => request.phase == null || issue.phase == null || issue.phase === request.phase);
      if (!issues.length) {
        return refuse(409,
          `${request.slug} has no plan errors to repair — the board and its artefacts agree.`);
      }
      facts.issues = issues.map((issue) => ({
        kind: issue.kind,
        message: issue.message,
        severity: issue.severity,
        ...(issue.phase != null ? { phase: issue.phase } : {}),
      }));
    }

    return { ok: true, facts };
  }

  /**
   * The gate in front of every recovery: is there anything left to recover?
   *
   * (1) Reconcile records against the live board — a phase finished outside
   * the run closes here, the halt anchored to it dissolves, and the answer is
   * `superseded` with nothing spawned. (2) A standing `resolved` on the run
   * is an answer somebody (or the board resolver) already gave — honored, not
   * relitigated.
   */
  private async preRecoveryGate(
    slug: string, state: RunState, phase: number,
  ): Promise<'proceed' | 'superseded' | 'resolved'> {
    const board = await this.boardStates(slug).catch(() => null);
    if (board) {
      const pooled = this.runners.get(slug);
      const holder = pooled?.current()?.id === state.id && !pooled.busy() ? pooled : null;
      const result = holder
        ? holder.reconcileAgainstBoard(board)
        : reconcileRecordsAgainstBoard(state, board);
      if (!holder && result.changed) {
        try { saveRun(state); } catch { /* a failed write must not block the verdict */ }
        this.emit('run:state', { state });
      }
      if (result.closed.includes(phase) || board[phase] === 'done') {
        const now = new Date().toISOString();
        const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: now });
        slot.lastAt = now;
        slot.lastOutcome = 'superseded';
        if (!state.resolved) autoResolveRun(state, board);
        try { saveRun(state); } catch { /* as above */ }
        this.emit('run:state', { state });
        // The urgent card this halt raised is now about nothing — stand it
        // down, with the quiet corrective push (same tag replaces the alarm).
        this.retractHalt(state, `the board already shows phase ${phase} done — records reconciled`, { push: true });
        return 'superseded';
      }
    }
    if (state.resolved) return 'resolved';
    return 'proceed';
  }

  /**
   * What a finished recovery session actually achieved, checked rather than
   * assumed.
   *
   * The whole point of linking a session to a target is that its exit can be
   * answered with evidence: the board is re-read, the run re-resolved, the
   * plan re-validated. "The session ended" is not an outcome — every session
   * ends.
   */
  async recoveryOutcome(link: {
    kind: string; slug?: string; phase?: number; runId?: string;
  }): Promise<{ fixed: boolean; noDefect?: boolean; headline: string; detail: string }> {
    const slug = link.slug;
    if (!slug || !this.root) {
      return { fixed: false, headline: 'Recovery finished', detail: 'Nothing to check it against.' };
    }

    // The watcher may not have noticed the session's writes yet, and every
    // engine answer is cached by revision — so ask for a fresh read before
    // judging what the session achieved.
    this.reread(slug);

    if (link.kind === 'plan-repair') {
      // A repair launched for a verification-preflight park is judged by the
      // thing that parked the run: does every open phase now extract at least
      // one runnable command? `lint.ok` cannot judge it — F14 is warning-tier
      // and leaves lint green before AND after, which would call every such
      // repair "fixed" no matter what the session did.
      const pooled = this.runners.get(slug)?.current();
      const target = pooled && pooled.slug === slug && (!link.runId || pooled.id === link.runId)
        ? pooled
        : link.runId ? loadRun(this.root.path, slug, link.runId, this.liveRunId()) : null;
      if (target?.halt?.kind === 'verification-preflight') {
        const advisories = await this.verificationPreflight(
          slug, target.onlyPhases?.length ? target.onlyPhases : undefined);
        const fixed = advisories.length === 0;
        return {
          fixed,
          headline: fixed ? `${slug}'s §Verification is runnable` : `${slug} still has unrunnable §Verification`,
          detail: fixed
            ? 'Every open phase now extracts a runnable verification command — boarding will pass.'
            : advisories.join('; '),
        };
      }
      const lint = await this.lint(slug);
      const fixed = Boolean(lint?.ok);
      return {
        fixed,
        headline: fixed ? `${slug} validates` : `${slug} still has plan errors`,
        detail: fixed
          ? 'validate.sh exits 0 — the plan, its handoffs and its INDEX agree again.'
          : lint?.summary ?? 'validate.sh is still red — open the plan and look.',
      };
    }

    const phase = link.phase;
    if (phase == null) {
      return { fixed: false, headline: `Recovery for ${slug} finished`, detail: 'Check the board.' };
    }

    const board = await this.board(slug);
    const state = board.states[phase] ?? 'unknown';
    const fixed = state === 'done';
    if (fixed) {
      return {
        fixed,
        headline: `${slug} P${phase} is done`,
        detail: `The board now reads done — ${RECOVERY_TITLES[link.kind as RecoveryClass] ?? 'the recovery'} worked.`,
      };
    }
    // Before scoring a miss a failure, ask whether there was anything to fix:
    // a verification-shaped recovery whose commands all pass found NO DEFECT,
    // and "found nothing wrong" must not read as "failed to fix" — that
    // scoring is what left halts standing over healthy phases.
    if (link.kind === 'halted-verification') {
      const run = this.runners.get(slug)?.current()
        ?? (this.root ? listRuns(this.root.path, slug, this.liveRunId()).find((r) => r.phases[String(phase)]) : null);
      const record = run?.phases[String(phase)];
      const text = this.store?.get(slug)?.plan?.phases[phase]?.verification;
      if (run && text) {
        try {
          const verification = await verifyPhase(text, {
            cwd: join(run.root, record?.verifiedIn ?? '.'),
            timeoutMs: 5 * 60_000,
          });
          if (verification.ran.length && verification.ran.every((r) => r.ok)) {
            return {
              fixed: false,
              noDefect: true,
              headline: `${slug} P${phase}: nothing to fix`,
              detail: 'Every verification command is green — the recovery found no defect, '
                + 'so the halt is stood down rather than re-armed.',
            };
          }
        } catch { /* an unrunnable re-check keeps the honest miss below */ }
      }
    }
    return {
      fixed,
      headline: `${slug} P${phase} is still ${state}`,
      detail: 'The recovery session ended without moving the board — inspect it before starting another.',
    };
  }

  /**
   * Move the run record to where the board says it now is — the write-back
   * half of a recovery session's exit.
   *
   * `recoveryOutcome` computes the verdict; this makes it true on the run. For
   * a while the verdict went only into a notification, so the phase stayed
   * `failed`, the run stayed `halted`, and the button that had just worked was
   * offered again. Three rules keep the write safe:
   *
   *  - **Never under a live loop.** A busy runner owns its state, and the
   *    resumed loop re-reads the board anyway.
   *  - **The pooled object first.** `runFor` prefers an idle Runner's
   *    in-memory state over disk, so when the pool still holds this run, THAT
   *    object is the one rewritten — a disk-only edit would be shadowed until
   *    the next restart.
   *  - **Annotation on a miss.** A not-fixed outcome only records the attempt;
   *    the halt keeps standing and keeps its words.
   *
   * On success the run lands on `parked` with `Runner.recover`'s own wording —
   * one vocabulary for both recovery paths, and the state auto-continue and
   * the Continue button both already consume.
   */
  syncRecoveredRun(
    link: { kind: string; slug?: string; phase?: number; runId?: string },
    outcome: { fixed: boolean; noDefect?: boolean; headline?: string; detail?: string },
    by = 'an AI recovery session',
  ): RunState | null {
    const slug = link.slug;
    if (!slug || !this.root?.ok) return null;

    const pooled = this.runners.get(slug);
    if (pooled?.busy()) {
      // The loop owns the state — hand it the write instead of skipping it.
      // Returning null here (which this did) is how records stayed `failed`
      // forever while the resumed run drove past them: auto-continue
      // restarts the run inside the same exit handler, so the race was
      // structural, not incidental. Only positive verdicts are queued; a
      // true miss keeps the halt standing by design.
      if (link.phase != null && link.kind !== 'plan-repair' && (outcome.fixed || outcome.noDefect)) {
        pooled.enqueueResolution({
          phase: link.phase,
          outcome: outcome.fixed ? 'done' : 'no-defect',
          by,
        });
        return pooled.current();
      }
      return null;
    }
    const held = pooled?.current();
    const target = held && held.slug === slug && (!link.runId || held.id === link.runId)
      ? held
      : link.runId
        ? loadRun(this.root.path, slug, link.runId, this.liveRunId())
        : latestRun(this.root.path, slug, this.liveRunId());
    if (!target) return null;
    if (!RESOLVABLE.includes(target.status) && target.status !== 'parked') return null;

    const now = new Date().toISOString();
    const phase = link.phase;

    // A plan repair for a run that PARKED at the verification preflight: the
    // parked phases never ran, so "fixed" must not mark anything done — they
    // go back to pending, the halt clears, and the auto-continue resume
    // boards them again through the same preflight that parked them. Checked
    // by the halt's own kind, read BEFORE anything clears it, and checked
    // ahead of the generic phase branch below — which would otherwise write
    // `done` on a phase that has not spent a minute.
    if (link.kind === 'plan-repair' && target.halt?.kind === 'verification-preflight') {
      const slotKey = phase != null ? String(phase) : 'plan';
      return this.writeStoredRun(target, (state) => {
        const slot = ((state.recoveries ??= {})[slotKey] ??= { attempts: 0, lastAt: now });
        slot.lastAt = now;
        if (!outcome.fixed) {
          if (state.halt?.reason) slot.lastReason = state.halt.reason;
          delete slot.fixed;
          return;
        }
        for (const record of Object.values(state.phases)) {
          if (record.status !== 'parked') continue;
          if (!VERIFICATION_PARK_NOTE.test(record.note ?? '')) continue;
          record.status = 'pending';
          record.note = undefined;
          record.endedAt = undefined;
          delete record.preflight;
          delete record.mcpDegraded;
        }
        slot.fixed = true;
        delete slot.lastReason;
        state.halt = null;
        state.consecutiveFailures = 0;
        state.resolved = null;
        state.reopenedAt = null;
        state.status = 'parked';
        state.finishedReason = `the plan's §Verification is runnable again — repaired by ${by}. `
          + 'Continue to carry on through the rest of the plan.';
      });
    }

    if (link.kind === 'plan-repair' && phase == null) {
      if (!outcome.fixed) return null;
      // A repair may only clear a halt that was ABOUT the plan's paperwork —
      // by kind, or by the words on a record written before kinds existed.
      const halt = target.halt;
      const lintHalt = halt != null
        && (halt.kind === 'plan-lint' || (!halt.kind && /validate\.sh|plan error/i.test(halt.reason)));
      if (!lintHalt) return null;
      return this.writeStoredRun(target, (state) => {
        state.halt = null;
        state.resolved = null;
        state.reopenedAt = null;
        state.status = 'parked';
        state.finishedReason = `the plan validates again — closed by ${by}. `
          + 'Continue to carry on through the rest of the plan.';
        const slot = ((state.recoveries ??= {}).plan ??= { attempts: 0, lastAt: now });
        slot.lastAt = now;
        slot.fixed = true;
      });
    }

    if (phase == null) return null;

    return this.writeStoredRun(target, (state) => {
      const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: now });
      slot.lastAt = now;
      if (outcome.noDefect && !outcome.fixed) {
        // The recovery concluded nothing was wrong. Clearing the halt and
        // resolving the stop is the honest write; inventing `done` on a
        // phase the board does not show done is not — the record keeps its
        // status, annotated by the resolution.
        slot.lastOutcome = 'no-defect';
        delete slot.lastReason;
        state.halt = null;
        state.consecutiveFailures = 0;
        state.resolved ??= {
          at: now,
          auto: true,
          reason: `a recovery by ${by} found nothing wrong — ${outcome.detail ?? outcome.headline ?? 'verification passes'}`,
        };
        return;
      }
      if (!outcome.fixed) {
        // The failed attempt is bookkeeping the auto-recovery budget reads;
        // the halt keeps standing so the operator still sees why it stopped.
        if (state.halt?.reason) slot.lastReason = state.halt.reason;
        delete slot.fixed;
        slot.lastOutcome = 'failed';
        return;
      }
      const record = phaseRecord(state, phase);
      record.status = 'done';
      record.endedAt ??= now;
      record.note = `closed by ${by}`;
      slot.fixed = true;
      slot.lastOutcome = 'fixed';
      delete slot.lastReason;
      state.halt = null;
      state.consecutiveFailures = 0;
      // Same rule as `start` on resume: the resolution was about the stop this
      // recovery just ended, and left in place it silences the next one's card.
      state.resolved = null;
      state.reopenedAt = null;
      state.status = 'parked';
      state.finishedReason = `phase ${phase} was closed by ${by}. `
        + 'Continue to carry on through the rest of the plan.';
    });
  }

  /**
   * Launch the recovery agent for a halted run, if — and only if — every guard
   * passes. The unattended half of the Fix-with-AI button.
   *
   * The guards run in the order a person would apply them: is the run even
   * asking to be healed, is the halt a kind an agent clears, is the console
   * allowed to spawn agents, is there budget left, and did the *identical*
   * failure already burn an attempt (a loop that fails the same way twice is a
   * person's to read, not a third session's). The attempt counter is bumped
   * and persisted BEFORE the mint, so a console that dies mid-recovery
   * relaunches at most what the budget still allows on the next boot.
   */
  async maybeAutoRecover(slug: string): Promise<AutoRecoverResult> {
    const no = (reason: string, extra: Partial<AutoRecoverResult> = {}): AutoRecoverResult =>
      ({ launched: false, reason, ...extra });
    if (!this.root?.ok) return no('no source directory is open');
    if (this.liveRunner(slug)) return no('the run is live again');

    const state = await this.runFor(slug);
    if (!state) return no('no run of that plan');
    if (!state.autoRecover) return no('the run opted out of auto-recovery');

    /* Resolve-first, for the halt's own phase when there is one: the board is
     * re-read, records it has overtaken close, the halt about them dissolves
     * and nothing is launched for finished work. A standing resolution is an
     * answer somebody already gave. (The same gate runs again on the anchor
     * below — idempotent, and the anchor may be a different phase.) */
    if (state.halt?.phase != null) {
      const gate = await this.preRecoveryGate(slug, state, state.halt.phase);
      if (gate === 'superseded') {
        return no('the board had already moved past the halt — records reconciled, nothing to launch');
      }
      if (gate === 'resolved') return no('the stop is already resolved');
    } else if (state.resolved) {
      return no('the stop is already resolved');
    }

    /* The anchor is no longer "the halt's phase, else the active phase": every
     * open record is CLASSIFIED (runner/situation.ts) and the anchor is the
     * first whose situation has a rung this console can climb (runner/
     * ladder.ts). That is what cures the measured dead end — a parked run
     * whose only open record was `interrupted` had no halt phase and no active
     * phase, so the old derivation answered "no phase to anchor a recovery
     * on" about a phase that had simply never started. */
    const board = await this.boardStates(slug);
    const candidates = await this.classifyOpenPhases(slug, state, board);
    if (!candidates.length) return no('no open phase of this run has a record to act on');

    const journal = new Journal(this.root.path, slug, state.id);
    const caps = ladderCaps(this.prefs);
    const cap = state.autoRecover.attempts;
    const recoveries = (state.recoveries ??= {});
    const runHistory = Object.values(recoveries).flatMap((slot) => slot.rungs ?? []);
    const totalAttempts = Object.values(recoveries).reduce((sum, slot) => sum + (slot.attempts ?? 0), 0);

    let chosen: {
      phase: number; evidence: PhaseEvidence; situation: Situation; rung: Rung; vehicle: DriveVehicle;
    } | null = null;
    let firstRefusal: AutoRecoverResult | null = null;
    const refuse = (reason: string, c: { phase: number; situation: Situation }) => {
      firstRefusal ??= { launched: false, reason, phase: c.phase, situation: c.situation.key, label: c.situation.label };
    };

    for (const c of candidates) {
      const key = String(c.phase);
      const record = state.phases[key];
      const slot = recoveries[key];
      // Settle a rung left open by an earlier climb, by what the board says now
      // — the board's answer, never the fact that a session ended.
      if (slot?.rungs?.some((r) => r.outcome === 'running')) {
        const settled = settleRung(slot, record?.status === 'done' ? 'fixed' : 'failed', undefined,
          record?.status === 'done' ? 'the record reads done' : `the record reads ${record?.status ?? 'absent'}`);
        if (settled) journal.append('phase.rung-settled', { rung: settled.rung, outcome: settled.outcome }, c.phase);
      }
      journal.append('phase.situation', { situation: c.situation.key, sub: c.situation.sub ?? null, why: c.situation.why }, c.phase);
      if (record) record.situation = { key: c.situation.key, at: c.evidence.at, why: c.situation.why };

      if (c.situation.actor === 'wait' || c.situation.actor === 'none') {
        refuse(`phase ${c.phase} reads ${c.situation.label} — nothing to climb`, c);
        continue;
      }
      // A `require` MCP park still on its clock is nobody's to climb: the
      // timer continues the phase without its servers when the clock runs
      // out (re-armed here in case the console that parked it is gone), and
      // `healMcpParks` requeues it sooner if the server heals. Not an errand —
      // that is written when the clock fires, not while it is running.
      if (c.situation.id === 'mcp-unavailable') {
        const due = mcpParkDueAt(record, this.mcpRequireTimeoutMs());
        if (due !== null && due > Date.now()) {
          this.armMcpRequireTimer(slug, c.phase, due);
          refuse(`phase ${c.phase} is parked on an MCP server — it continues without it at `
            + `${new Date(due).toISOString()} unless the server heals first`, c);
          continue;
        }
      }
      // The run's own per-phase launch cap (the launch dialog's number) and
      // the legacy per-run cap still bound the healer, for the records and
      // readers that predate rungs; the ladder's caps apply on top.
      if ((slot?.attempts ?? 0) >= cap) {
        refuse(`phase ${c.phase}'s recovery budget is spent (${cap} launch${cap === 1 ? '' : 'es'})`, c);
        continue;
      }
      if (totalAttempts >= 5) return no('the run recovery budget is spent (5 launches)', { phase: c.phase, situation: c.situation.key, label: c.situation.label });

      // A legacy slot that tried the identical failure once, before rungs were
      // recorded, is read as having climbed the rung the old healer drove —
      // the own session when it had one, the agent otherwise — so the ladder
      // escalates from there instead of repeating it.
      const history: typeof runHistory = slot?.rungs ? [...slot.rungs] : [];
      if (!slot?.rungs && slot?.lastReason && state.halt?.reason === slot.lastReason && (slot.attempts ?? 0) >= 1) {
        const resumable = Boolean(record?.sessionId ?? record?.resumeSessionId);
        for (const rung of rungsFor(c.situation.key)) {
          const own = rung.vehicle === 'resume-own-session' || rung.vehicle === 'closeout-own-session' || rung.vehicle === 'unblock-session';
          const agent = rung.vehicle === 'fix-agent' || rung.vehicle === 'closeout-agent' || rung.vehicle === 'plan-repair-agent';
          if ((resumable && own) || (!resumable && agent)) {
            history.push({ situation: c.situation.key, rung: rung.vehicle, at: slot.lastAt, outcome: 'failed', ...(rung.params ? { params: rung.params } : {}) });
          }
        }
      }

      const next = nextRung({
        // The same day budget the runner's own climb counts against, so the
        // loop's rungs and the healer's cannot each spend it in full.
        situation: c.situation.key, history, runHistory, caps, dayHistory: this.dayRungs(),
        available: (rung) => this.vehicleForRung(rung, c.situation, record, c.evidence) !== null,
      });
      if (!next.ok) {
        if (next.exhausted || c.situation.actor === 'person') {
          const errand = errandFor(c.situation.key, slot?.rungs ?? [], c.phase);
          (recoveries[key] ??= { attempts: 0, lastAt: errand.at }).errand = errand;
          journal.append('phase.errand', { ...errand }, c.phase);
          // The healer's errands push on the same channel and through the same
          // dedupe as the runner's. Which of the two exhausted the ladder is an
          // implementation detail; being asked twice is not.
          this.announceErrand({ slug, runId: state.id, phase: c.phase, errand });
        }
        refuse(`phase ${c.phase} reads ${c.situation.label} — ${next.reason}`, c);
        continue;
      }
      const vehicle = this.vehicleForRung(next.rung, c.situation, record, c.evidence);
      if (!vehicle) { refuse(`phase ${c.phase} reads ${c.situation.label} — ${next.rung.label} cannot be driven here`, c); continue; }
      chosen = { ...c, rung: next.rung, vehicle };
      break;
    }
    try { saveRun(state); } catch { /* the verdict matters more than the write */ }
    this.emit('run:state', { state });
    if (!chosen) return firstRefusal ?? no('nothing the autopilot can climb');

    const { phase, situation, rung, vehicle } = chosen;
    const key = String(phase);
    const gate = await this.preRecoveryGate(slug, state, phase);
    if (gate === 'superseded') {
      return no('the board had already moved past the halt — records reconciled, nothing to launch', { phase, situation: situation.key, label: situation.label });
    }
    if (gate === 'resolved') return no('the stop is already resolved', { phase, situation: situation.key, label: situation.label });

    const answer = (extra: Partial<AutoRecoverResult> = {}): AutoRecoverResult =>
      ({ launched: true, phase, situation: situation.key, label: situation.label, rung: rung.vehicle, vehicle: vehicle.kind, ...extra });
    const now = new Date().toISOString();
    const slot = (recoveries[key] ??= { attempts: 0, lastAt: now });
    const climb = () => {
      // Recorded BEFORE the spend, so a console that dies mid-rung still
      // remembers it tried — and the old `attempts`/`lastAt` move with it.
      accountRung(slot, { situation: situation.key, rung: rung.vehicle, params: rung.params, at: now, note: rung.label });
      if (state.halt?.reason) slot.lastReason = state.halt.reason;
      saveRun(state);
      this.emit('run:state', { state });
      journal.append('phase.rung', { situation: situation.key, rung: rung.vehicle, params: rung.params ?? null, vehicle: vehicle.kind, attempt: slot.attempts }, phase);
      log.info('run.auto-recovery', { slug, runId: state.id, phase, situation: situation.key, rung: rung.vehicle, vehicle: vehicle.kind, attempt: slot.attempts });
      this.announce('session', {
        title: `Auto-recovery started · ${slug} P${phase}`,
        body: `${situation.label} — ${rung.label} (attempt ${slot.attempts} of ${cap}). The run resumes by itself when the board reads fixed.`,
        tag: tagFor('session', state.id, `auto-recover-${phase}-${slot.attempts}`),
      }, { slug, runId: state.id, phase });
    };

    /* The runner's own re-board: reset the record and continue the run under
     * normal admission — the cheapest vehicle there is, and the right one for
     * a phase that never started. */
    if (vehicle.kind === 'retry') {
      if (!this.flags.allowRun) return no('the runner re-board needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      climb();
      void this.retryPhase(slug, phase)
        .catch((error) => {
          log.warn('run.auto-recovery-failed', { slug, phase, error });
          settleRung(slot, 'failed', undefined, (error as Error)?.message ?? String(error));
          try { saveRun(state); } catch { /* best effort */ }
        });
      return answer();
    }

    /* A `require` MCP park past its clock: continue without the servers. No
     * `climb()` — the flip writes both rungs and the errand itself, and the
     * journal line below is the healer's own voice. */
    if (vehicle.kind === 'mcp-continue') {
      if (!this.flags.allowRun) return no('continuing without the MCP server needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      journal.append('phase.rung', { situation: situation.key, rung: rung.vehicle, params: null, vehicle: 'mcp-continue', attempt: slot.attempts }, phase);
      void this.continueMcpParkedPhase(slug, phase, 'auto-recovery')
        .catch((error) => { log.warn('run.auto-recovery-failed', { slug, phase, error }); });
      return answer();
    }

    /* The runner's own re-board WITH A BRIEF: resume the run with the phase
     * reset and hinted, and let boarding assemble the resume/unblock brief.
     * `start({reboard})` does not account the rung — this healer did, above. */
    if (vehicle.kind === 'reboard') {
      if (!this.flags.allowRun) return no('the runner re-board needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      climb();
      const record = state.phases[key];
      void this.startRun(slug, {
        resumeRunId: state.id,
        reboard: [{
          phase, situation: situation.key, rung: rung.vehicle, brief: vehicle.brief,
          ...(record?.sessionId ?? record?.resumeSessionId ? { sessionId: record?.sessionId ?? record?.resumeSessionId } : {}),
          ...(vehicle.escalate ? { escalate: vehicle.escalate } : {}),
          by: 'auto-recovery',
        }],
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
      }).catch((error) => {
        log.warn('run.auto-recovery-failed', { slug, phase, error });
        settleRung(slot, 'failed', undefined, (error as Error)?.message ?? String(error));
        try { saveRun(state); } catch { /* best effort */ }
      });
      return answer();
    }

    /* The phase's own session through the RUNNER — `claude -p --resume`, with
     * the settings file, the deny rules, the hooks and the journal all
     * applying, under `--allow-run` — never a fresh interactive agent with
     * none of that. */
    if (vehicle.kind === 'session') {
      if (!this.flags.allowRun) return no('session recovery needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      climb();
      void this.recoverPhase(slug, phase, vehicle.mode, { by: 'auto-recovery', ...(vehicle.instruction ? { instruction: vehicle.instruction } : {}) })
        .then(async () => {
          const after = this.runners.get(slug)?.current()
            ?? (this.root ? loadRun(this.root.path, slug, state.id, this.liveRunIds()) : null);
          if (!after || after.id !== state.id) return;
          const afterSlot = ((after.recoveries ??= {})[key] ??= { attempts: 0, lastAt: now });
          if (after.status === 'parked' && !after.halt) {
            // No cost here any more: `chargeRung` books each attempt's own
            // spend as it ends. This line passed `PhaseRecord.costUsd`, which
            // is CUMULATIVE across attempts, so a phase that climbed twice
            // would have had its whole history added again on the second
            // settle. Outcome only — the cost half already happened.
            settleRung(afterSlot, 'fixed', undefined, 'the board reads fixed');
            afterSlot.fixed = true;
            afterSlot.lastOutcome = 'fixed';
            delete afterSlot.lastReason;
            delete afterSlot.errand;
            saveRun(after);
            if (this.prefs.autoContinueRecovery !== false && this.flags.allowRun && !this.liveRunner(slug)) {
              log.info('run.recovery-continue', { slug, runId: after.id });
              await this.startRun(slug, {
                resumeRunId: after.id,
                ...(after.onlyPhases?.length ? { onlyPhases: after.onlyPhases } : {}),
                skills: after.skills ?? [],
              });
            }
          } else if (after.status === 'waiting' && after.waitUntil) {
            // The honest middle: the session declared the external clock has
            // still not landed. The park machinery owns it from here.
            settleRung(afterSlot, 'no-defect', undefined, 'the session declared an external wait');
            saveRun(after);
            this.armLimitResume(slug, after);
          } else {
            settleRung(afterSlot, 'failed', undefined, `the run reads ${after.status}${after.halt ? ` — ${after.halt.reason.slice(0, 120)}` : ''}`);
            saveRun(after);
          }
        })
        .catch((error) => {
          log.warn('run.auto-recovery-failed', { slug, phase, error });
          settleRung(slot, 'failed', undefined, (error as Error)?.message ?? String(error));
          try { saveRun(state); } catch { /* best effort */ }
        });
      return answer();
    }

    /* A fresh briefed pty agent — for plan-shaped repairs, for phases whose
     * own session is gone, and for the stronger second try. */
    if (!agentEnabled(this.flags)) return no('agent auto-recovery needs --allow-agent', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
    if (this.terminals.availability() === 'no') return no('agent sessions are unavailable (node-pty)', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });

    const request: RecoveryRequest = { class: vehicle.cls, slug, phase, runId: state.id };
    const resolved = await this.resolveRecovery(request);
    if (!resolved.ok) return no(resolved.error, { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });

    // Spawn as the run's own account: the run's quota, the run's identity.
    const env = state.accountId ? await this.accounts.envFor(state.accountId) : null;
    const account = state.accountId
      ? {
        id: state.accountId,
        env: env
          ? Object.fromEntries(Object.entries(env)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : null,
      }
      : undefined;

    const built = buildAgentLaunch(
      { kind: 'claude', intent: 'recovery', model: state.model },
      {
        skills: () => this.skills(),
        scriptsDir: this.flags.scriptsDir,
        rootOpen: Boolean(this.store),
        recovery: resolved.facts,
        ...(account ? { account } : {}),
      },
    );
    if (!built.ok) return no(built.error, { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });

    // Bumped before the session exists — see `climb`.
    climb();
    const minted = await this.terminals.mint(undefined, undefined, built.launch);
    if (!minted.ok) {
      settleRung(slot, 'failed', undefined, minted.error);
      try { saveRun(state); } catch { /* best effort */ }
      return no(minted.error, { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
    }
    this.runners.get(slug)?.note('run.auto-recovery', { phase, class: vehicle.cls, situation: situation.key, rung: rung.vehicle, attempt: slot.attempts }, phase);
    return answer();
  }

  /* ---------------------------------------------------------------- *
   * QA sessions
   * ---------------------------------------------------------------- */

  /**
   * The live QA session already reviewing a phase, if there is one.
   *
   * Keyed by `(slug, phase)` like a recovery's, and for a sharper reason: two
   * reviewers of one phase write the same report path and race each other's
   * `qa-record.sh` row, so the second one does not merely duplicate work — it
   * can overwrite a verdict nobody read.
   */
  liveQaFor(link: { slug?: string; phase?: number }): SessionInfo | undefined {
    const key = qaKey(link);
    return this.terminals.state().sessions.find((session) =>
      !session.exited && session.meta?.qa && qaKey(session.meta.qa) === key);
  }

  /**
   * Turn "QA this phase" into the brief a reviewer can act on — or say why not.
   *
   * The browser names the phase; every fact in the brief is read here, from the
   * plan, the handoff, the repository's own history and the board. Same split
   * as a recovery, for the same two reasons: a page cannot dictate what a
   * session is told, and a brief cannot quote an exit criterion the plan does
   * not hold.
   *
   * Three refusals live here (the fourth, `--allow-agent`, is the route's, so
   * that a console without the flag never even resolves a brief):
   *
   *  1. **the autopilot is driving** — a review reads the working tree and runs
   *     the phase's tests, and both are meaningless while another session is
   *     editing underneath. Broader than "holds that phase" on purpose: the
   *     tree is shared, so a run on *any* phase invalidates the reading;
   *  2. **the phase is being built right now** — a recovery session on this
   *     exact phase is its author, and reviewing a moving target is not a
   *     review. This is the guard that keeps "independent" true;
   *  3. **a review is already running** for this `(slug, phase)`, whose id the
   *     refusal carries so the client can open it rather than only refuse.
   */
  async resolveQa(
    request: QaRequest,
  ): Promise<
    { ok: true; facts: QaFacts }
    | { ok: false; status: number; error: string; sessionId?: string }
  > {
    const refuse = (status: number, error: string, sessionId?: string) =>
      ({ ok: false as const, status, error, ...(sessionId ? { sessionId } : {}) });

    const root = this.root?.path;
    if (!root) return refuse(409, 'No source directory is open.');

    let record = this.store?.get(request.slug);
    if (!record) return refuse(404, `No plan named ${request.slug}.`);
    if (!record.plan?.graph.some((row) => row.phase === request.phase)) {
      return refuse(404, `${request.slug} has no phase ${request.phase}.`);
    }

    // Same reasoning as `resolveRecovery`: only a run whose scope overlaps the
    // phase under review actually threatens it. A review runs the phase's
    // tests in its tree, so an overlapping run is a genuine refusal — and a
    // disjoint one is not the console's business.
    const reviewing = this.scopeOf(request.slug, request.phase) ?? ['all'];
    for (const live of this.runStates()) {
      const overlapping = this.scheduler.granted(live.id)
        .filter((grant) => scopesIntersect(grant.scope, reviewing));
      if (!overlapping.length) continue;
      return refuse(409,
        `${live.slug} is mid-run (${live.status}) in ${formatScope(overlapping[0].scope)} — a review `
        + 'reads the working tree and runs the phase\'s tests, so pause or stop it first.');
    }

    const building = this.liveRecoveryFor({ slug: request.slug, phase: request.phase });
    if (building) {
      return refuse(409,
        `${request.slug} P${request.phase} is being worked on by a live session — a review of a `
        + 'phase still being changed is not a review. Wait for it to finish.',
        building.id);
    }

    const already = this.liveQaFor(request);
    if (already) {
      return refuse(409,
        `A QA session for ${request.slug} P${request.phase} is already running.`, already.id);
    }

    // A claim this console cannot see the session behind. `building` above only
    // knows about sessions THIS console started; a phase claimed from a
    // terminal, or by an agent in another Claude home, is invisible to it and
    // is exactly the case the lock file exists to cover.
    const handoffsDir = this.root?.handoffsDir;
    const claim = handoffsDir ? readLock(handoffsDir, request.slug, request.phase) : null;
    if (claim && !claim.expired) {
      return refuse(409,
        `${request.slug} P${request.phase} is claimed by ${claim.owner}`
        + (claim.host ? ` on ${claim.host}` : '')
        + ' — a review of a phase still being changed is not a review. Wait for that session, '
        + 'or release the claim.');
    }

    // Activation before the facts are read, so the brief reports the qa-mode
    // the session will actually be gated by rather than the one it replaced.
    if (request.activate) {
      const turned = await this.activateQa(request.slug, request.phase);
      if (!turned.ok) return refuse(409, turned.detail);
      record = this.store?.get(request.slug) ?? record;
    }

    const handoff = handoffFor(record, request.phase);
    const detail = record.plan?.phases[request.phase];
    const padded = String(request.phase).padStart(2, '0');
    const reportArg = `reports/phase-${padded}-qa.md`;

    const [board, engineBrief, qaMode, commits, latestRun] = await Promise.all([
      this.board(request.slug),
      this.qaPrompt(request.slug, request.phase).catch(() => ''),
      this.qaMode(request.slug),
      handoff?.path ? commitsTouching(root, handoff.path, 5) : Promise.resolve([]),
      this.runFor(request.slug).catch(() => null),
    ]);

    const rows = record.plan?.graph ?? [];
    const previous = qaFor(record, request.phase);

    return {
      ok: true,
      facts: {
        slug: request.slug,
        phase: request.phase,
        scriptsDir: this.flags.scriptsDir,
        skillId: phasedExecutionSkillId(this.skills()),
        reportPath: `docs/handoffs/${request.slug}/${reportArg}`,
        reportArg,
        qaMode: qaMode.mode,
        ...(titleOf(rows, request.phase) ? { phaseTitle: titleOf(rows, request.phase) } : {}),
        ...(engineBrief ? { engineBrief } : {}),
        ...(handoff
          ? {
            handoffPath: `docs/handoffs/${request.slug}/${handoff.file}`,
            handoffStatus: handoff.status,
            ...(handoff.keyFiles.length ? { keyFiles: handoff.keyFiles } : {}),
          }
          : {}),
        ...(commits.length ? { commits } : {}),
        ...(detail?.goal ? { goal: detail.goal } : {}),
        ...(detail?.exitCriteria ? { exitCriteria: detail.exitCriteria } : {}),
        ...(detail?.verification ? { verification: detail.verification } : {}),
        ...(record.plan?.sessionBudget.skills?.length
          ? { skills: record.plan.sessionBudget.skills } : {}),
        // A reviewer told nothing about the branch runs the suite on the wrong
        // tree; the brief names it when the plan's latest run is branched.
        ...(latestRun?.gitMode === 'new-branch'
          ? { gitStrategy: { branch: `pe/${request.slug}` } } : {}),
        board: rows.length
          ? rows.map((row) => ({
            phase: row.phase,
            state: board.states[row.phase] ?? 'unknown',
            ...(row.title ? { title: row.title } : {}),
          }))
          : Object.entries(board.states).map(([phase, state]) => ({ phase: Number(phase), state })),
        ...(previous && previous.result !== 'unknown'
          ? { previous: { result: previous.result, ...(previous.report ? { report: previous.report } : {}) } }
          : {}),
      },
    };
  }

  /**
   * The snapshot a QA session is judged against, taken at mint time.
   *
   * Both halves matter: a re-review that lands the same verdict still writes a
   * new report, and without the report path that session would be reported as
   * having recorded nothing.
   */
  qaSnapshot(slug: string, phase: number): { before?: string; beforeReport?: string } {
    const record = this.store?.get(slug);
    const row = record ? qaFor(record, phase) : undefined;
    if (!row) return {};
    return {
      ...(row.result ? { before: row.result } : {}),
      ...(row.report && row.report !== '-' ? { beforeReport: row.report } : {}),
    };
  }

  /**
   * Turn QA on for a plan that has it off.
   *
   * This delegates to the skill's own `--qa` activation (`new-handoff.sh --qa`)
   * rather than writing `test-status.md` here, because activation is not one
   * row — it also **backfills every already-complete phase as `waived`**. Skip
   * that and gating turns on plan-wide, every finished phase reads "no QA
   * result", and their dependents flip ready → waiting: the board would break
   * as a side effect of asking for one review.
   *
   * ⚠️ The script exits **1** in the normal case here, and that is correct: it
   * writes `test-status.md` and *then* refuses to overwrite the phase's
   * existing handoff. Refusing is what protects the handoff, so the exit code
   * is not the verdict — the postcondition is, read back from the engine. A
   * server test pins this, so a future reordering of that script fails the
   * suite rather than silently doing nothing here.
   *
   * With no handoff to protect there is nothing to backfill either, so the
   * lighter `qa-record.sh <phase> pending` is used: it creates the file and
   * says, truthfully, that a review has been asked for and not yet answered.
   */
  async activateQa(slug: string, phase: number): Promise<{ ok: boolean; mode: string; detail: string }> {
    if (!this.flags.allowWrites) {
      return { ok: false, mode: 'off', detail: 'Writes are disabled. Restart with --allow-writes to enable them.' };
    }
    const record = this.store?.get(slug);
    if (!record || !this.root) return { ok: false, mode: 'off', detail: `No plan named ${slug}.` };

    const current = await this.qaMode(slug);
    if (current.mode !== 'off') {
      return { ok: true, mode: current.mode, detail: `QA is already ${current.mode} for ${slug}.` };
    }

    const handoff = handoffFor(record, phase);
    // `unknown` is a parse outcome, not a status the scripts accept — a handoff
    // whose frontmatter the parser could not read must not turn activation into
    // a validation error about a field nobody asked about.
    const status = handoff && handoff.status !== 'unknown' ? handoff.status : 'complete';
    const request = handoff
      ? { action: 'new-handoff' as const, slug, phase, title: handoff.title, status, qa: true }
      : { action: 'qa-record' as const, slug, phase, result: 'pending', report: `reports/phase-${String(phase).padStart(2, '0')}-qa.md` };

    let outcome;
    try {
      outcome = await runWrite(
        planWrite(request, { root: this.root.path, docsDir: this.root.docsDir }),
        { scriptsDir: this.flags.scriptsDir, root: this.root.path },
      );
    } catch (error) {
      // A handoff whose title the write layer will not accept is a reason QA
      // could not be turned on, not a 500 — say which and let the operator use
      // the write menu, where the field is editable.
      return { ok: false, mode: 'off', detail: `Could not turn QA on: ${(error as Error).message}` };
    }

    // Read the postcondition rather than the exit code — see the note above.
    this.reread(slug);
    const mode = (await this.qaMode(slug)).mode;
    const ok = mode !== 'off';
    log.info('qa.activate', { slug, phase, ok, mode, code: outcome.code });
    if (ok) this.invalidateAll();
    return {
      ok,
      mode,
      detail: ok
        ? `QA is now ${mode} for ${slug} — earlier completed phases were recorded as waived.`
        : (outcome.stderr || outcome.stdout).trim() || 'The activation did not turn QA on.',
    };
  }

  /**
   * What the QA session recorded, read back rather than assumed.
   *
   * "The session ended" is not an outcome — every session ends. The question a
   * review is opened to answer is whether a verdict now exists, and the only
   * evidence for that is `test-status.md` having changed for this phase. A
   * session that argues convincingly in its final message and never runs
   * `qa-record.sh` has produced nothing the engine can gate on, and this says
   * so in those words.
   */
  async qaOutcome(link: {
    slug: string; phase: number; before?: string; beforeReport?: string;
  }): Promise<QaOutcome> {
    const { slug, phase } = link;
    if (!this.root) {
      return { recorded: false, headline: `QA for ${slug} P${phase} finished`, detail: 'Nothing to check it against.' };
    }

    // The watcher is debounced and every engine answer is cached by revision,
    // so the session's last commit would otherwise be judged against the table
    // as it stood before the review — P4's `reread` exists for exactly this.
    this.reread(slug);

    const record = this.store?.get(slug);
    const row = record ? qaFor(record, phase) : undefined;
    const result = row?.result;
    const report = row?.report && row.report !== '-' ? row.report : undefined;

    const moved = result !== link.before || report !== link.beforeReport;
    if (isVerdict(result) && moved) {
      return {
        recorded: true,
        result,
        ...(report ? { report } : {}),
        headline: `${slug} P${phase} recorded ${result}`,
        detail: result === 'fail'
          ? `The review recorded FAIL — every dependent of P${phase} stays gated until it is fixed `
            + `and re-reviewed.${report ? ` Report: ${report}` : ''}`
          : `The review recorded ${result}.${report ? ` Report: ${report}` : ''}`,
      };
    }

    return {
      recorded: false,
      ...(result && result !== 'unknown' ? { result } : {}),
      headline: `${slug} P${phase} — no verdict recorded`,
      detail: isVerdict(result)
        ? `test-status.md still reads ${result}, exactly as it did before the session started — `
          + 'nothing new was recorded. Open the session and see what it concluded.'
        : 'The session ended without running qa-record.sh, so the phase has no QA verdict. '
          + 'Open the session and see how far it got.',
    };
  }

  /* ---- signing in ---- */

  /** Free, non-interactive, and about a second — cheap enough to poll. */
  authStatus(force = false): Promise<AuthStatus> {
    return checkAuth(this.root?.path ?? process.cwd(), force);
  }

  /**
   * Open a real terminal on `claude auth login`.
   *
   * The OAuth flow needs a TTY and a browser, so a web page cannot host it. It
   * can, however, remove every step between reading "authentication failed" and
   * being signed in, which is the actual complaint.
   */
  async startLogin(): Promise<{ opened: boolean; command: string; detail?: string }> {
    if (!this.flags.allowRun) throw new Error('Runs are disabled. Restart with --allow-run to enable them.');
    const result = openLoginTerminal(this.root?.path ?? process.cwd());
    forgetAuth();
    return result;
  }

  /* ---- accounts ---- */

  /** Redacted views, always readable — the meters are display, not capability. */
  listAccounts(): Promise<AccountView[]> {
    return this.accounts.list();
  }

  async addTokenAccount(name: string, token: string): Promise<AccountView> {
    this.assertAccountsAllowed();
    return this.accounts.addToken(name, token);
  }

  async removeAccount(id: string): Promise<boolean> {
    this.assertAccountsAllowed();
    // Refuse while a LIVE run pays as this account: its very next spawn would
    // silently land on the machine login — the quiet-wrong the accounts seam
    // exists to prevent. Stored/paused runs already degrade safely (an absent
    // env means the machine login, by design).
    for (const [slug, runner] of this.runners) {
      const state = runner.busy() ? runner.current() : null;
      if (state && (state.accountId ?? DEFAULT_ACCOUNT_ID) === id) {
        throw new Error(`${slug} is running as this account — pause it, or switch its account first.`);
      }
    }
    return this.accounts.remove(id);
  }

  /** Display-name only — ids are journal keys, path segments and keychain hashes. */
  async renameAccount(id: string, name: string): Promise<AccountView | undefined> {
    this.assertAccountsAllowed();
    return this.accounts.rename(id, name);
  }

  /**
   * Put a login in front of the operator for a profile account.
   *
   * Two shapes, tried in order. The embedded terminal (a pty running exactly
   * `claude auth login` under the profile's `CLAUDE_CONFIG_DIR`) is the flow
   * that completes itself — its exit triggers `completeLogin`. When there is
   * no pty to be had (node-pty missing, headless), the same command is opened
   * in Terminal.app or handed back for the operator to paste; `completeLogin`
   * then runs on the next accounts read instead of on an exit event.
   */
  async beginAccountLogin(options: { accountId?: string; name?: string }): Promise<{
    accountId: string;
    command: string;
    mode: 'embedded' | 'external' | 'command';
    terminal?: { sessionId: string; token: string; expiresAt: number };
    detail?: string;
  }> {
    this.assertAccountsAllowed();
    let accountId = options.accountId;
    if (accountId) {
      const meta = this.accounts.meta(accountId);
      if (!meta || meta.kind !== 'profile') throw new Error('Only profile accounts can be signed in here.');
    } else {
      accountId = this.accounts.beginProfile(options.name).id;
    }
    const dir = profileConfigDir(accountId);
    const command = `CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude auth login`;

    const minted = await this.terminals.mint(undefined, undefined, {
      kind: 'claude',
      file: 'claude',
      args: ['auth', 'login'],
      label: `Sign in — ${this.accounts.labelFor(accountId)}`,
      env: { CLAUDE_CONFIG_DIR: dir },
      meta: { intent: 'login', accountId },
    });
    if (minted.ok) {
      return {
        accountId,
        command,
        mode: 'embedded',
        terminal: { sessionId: minted.sessionId, token: minted.token, expiresAt: minted.expiresAt },
      };
    }

    const external = openCommandTerminal(command);
    const detail = external.detail ?? minted.error;
    return {
      accountId,
      command,
      mode: external.opened ? 'external' : 'command',
      ...(detail ? { detail } : {}),
    };
  }

  /** A profile the operator signed in outside the exit hook — re-read it. */
  /**
   * Re-read one account — its login state AND its meters — and answer with
   * what came back.
   *
   * It used to `kick` the poller and then read the cache, which the poll had
   * not replaced yet: the button answered 200 with the same numbers it was
   * pressed to replace, so refreshing appeared to do nothing at all. The fix
   * is to AWAIT the poll (`accounts.refreshUsage`) before building the view.
   */
  async refreshAccount(id: string): Promise<AccountView | undefined> {
    const meta = this.accounts.meta(id);
    if (!meta) return undefined;
    // A profile re-probes its login first — a signed-out profile has no
    // credential to ask the usage endpoint with, and saying "signed out" is
    // more useful than a meter that failed for an unexplained reason.
    if (meta.kind === 'profile') await this.accounts.completeLogin(id);
    await this.accounts.refreshUsage(id);
    const views = await this.accounts.list();
    return views.find((v) => v.id === id);
  }

  /** Every account at once — what a panel's "Refresh" asks for. */
  async refreshAllAccounts(): Promise<AccountView[]> {
    await this.accounts.refreshAllUsage();
    return this.accounts.list();
  }

  /* ---- the desktop launcher ---- */

  /** Where a one-click launcher would land on THIS platform, and whether it can. */
  launcherPlan() {
    return {
      ...launcherPlan({ instanceName: INSTANCE.name, isDefault: INSTANCE.default }),
      rootOpen: Boolean(this.root?.ok),
      fullFlags: FULL_FLAGS,
    };
  }

  /** Write the launcher with THIS console's root and port, every switch on. */
  createDesktopLauncher(): { ok: true; path: string; note: string } {
    if (!this.root?.ok) {
      throw new Error('Open a source directory first — the launcher bakes it in as its ROOT.');
    }
    return installDesktopLauncher({
      root: this.root.path,
      port: this.flags.port,
      instanceName: INSTANCE.name,
      isDefault: INSTANCE.default,
      // The console's own settings, so the artifact starts the console this
      // console IS — remote access and session ceiling included, not just the
      // five switches.
      remoteHosts: this.flags.remoteHosts,
      remoteUsers: this.flags.remoteUsers,
      maxSessions: this.flags.maxSessions,
      defaultSkills: this.flags.defaultSkills,
    });
  }

  private assertAccountsAllowed(): void {
    if (!this.flags.allowAccounts) {
      throw new Error('Account registration is disabled. Restart with --allow-accounts to enable it.');
    }
  }

  /**
   * The pre-flight quota gate: refuse to start a run against a 5-hour window
   * that is already spent (≥97% — the first long phase would only find the
   * wall the expensive way), and warn on the way up. Cached meters only; a
   * console that has never managed to poll starts runs exactly as before.
   */
  private preflightAccount(accountId: string | undefined): void {
    const limited = this.accounts.limitedUntil(accountId);
    const learned = limited.five_hour ?? limited.seven_day;
    if (learned) {
      throw new Error(
        `${this.accounts.labelFor(accountId)} hit its usage limit — it resets ${new Date(learned).toLocaleString()}. `
        + 'Pick another account, or wait.');
    }
    const five = this.accounts.usageFor(accountId)?.buckets.five_hour;
    if (!five) return;
    if (five.utilization >= 97) {
      throw new Error(
        `${this.accounts.labelFor(accountId)} has ${Math.round(100 - five.utilization)}% of its 5-hour window left `
        + `(resets ${new Date(five.resetsAt).toLocaleString()}). Pick another account, or wait.`);
    }
    if (five.utilization >= 80) {
      this.announce('limits', {
        title: 'Starting against a busy window',
        body: `${this.accounts.labelFor(accountId)} is at ${Math.round(five.utilization)}% of its 5-hour window `
          + `(resets ${new Date(five.resetsAt).toLocaleString()}).`,
        tag: tagFor('limits', 'preflight', accountId ?? 'default', five.resetsAt),
      });
    }
  }

  /**
   * The accounts stream, debounced: a poller sweep touches every account in a
   * burst, and one event carrying the whole list is what the header wants.
   */
  /* ---------------- MCP servers ---------------- */

  /** The registry, already redacted by the facade. Never gated — this is display. */
  async listMcp(): Promise<McpServerView[]> {
    return this.mcp.list();
  }

  /**
   * Registering a server is a credential-holding, supply-chain-widening act, so
   * it is behind its own flag — and refused HERE as well as at the route, because
   * the route guard is not the only wall (see `assertAccountsAllowed`).
   */
  assertMcpAllowed(): void {
    if (!this.flags.allowMcp) {
      throw new Error('MCP registration is disabled. Restart with --allow-mcp to enable it.');
    }
  }

  /**
   * Re-probe, then tell every browser. A registry change also invalidates the
   * engine cache: F15's verdict is a function of what is registered, so a plan
   * that linted clean a moment ago may not now.
   */
  async refreshMcp(force = false): Promise<McpServerView[]> {
    await this.mcp.refresh({ force, ...(this.root ? { cwd: this.root.path } : {}) });
    invalidate();
    return this.mcp.list();
  }

  /**
   * Register a server from a browser payload.
   *
   * Validation lives in the facade (`Mcp.add`) rather than here or in the
   * route: it is the layer that knows the registry, and a URL that carries its
   * own credential must be refused whoever asks. This is the shape-narrowing
   * step — turning `unknown` from the wire into the facade's argument.
   */
  async addMcpServer(body: Record<string, unknown>): Promise<McpServerView> {
    this.assertMcpAllowed();
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
    const record = (value: unknown): Record<string, string> | undefined => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const out: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) if (typeof item === 'string') out[key] = item;
      return out;
    };
    const server = await this.mcp.add({
      ...(typeof body.id === 'string' ? { id: body.id } : {}),
      label: typeof body.label === 'string' ? body.label : '',
      transport: typeof body.transport === 'string' ? body.transport : '',
      ...(typeof body.url === 'string' ? { url: body.url } : {}),
      ...(typeof body.command === 'string' ? { command: body.command } : {}),
      ...(strings(body.args) ? { args: strings(body.args)! } : {}),
      ...(record(body.env) ? { env: record(body.env)! } : {}),
      ...(record(body.headers) ? { headers: record(body.headers)! } : {}),
      ...(Array.isArray(body.secretRefs) ? { secretRefs: body.secretRefs as never } : {}),
      ...(record(body.secrets) ? { secrets: record(body.secrets)! } : {}),
      ...(body.alwaysLoad === true ? { alwaysLoad: true } : {}),
      ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
      source: body.source === 'catalog' ? 'catalog' : 'manual',
    });
    // A new server can only be reachable or not; find out rather than showing
    // `unknown` until something else happens to probe.
    void this.refreshMcp(true).catch((error) => log.warn('mcp.refresh-failed', { error }));
    return server;
  }

  /** Rename, enable/disable, or replace a secret. One verb per call. */
  async patchMcpServer(id: string, body: Record<string, unknown>): Promise<McpServerView | undefined> {
    this.assertMcpAllowed();
    if (typeof body.enabled === 'boolean') {
      if (!this.mcp.setEnabled(id, body.enabled)) return undefined;
      // Switching a server OFF is an answer to the phases parked on it, and it
      // used to be treated as unrelated. The operator has said this run does
      // not get that server; the run should stop waiting to be told again.
      if (!body.enabled) void this.healMcpParks(id);
    }
    if (typeof body.secret === 'string' && body.secretRef && typeof body.secretRef === 'object') {
      await this.mcp.setSecret(id, body.secretRef as never, body.secret);
    }
    if (typeof body.label === 'string') return this.mcp.rename(id, body.label);
    return (await this.mcp.list()).find((server) => server.id === id);
  }

  async removeMcpServer(id: string): Promise<boolean> {
    this.assertMcpAllowed();
    const removed = this.mcp.remove(id);
    // Same reasoning as disabling, more so: the thing the phase was waiting for
    // no longer exists on this console, so waiting is the one wrong answer.
    if (removed) void this.healMcpParks(id);
    return removed;
  }

  /**
   * Start `claude mcp login <name>` where a person can answer it.
   *
   * The same multi-modal shape as an account login, and for the same reason:
   * OAuth needs a browser and a paste-back, which is a terminal's job. The
   * console never sees the resulting token — `claude mcp login` writes it into
   * the CLI's own store, which is the one credential store we never touch.
   */
  async beginMcpLogin(id: string): Promise<{
    id: string;
    command: string;
    mode: 'embedded' | 'external' | 'command';
    terminal?: { sessionId: string; token: string; expiresAt: number };
    detail?: string;
  }> {
    this.assertMcpAllowed();
    const meta = this.mcp.meta(id);
    if (!meta) throw new Error(`no MCP server called ${id}`);
    if (meta.transport === 'stdio') {
      throw new Error('a stdio server does not sign in — it needs its environment set, not an OAuth flow.');
    }

    // `--no-browser` because the console is routinely driven from a phone or
    // over ssh: it prints the authorization URL and takes the pasted callback,
    // which works in a terminal pane and degrades to a copyable command when
    // there is none. A local browser flow would simply hang on those machines.
    const command = `claude mcp login ${shellQuote(id)} --no-browser`;
    const minted = await this.terminals.mint(undefined, undefined, {
      kind: 'claude',
      file: 'claude',
      args: ['mcp', 'login', id, '--no-browser'],
      label: `Sign in — ${meta.label ?? id}`,
      meta: { intent: 'login', mcpServer: id },
    });
    if (minted.ok) {
      return {
        id,
        command,
        mode: 'embedded',
        terminal: { sessionId: minted.sessionId, token: minted.token, expiresAt: minted.expiresAt },
      };
    }

    const external = openCommandTerminal(command);
    const detail = external.detail ?? minted.error;
    return { id, command, mode: external.opened ? 'external' : 'command', ...(detail ? { detail } : {}) };
  }

  /**
   * A server came back — re-arm every phase that parked waiting for it.
   *
   * This is the whole point of parking BEFORE the spawn rather than failing
   * after it. The park cost nothing but a probe, it named the server, and the
   * moment somebody signs that server in the run can simply carry on. Nobody
   * has to remember which of six plans was blocked on the thing they just fixed.
   *
   * Deliberately narrow in WHAT it touches: only records parked by the MCP
   * preflight, and only when the note names THIS server. A phase parked for any
   * other reason is left exactly where it is.
   *
   * Deliberately WIDE in when it fires, which it was not. It used to run on one
   * trigger — a `claude mcp login` terminal exiting for that id — and that
   * misses the shapes people actually hit. A server that reports `failed`
   * because its command holds an unfilled `${VAR}` has no login to complete, so
   * it never fired. A server the operator gives up on and switches off or
   * removes stops blocking anything, and it never fired for that either. It is
   * called now on any transition INTO `connected`, and on disable and removal,
   * because in all three cases the reason the phase parked has gone.
   *
   * A halted run is still healable and that is not an accident: `drive()`'s
   * teardown leaves `this.state` in place, the runner stays in the pool, and
   * `retryPhase` restarts a stopped run rather than only resetting a record.
   * Which matters most in exactly the case that motivated all of this — where
   * the MCP park was what halted the run in the first place.
   */
  /* ---- the `require` park's clock ---- */

  /** One armed clock per (plan, phase): the newest due time wins, restarts survive. */
  private mcpRequireTimers = new Map<string, NodeJS.Timeout>();
  /** Announced once per (run, phase): the clock may fire on both sides of a restart. */
  private mcpTimeoutAnnounced = new Set<string>();

  /** The operator's timeout for a `require` park, in ms; 0 = wait indefinitely. */
  private mcpRequireTimeoutMs(): number {
    const value = this.prefs.mcpRequireTimeoutMs;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_MCP_REQUIRE_TIMEOUT_MS;
  }

  /** Arm (or re-arm) the continue-without clock for one parked phase. */
  private armMcpRequireTimer(slug: string, phase: number, dueAt: number): void {
    const key = `${slug}:${phase}`;
    const delay = Math.max(0, dueAt - Date.now());
    if (delay > MAX_TIMER_MS) return;
    const existing = this.mcpRequireTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.mcpRequireTimers.delete(key);
      void this.continueMcpParkedPhase(slug, phase, 'timeout')
        .catch((error) => { log.warn('mcp.require-timeout-failed', { slug, phase, error }); });
    }, delay);
    timer.unref?.();
    this.mcpRequireTimers.set(key, timer);
  }

  /** Every `require` park of a run re-arms its clock — at boot, and for a run that stopped on one. */
  private armMcpRequireTimersFor(state: RunState): void {
    const timeout = this.mcpRequireTimeoutMs();
    for (const record of Object.values(state.phases ?? {})) {
      const due = mcpParkDueAt(record, timeout);
      if (due !== null) this.armMcpRequireTimer(state.slug, record.phase, due);
    }
  }

  /**
   * "Continue without these servers" for ONE `require`-parked phase — the
   * clock's act (`mcpRequireTimeoutMs`), the healer's when a lost clock is
   * found overdue, or a caller's by name. Live run: the runner's own verb
   * (flip, wake, announce through the dep). Stopped run: the stored record is
   * flipped with the same function, journalled in the service's voice, the
   * halt about it cleared, the operator told once — and the run restarted so
   * the loop boards the phase under normal admission. Null when the phase is
   * not (or no longer) such a park; a `timeout` fire against a park that is
   * not yet due (a newer run parked the same phase) re-arms instead.
   */
  async continueMcpParkedPhase(slug: string, phase: number, by = 'timeout'): Promise<McpContinueResult | null> {
    const key = `${slug}:${phase}`;
    const armed = this.mcpRequireTimers.get(key);
    if (armed) { clearTimeout(armed); this.mcpRequireTimers.delete(key); }
    const runner = this.liveRunner(slug);
    if (runner) {
      const record = runner.current()?.phases?.[String(phase)];
      const due = mcpParkDueAt(record, this.mcpRequireTimeoutMs());
      if (by === 'timeout' && due !== null && due > Date.now()) { this.armMcpRequireTimer(slug, phase, due); return null; }
      return runner.continueMcpPark(phase, by);
    }
    if (!this.root?.ok) return null;
    let result: McpContinueResult | null = null;
    let pending: number | null = null;
    const edited = this.editStoredRun(slug, (state) => {
      const record = state.phases?.[String(phase)];
      const due = mcpParkDueAt(record, this.mcpRequireTimeoutMs());
      if (by === 'timeout' && due !== null && due > Date.now()) { pending = due; return; }
      result = continueMcpParkedRecord(state, phase, { by });
      if (!result) return;
      // The park was what stopped this run: the halt about it ends here. A
      // halt about some OTHER phase stands.
      if (state.halt && (state.halt.kind === 'mcp-preflight' || state.halt.phase === phase)) state.halt = null;
    });
    if (pending !== null) { this.armMcpRequireTimer(slug, phase, pending); return null; }
    if (!edited || !result) return null;
    const flipped: McpContinueResult = result;
    const journal = new Journal(this.root.path, slug, edited.id);
    journal.append('phase.mcp-require-timeout', { servers: flipped.servers, waitedMs: flipped.waitedMs, by }, phase);
    journal.append('phase.errand', {
      ...flipped.errand, label: 'MCP server unavailable',
      reason: `waited ${Math.round(flipped.waitedMs / 60_000)} min under the require policy`, by,
    }, phase);
    log.info('mcp.require-timeout', { slug, runId: edited.id, phase, servers: flipped.servers, by });
    this.announceMcpTimeout(edited, phase, flipped);
    this.emit('run:state', { state: edited });
    // Nothing drives a stopped run but a start. `queued` and in-flight runs
    // (under another process) are left to whoever owns them.
    if (this.flags.allowRun && !IN_FLIGHT.includes(edited.status) && edited.status !== 'queued') {
      await this.startRun(slug, {
        resumeRunId: edited.id,
        ...(edited.onlyPhases?.length ? { onlyPhases: edited.onlyPhases } : {}),
        skills: edited.skills ?? [],
      });
    }
    return flipped;
  }

  /** A `require` park timed out and the phase went ahead: say so, once per run per phase. */
  private announceMcpTimeout(state: RunState, phase: number, result: McpContinueResult): void {
    const key = `${state.id}:${phase}`;
    if (this.mcpTimeoutAnnounced.has(key)) return;
    this.mcpTimeoutAnnounced.add(key);
    const one = result.servers.length === 1;
    const minutes = Math.round(result.waitedMs / 60_000);
    // `parked` is the category that announced the park; its ending is the
    // same conversation, so it goes to the same subscribers.
    this.announce('parked', {
      title: `Phase ${phase} continues without ${one ? 'an MCP server' : 'some MCP servers'} — ${state.slug}`,
      body: `${result.servers.join(', ')} did not connect within ${minutes} min under the require policy, so the `
        + 'phase goes ahead without it and was told to record what it could not do. Sign '
        + `${one ? 'it' : 'them'} in under Settings ▸ MCP, or drop the name from the plan.`,
      tag: tagFor('run', 'mcp-timeout', state.slug, String(phase)),
    }, { slug: state.slug, runId: state.id, phase });
  }

  private async healMcpParks(serverId: string): Promise<void> {
    for (const runner of this.runners.values()) {
      const state = runner.current();
      if (!state) continue;
      for (const record of Object.values(state.phases ?? {})) {
        if (record.status !== 'parked') continue;
        const note = record.note ?? '';
        if (!MCP_PARK_NOTE.test(note) || !note.includes(serverId)) continue;
        log.info('mcp.park-healed', { slug: state.slug, phase: record.phase, server: serverId });
        // `parked` is the category that announced the park; its unparking is
        // the same conversation, so it goes to the same subscribers.
        this.announce('parked', {
          title: `Phase ${record.phase} unblocked — ${state.slug}`,
          body: `${serverId} is connected again, so the phase that parked waiting for it has been `
            + 'requeued.',
          tag: tagFor('run', 'mcp-healed', state.slug, String(record.phase)),
        });
        try {
          await this.retryPhase(state.slug, record.phase);
        } catch (error) {
          // A claimed phase refuses; that is correct and not our business to
          // force. The park stays, and the operator's own Retry still works.
          log.warn('mcp.park-heal-refused', { slug: state.slug, phase: record.phase, error });
        }
      }
    }
  }

  /**
   * A phase ran without servers it asked for. Say so, once.
   *
   * Once per run per SERVER, not per phase: a plan with three unreachable
   * servers and seven phases would otherwise be twenty-one notifications for
   * one fact the operator can act on exactly once. The `health` category is
   * right for it — this is the console reporting on its own equipment, not the
   * run asking for anything, and the run is not stopping.
   */
  private announceMcpDegraded(state: RunState, phase: number, degraded: McpDegradation[]): void {
    const fresh = degraded.filter((row) => {
      const key = `${state.id}:${row.id}`;
      if (this.degradedAnnounced.has(key)) return false;
      this.degradedAnnounced.add(key);
      return true;
    });
    if (!fresh.length) return;
    const named = fresh.map((row) => `${row.id} (${row.detail ?? mcpReasonText(row.reason)})`).join(', ');
    const one = fresh.length === 1;
    this.announce('health', {
      title: `${state.slug} is running without ${one ? 'an MCP server' : 'some MCP servers'}`,
      body: `Phase ${phase} started without ${named}. The run is carrying on and the session was told `
        + `to record what it could not do. Sign ${one ? 'it' : 'them'} in from Settings ▸ MCP, or drop `
        + `${one ? 'the name' : 'the names'} from the plan.`,
      tag: tagFor('run', 'mcp-degraded', state.slug),
    });
  }

  private emitMcp(): void {
    // A registry change moves F15, which the lint panel reads from the engine.
    invalidate();
    if (this.mcpEmitTimer) return;
    this.mcpEmitTimer = setTimeout(() => {
      this.mcpEmitTimer = null;
      void this.mcp.list()
        .then((servers) => this.emit('mcp', { servers }))
        .catch((error) => log.warn('mcp.emit-failed', { error }));
    }, 150);
    this.mcpEmitTimer.unref?.();
  }

  private emitAccounts(): void {
    if (this.accountsEmitTimer) return;
    this.accountsEmitTimer = setTimeout(() => {
      this.accountsEmitTimer = null;
      void this.accounts.list()
        .then((accounts) => this.emit('accounts', { accounts }))
        .catch((error) => log.warn('accounts.emit-failed', { error }));
    }, 150);
    this.accountsEmitTimer.unref?.();
  }

  /**
   * Everything that needs a person, across everything, in one answer.
   *
   * Deliberately NOT named `inbox()`: that method is already the NOTIFICATION
   * inbox (`notifications.list`), and quietly taking its name would have
   * broken `GET /api/notifications` with no test to catch it. The two are
   * different things — that one is a log of what happened, this one is a list
   * of what is still owed.
   *
   * Every gatherer is individually guarded. A console whose MCP registry
   * cannot be read should still show its errands: an inbox that throws because
   * one source failed is strictly worse than one missing a row, which is why
   * every field of `InboxFacts` is optional and absent means "nothing to say".
   */
  async attention(all = false): Promise<InboxView> {
    const ok = async <T>(what: string, get: () => Promise<T> | T, fallback: T): Promise<T> => {
      try { return await get(); } catch (error) { log.warn('inbox.source-failed', { what, error }); return fallback; }
    };

    const records = this.store?.list() ?? [];
    const [runs, accounts, auth, mcp, plans] = await Promise.all([
      ok('runs', () => this.allRuns(), [] as RunState[]),
      ok('accounts', () => this.listAccounts(), [] as AccountView[]),
      ok('auth', () => this.authStatus(), { loggedIn: false } as AuthStatus),
      ok('mcp', () => this.listMcp(), [] as McpServerView[]),
      ok('plans', async () => Promise.all(records.map(async (record) => {
        const ctx = await this.context(record);
        const phases = (record.plan?.graph ?? []).map((row) => {
          const detail = record.plan?.phases[row.phase];
          return {
            phase: row.phase,
            title: detail?.title || row.title,
            state: ctx.board.states[row.phase] ?? 'waiting',
            gated: detail?.gated ?? false,
            gateCheck: detail?.gateCheck,
            gateKind: gateKindOf(detail?.gateCheck, detail?.gated ?? false, this.gateVocab),
          };
        });
        // `gateStatus` shells the engine, so it is asked ONLY for the handful
        // of phases whose answer can produce a row: gated, and not already
        // done. On a plan with no gates this costs nothing at all.
        const gates = await Promise.all(phases
          .filter((ph) => ph.gated && ph.state !== 'done')
          .map(async (ph) => [ph.phase, await this.gateStatus(record.slug, ph.phase).catch(() => null)] as const));
        const gateBy = new Map(gates);
        return {
          slug: record.slug,
          title: record.plan?.title ?? record.slug,
          closed: this.isClosedPlan(record.slug),
          updatedAt: record.updatedAt,
          qaMode: await this.qaMode(record.slug).catch(() => ({ mode: 'off' })),
          qa: record.qa ?? [],
          issues: healthIssues(ctx),
          phases: phases.map((ph) => ({ ...ph, gate: gateBy.get(ph.phase) ?? undefined })),
        };
      })), [] as unknown[]),
    ]);

    // The ruling ledgers, and the plans Insights already calls stalled. The
    // portfolio is cached per generation and `attention` has just built every
    // plan's context anyway, so this costs the pure computation and not a
    // second pass over the store.
    const rulings = await ok('rulings', () => this.store?.list().flatMap((record) =>
      (this.isClosedPlan(record.slug) ? [] : this.runRulings(record.slug))) ?? [], [] as Ruling[]);
    const stalledPlans = await ok('stalled-plans', async () => (await this.portfolio()).stalled, []);

    const locks = await ok('locks', () => this.allLocks(), [] as LockView[]);
    const lockPresence: Record<string, 'live' | 'ended' | 'unknown'> = {};
    for (const lock of locks) {
      lockPresence[`${lock.slug}:${lock.phase}`] =
        await ok('lock-presence', () => this.sessions.presenceOfLock(lock), 'unknown' as 'live' | 'ended' | 'unknown');
    }

    const facts = {
      runs, approvals: this.approvals.all(), plans, locks, lockPresence,
      queue: this.queueSnapshot(),
      accounts, auth, mcp,
      environment: this.environment.issues,
      watcher: this.watcher.status(),
      flags: {
        allowWrites: this.flags.allowWrites, allowRun: this.flags.allowRun,
        allowTerminal: this.flags.allowTerminal, allowAgent: this.flags.allowAgent,
        allowAccounts: this.flags.allowAccounts, allowMcp: this.flags.allowMcp,
      },
      rulings,
      stalledPlans,
      // Two ack stores, one map. The ledger's acks are the durable half — they
      // travel with the plan and survive a console reinstall — and this
      // instance's acks file is the local half, which is where every other
      // kind's ack lives and which wins on a conflict because it is the one a
      // person just wrote.
      acks: { ...Service.rulingAcksOf(rulings), ...readAcks(INBOX_ACKS_DIR) },
    } as unknown as InboxFacts;

    const now = Date.now();
    const view = buildInbox(facts, now, { all });
    // An ack for something that is no longer asking is dead weight, and — for
    // the items that have no clock of their own — pruning is the ONLY thing
    // that makes a gone-and-came-back item read as new again.
    try { pruneAcks(INBOX_ACKS_DIR, inboxIds(facts, now)); }
    catch (error) { log.warn('inbox.prune-failed', { error }); }
    return view;
  }

  /**
   * The ledger's own acknowledgements, keyed by the inbox id they belong to.
   *
   * Minted here with `inboxItemId` and never re-derived on the client, so the
   * two halves of the ack story cannot disagree about what an item is called.
   */
  private static rulingAcksOf(rulings: readonly Ruling[]): Record<string, InboxAck> {
    const out: Record<string, InboxAck> = {};
    for (const ruling of rulings) {
      if (!ruling.ack) continue;
      out[inboxItemId({ kind: 'ruling', slug: ruling.slug, phase: ruling.phase, subject: ruling.id })] = ruling.ack;
    }
    return out;
  }

  /** Annotate an inbox item as seen. Never resolution — the ask still stands. */
  ackInbox(id: string, by?: string): boolean {
    try {
      writeAck(INBOX_ACKS_DIR, id, by);
      // A RULING's acknowledgement belongs in the ledger too, as a further
      // appended line. The acks file is this instance's state and the ledger
      // is the plan's record: an ack that lived only in the first would vanish
      // with a reinstall, and `GET /api/run/:slug/rulings` — which reads the
      // file and not the acks — would keep showing the row as unseen.
      const parsed = parseInboxItemId(id);
      if (parsed?.kind === 'ruling' && parsed.slug && parsed.subject && this.root?.ok) {
        appendRulingAck(rulingsFile(this.root.path, parsed.slug), parsed.subject, by);
      }
      this.emit('inbox', { at: new Date().toISOString() });
      return true;
    } catch (error) { log.warn('inbox.ack-failed', { id, error }); return false; }
  }

  /** Undo an annotation. */
  unackInbox(id: string): boolean {
    const gone = removeAck(INBOX_ACKS_DIR, id);
    if (gone) this.emit('inbox', { at: new Date().toISOString() });
    return gone;
  }

  /**
   * Every run on disk, unresolved, for the read-only money questions.
   *
   * Deliberately NOT `allRuns()`: that one calls `resolveAgainstBoard`, which
   * shells `phase-graph.sh` once per plan. Spend is a header widget and the
   * day cap is asked on every ladder climb, so both must be answerable without
   * starting a process. The TTL is short because the only readers are a poll
   * and a climb, and both would rather be a second stale than a scan late.
   */
  private runsForSpend(): SpendRunView[] {
    const now = Date.now();
    if (this.spendPool && now - this.spendPool.at < 5_000) return this.spendPool.runs;
    if (!this.root) return [];
    const slugs = this.store?.list().map((r) => r.slug) ?? [];
    const runs = slugs.flatMap((slug) => listRuns(this.root!.path, slug, this.liveRunId())) as SpendRunView[];
    this.spendPool = { at: now, runs };
    return runs;
  }

  /**
   * Every ladder rung this console climbed today, across every run.
   *
   * The denominator of `ladderPerDayUsd`, which no single run can see: the cap
   * is a promise about the machine, so three runs healing at once must count
   * against one budget rather than three.
   */
  dayRungs(): RungRecord[] {
    return rungsToday(this.runsForSpend(), new Date());
  }

  /** What this console has spent, and against which ceilings. */
  spend(): SpendView {
    return spendSummary(
      { runs: this.runsForSpend(), capUsd: ladderCaps(this.prefs).perDayUsd },
      new Date(),
    );
  }

  /** Every run across every plan, for the runs list. */
  async allRuns(): Promise<RunState[]> {
    const slugs = this.store?.list().map((r) => r.slug) ?? [];
    if (!this.root) return [];
    const runs = slugs.flatMap((slug) => listRuns(this.root!.path, slug, this.liveRunId()));
    await this.resolveAgainstBoard(runs);
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Answer one PreToolUse hook call.
   *
   * The reply shape is the one a live session was measured accepting:
   * `hookSpecificOutput.permissionDecision`, with the reason handed to the
   * model so a denial reads as a decision it can work around rather than an
   * unexplained failure.
   */
  /** Per-session Stop-hook block counter — the loop guard. Bounded; cleared wholesale. */
  private stopBlocks = new Map<string, number>();

  /**
   * The Stop hook's decision: may this session end its turn?
   *
   * Yes when the phase's board reads done, or a valid outcome file is
   * declared, or the session was already blocked twice (the loop guard), or
   * anything about the question cannot be answered — fail open, always: this
   * hook carries workflow, never safety, and the runner's own exit-time
   * check is the load-bearing layer. A block carries the precise
   * instructions: finish the closeout, or declare the wait.
   *
   * `hook.stop-seen` in the log doubles as the runtime probe for whether the
   * CLI fires Stop hooks in `-p` at all — designed not to matter either way.
   */
  async decideStop(body: Record<string, unknown>, runId?: string | null): Promise<Record<string, unknown>> {
    const allow = {};
    const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
    if (!runId || !sessionId || !this.root?.ok) return allow;

    const state = this.runBytoken(runId);
    if (!state) return allow;
    // WHICH phase this session belongs to — matched by session id against the
    // run's own records, never guessed from "the current phase".
    const entry = Object.values(state.phases).find((record) => record.sessionId === sessionId);
    const phase = entry?.phase ?? state.activePhase;
    if (phase == null) return allow;

    log.info('hook.stop-seen', { slug: state.slug, runId: state.id, phase });

    try {
      const board = await this.boardStates(state.slug);
      if (board[phase] === 'done') return allow;
    } catch {
      return allow;
    }

    const declared = readOutcome(outcomeFileFor(state.root, state.slug, state.id, phase), {
      slug: state.slug, phase, ...(entry?.startedAt ? { notBefore: entry.startedAt } : {}),
    });
    if (declared) return allow;

    const blocks = this.stopBlocks.get(sessionId) ?? 0;
    if (blocks >= 2) return allow;
    if (this.stopBlocks.size > 512) this.stopBlocks.clear();
    this.stopBlocks.set(sessionId, blocks + 1);
    log.info('hook.stop-blocked', { slug: state.slug, phase, sessionId, blocks: blocks + 1 });
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        decision: 'block',
        reason: `Phase ${phase} of ${state.slug} is not closed: the board does not read done and no `
          + 'outcome is declared. If you are WAITING on an external process (a CI build, a deploy '
          + 'window), declare it now and stop — prose is invisible to the supervisor: '
          + `\`bash ${this.flags.scriptsDir}/phase-outcome.sh ${state.slug} ${phase} `
          + 'waiting-external --wait-minutes <M> --reason "<what>" --watch <ref>` '
          + '(write the handoff `in-progress` first). Otherwise finish the closeout — run the '
          + 'plan\'s §Verification commands, commit with explicit paths, then run '
          + `\`bash ${this.flags.scriptsDir}/new-handoff.sh ${state.slug} ${phase} <kebab-title> complete\` `
          + 'and fill it in.',
      },
    };
  }

  async decideToolUse(
    body: Record<string, unknown>, runId?: string | null,
  ): Promise<Record<string, unknown>> {
    // The token says WHICH run this call came from, and with a pool that is the
    // only thing that does. Answering under "the current run" would classify a
    // call from a `guarded` run against a `bypass` neighbour's profile — a bug
    // that appears only when two things run at once, and is close to
    // unreadable when it does.
    const run = this.runBytoken(runId);
    if (runId && !run) {
      log.warn('hook.run-unknown', {
        runId, note: 'the token names a run this console is not driving — answered as guarded',
      });
    }
    const toolName = String(body.tool_name ?? 'unknown');
    const input = body.tool_input;
    const phase = run?.activePhase ?? null;

    // What this console has ever been asked about, which is what makes the
    // editor's "learn from the queue" list real rather than a guess.
    this.toolsSeen.add(toolName);

    // Read per call, not per run: a profile switched mid-run has to change the
    // very next classification, and the settings file the child already loaded
    // cannot be reloaded. This is the path that makes the switch immediate.
    const profile: PermissionProfile = run?.permissionProfile ?? 'guarded';
    // The openPr carve-out rides the same read: for a new-branch run that will
    // open a PR, bare `git push` is an ask (a card, one human tap) instead of a
    // deny — and `gh pr create` stays an ask even under `trusted`.
    const policy = carvedPolicy(
      loadPolicyFor(run?.slug ?? null), profile,
      run?.gitMode === 'new-branch' && run.openPr !== false,
    );

    // The hook fires on every matching tool, so most calls have to be answered
    // here without troubling anyone. Only what the policy marks `ask` becomes a
    // card — a queue that fills up with `find docs -type f` is a queue nobody
    // reads, and one nobody reads trains the answer "yes".
    const verdict = classifyTool(toolName, input, policy, profile);
    if (verdict !== 'ask') {
      // A veto is a decision this console made, and it was the one decision it
      // never wrote down: the deny happened inside a hook reply and left no
      // trace, so a phase that quietly worked around a blocked command was
      // unexplainable afterwards. Named rule included — "which line stopped
      // this" is the only question an operator asks next.
      const rule = verdict === 'deny' ? matchedDenyRule(toolName, input, policy) : null;
      if (verdict === 'deny') {
        // The journal of the run that was actually denied, found by token.
        this.runnerByRunId(run?.id ?? '')?.note(
          'phase.tool-denied', { tool: toolName, rule }, phase ?? undefined);
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict,
          permissionDecisionReason: verdict === 'allow'
            ? (profile === 'guarded'
              ? 'not on the autopilot ask list'
              : `this run is on the ${profile} profile — only the deny list stops it`)
            // Worded against what the model does with it. The old text was
            // close enough to the CLI's own rejection wording that a session
            // read standing policy as a person refusing its work, apologised,
            // and tried a way around it. This says whose decision it is, that
            // it will not change on a retry, and what to do instead.
            : `blocked by the console's deny list${rule ? ` (rule: ${rule})` : ''}. `
              + 'This is standing policy, not a person rejecting your work — do not retry the '
              + 'command or look for a way around it; note it in your handoff and carry on.',
        },
      };
    }

    const { decided } = this.approvals.request({
      runId: run?.id ?? 'unknown',
      slug: run?.slug ?? 'unknown',
      phase,
      kind: 'tool',
      title: `${toolName}: ${describeToolInput(input)}`,
      detail: `Phase ${phase ?? '?'} of ${run?.slug ?? 'a run'} wants to use ${toolName}.`,
      evidence: await this.evidenceFor(phase),
      tool: { name: toolName, input, cwd: typeof body.cwd === 'string' ? body.cwd : undefined },
      suggestedRule: suggestedRule(toolName, input, policy),
    });

    const { decision, by, reason } = await decided;

    // Nobody answered. The hook still has to be told something — silence fails
    // open — so it is told no, and the run is parked rather than left to treat
    // that no as a judgement about the work. See `Runner.park`.
    if (by === 'timeout') {
      // The run that asked, not whichever one happens to be first. Parking a
      // neighbour because this one's card timed out would stop a plan that had
      // done nothing wrong.
      this.runnerByRunId(run?.id ?? '')?.park(
        `an approval went unanswered: ${toolName} — ${describeToolInput(input)}`,
        phase,
      );
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: decision === 'allow'
          ? `approved by ${by}`
          : `not approved (${by})${reason ? `: ${reason}` : ''}`,
      },
    };
  }

  /**
   * What a person would have gone and looked up before answering. A bare
   * "allow this?" automates the ceremony of approval and deletes its substance.
   */
  private async evidenceFor(phase: number | null): Promise<Evidence[]> {
    const evidence: Evidence[] = [];
    const root = this.root?.path;
    if (!root) return evidence;

    const [status, diff] = await Promise.all([
      gitRead(root, ['status', '--short']),
      gitRead(root, ['diff', '--stat']),
    ]);
    if (status) evidence.push({ label: 'Working tree', body: status });
    if (diff) evidence.push({ label: 'Uncommitted changes', body: diff });

    const run = this.runStates()[0] ?? null;
    const record = phase === null ? undefined : run?.phases[String(phase)];
    if (record?.verification?.ran.length) {
      evidence.push({
        label: 'Verification so far',
        body: record.verification.ran.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.command}`).join('\n'),
      });
    }
    if (record?.gate) {
      evidence.push({ label: 'Phase gate', body: `${record.gate.kind}: ${record.gate.detail}` });
    }
    return evidence;
  }

  runJournal(slug: string, id: string, limit = 500) {
    if (!this.root) return [];
    return new Journal(this.root.path, slug, id).read(limit);
  }

  savePreferences(patch: Partial<Prefs>): Prefs {
    // The patch arrives straight off an HTTP body, so it is picked apart
    // allowlist-style: only keys this type has, with the types they take. A
    // client must not write arbitrary JSON into config.json, and a mistyped
    // value is dropped — the stored value survives — rather than persisted.
    const picked: Partial<Prefs> = {};
    if (Array.isArray(patch.recentRoots)) picked.recentRoots = patch.recentRoots.filter((r): r is string => typeof r === 'string');
    if (typeof patch.lastRoot === 'string') picked.lastRoot = patch.lastRoot;
    if (patch.theme === 'dark' || patch.theme === 'light' || patch.theme === 'system') picked.theme = patch.theme;
    if (patch.density === 'comfortable' || patch.density === 'compact') picked.density = patch.density;
    if (typeof patch.model === 'string') picked.model = patch.model;
    if (typeof patch.sort === 'string') picked.sort = patch.sort;
    if (typeof patch.attachDefaultSkills === 'boolean') picked.attachDefaultSkills = patch.attachDefaultSkills;
    if (typeof patch.qaByDefault === 'boolean') picked.qaByDefault = patch.qaByDefault;
    if (patch.gitMode === 'default-branch' || patch.gitMode === 'new-branch') picked.gitMode = patch.gitMode;
    if (typeof patch.openPrOnComplete === 'boolean') picked.openPrOnComplete = patch.openPrOnComplete;
    if (typeof patch.repoGuard === 'boolean') picked.repoGuard = patch.repoGuard;
    if (typeof patch.autoRecoverByDefault === 'boolean') picked.autoRecoverByDefault = patch.autoRecoverByDefault;
    if (typeof patch.autoContinueRecovery === 'boolean') picked.autoContinueRecovery = patch.autoContinueRecovery;
    if (isMcpPolicy(patch.mcpPolicy)) picked.mcpPolicy = patch.mcpPolicy;
    // The ladder caps and toggles: numbers must be finite and non-negative,
    // booleans booleans — the same rule `sanitiseAutomation` applies on load.
    const cap = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (cap(patch.ladderPerPhaseRungs)) picked.ladderPerPhaseRungs = patch.ladderPerPhaseRungs;
    if (cap(patch.ladderPerPhaseUsd)) picked.ladderPerPhaseUsd = patch.ladderPerPhaseUsd;
    if (cap(patch.ladderPerRunRungs)) picked.ladderPerRunRungs = patch.ladderPerRunRungs;
    if (cap(patch.ladderPerRunUsd)) picked.ladderPerRunUsd = patch.ladderPerRunUsd;
    if (cap(patch.ladderPerDayUsd)) picked.ladderPerDayUsd = patch.ladderPerDayUsd;
    if (cap(patch.convergeEveryMs)) picked.convergeEveryMs = patch.convergeEveryMs;
    if (cap(patch.budgetAutoRaisePct)) picked.budgetAutoRaisePct = patch.budgetAutoRaisePct;
    if (cap(patch.mcpRequireTimeoutMs)) picked.mcpRequireTimeoutMs = patch.mcpRequireTimeoutMs;
    // Strictly positive, matching `sanitiseAutomation`: a zero threshold would
    // stall-flag every lane on its first tick, which is not a setting anybody
    // means.
    const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
    if (positive(patch.stallSilentMs)) picked.stallSilentMs = patch.stallSilentMs;
    if (positive(patch.stallSpinTurns)) picked.stallSpinTurns = patch.stallSpinTurns;
    if (positive(patch.stallStalemateAttempts)) picked.stallStalemateAttempts = patch.stallStalemateAttempts;
    if (typeof patch.unblockAttempts === 'boolean') picked.unblockAttempts = patch.unblockAttempts;
    if (typeof patch.staleClaimTakeover === 'boolean') picked.staleClaimTakeover = patch.staleClaimTakeover;
    if (typeof patch.resumeAtBoot === 'boolean') picked.resumeAtBoot = patch.resumeAtBoot;
    if (typeof patch.autoAccountSwitch === 'boolean') picked.autoAccountSwitch = patch.autoAccountSwitch;
    // `notify` is a map inside a patch, so a shallow spread alone would let a
    // client sending one toggle reset every other category to its default.
    // Merged off the *current* map (captured before the spread overwrites it),
    // then sanitised: unknown keys are dropped and a category this client has
    // never heard of keeps the value it already had.
    const notify = patch.notify === undefined
      ? this.prefs.notify
      : sanitiseCategories({ ...this.prefs.notify, ...patch.notify });
    this.prefs = { ...this.prefs, ...picked, notify };
    savePrefs(this.prefs);
    return this.prefs;
  }

  /** Remaining-work arithmetic for one plan, used by the analysis panel. */
  async work(slug: string) {
    const record = this.store?.get(slug);
    if (!record?.plan) return null;
    const board = await this.board(slug);
    const sizes = new Map(record.plan.graph.map((r) => [r.phase, record.plan!.phases[r.phase]?.size ?? 'M' as const]));
    const budget = resolveBudget(record.plan.sessionBudget.targetModel, this.sizing);
    return remainingWork(record.plan.graph, board, sizes, this.sizing, budget);
  }
}

/**
 * Human names for the usage endpoint's bucket keys. Unknown keys — a tier that
 * ships after this file — degrade to a readable form of the key itself, so a
 * new window appears in notifications the day it exists rather than after an
 * update here.
 */
function bucketLabel(bucket: string): string {
  if (bucket === 'five_hour') return '5-hour session';
  if (bucket === 'seven_day') return 'weekly (all models)';
  const model = /^seven_day_(.+)$/.exec(bucket)?.[1];
  if (model) return `weekly (${model[0].toUpperCase()}${model.slice(1)})`;
  return bucket.replace(/_/g, ' ');
}
