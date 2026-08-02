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
  checkRoot, rememberRoot, loadPrefs, savePrefs, serverIsStale,
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
import { degradedState, onDegraded } from './lifecycle.ts';
import { log } from './log.ts';
import { Push, tagFor } from './push/index.ts';
import { repoInfo, lastCommit, type GitRepoInfo, type GitFileInfo } from './git.ts';
import { findMemory, memoryIndexLines } from './memory.ts';
import {
  loadSizing, indexGraph, routeLayout, analysePhases, criticalPath, remainingWork,
  resolveBudget, weightOf, type Sizing, type PhaseAnalysis,
} from './analysis/graph.ts';
import { planStats, portfolio, type PlanStats, type Portfolio, type PlanContext } from './analysis/stats.ts';
import type { PhaseDetail, PhaseRow } from './parse/plan.ts';
import { Runner, applySettings, type RunSettingsPatch, type StartOptions } from './runner/runner.ts';
import { Journal } from './runner/journal.ts';
import { latestRun, listRuns, phaseRecord, saveRun, IN_FLIGHT, type RunState } from './runner/state.ts';
import { readTranscript, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import { checkAuth, forgetAuth, openLoginTerminal, type AuthStatus } from './runner/auth.ts';
import {
  Approvals, classifyTool, loadPolicy, policyExtras, addPolicyRules, notifyOutOfBand,
  DEFAULT_DENY, DEFAULT_ASK, DEFAULT_ALLOW, POLICY_PATH, type Evidence,
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

  readonly runner: Runner;
  readonly approvals: Approvals;
  readonly push: Push;

  constructor(flags: Flags) {
    this.flags = flags;
    this.prefs = loadPrefs();
    this.sizing = loadSizing(flags.scriptsDir);
    this.push = new Push(flags.remoteUsers);
    this.watcher = new DocsWatcher((paths) => this.onChange(paths));
    this.approvals = new Approvals((approval) => {
      this.emit('approval', approval);
      const where = `${approval.slug}${approval.phase != null ? ` phase ${approval.phase}` : ''}`;
      // The browser can only be told if a browser is open. These are the paths
      // that reach an operator who is asleep, which is the case the whole
      // unattended design exists for.
      notifyOutOfBand(`Phase Console: ${approval.title}`, `${where} — ${approval.detail}`);
      this.push.announce('approval', {
        title: approval.kind === 'verify' ? 'A check only you can make' : 'Permission needed',
        body: `${where} — ${approval.title}`,
        tag: tagFor('approval', approval.id),
        url: `/#/plan/${approval.slug}/autopilot`,
      });
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
      this.push.announce('health', {
        title: 'Phase Console is degraded',
        body: `${state.kind}: ${state.message}`,
        tag: tagFor('health', state.kind, state.message),
        url: '/#/settings',
      });
    });
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

  close(): void { this.watcher.stop(); }

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
      notifyOutOfBand(`Phase Console: ${title}`, body);
      this.push.announce(category, {
        title, body, tag: tagFor('run', state.id, state.status), url: `/#/plan/${state.slug}/autopilot`,
      });
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

  /** Each phase as it lands. The steady pulse of a run nobody is watching. */
  private announcePhase(data: unknown): void {
    const event = data as { slug?: string; phase?: number; status?: string } | undefined;
    const { slug, phase, status } = event ?? {};
    if (!slug || typeof phase !== 'number') return;
    if (status !== 'done' && status !== 'failed') return;

    const key = `${slug}:${phase}`;
    if (this.notifiedPhase.get(key) === status) return;
    this.notifiedPhase.set(key, status);

    const title = this.store?.get(slug)?.plan?.phases[phase]?.title;
    this.push.announce('phase', {
      title: `${slug} · phase ${phase} ${status}`,
      body: title ?? (status === 'done' ? 'the phase landed' : 'the phase did not land'),
      tag: tagFor('phase', slug, phase, status),
      url: `/#/plan/${slug}/phase/${phase}`,
    });
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
    this.push.announce('changed', {
      title: 'Plans changed',
      body: slugs.length === 1 ? `${slugs[0]} was written` : `${slugs.length} plans were written`,
      tag: tagFor('changed', ...slugs),
      url: '/#/plans',
    });
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
      this.push.announce('ready', {
        title: fresh.length === 1 ? `${slug} · phase ${phase} is ready` : `${fresh.length} phases became ready`,
        body: fresh.length === 1
          ? (this.store.get(slug)?.plan?.phases[Number(phase)]?.title ?? 'nothing is blocking it now')
          : fresh.join(', '),
        tag: tagFor('ready', ...fresh),
        url: '/#/ready',
      });
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
  policy() {
    return {
      defaults: { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: DEFAULT_ALLOW },
      extra: policyExtras(),
      effective: loadPolicy(),
      file: POLICY_PATH,
    };
  }

  addPolicy(rules: { deny?: string[]; ask?: string[] }) {
    addPolicyRules(rules);
    return this.policy();
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
      allowRun: this.flags.allowRun,
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
  askRun(slug: string, question: string, by = 'console'): { ok: boolean; reason?: string } {
    const live = this.runner.current();
    if (!live || live.slug !== slug) {
      return { ok: false, reason: `nothing is running for ${slug} in this console` };
    }
    return this.runner.ask(question, by);
  }

  /** Change model, autonomy or budgets on a run in flight; applies next phase. */
  configureRun(slug: string, patch: RunSettingsPatch): RunState | null {
    const live = this.runner.current();
    if (live?.slug === slug && this.runner.configure(patch)) return this.runner.current();
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

    // The hook fires on every matching tool, so most calls have to be answered
    // here without troubling anyone. Only what the policy marks `ask` becomes a
    // card — a queue that fills up with `find docs -type f` is a queue nobody
    // reads, and one nobody reads trains the answer "yes".
    const verdict = classifyTool(toolName, input, loadPolicy());
    if (verdict !== 'ask') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict,
          permissionDecisionReason: verdict === 'allow'
            ? 'not on the autopilot ask list'
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
    });

    const { decision, by, reason } = await decided;
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
