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

import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { classify, nextModel, type Disposition } from './errors.ts';
import { spawnClaude, type SpawnFn, type StreamEvent } from './spawn.ts';
import { verifyPhase } from './verify.ts';
import {
  loadRun, newRun, phaseRecord, saveRun, pidAlive, SETTLED,
  type Autonomy, type RunState, type PhaseStatus, type VerifySummary,
} from './state.ts';
import { Journal } from './journal.ts';

export type RunnerEvent = (event: string, data: Record<string, unknown>) => void;

export type RunnerDeps = {
  scriptsDir: string;
  /** Injectable so the loop can be tested without spending money on a model. */
  spawn?: SpawnFn;
  verify?: typeof verifyPhase;
  /** The plan's `**Verification:**` text for a phase, from the service's store. */
  verificationText: (slug: string, phase: number) => Promise<string | undefined> | string | undefined;
  onEvent?: RunnerEvent;
  now?: () => Date;
};

export type StartOptions = {
  slug: string;
  root: string;
  model?: string;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  /** Continue this run id instead of creating one. */
  resumeRunId?: string;
};

/** Per phase: one first try, plus room for a model switch, a resume and a retry. */
const MAX_ATTEMPTS = 4;
/** Give a stopped session time to run its own SessionEnd hooks before SIGKILL. */
const SIGTERM_GRACE_MS = 15_000;

export class Runner {
  private deps: RunnerDeps;
  private state: RunState | null = null;
  private journal: Journal | null = null;
  private abort: AbortController | null = null;
  private driving: Promise<void> | null = null;
  private childPid: number | null = null;
  /** Set when the operator stopped us, so exit 143 is not read as a mystery. */
  private stopRequested = false;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  current(): RunState | null { return this.state; }
  busy(): boolean { return this.driving !== null; }
  /** Resolves once the loop has stopped driving. */
  async wait(): Promise<void> { await this.driving; }

  /* ---------------------------------------------------------------- *
   * Starting, and picking up where something left off
   * ---------------------------------------------------------------- */

