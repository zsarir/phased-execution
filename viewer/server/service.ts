/**
 * The service layer: one open source directory, everything the API serves.
 *
 * It owns the store, the engine cache, the search index and the live watcher,
 * and it is the only place that decides what is cached and for how long — a
 * plan's cached engine answers are keyed by its revision, which the watcher
 * bumps whenever one of its files changes.
 */

import { basename } from 'node:path';
import { execFile } from 'node:child_process';

import {
  agentEnabled, checkRoot, rememberRoot, loadPrefs, savePrefs, serverIsStale, staticRoot,
  type Flags, type Prefs, type RootCheck,
} from './config.ts';
import { Store, handoffFor, lockFor, qaFor, readLock, type PlanRecord } from './store.ts';
import { planWrite, runWrite } from './writes.ts';
import {
  run, invalidate, readMemoryBlock, readQaMode, readSessionPlan, readLint, readGateStatus,
  readText, readBoardText, type Board, type QaMode, type SessionPlan, type LintResult,
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
import {
  planStats, portfolio, etaSamples, etaFrom, rateFor, phaseEtaFor, healthIssues, isClosedStatus, splitRepos,
  type PlanStats, type Portfolio, type PlanContext, type EtaEstimate, type EtaSample,
  type PhaseEta, type RateReading,
} from './analysis/stats.ts';
import type { PhaseDetail, PhaseRow } from './parse/plan.ts';
import {
  Runner, applySettings,
  type AskResult, type RecoverMode, type RunSettingsPatch, type StartOptions,
} from './runner/runner.ts';
import { Scheduler, type LockView } from './runner/scheduler.ts';
import { formatScope, scopeOfRow, scopesIntersect } from '../shared/scope.js';
import { Terminals, type SessionEvent, type SessionInfo, type SessionKind } from './terminal.ts';
import { Journal } from './runner/journal.ts';
import {
  childrenOf, latestRun, listRuns, loadRun, phaseRecord, resolveRunsAgainst, saveRun,
  slugsNeedingBoard, IN_FLIGHT, type RunState, type VerifySummary,
} from './runner/state.ts';
import { readTranscript, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import { checkAuth, forgetAuth, openLoginTerminal, type AuthStatus } from './runner/auth.ts';
import {
  RECOVERY_TITLES, recoveryKey,
  type RecoveryClass, type RecoveryFacts, type RecoveryRequest,
} from './recovery.ts';
import { phasedExecutionSkillId } from './agent.ts';
import {
  isVerdict, qaKey, type QaFacts, type QaRequest,
} from './qa-session.ts';
import {
  Approvals, classifyTool, matchedDenyRule, loadPolicy, loadPolicyFor, policyExtras, addPolicyRules,
  editPolicy, planPolicyPath, notifyOutOfBand, carvedPolicy, suggestedRule,
  parseRule, inertRules, HOOK_TOOLS, WRAPPERS_NOT_STRIPPED,
  PERMISSION_PROFILES, PROFILE_LABELS,
  DEFAULT_DENY, DEFAULT_ASK, DEFAULT_ALLOW, POLICY_PATH,
  type Evidence, type PolicyScope, type PermissionProfile,
} from './runner/approvals.ts';

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

export type PhaseView = {
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
  lock?: { owner: string; expired: boolean; leaseUntil?: number };
  handoff?: {
    file: string; status: string; completed?: string; title: string;
    outstanding?: string; skillsUsed: string[]; prompts: number;
  };
};

export type RouteView = {
  nodes: { phase: number; layer: number; row: number; state: string; size: string; gated: boolean; title: string }[];
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
  locks: { phase: number; owner: string; expired: boolean; leaseUntil?: number; host?: string }[];
  git: GitFileInfo & { dirty?: boolean };
  memory: { key: string; path: string; text: string; indexLines: string[] } | null;
};

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
  id: 'recheck' | 'closeout' | 'resume' | 'retry' | 'skip';
  label: string;
  /** What it costs — the thing that was never stated on the old Retry button. */
  detail: string;
};

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
export function recoveryActions(status: string, resumable: boolean): RecoveryAction[] {
  if (status === 'done' || status === 'skipped') return [];

  const actions: RecoveryAction[] = [{
    id: 'recheck',
    label: 'Re-check',
    detail: 'Runs the board, verification and validate.sh again. Starts no session and costs nothing.',
  }];

  if (resumable) {
    actions.push({
      id: 'closeout',
      label: 'Finish this phase',
      detail: 'Resumes this phase\'s own session and asks it to verify, commit and write the handoff.',
    }, {
      id: 'resume',
      label: 'Resume with an instruction',
      detail: 'The same, carrying words you type — for when it needs to fix something first.',
    });
  }

  actions.push({
    id: 'retry',
    label: 'Retry from the start',
    detail: resumable
      ? 'Runs the phase again from its boot prompt. Discards the session above and whatever it had done.'
      : 'Runs the phase again from its boot prompt.',
  }, {
    id: 'skip',
    label: 'Skip',
    detail: 'Marks the phase abandoned and moves on. The plan will read it as not done.',
  });

  return actions;
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
 * The model alias inside a plan's `**Model:**` bullet.
 *
 * Plans write these as prose — "`claude-opus-5` (1M window)", "Opus for the
 * hard reasoning", "Haiku — mechanical". Passing that whole string to `--model`
 * would fail, so only a known alias is taken and anything unrecognised is left
 * to the run's default rather than guessed at.
 */
export function modelAlias(text?: string): string | undefined {
  const match = /\b(fable|opus|sonnet|haiku)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
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

export class Service {
  readonly flags: Flags;
  prefs: Prefs;
  root: RootCheck | null = null;
  store: Store | null = null;
  readonly search = new SearchIndex();
  readonly sizing: Sizing;
  generation = 0;

  private watcher: DocsWatcher;
  private boards = new Map<string, Cached<Board>>();
  private qaModes = new Map<string, Cached<QaMode>>();
  private lints = new Map<string, Cached<LintResult>>();
  private sessionPlans = new Map<string, Cached<SessionPlan>>();
  private portfolioCache: { generation: number; value: Portfolio } | null = null;
  private etaPoolCache: { at: number; value: EtaPool } | null = null;
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
  /** Admission control shared by every runner in the pool. See `scheduler.ts`. */
  readonly scheduler: Scheduler;
  readonly approvals: Approvals;
  readonly push: Push;
  readonly notifications: Notifications;
  readonly terminals: Terminals;

  constructor(flags: Flags) {
    this.flags = flags;
    this.prefs = loadPrefs();
    this.sizing = loadSizing(flags.scriptsDir);
    // A new shell opens where you are working, not in `$HOME` — the source
    // directory is what every command you were about to type is relative to.
    this.terminals = new Terminals({
      allowed: flags.allowTerminal,
      agentAllowed: agentEnabled(flags),
      cwd: () => this.root?.path,
      onSession: (event) => this.onSessionEvent(event),
    });
    this.push = new Push(flags.remoteUsers);
    this.notifications = new Notifications();
    this.watcher = new DocsWatcher((paths) => this.onChange(paths));
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
      // A lock with no `scope=` line: recover what the plan says that phase
      // touches rather than reading it as `all`. See `SchedulerDeps.scopeFor`.
      scopeFor: (slug, phase) => this.scopeOf(slug, phase),
      // The repository guard is a preference, read per call so a flip in the
      // settings page lands on the very next poll. Off never means unguarded
      // within one run — see `SchedulerDeps.guard`.
      guard: () => this.prefs.repoGuard !== false,
      onChange: (snapshot) => this.emit('run:queue', {
        max: snapshot.max,
        live: snapshot.live,
        queued: snapshot.queued,
        throttledUntil: snapshot.throttledUntil,
      }),
    });
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
  concurrency(): { max: number; live: number; queued: number; throttledUntil: number | null } {
    const snapshot = this.scheduler.snapshot();
    return {
      max: snapshot.max,
      // Lanes, not runs. One run driving three phases is three sessions on this
      // machine, and the cap is about sessions.
      live: snapshot.live,
      queued: snapshot.queued,
      throttledUntil: snapshot.throttledUntil,
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
      for (const lock of record.locks) {
        out.push({
          slug: record.slug, phase: lock.phase, owner: lock.owner,
          expired: lock.expired, scope: lock.scope,
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
      origin: `http://${flags.host}:${flags.port}`,
      // The plan is the only source for what proves a phase worked, exactly as
      // it is the only source for what the phase should do.
      verificationText: (slug, phase) => this.store?.get(slug)?.plan?.phases[phase]?.verification,
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
      // The plan's Branch prose and title, for the git-strategy block: the
      // prose is read only to WARN on a mismatch, the title names the PR.
      planBranch: (slug) => this.store?.get(slug)?.plan?.sessionBudget.branch,
      planTitle: (slug) => this.store?.get(slug)?.plan?.title,
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
    });

    if (type !== 'exited') return;
    const code = session.exited?.code ?? 0;
    const failed = code !== 0 || session.exited?.signal != null;
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
      recovery: { ...link, ...outcome },
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
    });
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
    void this.refreshRepoInfo();
    void this.warm();
    void this.readoptQueued();
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
      if (state?.status !== 'queued') continue;
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
    }
  }

  close(): void {
    this.watcher.stop();
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
    if (event === 'run:phase') { this.announcePhase(data); return; }
    if (event !== 'run:run') return;

    const state = (data as { state?: RunState } | undefined)?.state;
    if (!state) return;
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
      case 'waiting':
        push('parked', `${state.slug} is waiting`, 'asleep until a usage window reopens');
        break;
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
   * Each phase as it lands — and the one that lands on a question.
   *
   * `awaiting-verification` reached neither announcer before: `announcePhase`
   * returned early on anything but `done|failed`, and `announceRun` only ever
   * looks at the run. So the single state where a phase has done its work and
   * stopped dead on a check nobody but a person can make was the one state that
   * told nobody. It is not a failure and not a success, so it gets its own
   * category rather than being smuggled into either.
   */
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
   * A live lease is refused. A lease that has not run out is someone working,
   * and no card on this dashboard is worth interrupting them for — `--force` is
   * the operator's own decision to make at a terminal.
   */
  async releaseLock(slug: string, phase: number): Promise<LockRelease> {
    if (!this.flags.allowWrites) throw new Error('Writes are disabled. Restart with --allow-writes to enable them.');
    const handoffsDir = this.root?.handoffsDir;

    // Already gone is a success, not an error — including a source with no
    // handoff folder at all, which cannot be holding a claim. On a bulk release
    // two clients can both be right about a lock only one of them removed.
    const lock = handoffsDir ? readLock(handoffsDir, slug, phase) : null;
    if (!lock) return { slug, phase, ok: true, owner: null, detail: 'already free' };
    if (!lock.expired) {
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
      planWrite({ action: 'lock-release', slug, phase, owner: lock.owner }, { root: this.root!.path }),
      { scriptsDir: this.flags.scriptsDir, root: this.root!.path },
    );
    // Every release is audited. A claim vanishing with no record of who removed
    // it is indistinguishable from a lock file that was never written.
    log.info('lock.released', {
      slug, phase, owner: lock.owner, ok: outcome.ok, code: outcome.code,
      claimedAt: lock.claimedAt, leaseUntil: lock.leaseUntil,
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
    return { scriptsDir: this.flags.scriptsDir, root: this.root!.path };
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
    return { record, board, qaMode };
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

    const phases: PhaseView[] = rows.map((row) => {
      const detail: PhaseDetail | undefined = plan?.phases[row.phase];
      const handoff = handoffFor(record, row.phase);
      const lock = lockFor(record, row.phase);
      const qa = qaFor(record, row.phase);
      return {
        phase: row.phase,
        title: detail?.title || row.title,
        state: ctx.board.states[row.phase] ?? 'waiting',
        size: detail?.size ?? 'M',
        weight: weightOf(detail?.size, this.sizing),
        gated: detail?.gated ?? false,
        gates: detail?.gates,
        gateCheck: detail?.gateCheck,
        model: detail?.model,
        effort: detail?.effort,
        goal: detail?.goal,
        readFirst: detail?.readFirst,
        files: detail?.files,
        steps: detail?.steps,
        exitCriteria: detail?.exitCriteria,
        verification: detail?.verification,
        handoffMustRecord: detail?.handoffMustRecord,
        bullets: detail?.bullets ?? [],
        row,
        analysis: analyses.find((a) => a.phase === row.phase),
        qa: qa ? { result: qa.result, report: qa.report } : undefined,
        lock: lock ? { owner: lock.owner, expired: lock.expired, leaseUntil: lock.leaseUntil } : undefined,
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
          return {
            phase: node.phase, layer: node.layer, row: node.row,
            state: ctx.board.states[node.phase] ?? 'waiting',
            size: detail?.size ?? 'M',
            gated: detail?.gated ?? false,
            title: detail?.title || rows.find((r) => r.phase === node.phase)?.title || `Phase ${node.phase}`,
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
      locks: record.locks.map((l) => ({
        phase: l.phase, owner: l.owner, expired: l.expired, leaseUntil: l.leaseUntil, host: l.host,
      })),
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
      plan: slug ? { slug, path: planPolicyPath(slug), extra: policyExtras(planPolicyPath(slug)) } : null,
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
    by?: string;
  }) {
    const scope: PolicyScope = edit.scope === 'plan' ? 'plan' : 'global';
    if (scope === 'plan' && !edit.slug) throw new Error('a plan-scoped rule needs a plan');
    const file = scope === 'plan' ? planPolicyPath(edit.slug as string) : POLICY_PATH;
    editPolicy({ add: edit.add, remove: edit.remove, by: edit.by ?? 'console' }, file);
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
      // What a NEW run would start with, so the picker can pre-check them and
      // say where they came from. Not what any existing run has — that is on
      // the run.
      defaultSkills: this.flags.defaultSkills,
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

    const state = await this.runnerFor(slug).start({
      ...options,
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

  async stopRun(slug: string, phase?: number | null): Promise<RunState | null> {
    const runner = this.liveRunner(slug);
    if (runner) {
      // A Stop aimed at a phase that is no longer the one running would end a
      // session the operator never looked at. Refusing is the only safe answer
      // — and a Stop is the most expensive control here to get wrong.
      const mismatch = runner.phaseMismatch(phase);
      if (mismatch) throw new Error(mismatch);
      await runner.stop();
      return runner.current();
    }
    return this.editStoredRun(slug, (state) => {
      if (!IN_FLIGHT.includes(state.status)) return;
      state.status = 'interrupted';
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

  async retryPhase(slug: string, phase: number): Promise<RunState | null> {
    const runner = this.liveRunner(slug);
    if (runner) { runner.retry(phase); return runner.current(); }
    // No loop behind it: resetting the record used to be the WHOLE action —
    // the button answered 200, the halt banner cleared, and nothing anywhere
    // was going to run the phase. Retry on a stopped run now means what the
    // operator means by it: clear the failure AND continue the run, under
    // normal admission.
    const edited = this.editStoredRun(slug, (state) => {
      const record = phaseRecord(state, phase);
      record.status = 'pending';
      record.note = undefined;
      record.endedAt = undefined;
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
    const root = this.root?.path;
    if (!root) throw new Error('No repository is open.');

    // The most recent run that actually reached this phase — recovery acts on a
    // real record, never on an invented one.
    const target = listRuns(root, slug)
      .find((run) => run.phases[String(phase)]);
    if (!target) throw new Error(`No run of ${slug} has a record for phase ${phase}.`);

    return this.runnerFor(slug).recover({
      slug, root, runId: target.id, phase, mode,
      instruction: opts.instruction,
      by: opts.by ?? 'console',
    });
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
    const [dirty, lock] = await Promise.all([
      gitPorcelain(run.root),
      this.phaseLock(slug, phase),
    ]);

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
      actions: recoveryActions(record.status, Boolean(record.sessionId ?? record.resumeSessionId)),
    };
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
    if (request.class === 'auth-interrupted') {
      const auth = await this.authStatus(true);
      if (!auth.loggedIn) {
        return refuse(409,
          'Claude is signed out — sign in first, then continue the run. A recovery session '
          + 'cannot authenticate for you.');
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
  }): Promise<{ fixed: boolean; headline: string; detail: string }> {
    const slug = link.slug;
    if (!slug || !this.root) {
      return { fixed: false, headline: 'Recovery finished', detail: 'Nothing to check it against.' };
    }

    // The watcher may not have noticed the session's writes yet, and every
    // engine answer is cached by revision — so ask for a fresh read before
    // judging what the session achieved.
    this.reread(slug);

    if (link.kind === 'plan-repair') {
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
    return {
      fixed,
      headline: `${slug} P${phase} is still ${state}`,
      detail: 'The recovery session ended without moving the board — inspect it before starting another.',
    };
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
