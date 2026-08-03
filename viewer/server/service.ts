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
  checkRoot, rememberRoot, loadPrefs, savePrefs, serverIsStale, staticRoot,
  type Flags, type Prefs, type RootCheck,
} from './config.ts';
import { Store, handoffFor, lockFor, qaFor, type PlanRecord } from './store.ts';
import {
  run, invalidate, readMemoryBlock, readQaMode, readSessionPlan, readLint, readGateStatus,
  readText, readBoardText, type Board, type QaMode, type SessionPlan, type LintResult,
} from './engine.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import { listSkills, type SkillInfo } from './skills.ts';
import { DocsWatcher } from './watch.ts';
import { degradedState, hasShutdownWork, onDegraded, requestRestart, supervisor } from './lifecycle.ts';
import { log } from './log.ts';
import { CATEGORIES, Push, routeFor, tagFor, type CategoryId } from './push/index.ts';
import { Notifications, type NotificationQuery, type NotificationRecord } from './notifications.ts';
import { repoInfo, lastCommit, type GitRepoInfo, type GitFileInfo } from './git.ts';
import { findMemory, memoryIndexLines } from './memory.ts';
import {
  loadSizing, indexGraph, routeLayout, analysePhases, criticalPath, remainingWork,
  resolveBudget, weightOf, type Sizing, type PhaseAnalysis,
} from './analysis/graph.ts';
import {
  planStats, portfolio, etaSamples, estimateEta,
  type PlanStats, type Portfolio, type PlanContext, type EtaEstimate,
} from './analysis/stats.ts';
import type { PhaseDetail, PhaseRow } from './parse/plan.ts';
import {
  Runner, applySettings,
  type AskResult, type RecoverMode, type RunSettingsPatch, type StartOptions,
} from './runner/runner.ts';
import { Terminals } from './terminal.ts';
import { Journal } from './runner/journal.ts';
import {
  latestRun, listRuns, phaseRecord, saveRun, IN_FLIGHT,
  type RunState, type VerifySummary,
} from './runner/state.ts';
import { readTranscript, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import { checkAuth, forgetAuth, openLoginTerminal, type AuthStatus } from './runner/auth.ts';
import {
  Approvals, classifyTool, loadPolicy, loadPolicyFor, policyExtras, addPolicyRules,
  editPolicy, planPolicyPath, notifyOutOfBand, profilePolicy, suggestedRule,
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
  qa: { phase: number; result: string; report?: string }[];
  locks: { phase: number; owner: string; expired: boolean; leaseUntil?: number; host?: string }[];
  git: GitFileInfo & { dirty?: boolean };
  memory: { key: string; path: string; text: string; indexLines: string[] } | null;
};

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
 * Plans write these as prose — "`claude-opus-4-8` (1M window)", "Opus for the
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

/** Read-only git, for approval evidence. Never fails the request it decorates. */
function gitRead(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout).trim().slice(0, 4_000));
    });
  });
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
  private listeners = new Set<LiveListener>();
  private repo: GitRepoInfo = { available: false, dirty: [] };

  /** Monotonic id per emitted event, so a client can say what it already saw. */
  eventCursor = 0;
  private eventLog: LiveEvent[] = [];
  /** The last run+status announced, so a halt is not announced on every poll. */
  private notifiedRun: { id: string; status: string } | null = null;
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

  readonly runner: Runner;
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
      cwd: () => this.root?.path,
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
    this.runner = new Runner({
      scriptsDir: flags.scriptsDir,
      approvals: this.approvals,
      origin: `http://${flags.host}:${flags.port}`,
      // The plan is the only source for what proves a phase worked, exactly as
      // it is the only source for what the phase should do.
      verificationText: (slug, phase) => this.store?.get(slug)?.plan?.phases[phase]?.verification,
      // …and for what it should run as. These bullets have been in the plan
      // format from the start; until now nothing read them.
      phaseDefaults: (slug, phase) => {
        const detail = this.store?.get(slug)?.plan?.phases[phase];
        if (!detail) return undefined;
        return { model: modelAlias(detail.model), effort: effortOf(detail.effort) };
      },
      onEvent: (event, data) => this.onRunnerEvent(event, data),
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
   */
  private announce(
    category: CategoryId,
    message: { title: string; body: string; tag: string; detail?: string },
    context: { slug?: string | null; phase?: number | null; runId?: string; approvalId?: string } = {},
  ): NotificationRecord {
    const url = routeFor(category, context);
    const record = this.notifications.record({
      category,
      title: message.title,
      body: message.body,
      url,
      slug: context.slug ?? undefined,
      phase: context.phase ?? undefined,
      runId: context.runId,
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
    return check;
  }

  close(): void {
    this.watcher.stop();
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
  } {
    const state = this.runner.current();
    // `hasShutdownWork()` is the real test rather than a status on disk: the
    // runner registers its handler exactly while it is driving, and drops it
    // the moment the loop returns. A `running` row left by a killed process
    // does not register anything, and must not block a restart forever.
    const busy = hasShutdownWork();
    const supervision = supervisor();
    if (busy) {
      return {
        ok: false,
        reason: state
          ? `${state.slug} is mid-run (${state.status}) — restarting would abort the session it is driving `
            + 'and expire every card it is waiting on, unanswerably'
          : 'a run is checkpointing — restarting now would cut it in half',
        supervisor: supervision, busy, run: state ? { slug: state.slug, status: state.status } : null,
      };
    }
    if (!supervision.supervised) {
      return {
        ok: false,
        reason: `${supervision.detail}. Stopping it here would leave nothing serving this page — `
          + 'start it again from a terminal, or install it as an agent (deploy/agent.sh install).',
        supervisor: supervision, busy, run: null,
      };
    }
    return { ok: true, supervisor: supervision, busy, run: null };
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
    if (this.notifiedRun?.id === state.id && this.notifiedRun.status === state.status) return;

    const push = (category: 'halted' | 'parked' | 'finished', title: string, body: string) => {
      this.notifiedRun = { id: state.id, status: state.status };
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

  private onChange(paths: string[]): void {
    if (!this.store) return;
    const slugs = this.store.refresh(paths);
    for (const slug of slugs) {
      invalidate(slug);
      this.boards.delete(slug);
      this.qaModes.delete(slug);
      this.lints.delete(slug);
      for (const key of [...this.sessionPlans.keys()]) if (key.startsWith(`${slug}::`)) this.sessionPlans.delete(key);
      const record = this.store.get(slug);
      if (record) this.search.update(record);
    }
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
      // unrelated reason is not news.
      const touched = new Set(slugs);
      const fresh = [...now].filter((key) => !before.has(key) && touched.has(key.split(':')[0]));
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
    return {
      ...stats,
      engineError: ctx.board.error,
      issueCounts,
      hasHandoffs: ctx.record.handoffs.length > 0,
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
    const value = portfolio(contexts, this.sizing);
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
    this.runner.note('policy.edited', {
      scope, by: edit.by ?? 'console', ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}),
    });
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
      run: this.runner.current(),
      scriptsDir: this.flags.scriptsDir,
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
    const state = await this.runner.start({ ...options, slug, root: this.root.path });
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
  private liveRunId(): string | null {
    return this.runner.busy() ? this.runner.current()?.id ?? null : null;
  }

  /** The live run if there is one, otherwise the last one recorded on disk. */
  runFor(slug: string): RunState | null {
    const live = this.runner.current();
    if (live && live.slug === slug) return live;
    return this.root ? latestRun(this.root.path, slug, this.liveRunId()) : null;
  }

  runsFor(slug: string): RunState[] {
    return this.root ? listRuns(this.root.path, slug, this.liveRunId()) : [];
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
    const weights = new Map(plan.graph.map((r) => [r.phase, weightOf(plan.phases[r.phase]?.size, this.sizing)]));
    const sizes = new Map(plan.graph.map((r) => [r.phase, plan.phases[r.phase]?.size ?? 'M' as const]));
    const board = await this.board(slug);

    // A scoped run is not going to do the rest of the plan, and saying it will
    // is the same defect as not showing the scope in the header at all.
    const run = this.runFor(slug);
    const scope = run?.onlyPhases?.length ? new Set(run.onlyPhases) : null;
    const rows = scope ? plan.graph.filter((r) => scope.has(r.phase)) : plan.graph;

    const budget = resolveBudget(plan.sessionBudget.targetModel, this.sizing);
    const remaining = remainingWork(rows, board, sizes, this.sizing, budget);
    return estimateEta(etaSamples(this.runsFor(slug), weights), remaining);
  }

  /**
   * Everything the session printed, replayed from disk.
   *
   * The live console used to exist only in whichever browser tab happened to be
   * open when the phase ran. This is the same events, kept, so a reload or a
   * console restart does not erase the only record of what a session did.
   */
  runTranscript(slug: string, id: string | undefined, limit = 400): TranscriptEntry[] {
    const runId = id ?? this.runFor(slug)?.id;
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
    const state = latestRun(this.root.path, slug, this.liveRunId());
    if (!state) return null;
    apply(state);
    saveRun(state);
    this.emit('run:state', { state });
    return state;
  }

  async stopRun(slug: string): Promise<RunState | null> {
    const live = this.runner.current();
    if (live?.slug === slug && this.runner.busy()) {
      await this.runner.stop();
      return this.runner.current();
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
    const live = this.runner.current();
    if (live?.slug === slug && this.runner.pause(by)) return this.runner.current();
    return this.editStoredRun(slug, (state) => {
      if (!IN_FLIGHT.includes(state.status)) return;
      state.status = 'pausing';
      state.pause = { requestedAt: new Date().toISOString(), afterPhase: state.activePhase, by };
    });
  }

  /** Take back a pause that has not been reached yet. */
  resumePause(slug: string): RunState | null {
    const live = this.runner.current();
    if (live?.slug === slug && this.runner.resumePause()) return this.runner.current();
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
  askRun(slug: string, question: string, by = 'console', key?: string): AskResult {
    const live = this.runner.current();
    if (!live || live.slug !== slug) {
      return { ok: false, reason: `nothing is running for ${slug} in this console` };
    }
    return this.runner.ask(question, by, key);
  }

  /** The same channel, said as an instruction rather than a question. */
  steerRun(slug: string, instruction: string, by = 'console', key?: string): AskResult {
    const live = this.runner.current();
    if (!live || live.slug !== slug) {
      return { ok: false, reason: `nothing is running for ${slug} in this console` };
    }
    return this.runner.steer(instruction, by, key);
  }

  /**
   * Freeze and thaw the session mid-phase.
   *
   * No on-disk fallback, and for the same reason `askRun` has none: both act on
   * a live child. A run this console is not driving has a child belonging to
   * another console or to nothing, and signalling a pid we do not own is not a
   * fallback, it is a different and much worse action.
   */
  freezeRun(slug: string, by = 'console'): RunState | null {
    const live = this.runner.current();
    if (live?.slug !== slug || !this.runner.freeze(by)) return live?.slug === slug ? live : null;
    return this.runner.current();
  }

  thawRun(slug: string): RunState | null {
    const live = this.runner.current();
    if (live?.slug !== slug || !this.runner.thaw()) return live?.slug === slug ? live : null;
    return this.runner.current();
  }

  /** Change model, autonomy or budgets on a run in flight; applies next phase. */
  configureRun(slug: string, patch: RunSettingsPatch, by = 'console'): RunState | null {
    const live = this.runner.current();
    if (live?.slug === slug && this.runner.configure(patch, by)) return this.runner.current();
    return this.editStoredRun(slug, (state) => { applySettings(state, patch); });
  }

  retryPhase(slug: string, phase: number): RunState | null {
    const live = this.runner.current();
    if (live?.slug === slug && this.runner.busy()) { this.runner.retry(phase); return live; }
    return this.editStoredRun(slug, (state) => {
      const record = phaseRecord(state, phase);
      record.status = 'pending';
      record.note = undefined;
      record.endedAt = undefined;
      state.consecutiveFailures = 0;
      state.halt = null;
    });
  }

  skipPhase(slug: string, phase: number): RunState | null {
    const live = this.runner.current();
    if (live?.slug === slug && this.runner.busy()) { this.runner.skip(phase); return live; }
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
    if (this.runner.busy()) {
      throw new Error('A run is in progress. Pause or stop it before recovering a phase.');
    }
    const root = this.root?.path;
    if (!root) throw new Error('No repository is open.');

    // The most recent run that actually reached this phase — recovery acts on a
    // real record, never on an invented one.
    const target = listRuns(root, slug)
      .find((run) => run.phases[String(phase)]);
    if (!target) throw new Error(`No run of ${slug} has a record for phase ${phase}.`);

    return this.runner.recover({
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
    const run = this.runner.current()?.slug === slug
      ? this.runner.current()!
      : listRuns(root, slug).find((r) => r.phases[String(phase)]);
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
  allRuns(): RunState[] {
    const slugs = this.store?.list().map((r) => r.slug) ?? [];
    return slugs
      .flatMap((slug) => this.runsFor(slug))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Answer one PreToolUse hook call.
   *
   * The reply shape is the one a live session was measured accepting:
   * `hookSpecificOutput.permissionDecision`, with the reason handed to the
   * model so a denial reads as a decision it can work around rather than an
   * unexplained failure.
   */
  async decideToolUse(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = this.runner.current();
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
    const policy = profilePolicy(loadPolicyFor(run?.slug ?? null), profile);

    // The hook fires on every matching tool, so most calls have to be answered
    // here without troubling anyone. Only what the policy marks `ask` becomes a
    // card — a queue that fills up with `find docs -type f` is a queue nobody
    // reads, and one nobody reads trains the answer "yes".
    const verdict = classifyTool(toolName, input, policy);
    if (verdict !== 'ask') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict,
          permissionDecisionReason: verdict === 'allow'
            ? (profile === 'guarded'
              ? 'not on the autopilot ask list'
              : `this run is on the ${profile} profile — only the deny list stops it`)
            : 'on the autopilot deny list — a person must run this themselves',
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
      this.runner.park(
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

    const run = this.runner.current();
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
    this.prefs = { ...this.prefs, ...patch };
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