  async start(options: StartOptions): Promise<RunState> {
    if (this.driving) throw new Error('A run is already in progress. Pause or stop it first.');

    const state = options.resumeRunId
      ? loadRun(options.root, options.slug, options.resumeRunId)
      : null;
    if (options.resumeRunId && !state) throw new Error(`No run ${options.resumeRunId} for ${options.slug}.`);

    this.state = state ?? newRun({
      slug: options.slug,
      root: options.root,
      model: options.model,
      autonomy: options.autonomy,
      phaseBudgetUsd: options.phaseBudgetUsd,
      runBudgetUsd: options.runBudgetUsd,
    });

    if (state) {
      // Resuming: the halt that stopped it has been seen, and anything left
      // mid-flight is reconciled before a new child is started.
      this.state.halt = null;
      this.state.waitUntil = null;
      const blocked = this.adopt(this.state);
      if (blocked) { this.persist(); return this.state; }
      if (options.model) this.state.model = options.model;
      if (options.autonomy) this.state.autonomy = options.autonomy;
    }

    this.state.status = 'running';
    this.journal = new Journal(this.state.root, this.state.slug, this.state.id);
    this.abort = new AbortController();
    this.stopRequested = false;
    this.record('run.start', {
      runId: this.state.id, slug: this.state.slug, model: this.state.model,
      autonomy: this.state.autonomy, resumed: Boolean(state),
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

  /** Finish the current phase, then stop. */
  pause(): void {
    if (!this.state || !this.driving) return;
    this.state.status = 'pausing';
    this.record('run.pause-requested');
    this.persist();
  }

  /** Stop now: the child gets SIGTERM so its own SessionEnd hooks still run. */
  async stop(): Promise<void> {
    if (!this.state) return;
    this.stopRequested = true;
    this.state.status = 'stopping';
    this.record('run.stop-requested', { pid: this.childPid ?? undefined });
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

  /** Take a phase off this run's list without running it. */
  skip(phase: number): void {
    if (!this.state) return;
    const record = phaseRecord(this.state, phase);
    record.status = 'skipped';
    record.note = 'skipped by the operator';
    this.record('phase.skip', {}, phase);
    this.persist();
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
  }

  /* ---------------------------------------------------------------- *
   * The loop
   * ---------------------------------------------------------------- */

  private async drive(): Promise<void> {
    const state = this.state!;
    try {
      while (true) {
        if (this.abort?.signal.aborted) { state.status = 'paused'; break; }
        if (state.status === 'pausing') { state.status = 'paused'; this.record('run.paused'); break; }

        if (state.runBudgetUsd && state.spentUsd >= state.runBudgetUsd) {
          this.halt(`the run budget of $${state.runBudgetUsd} is spent`);
          break;
        }

        const board = await this.board();
        if (board.error) { this.halt(`the engine could not read the plan: ${board.error}`); break; }

        const outstanding = [...board.ready, ...board.waiting, ...board.inProgress, ...board.stuck];
        const candidates = board.ready.filter((p) => !SETTLED.includes(phaseRecord(state, p).status));

        if (!candidates.length) {
          state.status = outstanding.length ? 'parked' : 'finished';
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
      this.persist();
      this.emit('run', { state });
    }
  }

  /** Returns false when the run must stop. */
  private async runPhase(phase: number, board: Board): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
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

    /* ---- lock ---- */
    const owner = `autopilot/${state.id}`;
    const claim = await this.script('phase-lock.sh', [state.slug, 'claim', String(phase), '--owner', owner]);
    if (claim.code !== 0) {
      record.status = 'parked';
      record.note = `the phase lock is held by another session: ${(claim.stdout || claim.stderr).trim().slice(0, 200)}`;
      this.record('phase.lock-refused', { detail: record.note }, phase);
      return true;
    }

    /* ---- prompt ---- */
    const prompt = readText(await this.engine(['--boot-prompt', String(phase)]));
    if (!prompt.trim()) {
      await this.release(phase, owner);
      this.halt(`the engine produced no boot prompt for phase ${phase}`, phase);
      return false;
    }

    record.status = 'running';
    record.startedAt = new Date().toISOString();
    record.model = record.model ?? state.model;
    this.record('phase.start', { model: record.model, title: board.states[phase] }, phase);
    this.emit('phase', { phase, status: 'running', model: record.model });

    /* ---- the session, with the error policy driving retries ---- */
    const settled = await this.attempt(phase, prompt, record.model!);
    await this.release(phase, owner);
    if (!settled.carryOn) return false;
    if (!settled.completed) return true;

    /* ---- independent verification ---- */
    return this.confirm(phase);
  }

  /**
   * Run the phase until it either finishes or the error policy says to stop.
   * Every disposition from `classify` is handled here and nowhere else.
   */
  private async attempt(
    phase: number, prompt: string, model: string,
  ): Promise<{ carryOn: boolean; completed: boolean }> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const spawn = this.deps.spawn ?? spawnClaude;
    let currentModel = model;
    let resume: string | undefined;
    let budget = state.phaseBudgetUsd;
    let maxTurns: number | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      record.attempts++;
      const outcome = await spawn({
        prompt,
        cwd: state.root,
        model: currentModel,
        sessionId: record.sessionId,
        resume,
        budgetUsd: budget,
        maxTurns,
        signal: this.abort?.signal,
        onPid: (pid) => {
          this.childPid = pid;
          state.child = { pid, phase, sessionId: record.sessionId ?? '', startedAt: new Date().toISOString() };
          this.persist();
        },
        onEvent: (event) => this.onStream(phase, event),
      });

      this.childPid = null;
      state.child = null;
      state.spentUsd += outcome.costUsd;
      record.costUsd += outcome.costUsd;
      if (outcome.sessionId) record.sessionId = outcome.sessionId;
      this.record('phase.session', {
        attempt, model: currentModel, costUsd: outcome.costUsd, turns: outcome.turns,
        subtype: outcome.signal.subtype, ms: outcome.durationMs, argv: outcome.argv,
      }, phase);

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
          state.status = 'running';
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

    if (!verification.ok) {
      record.status = 'failed';
      state.consecutiveFailures++;
      this.halt(`phase ${phase} did not verify: ${verification.reason}`, phase);
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

    /* 3. the board, re-read from disk — never the session's word for it */
    const board = await this.board();
    if (board.states[phase] !== 'done') {
      record.status = 'failed';
      state.consecutiveFailures++;
      this.halt(
        `the session for phase ${phase} ended cleanly but the board still reads `
        + `"${board.states[phase] ?? 'unknown'}" — no handoff was written, or it is not marked complete`,
        phase,
      );
      return false;
    }

    record.status = 'done';
    record.endedAt = new Date().toISOString();
    state.consecutiveFailures = 0;
    state.activePhase = null;
    this.record('phase.done', { costUsd: record.costUsd, attempts: record.attempts }, phase);
    this.emit('phase', { phase, status: 'done' });

    // An incomplete verification is not a failure, but it is not a clean bill of
    // health either: something in the plan was left for a person to check. Under
    // the cautious default that is where the run stops.
    if (verification.notRun.length && state.autonomy === 'halt-on-everything') {
      this.halt(
        `phase ${phase} passed the commands that could be run, but ${verification.notRun.length} `
        + 'verification step(s) need a person — see the run journal',
        phase,
      );
      return false;
    }
    return true;
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

  private async release(phase: number, owner: string): Promise<void> {
    // `--git` is never passed: the console does not commit, here or anywhere.
    const result = await this.script('phase-lock.sh', [this.state!.slug, 'release', String(phase), '--owner', owner]);
    if (result.code !== 0) log.warn('runner.release', { phase, stderr: result.stderr.trim().slice(0, 200) });
  }

  private onStream(phase: number, event: StreamEvent): void {
    if (event.kind === 'retry') this.record('phase.api-retry', { ...event }, phase);
    this.emit('stream', { phase, ...event });
  }

  private halt(reason: string, phase?: number): void {
    const state = this.state!;
    state.status = 'halted';
    state.halt = { at: new Date().toISOString(), reason, phase };
    this.record('run.halt', { reason, phase });
    this.emit('run', { state });
    log.warn('runner.halt', { slug: state.slug, runId: state.id, reason, phase });
  }

  private record(event: string, data?: Record<string, unknown>, phase?: number): void {
    this.journal?.append(event, data, phase);
    this.emit('journal', { event, phase, data });
  }

  private emit(event: string, data: Record<string, unknown>): void {
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

function reasonOf(disposition: Disposition): string {
  return 'reason' in disposition ? disposition.reason : 'completed';
}

export type { PhaseStatus, RunState, VerifySummary };
