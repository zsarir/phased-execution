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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { skillDirective } from '../skills.ts';
import { classify, fallbackChain, nextModel, type Disposition } from './errors.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type StreamEvent } from './spawn.ts';
import { verifyPhase } from './verify.ts';
import {
  loadRun, newRun, phaseRecord, saveRun, pidAlive, IN_FLIGHT, SETTLED,
  type Autonomy, type PhaseOptions, type RunState, type PhaseStatus, type VerifySummary,
} from './state.ts';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';

export type RunnerEvent = (event: string, data: Record<string, unknown>) => void;

export type RunnerDeps = {
  scriptsDir: string;
  /** Injectable so the loop can be tested without spending money on a model. */
  spawn?: SpawnFn;
  verify?: typeof verifyPhase;
  /** The plan's `**Verification:**` text for a phase, from the service's store. */
  verificationText: (slug: string, phase: number) => Promise<string | undefined> | string | undefined;
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
  onEvent?: RunnerEvent;
  now?: () => Date;
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
  /** How much this run may do unasked. Defaults to `guarded`. */
  permissionProfile?: PermissionProfile;
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
function closeoutPrompt(slug: string, phase: number, boardState: string): string {
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

export class Runner {
  private deps: RunnerDeps;
  private state: RunState | null = null;
  private journal: Journal | null = null;
  private transcript: Transcript | null = null;
  private abort: AbortController | null = null;
  private driving: Promise<void> | null = null;
  private childPid: number | null = null;
  /** The live session, while there is one — what `/btw` talks to. */
  private handle: SpawnHandle | null = null;
  /** Set when the operator stopped us, so exit 143 is not read as a mystery. */
  private stopRequested = false;
  /** Path to the 0600 settings file carrying this run's deny rules and hook. */
  private settingsPath: string | null = null;
  /** Idempotency keys of operator messages already written, newest last. */
  private injected = new Map<string, AskResult>();
  /** Armed while a phase is frozen; fires the escalation to a checkpoint. */
  private freezeTimer: NodeJS.Timeout | null = null;
  /** Set when a freeze was escalated, so the dead child is not read as a crash. */
  private checkpointed = false;
  /** Set while `recover` drives a single session rather than the phase loop. */
  private recovering = false;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  current(): RunState | null { return this.state; }
  busy(): boolean { return this.driving !== null; }

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
    const running = this.state?.child?.phase ?? null;
    if (running == null) {
      return this.driving
        ? `phase ${phase} has no session running just now — the run is between phases, or verifying`
        : `phase ${phase} has nothing running to act on`;
    }
    if (running !== phase) return `phase ${phase} is not the one running — phase ${running} is`;
    return null;
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
      permissionProfile: options.permissionProfile,
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
      const blocked = this.adopt(this.state);
      if (blocked) { this.persist(); return this.state; }
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
    }

    this.journal = new Journal(this.state.root, this.state.slug, this.state.id);
    this.transcript = new Transcript(this.state.root, this.state.slug, this.state.id);

    // Both refusals cost about a second and save a session each. The auth one
    // saves considerably more than that: without it an expired login is
    // discovered once per phase, each time as a session that reports success,
    // spends nothing and does nothing.
    const auth = await checkAuth(this.state.root, true);
    const refusal = preflight(this.state.root) ?? (auth.loggedIn ? null : authRefusal(auth.detail));
    if (refusal) {
      this.state.status = 'parked';
      this.state.halt = { at: new Date().toISOString(), reason: refusal };
      this.record('run.preflight-refused', { reason: refusal });
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
      ...(this.state.onlyPhases?.length ? { onlyPhases: this.state.onlyPhases } : {}),
    });
    this.persist();

    onShutdown('runner', () => this.checkpointForShutdown());
    this.driving = this.drive().finally(() => {
      this.driving = null;
      offShutdown('runner');
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
    // A forward action supersedes the halt that was showing. The reason stays in
    // the journal; what it must not do is keep the run looking stopped while
    // this works.
    state.halt = null;
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

    onShutdown('runner', () => this.checkpointForShutdown());
    this.recovering = true;
    this.driving = this.runRecovery(options).finally(() => {
      this.driving = null;
      this.recovering = false;
      offShutdown('runner');
      this.deps.approvals?.disarm();
      this.persist();
      this.emit('run', { state });
    });
    return state;
  }

  private async runRecovery(options: RecoverOptions): Promise<void> {
    const state = this.state!;
    const record = phaseRecord(state, options.phase);
    const owner = `autopilot/${state.id}`;

    try {
      if (options.mode !== 'recheck') {
        // An operator asking again is a new fact, not a repeat of the automatic
        // attempt — so the once-only guard is cleared rather than honoured.
        record.closeout = undefined;
      }

      if (options.mode === 'resume') {
        const said = await this.resumeWithInstruction(options.phase, options.instruction ?? '');
        if (said) { this.halt(said, options.phase); return; }
      }

      const ok = await this.confirm(options.phase);
      if (!ok) return; // confirm() halted and said why

      state.status = 'parked';
      state.finishedReason = `phase ${options.phase} was closed by ${options.by ?? 'console'}. `
        + 'Continue to carry on through the rest of the plan.';
      this.record('run.recovered', { phase: options.phase, mode: options.mode }, options.phase);
    } catch (error) {
      log.error('runner.recover.crashed', { error });
      this.halt(`the recovery of phase ${options.phase} failed: ${(error as Error)?.message ?? error}`, options.phase);
    } finally {
      await this.release(options.phase, owner);
      this.childPid = null;
      this.handle = null;
      state.child = null;
    }
  }

  /** Resume the phase's session with the operator's own words. Returns a refusal. */
  private async resumeWithInstruction(phase: number, instruction: string): Promise<string | null> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const sessionId = record.sessionId ?? record.resumeSessionId;
    if (!sessionId) {
      return `phase ${phase} has no session left to resume — retry it instead, or close it by hand`;
    }

    const spawn = this.deps.spawn ?? spawnClaude;
    const board = await this.board();
    const prompt = instruction.trim()
      ? `${instruction.trim()}\n\n---\n\n${closeoutPrompt(state.slug, phase, board.states[phase] ?? 'unknown')}`
      : closeoutPrompt(state.slug, phase, board.states[phase] ?? 'unknown');

    this.record('phase.resume-instruction', { sessionId, instruction: instruction.slice(0, 2_000) }, phase);
    // A resumed phase IS running, and nothing said so. The record kept whatever
    // terminal status it had halted on, so the header clock never started, the
    // dashboard counted the run as stopped, and the runs list showed a finished
    // run with a live session underneath it. The phase clock reads `startedAt`,
    // which is left alone when the phase already has one — this is a second
    // stretch of the same phase, not a new one.
    record.status = 'running';
    record.startedAt ??= new Date().toISOString();
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
        onHandle: (handle) => { this.handle = handle; },
        env: { ...process.env, PE_OWNER: `autopilot/${state.id}` },
        signal: this.abort?.signal,
        // The same wiring `attempt` uses, and for the same reason: `state.child`
        // is what Freeze and Stop signal, and what the console reads to know a
        // session is alive. Recorded here it was a bare pid nobody else could
        // see, so a recovery could not be frozen or stopped at all.
        onPid: (pid) => {
          this.childPid = pid;
          state.child = { pid, phase, sessionId, startedAt: new Date().toISOString() };
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      });
    } finally {
      this.childPid = null;
      this.handle = null;
      state.child = null;
    }

    state.spentUsd += outcome.costUsd;
    record.costUsd += outcome.costUsd;
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
    }));
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
    const token = approvals.liveToken();
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
    const child = state.child;
    if (!child) return null;

    const record = phaseRecord(state, child.phase);
    if (pidAlive(child.pid)) {
      state.status = 'parked';
      state.halt = {
        at: new Date().toISOString(),
        reason: `a session from an earlier console is still running (pid ${child.pid}, phase ${child.phase}). `
          + 'Let it finish or stop it, then start this run again.',
        phase: child.phase,
      };
      record.status = 'running';
      this.record('run.adopt.alive', { pid: child.pid, phase: child.phase }, child.phase);
      return state.halt.reason;
    }

    state.child = null;
    // The phase may in fact have completed — the child could have written its
    // handoff and exited in the moment the console was gone. The board says so
    // or it does not; either way this is checked, never assumed.
    record.status = 'interrupted';
    record.note = `the console stopped while phase ${child.phase} was running (pid ${child.pid})`;
    this.record('run.adopt.interrupted', { pid: child.pid, phase: child.phase }, child.phase);
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
  freeze(by = 'console'): boolean {
    const state = this.state;
    if (!state || !this.driving) return false;
    if (state.status === 'frozen') return true;
    const pid = this.childPid;
    if (!pid || !pidAlive(pid)) return false;

    try { process.kill(pid, 'SIGSTOP'); } catch (error) {
      log.warn('runner.freeze', { pid, error });
      return false;
    }

    const phase = state.activePhase;
    state.status = 'frozen';
    state.freeze = {
      at: new Date().toISOString(),
      phase,
      pid,
      by,
      escalateAt: new Date(this.now().getTime() + FREEZE_ESCALATE_MS).toISOString(),
    };
    this.record('run.frozen', { pid, phase, by, escalateAt: state.freeze.escalateAt }, phase ?? undefined);
    this.persist();
    this.emit('run', { state });

    this.freezeTimer = setTimeout(() => this.escalateFreeze(), FREEZE_ESCALATE_MS);
    this.freezeTimer.unref?.();
    return true;
  }

  /** Let a frozen session carry on, mid-token, in the same process. */
  thaw(): boolean {
    const state = this.state;
    if (!state || state.status !== 'frozen') return false;
    const pid = state.freeze?.pid;
    this.clearFreezeTimer();

    if (pid && pidAlive(pid)) {
      try { process.kill(pid, 'SIGCONT'); } catch (error) {
        log.warn('runner.thaw', { pid, error });
        return false;
      }
    }

    // Frozen time is not work time. Left in, an hour on the kitchen table would
    // show up as an hour the phase spent thinking, and every throughput figure
    // built on it would be wrong.
    const frozenMs = state.freeze ? Math.max(0, this.now().getTime() - Date.parse(state.freeze.at)) : 0;
    if (frozenMs && state.activePhase != null) {
      const record = phaseRecord(state, state.activePhase);
      record.frozenMs = (record.frozenMs ?? 0) + frozenMs;
    }
    // Same rule as the wait-until disposition: a pause armed while the session
    // was frozen is still a pause, and thawing is not taking it back — that is
    // what `resumePause` is for.
    state.status = state.pause ? 'pausing' : 'running';
    state.freeze = null;
    this.record('run.thawed', { pid, frozenMs }, state.activePhase ?? undefined);
    this.persist();
    this.emit('run', { state });
    return true;
  }

  /**
   * A freeze nobody came back to. Convert it into something that survives a
   * closed laptop: stop the child, keep its session id, and leave the phase
   * pending so Continue re-runs it with `--resume` rather than from scratch.
   */
  private escalateFreeze(): void {
    const state = this.state;
    this.freezeTimer = null;
    if (!state || state.status !== 'frozen') return;
    const pid = state.freeze?.pid;
    const phase = state.freeze?.phase ?? state.activePhase;
    const record = phase != null ? phaseRecord(state, phase) : null;
    const sessionId = record?.sessionId;

    this.checkpointed = true;
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
    state.freeze = null;
    state.child = null;
    state.status = 'paused';
    state.halt = null;
    this.record('run.freeze-escalated', {
      pid, phase, sessionId: sessionId ?? null, afterMs: FREEZE_ESCALATE_MS,
    }, phase ?? undefined);
    this.persist();
    this.emit('run', { state });
  }

  private clearFreezeTimer(): void {
    if (!this.freezeTimer) return;
    clearTimeout(this.freezeTimer);
    this.freezeTimer = null;
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
    // A stopped process cannot act on SIGTERM: the signal is queued and its own
    // SessionEnd hooks never run, so a frozen phase stopped from the console
    // would sit there until SIGKILL. Wake it first, then ask it to stop.
    this.clearFreezeTimer();
    const frozenPid = this.state.freeze?.pid;
    if (frozenPid && pidAlive(frozenPid)) {
      try { process.kill(frozenPid, 'SIGCONT'); } catch { /* already gone */ }
    }
    this.state.freeze = null;
    this.state.status = 'stopping';
    this.record('run.stop-requested', { pid: this.childPid ?? undefined, wasFrozen: Boolean(frozenPid) });
    this.persist();
    this.abort?.abort();
    if (this.childPid) {
      const pid = this.childPid;
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
  ask(question: string, by = 'console', key?: string): AskResult {
    return this.inject('ask', question, by, key);
  }

  /**
   * Tell the phase to do something differently. See `frameSteer` for why this
   * is a separate verb rather than an Ask with different words.
   */
  steer(instruction: string, by = 'console', key?: string): AskResult {
    return this.inject('steer', instruction, by, key);
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
  private inject(kind: 'ask' | 'steer', body: string, by: string, key?: string): AskResult {
    const text = body.trim();
    if (!text) return { ok: false, reason: kind === 'ask' ? 'nothing to ask' : 'nothing to say' };
    if (text.length > 8_000) return { ok: false, reason: 'that is longer than a message' };

    if (key) {
      const seen = this.injected.get(key);
      // Answered from the record rather than re-sent. The caller cannot tell the
      // difference, which is the point of an idempotency key.
      if (seen) return { ...seen, repeated: true };
    }

    const handle = this.handle;
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

    const phase = this.state?.activePhase ?? undefined;
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
  park(reason: string, phase: number | null = null): boolean {
    if (!this.state) return false;
    if (this.state.halt) return false;
    const at = phase ?? this.state.activePhase;
    this.state.halt = { at: new Date().toISOString(), reason, ...(at !== null ? { phase: at } : {}) };
    this.state.status = 'parked';
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

  /** Clear a phase's terminal state so the loop will pick it up again. */
  retry(phase: number): void {
    if (!this.state) return;
    const record = phaseRecord(this.state, phase);
    record.status = 'pending';
    record.note = undefined;
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
    try {
      while (true) {
        if (this.abort?.signal.aborted) {
          state.status = 'paused';
          state.pause = null;
          state.finishedReason ??= 'stopped by the operator';
          break;
        }
        if (state.status === 'pausing') {
          state.status = 'paused';
          this.record('run.paused', { afterPhase: state.pause?.afterPhase ?? null });
          state.finishedReason = state.pause?.afterPhase != null
            ? `paused by ${state.pause.by} after phase ${state.pause.afterPhase} finished`
            : `paused by ${state.pause?.by ?? 'the operator'} at a phase boundary`;
          state.pause = null;
          break;
        }
        if (state.runBudgetUsd && state.spentUsd >= state.runBudgetUsd) {
          this.halt(`the run budget of $${state.runBudgetUsd} is spent`);
          break;
        }

        const board = await this.board();
        // Re-read, because `board()` is a `phase-graph.sh` subprocess and the
        // whole gap between the check at the top of this loop and here is time
        // an operator can press Pause in. They did, repeatedly, and watched the
        // next phase start anyway: the flag was set a few hundred milliseconds
        // after the only line that read it. Going back to the top rather than
        // breaking here keeps ONE piece of pause bookkeeping, up there.
        if (state.status === 'pausing') continue;
        if (board.error) { this.halt(`the engine could not read the plan: ${board.error}`); break; }

        const outstanding = [...board.ready, ...board.waiting, ...board.inProgress, ...board.stuck];
        // A run asked for specific phases is finished when THOSE are settled —
        // not when the plan is. Restricting the candidate list here rather than
        // in the caller keeps one definition of "ready" (the engine's).
        const asked = state.onlyPhases?.length ? new Set(state.onlyPhases) : null;
        const candidates = board.ready
          .filter((p) => !asked || asked.has(p))
          .filter((p) => !SETTLED.includes(phaseRecord(state, p).status));

        if (asked && !candidates.length) {
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
          state.status = outstanding.length ? 'parked' : 'finished';
          state.finishedReason = outstanding.length
            ? undefined
            : `every phase of ${state.slug} is done.`;
          if (outstanding.length) {
            // Parking with work left is not self-explanatory: every ready phase
            // is in a state this loop will not pick up again by itself, and the
            // operator needs to know which and why to know what to press.
            const held = board.ready
              .map((p) => `phase ${p} is ${phaseRecord(state, p).status}`)
              .join(', ');
            state.halt ??= {
              at: new Date().toISOString(),
              reason: held
                ? `nothing left to run on its own — ${held}. Retry or skip them to carry on.`
                : `nothing is ready to run: ${outstanding.length} phase(s) are still waiting on a gate or an earlier phase.`,
            };
            state.finishedReason = state.halt.reason;
          }
          this.record(outstanding.length ? 'run.parked' : 'run.finished', {
            outstanding, done: board.done,
          });
          break;
        }

        const carryOn = await this.runPhase(candidates[0], board);
        this.persist();
        if (!carryOn) break;
      }
    } catch (error) {
      // A throw in here would otherwise be an unhandled rejection, which is one
      // of the ways this console used to disappear.
      log.error('runner.crashed', { error });
      this.halt(`the runner itself failed: ${(error as Error)?.message ?? error}`);
    } finally {
      state.child = null;
      this.childPid = null;
      this.clearFreezeTimer();
      // A freeze cannot outlive the loop that would have thawed it.
      state.freeze = null;
      // The token dies with the loop. Anything still waiting on a decision is
      // answered rather than left holding a socket nobody is watching.
      this.deps.approvals?.disarm();
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

  /** Returns false when the run must stop. */
  private async runPhase(phase: number, board: Board): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    // Where the run was pointing before this call. Everything between here and
    // the spawn is an await, so a phase can still turn out not to start — and
    // one that never starts must not leave the run claiming to be on it.
    const wasActive = state.activePhase;
    state.activePhase = phase;

    /* ---- gate ---- */
    const gate = readGateStatus(await this.engine(['--gate-status', String(phase)]));
    record.gate = gate;
    if (!gate.clear) {
      record.status = 'parked';
      record.note = `gate not clear: ${gate.kind}${gate.detail ? ` — ${gate.detail}` : ''}`;
      this.record('phase.gated', { gate }, phase);
      this.emit('phase', { phase, status: record.status, gate });
      // Other ready phases may still be runnable, so this is not a halt.
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
     * can park rather than start a session that would immediately stop. */
    const owner = `autopilot/${state.id}`;
    const status = await this.script('phase-lock.sh', [state.slug, 'status', String(phase)]);
    const holder = /held by (\S+)/.exec(status.stdout)?.[1];
    if (holder && holder !== owner) {
      record.status = 'parked';
      record.note = `phase ${phase} is locked by ${holder} — ${status.stdout.trim().slice(0, 160)}`;
      this.record('phase.lock-refused', { holder, detail: record.note }, phase);
      return true;
    }

    /* ---- prompt ---- */
    const engineText = readText(await this.engine(['--boot-prompt', String(phase)]));
    if (!engineText.trim()) {
      await this.release(phase, owner);
      this.halt(`the engine produced no boot prompt for phase ${phase}`, phase);
      return false;
    }
    // Appended, never woven in: `phase-graph.sh` stays the only thing that
    // decides what a boot prompt says about the plan — including the plan's own
    // skills line. This is the operator adding to it for one run.
    const extraSkills = [...(state.skills ?? []), ...(state.phaseOptions?.[String(phase)]?.skills ?? [])];
    const prompt = engineText + skillDirective(extraSkills);
    if (extraSkills.length) this.record('phase.skills', { skills: [...new Set(extraSkills)] }, phase);

    /* ---- the last chance to not start ----
     * The gate check, the lock check and the boot prompt are three subprocesses
     * — seconds, sometimes more. A pause armed during them used to be read only
     * after the session had already been spawned, which is the same defect as
     * the one at the top of `drive` and needs the same answer in the one place
     * that can still act on it: immediately before the phase is marked running.
     * `true` because the run carries on to the loop top, which owns every piece
     * of pause bookkeeping and will stop there. */
    if (state.status === 'pausing' || this.abort?.signal.aborted) {
      state.activePhase = wasActive;
      await this.release(phase, owner);
      this.record('phase.not-started', {
        reason: state.status === 'pausing' ? 'a pause was armed before it started' : 'the run was stopped',
      }, phase);
      return true;
    }

    /* ---- what this phase runs as ---- */
    const chosen = this.optionsFor(phase);
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    record.model = record.model ?? chosen.model;
    record.effort = record.effort ?? chosen.effort;
    this.record('phase.start', {
      model: record.model, effort: record.effort ?? null,
      // Where each choice came from, so a phase that ran on an unexpected model
      // can be explained without re-reading three files.
      source: chosen.source,
      ...(chosen.tools?.length ? { tools: chosen.tools } : {}),
      ...(chosen.permissionMode ? { permissionMode: chosen.permissionMode } : {}),
      title: board.states[phase],
    }, phase);
    this.emit('phase', { phase, status: 'running', model: record.model, effort: record.effort });

    /* ---- the session, with the error policy driving retries ---- */
    const settled = await this.attempt(phase, prompt, record.model!, owner, chosen);
    if (!settled.carryOn) { await this.release(phase, owner); return false; }
    if (!settled.completed) { await this.release(phase, owner); return true; }

    /* ---- independent verification ----
     * The lock is held across this, and released after. It used to be released
     * first, which meant a phase sitting in `awaiting-verification` — up to
     * twelve hours — was unlocked and read `ready` to every other session that
     * looked. Closeout needs it held too: it resumes the session that owns it. */
    try {
      return await this.confirm(phase);
    } finally {
      await this.release(phase, owner);
    }
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
      source,
    };
  }

  /**
   * Run the phase until it either finishes or the error policy says to stop.
   * Every disposition from `classify` is handled here and nowhere else.
   */
  private async attempt(
    phase: number, prompt: string, model: string, owner: string, chosen: PhaseOptions = {},
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
    }
    let budget = state.phaseBudgetUsd;
    let maxTurns: number | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      record.attempts++;
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
        permissionMode: chosen.permissionMode as never,
        // Read fresh each attempt, so a profile changed mid-run is in force for
        // the next phase rather than for the next run.
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { this.handle = handle; },
        // The child must know it IS the lock holder. Without this the runner
        // claims the phase as `autopilot/<runId>`, the session it spawns reads
        // a lock owned by a stranger, and — correctly, per the skill's own
        // guardrail — refuses to touch the phase rather than force it. The
        // supervisor deadlocks against its own worker. Sharing PE_OWNER makes
        // phase-lock.sh report the lock as the session's own, so it refreshes
        // instead of stopping, while everyone else still sees it held.
        env: { ...process.env, PE_OWNER: owner },
        signal: this.abort?.signal,
        onPid: (pid) => {
          this.childPid = pid;
          state.child = { pid, phase, sessionId: record.sessionId ?? '', startedAt: new Date().toISOString() };
          this.persist();
        },
        onEvent: (event) => this.onStream(phase, event),
      });

      this.childPid = null;
      this.handle = null;
      state.child = null;
      state.spentUsd += outcome.costUsd;
      record.costUsd += outcome.costUsd;
      record.turns = (record.turns ?? 0) + outcome.turns;
      // Wall-clock minus whatever the operator held it for. A phase frozen over
      // lunch did not take an extra hour to think.
      const frozenNow = state.freeze ? Math.max(0, this.now().getTime() - Date.parse(state.freeze.at)) : 0;
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

      // A freeze that ran past its threshold ended this child on purpose. The
      // phase record is already `pending` with a session to resume, and reading
      // exit 143 as a crash here would overwrite both.
      if (this.checkpointed) {
        this.checkpointed = false;
        state.freeze = null;
        state.finishedReason = record.resumeSessionId
          ? `phase ${phase} was frozen past ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes and `
            + 'checkpointed. Continue resumes the same session.'
          : `phase ${phase} was frozen past ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes and `
            + 'checkpointed. Continue starts it again from its boot prompt.';
        return { carryOn: false, completed: false };
      }

      // An operator stop is not a failure to diagnose — we caused it.
      if (this.stopRequested || this.abort?.signal.aborted) {
        record.status = 'interrupted';
        record.note = 'stopped by the operator';
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
          continue;

        case 'wait-until': {
          state.status = 'waiting';
          state.waitUntil = disposition.at.toISOString();
          this.record('run.waiting', { until: state.waitUntil, reason: disposition.reason });
          this.persist();
          await this.sleep(Math.max(0, disposition.at.getTime() - this.now().getTime()));
          if (this.abort?.signal.aborted) return { carryOn: false, completed: false };
          // A wait can be hours, which makes it the likeliest place for a pause
          // to be armed — and writing `running` unconditionally is how one got
          // thrown away. `state.pause` is the durable record of the request;
          // the status word is derived from it, never the other way round.
          state.status = state.pause ? 'pausing' : 'running';
          state.waitUntil = null;
          continue;
        }

        case 'switch-model': {
          const next = nextModel(currentModel);
          if (!next) {
            this.halt(`every model is exhausted or at capacity (${disposition.reason})`, phase);
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
          if (!record.sessionId) { this.halt('the session hit a cap but reported no session id to resume', phase); return { carryOn: false, completed: false }; }
          resume = record.sessionId;
          if (disposition.raise === 'budget') budget = Math.max(1, (budget ?? 5) * 2);
          else maxTurns = (maxTurns ?? 60) * 2;
          this.record('phase.resume', { raise: disposition.raise, budget, maxTurns }, phase);
          continue;
        }

        case 'needs-human':
          record.status = 'parked';
          record.note = disposition.reason;
          this.record('phase.needs-human', { reason: disposition.reason }, phase);
          // Anything a person must fix is usually global — an expired login does
          // not get better on the next phase. Stop rather than burn through the
          // rest of the plan failing identically.
          this.halt(disposition.reason, phase);
          return { carryOn: false, completed: false };

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
      this.halt(`${state.consecutiveFailures} phases failed in a row`, phase);
      return { carryOn: false, completed: false };
    }
    return { carryOn: state.autonomy === 'keep-going', completed: false };
  }

  /**
   * The three independent checks. All must agree before a phase counts as done.
   * Nothing here asks the session what happened.
   */
  private async confirm(phase: number): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    record.status = 'verifying';
    this.emit('phase', { phase, status: 'verifying' });

    /* 0. the board, re-read from disk — never the session's word for it.
     *
     * First, because it is free and it is decisive. It used to run last, after
     * the verification commands and after up to twelve hours of waiting for a
     * person to hand-confirm the fragments the runner would not execute — and
     * then threw their answer away, because the phase had never written a
     * handoff at all. Nobody should be asked to vouch for a phase that produced
     * nothing, and no test suite should be run to prove one. */
    if (!await this.closed(phase)) return false;

    /* 1. the plan's own verification commands */
    const text = await this.deps.verificationText(state.slug, phase);
    const verify = this.deps.verify ?? verifyPhase;
    const verification = await verify(text, {
      cwd: state.root,
      signal: this.abort?.signal ?? undefined,
      onStart: (command, index, total) => {
        this.emit('verify', { phase, command, index, total });
      },
    });
    record.verification = verification;
    this.record('phase.verify', {
      ok: verification.ok, reason: verification.reason,
      ran: verification.ran.map((r) => ({ command: r.command, code: r.code, ms: r.ms })),
      notRun: verification.notRun,
    }, phase);

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
        + `— ${broke.map((r) => r.command).join(', ')}`,
        phase,
      );
      return false;
    }

    /* 2. the plan still lints */
    const lint = readLint(await this.script('validate.sh', [state.slug]));
    record.lint = { ok: lint.ok, summary: lint.summary };
    if (!lint.ok) {
      record.status = 'failed';
      state.consecutiveFailures++;
      this.halt(`phase ${phase} left the plan failing validate.sh: ${lint.summary}`, phase);
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
      this.halt(`phase ${phase} did not verify: ${verification.reason}`, phase);
      return false;
    }

    record.status = 'done';
    record.endedAt = new Date().toISOString();
    state.consecutiveFailures = 0;
    state.activePhase = null;
    this.record('phase.done', { costUsd: record.costUsd, attempts: record.attempts }, phase);
    this.emit('phase', { phase, status: 'done' });
    return true;
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
  private async closed(phase: number): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);

    let board = await this.board();
    if (board.states[phase] === 'done') return true;

    const attempt = await this.closeout(phase, board.states[phase] ?? 'unknown');
    if (attempt.ran) {
      board = await this.board();
      if (board.states[phase] === 'done') return true;
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
    );
    return false;
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

    let outcome;
    try {
      outcome = await spawn({
        prompt: closeoutPrompt(state.slug, phase, boardState),
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
        onHandle: (handle) => { this.handle = handle; },
        env: { ...process.env, PE_OWNER: `autopilot/${state.id}` },
        signal: this.abort?.signal,
        // As in `attempt` and `resumeWithInstruction`: a closeout is a live
        // session like any other, and one the console could not freeze or stop
        // because nothing recorded its child.
        onPid: (pid) => {
          this.childPid = pid;
          state.child = { pid, phase, sessionId: record.sessionId ?? '', startedAt: new Date().toISOString() };
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      });
    } catch (error) {
      return { ran: false, note: `the closeout session could not be started: ${(error as Error)?.message ?? error}` };
    } finally {
      this.childPid = null;
      this.handle = null;
      state.child = null;
    }

    state.spentUsd += outcome.costUsd;
    record.costUsd += outcome.costUsd;
    record.turns = (record.turns ?? 0) + outcome.turns;
    if (outcome.resultText) record.said = outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200);
    record.closeout = {
      at: started,
      ok: classify(outcome.signal).kind === 'ok',
      sessionId: record.sessionId,
      note: worked.why,
    };
    this.record('phase.closeout-done', {
      ok: record.closeout.ok, costUsd: outcome.costUsd, turns: outcome.turns,
      said: record.said,
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

    if (await this.git(['status', '--porcelain'])) {
      return { did: true, why: 'the working tree has uncommitted changes' };
    }

    const record = phaseRecord(state, phase);
    if (record.startedAt && await this.git(['log', '--oneline', `--since=${record.startedAt}`])) {
      return { did: true, why: 'the phase committed but wrote no handoff' };
    }

    return { did: false, why: 'the session changed nothing on disk' };
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
      this.halt(`phase ${phase} needs a person to verify it, and there is no way to ask`, phase);
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
    }, VERIFY_ANSWER_MS);

    const outcome = await decided;
    this.record('phase.human-verified', { decision: outcome.decision, by: outcome.by, reason: outcome.reason }, phase);

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
    );
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Plumbing
   * ---------------------------------------------------------------- */

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  private engine(args: string[]) {
    const state = this.state!;
    // No cache key on purpose. The board is read moments after a child wrote a
    // handoff, and the watcher that invalidates the cache may not have fired
    // yet — a cached "not done" here would fail a phase that succeeded.
    return engineRun(
      { scriptsDir: this.deps.scriptsDir, root: state.root }, 'phase-graph.sh', [state.slug, ...args],
    );
  }

  private script(script: string, args: string[]) {
    const state = this.state!;
    return engineRun({ scriptsDir: this.deps.scriptsDir, root: state.root }, script, args);
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
    if (event.kind === 'retry') this.record('phase.api-retry', { ...event }, phase);

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
        if (this.state.child?.phase === phase) this.state.child.sessionId = event.sessionId;
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

  private halt(reason: string, phase?: number): void {
    const state = this.state!;
    state.status = 'halted';
    state.halt = { at: new Date().toISOString(), reason, phase };
    // One field the console can always read for "why did this stop", whichever
    // of the several endings it was.
    state.finishedReason = reason;
    this.record('run.halt', { reason, phase });
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

  /** A sleep that a stop can cut short. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * Shutdown: write the checkpoint and let the child settle. The console's
   * shutdown budget is generous for exactly this reason — a phase killed
   * halfway through leaves a repo nobody can reason about.
   */
  private async checkpointForShutdown(): Promise<void> {
    if (!this.state) return;
    this.record('run.console-shutdown', { pid: this.childPid ?? undefined, phase: this.state.activePhase });
    this.persist();
    if (!this.childPid) return;
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
  permissionProfile?: PermissionProfile;
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
  if (patch.permissionProfile) {
    if (patch.permissionProfile === 'guarded') delete state.permissionProfile;
    else state.permissionProfile = patch.permissionProfile;
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
function authRefusal(detail?: string): string {
  return 'Claude Code is not signed in for this console, so every phase would spend a turn '
    + 'and report success without doing anything. Sign in — the Autopilot page has a button '
    + 'that opens a terminal on it, or run `claude auth login` yourself — then start the run again.'
    + (detail ? ` (${detail})` : '');
}

export type { PhaseStatus, RunState, VerifySummary };
