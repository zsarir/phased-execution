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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { classify, nextModel, type Disposition } from './errors.ts';
import { spawnClaude, type SpawnFn, type StreamEvent } from './spawn.ts';
import { verifyPhase } from './verify.ts';
import {
  loadRun, newRun, phaseRecord, saveRun, pidAlive, IN_FLIGHT, SETTLED,
  type Autonomy, type RunState, type PhaseStatus, type VerifySummary,
} from './state.ts';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth } from './auth.ts';
import { buildSettings, writeSettingsFile, type Approvals } from './approvals.ts';

export type RunnerEvent = (event: string, data: Record<string, unknown>) => void;

export type RunnerDeps = {
  scriptsDir: string;
  /** Injectable so the loop can be tested without spending money on a model. */
  spawn?: SpawnFn;
  verify?: typeof verifyPhase;
  /** The plan's `**Verification:**` text for a phase, from the service's store. */
  verificationText: (slug: string, phase: number) => Promise<string | undefined> | string | undefined;
  /** Without one, sessions run on the deny rules alone and nothing can be asked. */
  approvals?: Approvals;
  /** Where the child posts its hook calls, e.g. `http://127.0.0.1:4123`. */
  origin?: string;
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
/**
 * How long a "please check this by hand" card waits. Unlike a tool approval
 * there is no hook holding a socket open, and the honest unit for "open the app
 * and look at the gate stack" is hours, not the ten minutes a permission
 * prompt gets.
 */
const VERIFY_ANSWER_MS = 12 * 60 * 60 * 1_000;

/**
 * Things worth knowing before spending a session finding them out.
 *
 * An untrusted workspace is the one that matters. Claude Code silently ignores
 * a repository's own `permissions.allow` entries — and its hooks — until
 * someone has accepted the trust prompt there interactively. A session spawned
 * into that state runs with *fewer* of the repo's protections than whoever
 * started the run believes, which for a repository that ships a
 * destructive-operation guard is exactly backwards. Refusing costs a second;
 * finding out costs a session and the trust in what it did.
 *
 * Returns a reason to refuse, or null to proceed.
 */
export function preflight(root: string, configFile = join(homedir(), '.claude.json')): string | null {
  let config: { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8')) as typeof config;
  } catch {
    return null; // no config to read is not evidence of anything
  }
  const project = config.projects?.[root];
  if (project && project.hasTrustDialogAccepted === false) {
    return `Claude Code has not been trusted in ${root}. A session spawned there ignores that `
      + "repository's own permissions and hooks — including any destructive-operation guard it "
      + 'ships — so the run would be less protected than it looks. Open Claude Code in that '
      + 'directory once and accept the trust prompt, then start the run again.';
  }
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
  /** Set when the operator stopped us, so exit 143 is not read as a mystery. */
  private stopRequested = false;
  /** Path to the 0600 settings file carrying this run's deny rules and hook. */
  private settingsPath: string | null = null;

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
      const path = writeSettingsFile(runId, buildSettings({ runId, token, origin }));
      this.record('run.settings', { path });
      return path;
    } catch (error) {
      log.error('runner.settings', { error });
      return null;
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
    // Nothing is driving: the loop already ended and left a status behind. A
    // Stop that quietly does nothing here is worse than no Stop at all — the
    // operator presses it, the badge still says `running`, and the console has
    // told them a lie about its own state.
    if (!this.driving) {
      if (IN_FLIGHT.includes(this.state.status)) {
        this.state.status = 'interrupted';
        this.state.child = null;
        this.state.halt ??= { at: new Date().toISOString(), reason: 'stopped by the operator', phase: this.state.activePhase ?? undefined };
        this.record('run.stopped-while-idle', { was: this.state.status });
        this.persist();
        this.emit('run', { state: this.state });
      }
      return;
    }
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
      // The token dies with the loop. Anything still waiting on a decision is
      // answered rather than left holding a socket nobody is watching.
      this.deps.approvals?.disarm();
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
    const settled = await this.attempt(phase, prompt, record.model!, owner);
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
    phase: number, prompt: string, model: string, owner: string,
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
        // Deliberately not `record.sessionId`. That is the id of a session that
        // has already run; handing it back as `--session-id` asks the CLI to
        // create a session that exists, and it refuses — "Session ID … is
        // already in use", which is what killed two real retries. A new attempt
        // gets a new id; continuing an existing one goes through `resume`.
        resume,
        budgetUsd: budget,
        maxTurns,
        settings: this.settingsPath ?? undefined,
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
      state.child = null;
      state.spentUsd += outcome.costUsd;
      record.costUsd += outcome.costUsd;
      if (outcome.sessionId) record.sessionId = outcome.sessionId;
      this.record('phase.session', {
        attempt, model: currentModel, costUsd: outcome.costUsd, turns: outcome.turns,
        subtype: outcome.signal.subtype, ms: outcome.durationMs, argv: outcome.argv,
        // The session's own closing words. When a phase exits clean but changes
        // nothing, this is the only place that says why — without it, diagnosing
        // the failure means re-running it and watching.
        said: outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200),
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

    // Anything the runner would not or could not execute goes to a person, with
    // the plan's own words attached. Under `keep-going` a verification that
    // otherwise passed does not stop for this; under the cautious default it
    // always does, which is what that setting means.
    if (verification.notRun.length && (!verification.ok || state.autonomy === 'halt-on-everything')) {
      if (!await this.askHuman(phase, verification)) return false;
    } else if (!verification.ok) {
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
    return true;
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
