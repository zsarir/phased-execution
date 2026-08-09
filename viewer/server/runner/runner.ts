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
import { accessSync, constants as fsConstants, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import { classify, fallbackChain, limitBucket, nextModel, type Disposition } from './errors.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type StreamEvent } from './spawn.ts';
import { extractCommands, hardenedPath, verifyPhase } from './verify.ts';
import { failureContext } from './failure-context.ts';
import {
  childrenOf, loadRun, newRun, phaseRecord, saveRun, pidAlive, IN_FLIGHT, SETTLED,
  type Autonomy, type ChildRef, type OnLimitPolicy, type PhaseOptions, type PhaseRecord,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary,
} from './state.ts';
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
  /** MCP servers every phase attaches, on top of the plan's own. */
  mcpServers?: string[];
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
};

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

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  current(): RunState | null { return this.state; }
  busy(): boolean { return this.driving !== null; }

  /* ---------------------------------------------------------------- *
   * Lanes
   * ---------------------------------------------------------------- */

  /** The phases with a live session right now. */
  livePhases(): number[] { return [...this.lanes.keys()].sort((a, b) => a - b); }

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
    // Why it stopped, kept before the banner is cleared. The clear below is for
    // the console's benefit — a run being worked on must not go on looking
    // stopped — and it used to take the reason with it, so the session opened to
    // fix a halt was the one thing on the machine that could not read what the
    // halt said. Only this phase's own halt: a stop recorded against another
    // phase explains nothing here.
    const haltedWith = state.halt?.phase === options.phase ? state.halt.reason : null;
    // A forward action supersedes the halt that was showing. The reason stays in
    // the journal; what it must not do is keep the run looking stopped while
    // this works.
    state.halt = null;
    delete state.finishedReason;
    // Same rule as `start` on resume: the resolution and any reopen-veto were
    // about the stop this recovery is ending, and a stale `resolved` silences
    // the card the NEXT stop should raise.
    state.resolved = null;
    state.reopenedAt = null;
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
      frozen: null, freezeTimer: null, stopped: null, checkpointed: false, checkpointNote: null,
    };
    this.lanes.set(options.phase, lane);

    try {
      if (options.mode !== 'recheck') {
        // An operator asking again is a new fact, not a repeat of the automatic
        // attempt — so the once-only guard is cleared rather than honoured.
        record.closeout = undefined;
      }

      if (options.mode === 'resume') {
        const said = await this.resumeWithInstruction(
          options.phase, options.instruction ?? '', options.haltedWith);
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
      this.deps.scheduler?.release(lane.grant);
      this.clearFreezeTimer(lane);
      this.lanes.delete(options.phase);
      // A recovery has no drive loop to finalize a drain: its halt above was
      // written while its own lane was still in the table, so with that lane
      // gone the run lands on the final word here.
      if (state.status === 'halting') state.status = 'halted';
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
    return { ...process.env, ...account, ...extra };
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
      };
      for (const child of alive) phaseRecord(state, child.phase).status = 'running';
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
    // Only when this was the last thing running. With another lane still live,
    // writing `paused` here would tell the console the run had stopped while a
    // session carried on editing under it.
    if (!this.lanes.size || [...this.lanes.values()].every((other) => other.pid == null)) {
      state.status = 'paused';
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
      const done = await Promise.race(inFlight.values());
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
          state.finishedReason ??= 'stopped by the operator';
          break;
        }
        if (state.status === 'pausing') {
          // A pause stops ADMITTING. What is already running is left to finish
          // — that is what "after this phase" has always meant, and with lanes
          // it means after all of them.
          if (await draining()) continue;
          state.status = 'paused';
          this.record('run.paused', { afterPhase: state.pause?.afterPhase ?? null });
          state.finishedReason = state.pause?.afterPhase != null
            ? `paused by ${state.pause.by} after phase ${state.pause.afterPhase} finished`
            : `paused by ${state.pause?.by ?? 'the operator'} at a phase boundary`;
          state.pause = null;
          break;
        }
        if (state.status === 'halting') {
          // A halt in one lane stops ADMITTING; what is already running drains
          // — the same shape as a pause, with a worse reason. Only when the
          // last lane settles may the run read `halted`: "halted" with live
          // sessions still editing trees is a lie, and one reconcile would
          // compound (halted is not IN_FLIGHT, so a dead console mid-drain
          // would never pid-check those children).
          if (await draining()) continue;
          state.status = 'halted';
          break;
        }
        if (stopping) {
          if (await draining()) continue;
          break;
        }
        if (state.runBudgetUsd && state.spentUsd >= state.runBudgetUsd) {
          if (await draining()) continue;
          this.halt(`the run budget of $${state.runBudgetUsd} is spent`, undefined, 'budget');
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

        const outstanding = [...board.ready, ...board.waiting, ...board.inProgress, ...board.stuck];
        // A run asked for specific phases is finished when THOSE are settled —
        // not when the plan is. Restricting the candidate list here rather than
        // in the caller keeps one definition of "ready" (the engine's).
        const asked = state.onlyPhases?.length ? new Set(state.onlyPhases) : null;
        const candidates = board.ready
          .filter((p) => !asked || asked.has(p))
          .filter((p) => !SETTLED.includes(phaseRecord(state, p).status))
          // A phase this loop is already driving is not a candidate to start
          // again. The board cannot know — it reads handoffs, and a phase in
          // flight has not written one yet.
          .filter((p) => !inFlight.has(p));

        // Nothing to start, but something is running: it may be about to make
        // more phases ready. Concluding "finished" here is the fastest way to
        // stop a plan one phase in.
        if (!candidates.length && await draining()) continue;

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
          // Two DAG leaves finishing together means neither read as "last", so
          // neither was told to open the PR. Saying the branch still awaits one
          // is the honest ending; inventing a session to do it here is not.
          if (!outstanding.length && state.gitMode === 'new-branch'
            && state.openPr !== false && !this.prBlockEmitted) {
            this.record('run.pr-pending', { branch: `pe/${state.slug}` });
            state.finishedReason = `every phase of ${state.slug} is done. The work branch `
              + `pe/${state.slug} still awaits its PR — no phase ran as the plan's last, so `
              + 'push it and open one by hand, or re-run the final phase.';
          }
          if (outstanding.length) {
            // Parking with work left is not self-explanatory: every phase this
            // loop will not pick up again needs its ACTUAL blocker named — a
            // gated phase parked with "is parked", and a blocked-handoff phase
            // hid behind "waiting on a gate or an earlier phase", and both
            // read as dead ends (reported twice, with two real plans).
            const readyRecords = board.ready.map((p) => ({ p, record: phaseRecord(state, p) }));
            const held = [
              ...readyRecords.map(({ p, record }) =>
                `phase ${p} is ${record.status}${record.note ? ` (${record.note})` : ''}`),
              ...board.stuck.map((p) =>
                `phase ${p}'s handoff is marked blocked — its Outstanding section says why`),
            ].join('; ');

            // The remedy tail names only doors that exist. It used to be one
            // fixed sentence advertising gate confirmation and Repair with AI
            // to runs with no gate and no blocked handoff — an operator did
            // nothing on that advice, correctly, and the run stayed down.
            const verificationParked = readyRecords.filter(({ record }) =>
              record.status === 'parked' && Runner.VERIFICATION_PARK.test(record.note ?? ''));
            const remedies: string[] = [];
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
            const tail = remedies.length ? ` ${remedies.join('; ')}.` : '';

            // When the ONLY thing in the way is verification parks, the halt
            // carries a machine-readable kind (and a phase to anchor on) so
            // auto-recovery can pick it up instead of a person.
            const allVerification = verificationParked.length > 0
              && verificationParked.length === readyRecords.length && !board.stuck.length;
            state.halt ??= {
              at: new Date().toISOString(),
              reason: held
                ? `nothing left to run on its own — ${held}.${tail}`
                : `nothing is ready to run: ${outstanding.length} phase(s) are still waiting on a gate or an earlier phase.`,
              ...(allVerification
                ? { kind: 'verification-preflight', phase: verificationParked[0].p }
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
      this.halt(`the runner itself failed: ${(error as Error)?.message ?? error}`);
    } finally {
      // A drain the loop never finished — a `break` that bypassed the loop top,
      // or the `catch` above halting with lanes still recorded — must still
      // land on the final word: nothing is running past this line.
      if (state.status === 'halting') state.status = 'halted';
      // Whatever is left is not running any more, whichever way the loop left.
      for (const lane of this.lanes.values()) this.clearFreezeTimer(lane);
      this.lanes.clear();
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
    if (!gate.clear) {
      if (gate.kind === 'ai') {
        // An ai-clearable gate is the session's FIRST task, not a wall: the
        // engine's own boot prompt orders it to verify each condition, do the
        // work to make failing ones true, and record the clearance before
        // implementing. Booting is exactly how this gate gets cleared.
        this.record('phase.gate-ai', { gate }, phase);
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
      phase, pid: null, handle: null, grant, frozen: null, freezeTimer: null, stopped: null, checkpointed: false, checkpointNote: null,
    };
    this.lanes.set(phase, lane);

    try {
      return await this.runPhaseAdmitted(phase, board, lane);
    } finally {
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
    const holder = expired ? undefined : /held by (\S+)/.exec(status.stdout)?.[1];
    if (holder && holder !== owner) {
      record.status = 'parked';
      record.note = `phase ${phase} is locked by ${holder} — ${status.stdout.trim().slice(0, 160)}`;
      this.record('phase.lock-refused', { holder, detail: record.note }, phase);
      return true;
    }

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
     * says so to the model rather than to anyone who could act. */
    const mcpProblem = await this.preflightMcp(phase, this.optionsFor(phase));
    if (mcpProblem) {
      record.status = 'parked';
      record.note = mcpProblem;
      this.record('phase.mcp-preflight-parked', { reason: mcpProblem }, phase);
      this.emit('phase', { phase, status: 'parked', note: mcpProblem });
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
    const ownMcp = own?.mcpOff
      ? [...(own.mcpServers ?? [])]
      : [...(state.mcpServers ?? []), ...(own?.mcpServers ?? [])];
    const prompt = engineText + (context ? `\n\n${context}\n` : '') + git
      + skillDirective(extraSkills) + mcpDirective(ownMcp);
    if (context) this.record('phase.retry-context', { bytes: Buffer.byteLength(context) }, phase);
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
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    // The phase is now genuinely starting: the active-phase pointer follows
    // the lane table (the mirror rule), written here and nowhere earlier.
    this.syncMirror();
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
    const settled = await this.attempt(phase, prompt, record.model!, owner, lane, chosen);
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
    const prBlock = pr
      ? `\n\nOpening the pull request — this is the plan's LAST remaining phase. After the\n`
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
        + `have run into the handoff and your final message, and finish the phase normally.`
      : '';

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
    chosen: PhaseOptions = {},
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
    let maxTurns: number | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A per-lane stop can land between attempts — during a retry backoff, a
      // usage-window sleep, or before the first spawn. Consume it here or the
      // next iteration starts a session for a phase the operator already ended.
      if (lane.stopped) return this.settleStoppedLane(lane, phase, 'spawn');
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
        // Resolved per attempt, not per run: a server signed in between attempts
        // has to be usable by the retry, and the file is rewritten cheaply.
        // Absent means "attach nothing", which leaves the machine's own MCP
        // configuration in place — what every run did before this existed.
        mcpConfig: (await this.armMcp(phase, chosen)) ?? undefined,
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

          const policy = state.onLimit ?? 'wait';
          if (policy === 'switch' && this.trySwitchAccount(phase, record, disposition.reason, currentModel)) {
            // Continue NOW, on the account that can pay — same session when
            // its transcript came along, a fresh boot prompt when it did not.
            resume = record.sessionId && this.transcriptFollows(record) ? record.sessionId : undefined;
            this.persist();
            continue;
          }
          if (policy === 'pause') {
            // The checkpoint shape `escalateFreeze` established: phase back to
            // pending with a session to resume, run paused, reason on the run.
            record.status = 'pending';
            if (record.sessionId) record.resumeSessionId = record.sessionId;
            state.status = 'paused';
            state.waitUntil = disposition.at.toISOString();
            state.finishedReason = `usage limit — resets ${disposition.at.toLocaleString()}. `
              + 'Continue now under another account, or wait for the window.';
            this.record('run.limit-paused', { until: state.waitUntil, reason: disposition.reason }, phase);
            this.persist();
            this.emit('run', { state });
            return { carryOn: false, completed: false };
          }

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
          // Compare-and-set for the same reason as after the queue wait: a
          // status another lane wrote while this one slept is not this lane's
          // to overwrite.
          if (state.status === 'waiting') state.status = this.resumedStatus();
          state.waitUntil = null;
          // And a lane woken into a halted run must stand down, not spawn
          // attempt N+1 hours after the run stopped.
          if (state.halt) {
            record.status = 'interrupted';
            record.note = 'the run halted while this phase waited for a usage window';
            return { carryOn: false, completed: false };
          }
          continue;
        }

        case 'switch-model': {
          // A QUOTA hit (as opposed to a 529 capacity blip) names its bucket —
          // file the per-model wall against the account, so the meters agree
          // with what just happened and `pickAccount` steers a same-model run
          // elsewhere. No scheduler throttle: every other model is still fine.
          if (disposition.bucket && disposition.at) {
            this.deps.onAccountLimited?.(state.accountId, disposition.bucket, disposition.at, disposition.reason);
          }
          const next = nextModel(currentModel);
          if (!next) {
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
          if (!record.sessionId) { this.halt('the session hit a cap but reported no session id to resume', phase); return { carryOn: false, completed: false }; }
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
            if ((state.onLimit ?? 'wait') === 'switch'
              && this.trySwitchAccount(phase, record, disposition.reason, currentModel)) {
              resume = record.sessionId && this.transcriptFollows(record) ? record.sessionId : undefined;
              this.persist();
              continue;
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
    const cwd = await this.verifyCwd(phase);
    const verification = await verify(text, {
      cwd,
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
    state.consecutiveFailures = 0;
    // Not a flat `null`: with another lane still running, clearing the pointer
    // here would tell the console the run was between phases while a session
    // was mid-edit. `syncMirror` moves it to whatever is still live, and only
    // clears it when nothing is.
    if (this.lanes.size > 1) this.syncMirror();
    else state.activePhase = null;
    this.record('phase.done', { costUsd: record.costUsd, attempts: record.attempts }, phase);
    this.emit('phase', { phase, status: 'done' });
    return true;
  }

  /** Leads whose meaning depends on the working directory. */
  private static readonly CWD_SENSITIVE = new Set([
    'docker', 'docker-compose', 'pnpm', 'npm', 'yarn', 'task', 'make', 'just',
    'pytest', 'go', 'cargo', 'alembic', 'vitest', 'jest', 'tsc', 'node',
  ]);

  /** Builtins and always-present names not worth a resolution warning. */
  private static readonly PREFLIGHT_SKIP = new Set([
    'cd', 'true', 'false', 'echo', 'printf', 'test', 'pwd', 'env', 'which',
    'bash', 'sh', 'command', 'export',
  ]);

  private static readonly VERIFICATION_PARK = VERIFICATION_PARK_NOTE;

  /** The program a command starts with, past any `FOO=1` prefixes — or null. */
  private leadToken(command: string): string | null {
    let rest = command.trim();
    for (;;) {
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
      if (!assignment) break;
      rest = rest.slice(assignment[0].length);
    }
    const token = rest.split(/\s+/)[0] ?? '';
    if (!token || token.includes('/')) return null; // paths are judged elsewhere
    return token;
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
  private async preflightMcp(phase: number, chosen: PhaseOptions): Promise<string | null> {
    const state = this.state!;
    const ids = this.mcpFor(phase, chosen);
    if (!ids.length) return null;
    if (!this.deps.mcp) {
      // No registry wired in (a harness, or a console built before this): the
      // phase runs on whatever MCP configuration the machine already has, which
      // is exactly what every run did before this existed.
      this.record('phase.mcp-unmanaged', { servers: ids }, phase);
      return null;
    }

    const result = await this.deps.mcp.preflight(ids, state.root);

    if (result.unknown.length) {
      return `phase ${phase} names MCP server${result.unknown.length === 1 ? '' : 's'} this console has `
        + `not registered: ${result.unknown.join(', ')}. Register ${result.unknown.length === 1 ? 'it' : 'them'} `
        + 'in Phase Console → MCP, or drop the name from the plan, then Retry.';
    }
    if (result.disabled.length) {
      return `phase ${phase} needs MCP server${result.disabled.length === 1 ? '' : 's'} that ${result.disabled.length === 1 ? 'is' : 'are'} `
        + `switched off here: ${result.disabled.join(', ')}. Turn ${result.disabled.length === 1 ? 'it' : 'them'} back on `
        + 'in Phase Console → MCP, or drop the name from the plan, then Retry.';
    }
    if (result.probeError) {
      this.record('phase.mcp-preflight-skipped', { reason: result.probeError, servers: ids }, phase);
      return null;
    }
    if (!result.ok) {
      const named = result.blocking.map((row) => {
        const why = row.status === 'needs-auth'
          ? 'needs authentication'
          : row.error?.message ?? 'will not connect';
        return `${row.id} (${why})`;
      });
      return `phase ${phase} cannot start: MCP server${named.length === 1 ? '' : 's'} ${named.join(', ')}. `
        + 'An unattended session cannot sign a server in — do it from Phase Console → MCP '
        + '(or `claude mcp login <name>`), then Retry.';
    }

    this.record('phase.mcp', { servers: ids }, phase);
    return null;
  }

  /**
   * Write this phase's `--mcp-config`, or null when it attaches nothing.
   *
   * Per attempt rather than per run, unlike the settings file: a server the
   * operator signed in between two attempts must be usable by the second, and
   * the file costs a JSON write. It carries secrets, so it is 0600 and passed
   * as a path — argv is world-readable in `ps`.
   */
  private async armMcp(phase: number, chosen: PhaseOptions): Promise<string | null> {
    if (!this.deps.mcp) return null;
    const state = this.state!;
    const ids = this.mcpFor(phase, chosen);
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
        return `phase ${phase}'s §Verification contains nothing the runner can execute — `
          + `${notRun.length} entr${notRun.length === 1 ? 'y' : 'ies'} refused`
          + (specimen ? ` (first: ${specimen.reason})` : '')
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
    for (const held of notRun) warnings.push(`a person will be asked: ${held.text} — ${held.reason}`);

    const declared = (await this.deps.verifyIn?.(state.slug, phase))?.trim();
    if (!declared) {
      const sensitive = commands.filter((command) => {
        if (/^cd\s/.test(command.trim())) return false; // names its own directory
        const lead = this.leadToken(command);
        return lead ? Runner.CWD_SENSITIVE.has(lead) : false;
      });
      if (sensitive.length) {
        warnings.push(`${sensitive.length} command(s) are cwd-sensitive and the plan declares no `
          + '**Verify in:** — they will run at the repository root');
      }
    }

    const dirs = hardenedPath(process.env.PATH).path.split(':').filter(Boolean);
    const seen = new Set<string>();
    for (const command of commands) {
      const lead = this.leadToken(command);
      if (!lead || seen.has(lead) || Runner.PREFLIGHT_SKIP.has(lead)) continue;
      seen.add(lead);
      const found = dirs.some((dir) => {
        try { accessSync(join(dir, lead), fsConstants.X_OK); return true; } catch { return false; }
      });
      if (!found) warnings.push(`\`${lead}\` is not on the verification PATH — its command would exit 127`);
    }

    // On the record too, not just the journal: the journal is rendered by
    // nothing, and these warnings' first visible symptom used to be the
    // verification failing after the money was spent.
    const record = phaseRecord(state, phase);
    if (warnings.length) {
      record.preflight = warnings;
      this.record('phase.verify-preflight', { warnings }, phase);
      this.emit('phase', { phase, preflight: warnings });
    } else {
      delete record.preflight;
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
      'no-handoff',
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
      'needs-human',
    );
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Plumbing
   * ---------------------------------------------------------------- */

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  private engine(args: string[], env?: Record<string, string>) {
    const state = this.state!;
    // No cache key on purpose. The board is read moments after a child wrote a
    // handoff, and the watcher that invalidates the cache may not have fired
    // yet — a cached "not done" here would fail a phase that succeeded.
    return engineRun(
      { scriptsDir: this.deps.scriptsDir, root: state.root }, 'phase-graph.sh', [state.slug, ...args],
      undefined, env ? { env } : undefined,
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

  private halt(reason: string, phase?: number, kind?: string): void {
    const state = this.state!;
    // With lanes still live the run is DRAINING, not stopped: `halting` keeps
    // it in IN_FLIGHT (a dead console mid-drain must still pid-check those
    // children) and the drive loop flips it to `halted` when the last lane
    // settles. A verified live run once read `running` WITH a halt attached —
    // admission bookkeeping overwrote `halted` — and this is the honest shape:
    // the halt is a fact the moment it happens, the "stopped" claim only when
    // nothing is running any more.
    state.status = this.lanes.size ? 'halting' : 'halted';
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
function authRefusal(detail?: string): string {
  return 'Claude Code is not signed in for this console, so every phase would spend a turn '
    + 'and report success without doing anything. Sign in — the Autopilot page has a button '
    + 'that opens a terminal on it, or run `claude auth login` yourself — then start the run again.'
    + (detail ? ` (${detail})` : '');
}

export type { PhaseStatus, RunState, VerifySummary };
