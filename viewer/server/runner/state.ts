/**
 * Run state: the checkpoint that survives a crash.
 *
 * A run is a long-lived thing — hours, many child processes, possibly a
 * console restart in the middle. Everything needed to pick it back up lives in
 * one JSON file per run, written after every transition and outside the repo
 * (`~/.local/state/phase-console/runs/…`), so a supervised plan never leaves
 * uncommitted machine state in someone's working tree.
 *
 * Writes are atomic: a half-written checkpoint read after a power cut is worse
 * than no checkpoint at all, because it looks valid.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { instanceId } from '../../shared/instances.mjs';
import { STATE_DIR } from '../config.ts';
import type { PermissionProfile } from './approvals.ts';

export type RunStatus =
  /** The loop is driving phases. */
  | 'running'
  /** Asked to stop after the current phase. */
  | 'pausing'
  /** Stopped between phases; `start` picks up where it left off. */
  | 'paused'
  /** Sleeping until a usage window reopens (`waitUntil`). */
  | 'waiting'
  /**
   * The session is stopped where it stood (`SIGSTOP`), mid-phase.
   *
   * Distinct from `paused` in the one way that matters operationally: there is
   * a live child holding a warm session, so this is reversible at no cost — and
   * it is also the only status where the run's own clock is not running.
   */
  | 'frozen'
  /** Every remaining phase needs a human — a gate, an approval, a decision. */
  | 'parked'
  /** Stopped on a condition that must not be automated past. */
  | 'halted'
  /**
   * A halt is recorded and no new phase may board; live lanes are draining.
   *
   * In `IN_FLIGHT`, unlike `halted`: sessions are still editing working trees,
   * so a console that dies mid-drain must have `reconcileRun` pid-check them
   * rather than read "halted" as final — that hole is how orphan sessions kept
   * writing with no card saying so. Flips to `halted` when the last lane
   * settles. The halt card itself keys on `run.halt`, which is already set.
   */
  | 'halting'
  /** Nothing left to do on this plan. */
  | 'finished'
  /** A stop was requested; the child is being wound down. */
  | 'stopping'
  /**
   * Admitted to the queue and waiting for a scope to clear.
   *
   * Deliberately NOT in `IN_FLIGHT`: a queued run has, by definition, done
   * nothing — no child, no session, no edit to any working tree — so there is
   * nothing for `reconcileRun` to reclaim and nothing a restart interrupts.
   * That is what makes it the one status `Service.open()` may re-adopt by
   * itself. See the scheduler's "no own persistence" note: the pending
   * `admit()` promises ARE the queue, and this is their durable shadow.
   */
  | 'queued'
  /** Nothing is driving this run any more, and nothing recorded why. */
  | 'interrupted';

export type PhaseStatus =
  | 'pending' | 'gated' | 'running' | 'verifying' | 'done'
  | 'failed' | 'interrupted' | 'skipped' | 'parked'
  /** Waiting on the scheduler for a scope that something else is holding. */
  | 'queued'
  /**
   * Parked on an EXTERNAL clock the session declared (`phase-outcome.sh
   * waiting-external`): a CI build, a PR auto-merge, a deploy window. Not
   * settled — the runner resumes the phase's own session at `parkedUntil` —
   * and not in flight — there is no live child while it waits. The one status
   * where "nothing is running" and "nothing is wrong" are both true.
   */
  | 'waiting'
  /** Verified as far as a machine can; the rest is a question for a person. */
  | 'awaiting-verification';

/**
 * Terminal for this run: the loop will not pick these up again by itself.
 *
 * `queued` is absent on purpose — it is the opposite of settled. A queued phase
 * is one the loop is actively waiting to start, and listing it here would make
 * `drive()` filter it out of its own candidate list the moment it was admitted.
 *
 * `gated` IS here: a human/auto gate the runner cannot clear would otherwise be
 * re-admitted every loop iteration — an infinite gate-check spin. Approving the
 * gate (the phase page's Gate card) retries the phase, which resets the record.
 */
export const SETTLED: readonly PhaseStatus[] = ['done', 'skipped', 'failed', 'parked', 'interrupted', 'gated'];

/**
 * Statuses that assert work is in flight — each one a claim made by a process
 * that can be killed between writing it and acting on it.
 *
 * `queued` is not one of them: it claims the opposite. See `RunStatus`.
 */
export const IN_FLIGHT: readonly RunStatus[] = ['running', 'pausing', 'stopping', 'waiting', 'frozen', 'halting'];

/** The same, per phase. A phase in one of these had a live loop behind it. */
export const PHASE_IN_FLIGHT: readonly PhaseStatus[] = ['running', 'verifying', 'awaiting-verification'];

export type VerifyRun = {
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  /** Tail only — a full test-suite log does not belong in a checkpoint. */
  output: string;
};

export type VerifySummary = {
  ok: boolean;
  reason: string;
  ran: VerifyRun[];
  /** Commands present in the plan that the runner would not execute, and why. */
  notRun: { text: string; reason: string }[];
};

/**
 * One MCP server a phase asked for and did not get.
 *
 * `reason` is the machine-readable half — it decides which remedy the console
 * offers, since "sign this in" and "this is not registered here" are different
 * errands — and `detail` carries whatever the CLI said, when it said anything.
 */
export type McpDegradation = {
  id: string;
  reason: 'needs-auth' | 'failed' | 'unregistered' | 'switched-off';
  detail?: string;
};

/** The one place the four reasons become the sentence a person reads. */
export function mcpReasonText(reason: McpDegradation['reason']): string {
  switch (reason) {
    case 'needs-auth': return 'needs authentication';
    case 'unregistered': return 'is not registered on this console';
    case 'switched-off': return 'is switched off here';
    default: return 'will not connect';
  }
}

export type PhaseRecord = {
  phase: number;
  status: PhaseStatus;
  attempts: number;
  costUsd: number;
  /** Turns and wall-clock across every attempt, so a phase can be read at a glance. */
  turns?: number;
  durationMs?: number;
  /**
   * Wall-clock this phase spent stopped by the operator, already subtracted
   * from `durationMs`. Kept rather than merely deducted so "it took two hours"
   * and "it worked for twenty minutes and waited for me for the rest" can be
   * told apart — the second is not a slow phase.
   */
  frozenMs?: number;
  /**
   * How many times this phase actually called each attached MCP server, by id.
   *
   * The only honest answer to "was attaching that worth it". Every attached
   * server costs context on every turn and adds names that can collide with
   * another server's tools, so the advice everyone converges on is three to six
   * — but nobody can act on that advice without knowing which of their six were
   * ever touched. Absent means the phase attached none, or ran before this was
   * recorded; zero for an id means it was attached and never used, which is the
   * interesting number.
   */
  mcpCalls?: Record<string, number>;
  /**
   * A session to hand to `--resume` when this phase next runs, left behind by a
   * freeze that was checkpointed. Cleared as soon as it is used: a session id
   * offered twice is the "Session ID … is already in use" refusal that killed
   * two real retries.
   */
  resumeSessionId?: string;
  model?: string;
  /** The reasoning effort this phase ran at. */
  effort?: string;
  /** What the session's own `init` message said it was running on. */
  actualModel?: string;
  sessionId?: string;
  /**
   * The account `sessionId`'s transcript was recorded under. What the port
   * needs when a resume happens under a DIFFERENT account: the file lives in
   * the config dir of the account that wrote it, not the one about to read it.
   */
  sessionAccountId?: string;
  startedAt?: string;
  endedAt?: string;
  note?: string;
  gate?: { clear: boolean; kind: string; detail: string };
  /**
   * Boarding-preflight warnings for the phase's §Verification — refused
   * fragments, cwd-sensitive commands with no `Verify in:`, leads missing
   * from the PATH. Non-blocking by design, but they used to live only in the
   * journal, which nothing renders: an operator's first sight of them was the
   * verification failing an hour later. Overwritten each boarding, absent
   * when clean, cleared on retry.
   */
  preflight?: string[];
  /**
   * MCP servers this phase asked for and boarded WITHOUT, under `continue`.
   *
   * The receipt for a degraded run. A phase that quietly did without half its
   * tools and a phase that had all of them look identical in the handoff
   * afterwards, so the fact is recorded where the run page and the operator's
   * notification both read it. Overwritten each boarding, absent when every
   * server connected, cleared on retry — exactly like `preflight`.
   */
  mcpDegraded?: McpDegradation[];
  verification?: VerifySummary;
  /**
   * Where the verification commands actually ran, relative to the run's root
   * (`.` for the root itself). Recorded because a suite that passed in the
   * wrong directory and one that passed in the right one look identical
   * afterwards — and for a whole class of monorepo plans the first is what was
   * happening. Set from the plan's `**Verify in:**`, or `.` when it says
   * nothing or names a directory that is not there.
   */
  verifiedIn?: string;
  lint?: { ok: boolean; summary: string };
  /**
   * The one continuation this phase is allowed when its session exits without
   * writing a handoff — recorded so a second attempt cannot happen by accident,
   * and so the panel can say a closeout was tried and what came of it.
   */
  closeout?: { at: string; ok: boolean; sessionId?: string; note?: string };
  /**
   * The session's own closing words. When a phase exits clean and changes
   * nothing this is the only account of why, and it used to live solely in the
   * journal — so the halt said "no handoff was written" and the reason it was
   * not written took a manual dig through NDJSON to recover.
   */
  said?: string;
  /**
   * When a `waiting` park elapses and the runner re-checks / resumes. Absolute
   * ISO so a console outage does the right thing on boot: an expired clock
   * resumes immediately, an unexpired one re-arms for the remainder.
   */
  parkedUntil?: string;
  /** The session's own words for what it is waiting on. */
  parkReason?: string;
  /** Machine-ish refs for the external things being waited on (`gh:…#run/N`, `lock:slug/N`). */
  watch?: string[];
  /**
   * How many waiting-external parks this phase has taken. Capped: a phase that
   * keeps re-filing the same wait is not waiting, it is stuck, and the cap is
   * what turns that into an honest halt instead of an infinite quiet loop.
   */
  waits?: number;
  /** Total wall-clock this phase has spent parked, accrued at each resume. */
  parkedMs?: number;
  /**
   * When this phase first started waiting on a foreign LOCK (queued-behind-a-
   * holder). Bounds the lock wait: past the cap the phase parks honestly with
   * the holder named instead of queueing forever behind a dead-but-unexpired
   * claim.
   */
  lockWaitSince?: string;
};

/**
 * Why a stopped run has stopped demanding a person.
 *
 * A `halted` or `interrupted` run is a permanent claim: nothing ever revisits
 * it, so the console goes on asking about a phase that was finished by hand
 * three weeks ago. The oldest card on this dashboard said a plan had halted
 * because phase 6 wrote no handoff — the handoff landed four hours later and
 * the board has read 7/7 done ever since.
 *
 * Resolution is the correction, and it is *annotation, never deletion*: the run
 * keeps its status, its halt reason and its whole record, and gains a note
 * saying why it is no longer waiting on anyone. `auto` distinguishes the two
 * ways that happens — the board overtook it, or a person dismissed it — because
 * only one of those is something the console is allowed to decide by itself.
 */
export type RunResolution = {
  at: string;
  /** True when the board settled it; false when a person did. */
  auto: boolean;
  reason: string;
  /** Who dismissed it, on a manual resolution. */
  by?: string;
  /** What they said about it, if anything. */
  note?: string;
};

/**
 * Stopped, with nothing driving it and nothing that will.
 *
 * These are the only statuses a run can be resolved out of. A `parked` run is
 * excluded deliberately: `reconcileRun` uses `parked` for the one case where a
 * child is *still alive* under a dead console, and a live session editing a
 * working tree is the last thing that should quietly stop being mentioned.
 */
export const RESOLVABLE: readonly RunStatus[] = ['halted', 'interrupted'];

/** A freeze on one lane: when, who, and when it stops being cheap. */
export type FreezeRef = { at: string; by: string; escalateAt: string };

/** One live session, as the checkpoint records it. */
export type ChildRef = {
  pid: number;
  phase: number;
  sessionId: string;
  startedAt: string;
  /**
   * Set while this lane's process sits under SIGSTOP. Recorded on the lane and
   * not only in the run-level `freeze` slot because several lanes can be frozen
   * at once, and a reader deciding per pid — reconcile telling a stopped orphan
   * from a running one, a client drawing one lane's controls — needs the fact
   * where the pid is. The single slot can only name one.
   */
  frozen?: FreezeRef;
};

/**
 * Every lane a run has open, however the checkpoint spells it.
 *
 * The single `child` and the `children` map are two recordings of the same
 * fact, and a run written by an older console only has the first. Reading them
 * through one function is what keeps "reconcile a one-lane run" and "reconcile
 * a three-lane run" the same code path — the alternative is two orphan checks
 * that drift, and the one that drifts is the one that leaves a live session
 * editing a tree nobody is watching.
 */
export function childrenOf(state: RunState): ChildRef[] {
  const lanes = state.children ? Object.values(state.children) : [];
  if (lanes.length) return lanes;
  return state.child ? [state.child] : [];
}

export type Autonomy = 'halt-on-everything' | 'keep-going';

/**
 * What a phase does when one of its MCP servers cannot be reached.
 *
 * `continue` — the shipped default — drops the unreachable servers from the
 * `--mcp-config`, tells the session which ones are missing and why, warns the
 * operator, and runs the phase anyway. `require` is the older, unconditional
 * behaviour: park at boarding before a token is spent.
 *
 * The default moved because the park was answering the wrong question. It was
 * built for the phase that genuinely cannot work without its server, but it
 * fires for every phase that merely has one attached — and a run whose ready
 * phases all park has nothing left to do, so one signed-out server stopped an
 * eleven-phase plan that named no MCP servers at all (observed live, 0 phases
 * done). `require` is still exactly right, per phase, when the plan says so.
 */
export const MCP_POLICIES = ['continue', 'require'] as const;
export type McpPolicy = (typeof MCP_POLICIES)[number];

export function isMcpPolicy(value: unknown): value is McpPolicy {
  return typeof value === 'string' && (MCP_POLICIES as readonly string[]).includes(value);
}

/**
 * What the operator chose for one phase, before it runs.
 *
 * Every field is optional and an absent field means "inherit". Three sources
 * are consulted in order — this, then the plan's own `**Model:**` /
 * `**Effort:**` bullets for that phase, then the run's defaults — so a plan
 * that already says a phase wants Opus gets Opus without anyone re-typing it,
 * and an operator who disagrees can say so for one run without editing a
 * versioned file.
 */
export type PhaseOptions = {
  model?: string;
  effort?: string;
  /** Restrict the built-in tool set for this phase. Empty means every tool. */
  tools?: string[];
  permissionMode?: string;
  /** Skills to invoke on top of the plan's own, for this phase. */
  skills?: string[];
  /**
   * Drop the RUN's skills for this phase — its own `skills` still apply.
   *
   * The escape hatch that makes a machine-level default safe to set. A skill
   * that is right for eighty-five phases can be exactly wrong for one (a phase
   * that touches no repository, a phase whose whole job is the thing the skill
   * would do), and without this the only way to exclude it would be to turn it
   * off for the entire run. `false` and absent are the same thing, so an older
   * checkpoint reads as "inherit" — which is what it meant.
   */
  skillsOff?: boolean;
  /** MCP servers to attach on top of the plan's and the run's, for this phase. */
  mcpServers?: string[];
  /**
   * Drop the RUN's MCP servers for this phase — its own still apply, and so
   * does the plan's own `**MCP:**` bullet, which is a versioned statement about
   * what this phase needs rather than an operator's choice for one run.
   *
   * Exactly `skillsOff`'s escape hatch, for the same reason and with the same
   * cost model: a server attached to every phase of a run is dead weight in the
   * one phase that touches nothing it can see, and every attached server is paid
   * for on every turn.
   */
  mcpOff?: boolean;
  /**
   * What this phase does when one of its servers cannot be reached.
   *
   * The most specific answer there is, and the only one that can overrule the
   * plan: an operator looking at a parked phase knows something the versioned
   * document cannot, which is whether THIS attempt can proceed without it.
   */
  mcpPolicy?: McpPolicy;
};

/**
 * Every kind a halt can carry, written at the halt site. The runtime list —
 * and the profile that decides how each kind is treated — lives in
 * `shared/recovery-model.js` (`HALT_KINDS`); this union mirrors it for TS and
 * `test/recovery-model.test.ts` pins the two identical. `halt.kind` stays
 * `HaltKind | (string & {})` so records written by other versions still load.
 */
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

export type RunState = {
  id: string;
  slug: string;
  root: string;
  status: RunStatus;
  autonomy: Autonomy;
  /** The model each phase starts on; a limited model falls back from here. */
  model: string;
  /** The reasoning effort each phase starts at, unless the phase overrides it. */
  effort?: string;
  /**
   * The account's usage window as the CLI last reported it mid-session. Not a
   * decision the runner makes — a fact worth showing before someone starts a
   * twelve-phase run against a window that is nearly spent.
   */
  limits?: { status: string; window?: string; utilization?: number; resetsAt?: number; at: string };
  /**
   * The Claude account this run's sessions spawn as, from the instance's
   * registry. Written as an omission when it is the machine login — a run file
   * from before accounts existed means exactly what it meant, and an id that
   * has since been removed degrades to the same place (`envFor` answers null).
   */
  accountId?: string;
  /**
   * What to do when a session hits the SHARED usage window (session/weekly —
   * model-specific limits keep their own model-switch path). Absent means
   * `wait`, which is the pre-accounts behavior: sleep to the reset. `switch`
   * checkpoints and continues under the account with the most headroom;
   * `pause` checkpoints and stops for a person.
   */
  onLimit?: 'wait' | 'switch' | 'pause';
  phaseBudgetUsd: number | null;
  runBudgetUsd: number | null;
  spentUsd: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  activePhase: number | null;
  /**
   * Set while a child is alive, so a restarted console can tell what it
   * interrupted.
   *
   * **A MIRROR of one live lane, and load-bearing as such.** A run may now
   * drive several phases at once (`children`), but this field is what every
   * console built before lanes reads to answer "is something running, and
   * what?" — including `reconcileRun`'s own orphan check, the freeze/stop
   * paths, and any older build of this client still open in a browser tab.
   * Dropping it in favour of `children` alone would make all of them report a
   * busy run as idle, which is the one lie this file exists to prevent. So the
   * runner writes BOTH: `children[phase]` for every live lane, and this for
   * whichever lane is currently the mirror. See `Runner.attempt`.
   */
  child: ChildRef | null;
  /**
   * Every live lane, keyed by phase number as a string.
   *
   * Absent on a run written before lanes existed, which is exactly why every
   * reader spells it `children ?? {child}` — one lane recorded the old way and
   * one recorded the new way must reconcile identically.
   */
  children?: Record<string, ChildRef>;
  waitUntil: string | null;
  /**
   * Why the run stopped and started asking for a person. `kind` is the
   * machine-readable class (`verify-failed`, `needs-human`, …) written at the
   * halt site so the auto-recovery classifier reads a name instead of parsing
   * a sentence; absent on records written before kinds existed, which is why
   * every reader keeps a fallback on the words.
   */
  halt: { at: string; reason: string; phase?: number; kind?: HaltKind | (string & {}) } | null;
  /**
   * A pause that has been asked for but not yet reached.
   *
   * `status: "pausing"` on its own tells an operator almost nothing — not when
   * they asked, not what it is waiting for, and not whether the request even
   * landed. It landed silently for so long that pressing Pause looked like a
   * no-op. This records the request the moment it is made, names the phase that
   * has to finish first, and is cleared either by the pause taking effect or by
   * the operator cancelling it.
   */
  pause: { requestedAt: string; afterPhase: number | null; by: string } | null;
  /**
   * A session stopped where it stands, and when that stops being the cheap
   * option. Null whenever nothing is frozen — including immediately after a
   * `thaw()` or an escalation, so a stale block can never make a live run look
   * held.
   */
  freeze: { at: string; phase: number | null; pid: number; by: string; escalateAt: string } | null;
  /**
   * Why the loop stopped, in the words the operator needs.
   *
   * `status` says *that* a run ended and `halt` says why it was halted, but the
   * ordinary endings — the plan is finished, the phases this run was asked for
   * are all settled, the budget is spent — went to the journal and nowhere the
   * console could show them. A run that stops after one phase because it was
   * scoped to one phase looks broken without this.
   */
  finishedReason?: string;
  /**
   * Run only these phases, in the usual ready order, then stop. Empty or absent
   * means "every phase that becomes ready", which is the normal run.
   */
  onlyPhases?: number[];
  /** Per-phase choices, keyed by phase number. See `PhaseOptions`. */
  phaseOptions?: Record<string, PhaseOptions>;
  /** Skills every phase of this run invokes, on top of the plan's own. */
  skills?: string[];
  /**
   * MCP servers every phase of this run attaches, on top of the plan's own.
   *
   * Registry ids, checked against the live registry when the run starts —
   * they become a child process's configuration, so an id that no longer
   * resolves is reported to the session rather than silently dropped.
   */
  mcpServers?: string[];
  /**
   * This run's answer to an unreachable MCP server, seeded from the console
   * preference at launch. Absent means the shipped default, `continue`.
   *
   * The plan outranks it, deliberately: a run-wide "carry on regardless" is an
   * operator's convenience for one launch, while a phase that says it requires
   * its server is a versioned statement about the work.
   */
  mcpPolicy?: McpPolicy;
  /**
   * How many phases of THIS run may be in flight at once.
   *
   * Absent means the console's own `--max-sessions`. A run may ask for fewer
   * — a plan whose phases share a repo gains nothing from lanes and an
   * operator may simply want to watch one thing at a time — but never for
   * more: the scheduler's global cap is about the machine, and a run does not
   * get to raise it.
   */
  maxParallel?: number;
  /**
   * How much this run may do without stopping to ask — `guarded` (the default
   * and what every run did before profiles existed), `trusted`, or `bypass`.
   *
   * On the state rather than only in the settings file because it is the thing
   * an operator most needs to see in the header: a run quietly on `bypass` and
   * a run on `guarded` look identical otherwise, and only one of them is
   * committing without asking.
   */
  permissionProfile?: PermissionProfile;
  /**
   * The run works on one plan-wide branch (`pe/<slug>`) instead of whatever is
   * checked out. **Absent means default-branch** — a run file written before
   * this feature keeps meaning what it meant, so the only branching state a
   * reader ever tests is `state.gitMode === 'new-branch'`.
   */
  gitMode?: 'new-branch';
  /**
   * Whether the final phase is told to push the branch and open a PR.
   * Meaningful only with `gitMode: 'new-branch'`; absent there means true.
   */
  openPr?: boolean;
  /**
   * Set once this run stopped being something a person has to deal with — by
   * the board overtaking it, or by someone dismissing it. Never a reason to
   * hide or delete the run: see `RunResolution`.
   */
  resolved?: RunResolution | null;
  /**
   * A person put this run's card back, and the board resolver does not get to
   * overrule that on the next read.
   *
   * Without it, un-dismissing an auto-resolved run is a no-op you can watch
   * happen: the card returns, the next read finds the same settled board, and
   * it resolves all over again. An operator saying "no, I still want to see
   * this" is a stronger signal than the inference, so it sticks until they
   * dismiss it themselves.
   */
  reopenedAt?: string | null;
  /**
   * Recovery bookkeeping, keyed by phase number as a string (`plan` for a
   * plan-wide repair). `attempts` counts sessions the console launched BY
   * ITSELF — bumped at launch, so a console that dies mid-recovery still
   * remembers it tried — while `lastAt` / `lastReason` / `fixed` record how
   * the newest session ended, whoever started it. Absent on runs that predate
   * the feature, which reads as "never tried".
   */
  recoveries?: Record<string, {
    attempts: number;
    lastAt: string;
    lastReason?: string;
    fixed?: boolean;
    /**
     * How the newest recovery actually ended — `fixed` kept in parallel for
     * old readers. `no-defect` (the recovery concluded nothing was wrong) and
     * `superseded` (the board had already moved past the halt before anything
     * was launched) both exist so an unnecessary recovery is RECORDED as
     * unnecessary instead of scored as a failure that clears nothing.
     */
    lastOutcome?: 'fixed' | 'no-defect' | 'superseded' | 'failed';
  }>;
  /**
   * The run heals itself: an auto-recoverable halt launches the fix agent, and
   * a fixed board resumes the run. Absent means off — a run file written
   * before the feature keeps meaning what it meant; new runs get it from the
   * launch dialog, seeded by the `autoRecoverByDefault` pref.
   */
  autoRecover?: { attempts: number };
  phases: Record<string, PhaseRecord>;
};

/* ------------------------------------------------------------------ *
 * Where a run lives
 * ------------------------------------------------------------------ */

/**
 * One directory per (source directory, plan). The hash keeps two checkouts of
 * the same repo apart; the basename keeps the path readable for a human who
 * goes looking, which they will the first time a run halts.
 *
 * The key is `instanceId()` — the same function that names a console instance,
 * imported rather than reimplemented. It was computed here first and the
 * instance registry adopted it, so the import direction looks backwards; it is
 * the right way round anyway, because the two must never drift and only one of
 * them can be the definition. `runs/` stays under the SHARED `STATE_DIR` rather
 * than moving into a per-instance directory: it is already keyed by root, so
 * two consoles cannot collide here, and moving it would orphan every run
 * journal on the machine to buy nothing.
 */
export function runDir(root: string, slug: string): string {
  return join(STATE_DIR, 'runs', instanceId(root), slug);
}

export function runFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.json`);
}

export function journalFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.jsonl`);
}

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

/** The on-limit policies a browser may name; anything else reads as `wait`. */
export const ON_LIMIT_POLICIES = ['wait', 'switch', 'pause'] as const;
export type OnLimitPolicy = (typeof ON_LIMIT_POLICIES)[number];

export function isOnLimitPolicy(value: unknown): value is OnLimitPolicy {
  return typeof value === 'string' && (ON_LIMIT_POLICIES as readonly string[]).includes(value);
}

export type NewRunOptions = {
  slug: string;
  root: string;
  model?: string;
  effort?: string;
  accountId?: string;
  onLimit?: OnLimitPolicy;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  maxConsecutiveFailures?: number;
  onlyPhases?: number[];
  phaseOptions?: Record<string, PhaseOptions>;
  skills?: string[];
  mcpServers?: string[];
  mcpPolicy?: McpPolicy;
  permissionProfile?: PermissionProfile;
  maxParallel?: number;
  gitMode?: 'default-branch' | 'new-branch';
  openPr?: boolean;
  /** Heal halts automatically. `true` takes the default budget; an object names it. */
  autoRecover?: boolean | { attempts?: number };
};

export function newRun(opts: NewRunOptions): RunState {
  const now = new Date().toISOString();
  return {
    id: randomUUID().slice(0, 8),
    slug: opts.slug,
    root: opts.root,
    status: 'running',
    // The opening posture, changed deliberately (2026-08-03).
    //
    // These were `halt-on-everything` / `sonnet` / no effort / `guarded`, which
    // was right for the first weeks of an unattended system — stop and show your
    // work — and wrong for what the autopilot is actually used for: a phase of
    // real engineering, left running while nobody watches. On those settings a
    // phase thought less hard than the operator would have asked for and then
    // stopped at the first commit to ask about something the deny list already
    // governs. The two failures compound, because the cheap model is the one
    // that needs supervision and nobody is there to give it.
    //
    // `trusted` is not "unguarded": the deny list still refuses pushes,
    // destructive git, deploys and publishes, from inside the CLI, so it holds
    // even with this console dead. What changes is that the reversible things
    // stop raising a card. See `client/src/views/run/defaults.ts` — the client
    // sends all four explicitly, and `api/routes.ts` still reads an
    // *unrecognised* profile as `guarded` so a typo cannot grant trust.
    autonomy: opts.autonomy ?? 'keep-going',
    model: opts.model ?? 'opus',
    // A conditional spread, because `effort: undefined` and no key are different
    // things on disk. An explicit empty string is a caller saying "this
    // machine's default" and must survive as one.
    ...(opts.effort === '' ? {} : { effort: opts.effort ?? 'max' }),
    phaseBudgetUsd: opts.phaseBudgetUsd ?? null,
    runBudgetUsd: opts.runBudgetUsd ?? null,
    spentUsd: 0,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 2,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    // Same omission convention as `permissionProfile`: the machine login and
    // the `wait` policy are the absent states, so old run files and old
    // readers agree without a migration.
    ...(opts.accountId && opts.accountId !== 'default' ? { accountId: opts.accountId } : {}),
    ...(opts.onLimit && opts.onLimit !== 'wait' ? { onLimit: opts.onLimit } : {}),
    ...(opts.onlyPhases?.length ? { onlyPhases: [...opts.onlyPhases] } : {}),
    ...(opts.phaseOptions ? { phaseOptions: { ...opts.phaseOptions } } : {}),
    ...(opts.skills?.length ? { skills: [...opts.skills] } : {}),
    ...(opts.mcpServers?.length ? { mcpServers: [...opts.mcpServers] } : {}),
    // `continue` is the absent state, so a run file written before the policy
    // existed reads as the shipped default rather than as the old park.
    ...(opts.mcpPolicy && opts.mcpPolicy !== 'continue' ? { mcpPolicy: opts.mcpPolicy } : {}),
    ...(opts.maxParallel && opts.maxParallel > 0 ? { maxParallel: opts.maxParallel } : {}),
    // **Absent still means `guarded` when reading**, and that does not change:
    // a run file written before profiles existed must not become trusted because
    // the default moved under it. So `guarded` is the one value written as an
    // omission, and everything else — including the new `trusted` default — is
    // written out explicitly.
    ...(opts.permissionProfile === 'guarded'
      ? {}
      : { permissionProfile: opts.permissionProfile ?? 'trusted' }),
    // Same omission convention as `permissionProfile`: default-branch is the
    // absent state, so old readers and old run files agree. `openPr` is written
    // both ways under new-branch so the header can show the run's own record.
    ...(opts.gitMode === 'new-branch'
      ? { gitMode: 'new-branch' as const, openPr: opts.openPr !== false }
      : {}),
    // Off is the absent state, like everything above — but unlike them the ON
    // value is chosen by the caller (the pref-resolved default), not here: a
    // pure constructor does not get to decide what "unset" means for automation.
    ...(opts.autoRecover
      ? {
        autoRecover: {
          attempts: Math.max(1,
            (typeof opts.autoRecover === 'object' ? opts.autoRecover.attempts ?? 0 : 0) || 2),
        },
      }
      : {}),
    phases: {},
  };
}

export function phaseRecord(state: RunState, phase: number): PhaseRecord {
  const key = String(phase);
  if (!state.phases[key]) {
    state.phases[key] = { phase, status: 'pending', attempts: 0, costUsd: 0 };
  }
  return state.phases[key];
}

/**
 * Write the checkpoint atomically — rename is the only step a reader can see —
 * and durably: the file is fsync'd before the rename and the directory after,
 * so a power cut can lose at most the newest write, never leave a torn one.
 * The directory fsync is best-effort (not every platform permits it); rename
 * already covers the torn-write case on its own.
 */
export function saveRun(state: RunState): void {
  state.updatedAt = new Date().toISOString();
  const target = runFile(state.root, state.slug, state.id);
  const dir = runDir(state.root, state.slug);
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  try {
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* best-effort */ }
}

/* ------------------------------------------------------------------ *
 * Reclaiming a run whose writer died
 * ------------------------------------------------------------------ */

/**
 * Which runs are genuinely being driven right now.
 *
 * A single id was the whole answer while one `Runner` existed. With a pool
 * there are several, and the shape has to widen without breaking the dozens of
 * callers that pass one id — so both are accepted and every reader goes
 * through `isLive`. Passing the wrong shape is the failure that matters here:
 * a Set silently compared with `===` would mark every live run as dead and
 * reconcile a fleet of working runs into `interrupted`.
 */
export type LiveRuns = string | null | undefined | ReadonlySet<string>;

/** Is this run one of the ones something is actually driving? */
export function isLive(id: string, live: LiveRuns): boolean {
  if (!live) return false;
  return typeof live === 'string' ? live === id : live.has(id);
}

/**
 * Make a loaded run tell the truth about whether anything is driving it.
 *
 * `status: "running"` is not an observation, it is a claim — written by a
 * process that can be killed in the next microsecond, and then never corrected,
 * because correcting it was that process's job. A console that reads the claim
 * back and believes it shows a run as live forever, offers a Stop button whose
 * handler has nothing to stop, and hides the one fact the operator needs: that
 * this run ended some time ago and nobody wrote down why.
 *
 * This is the ordinary stale-lease problem, and it takes the ordinary fix:
 * liveness is *derived* at read time from evidence that cannot be faked — is
 * this the run the in-process loop is actually driving, and is the recorded
 * child pid still alive — rather than trusted from a field.
 *
 * `liveRunId` is the id the current `Runner` is driving, and it is the only
 * thing that licenses an in-flight status. Everything else gets reclaimed.
 * Returns whether anything changed, so callers only write when there is
 * something to write.
 */
export function reconcileRun(state: RunState, liveRunId?: LiveRuns): boolean {
  if (isLive(state.id, liveRunId)) return false;
  if (!IN_FLIGHT.includes(state.status)) return false;

  const at = new Date().toISOString();

  // The dangerous case: the console went away but its child did not. That
  // session is still editing the working tree, unobserved. Say so precisely —
  // with the pid — rather than reclaiming a run something is still writing.
  //
  // Every lane is checked, not just the mirror: a three-lane run whose mirror
  // happened to be the one that exited would otherwise reconcile to
  // `interrupted` while two sessions carried on writing the tree.
  const alive = childrenOf(state).filter((child) => pidAlive(child.pid));
  if (alive.length) {
    const first = alive[0];
    // Per-lane first, single-slot second: a checkpoint written before lanes
    // carried `frozen` only recorded the mirror lane's freeze.
    const frozen = alive.filter((child) => child.frozen || state.freeze?.pid === child.pid);
    const running = alive.filter((child) => !frozen.includes(child));
    // A frozen orphan is the one case where "let it finish" is wrong advice:
    // nothing is scheduling it, so it will sit stopped forever waiting for a
    // console that is not coming back.
    const frozenAdvice = frozen.length === 1
      ? `phase ${frozen[0].phase} was frozen by the operator (pid ${frozen[0].pid}) and the `
        + 'console that stopped it is gone, so nothing will start it again. Continue it with '
        + `\`kill -CONT ${frozen[0].pid}\`, or stop it with \`kill ${frozen[0].pid}\` and run the phase again.`
      : `${frozen.length} phases were frozen by the operator and the console that stopped them `
        + 'is gone, so nothing will start them again. Continue each with `kill -CONT <pid>` '
        + `(${frozen.map((child) => `pid ${child.pid} — phase ${child.phase}`).join('; ')}), `
        + 'or stop them and run the phases again.';
    state.status = 'parked';
    state.halt ??= {
      at,
      reason: frozen.length
        ? frozenAdvice + (running.length
          ? ` Meanwhile ${running.length === 1 ? 'a session is' : `${running.length} sessions are`}`
            + ` still running (${running.map((child) => `pid ${child.pid}, phase ${child.phase}`).join('; ')}).`
          : '')
        : alive.length === 1
          ? `a session from an earlier console is still running (pid ${first.pid}, `
            + `phase ${first.phase}). Let it finish or stop it, then continue this run.`
          : `${alive.length} sessions from an earlier console are still running (`
            + `${alive.map((child) => `pid ${child.pid}, phase ${child.phase}`).join('; ')}). `
            + 'Let them finish or stop them, then continue this run.',
      phase: frozen.length ? frozen[0].phase : first.phase,
    };
    return true;
  }

  // A run asleep on a usage window is the one in-flight state whose "why" IS
  // recorded: `waitUntil` says exactly when it meant to continue. Flattening
  // it to `interrupted` — which this function did — threw that away, and a
  // console restart during a long window turned a self-resuming run into one
  // waiting for a person. It reconciles to `paused` with the clock intact;
  // whether anything re-arms the wait is the service's boot decision
  // (`readoptIdle`), not this function's — reconcile preserves facts.
  if (state.status === 'waiting' && state.waitUntil) {
    state.status = 'paused';
    state.child = null;
    delete state.children;
    state.pause = null;
    state.freeze = null;
    // Two kinds of run-level wait share the clock: the usage window, and a
    // park on external work some phase declared. Phase records tell them
    // apart — a `waiting` record exists only for the second — and the boot
    // re-arm (`Service.readoptQueued`) makes the same read.
    const parked = Object.values(state.phases).some((record) => record.status === 'waiting');
    state.finishedReason ??= parked
      ? `waiting on external work — this run meant to resume at ${state.waitUntil}. `
        + 'Continue now, or leave it to re-arm.'
      : `usage limit — this run meant to resume at ${state.waitUntil}. `
        + 'Continue now under another account, or leave it to re-arm.';
    for (const record of Object.values(state.phases)) {
      if (!PHASE_IN_FLIGHT.includes(record.status)) continue;
      record.status = 'pending';
      record.resumeSessionId ??= record.sessionId;
    }
    return true;
  }

  const phase = childrenOf(state)[0]?.phase ?? state.activePhase ?? undefined;
  state.halt ??= {
    at,
    reason: phase === undefined
      ? `nothing has been driving this run since ${state.updatedAt} — the console that started it stopped without recording why.`
      : `nothing has been driving this run since ${state.updatedAt} — the console stopped while phase ${phase} was in flight, without recording why.`,
    phase,
  };
  // A dead `halting` run DID record why it stopped — its halt is the reason —
  // so it finalizes to the `halted` its drive loop never got to write.
  // `interrupted` remains the word for "nothing recorded why".
  state.status = state.status === 'halting' ? 'halted' : 'interrupted';
  state.child = null;
  // Every lane, not only the mirror — a leftover `children` entry would keep
  // presenting a dead session as live on every page that reads the map.
  delete state.children;
  // A pause waiting for a phase that is no longer running will never arrive.
  state.pause = null;
  // Same for a freeze whose child is already gone: the block would otherwise
  // make a dead run look held, and offer a Continue that resumes nothing.
  state.freeze = null;

  // A phase left mid-flight may have half-finished something, so it is marked
  // interrupted rather than failed: continuing asks about it instead of
  // silently running it a second time.
  for (const record of Object.values(state.phases)) {
    if (!PHASE_IN_FLIGHT.includes(record.status)) continue;
    const was = record.status;
    record.status = 'interrupted';
    record.note ??= `the console stopped while phase ${record.phase} was `
      + (was === 'awaiting-verification' ? 'waiting to be verified' : 'running');
    record.endedAt ??= at;
    // The session survives the console that was watching it. Keeping its id
    // here is what makes the difference between offering to CONTINUE this phase
    // and offering only to start it over: an interrupted phase may be twenty
    // minutes of work from done, and a restart throws all of it away.
    record.resumeSessionId ??= record.sessionId;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Letting the board settle a run that stopped
 * ------------------------------------------------------------------ */

/**
 * The phases whose fate decides whether a stopped run still needs a person.
 *
 * A halt is always *about* something: the phase it stopped on. A scoped run is
 * about its scope as well — finishing the phase it halted on while three other
 * requested phases never ran is not a run anybody is done with.
 *
 * Empty means the run stopped without recording what it stopped on, and that
 * is deliberately not resolvable: there is no evidence to overtake, so a person
 * decides. Same fail-safe shape as `reconcileRun` — derive from what can be
 * checked, never from what can be assumed.
 */
export function decidingPhases(state: RunState): number[] {
  const phases = new Set<number>();
  for (const phase of state.onlyPhases ?? []) phases.add(phase);
  const stoppedOn = state.halt?.phase ?? state.activePhase;
  if (typeof stoppedOn === 'number') phases.add(stoppedOn);
  return [...phases].sort((a, b) => a - b);
}

/**
 * Rewrite phase records the board has overtaken: any not-in-flight, not-done
 * record whose phase the board now reads `done` becomes `done` with a note
 * saying the work was closed outside this run.
 *
 * This is the record-level half the run-level resolver below never did — it
 * annotates the RUN but leaves every `failed` phase record standing, which is
 * how a live plan ended up with eight "failed" chips over a board reading
 * done. Never the reverse: a phase the board does NOT read done is untouched,
 * whatever its record says — reconcile closes records, it never re-opens or
 * re-runs them. Clearing the halt is part of the same truth: a halt anchored
 * to a phase that is now done is a card about nothing.
 */
export const RECONCILABLE: readonly PhaseStatus[] = [
  'failed', 'parked', 'waiting', 'pending', 'interrupted', 'gated', 'queued',
];

export function reconcileRecordsAgainstBoard(
  state: RunState,
  board: Record<number, string>,
  now = new Date().toISOString(),
): { changed: boolean; closed: number[] } {
  const closed: number[] = [];
  for (const record of Object.values(state.phases)) {
    if (!RECONCILABLE.includes(record.status)) continue;
    if (board[record.phase] !== 'done') continue;
    record.status = 'done';
    record.note = 'closed outside this run (the board reads done)';
    record.endedAt ??= now;
    delete record.parkedUntil;
    delete record.parkReason;
    delete record.lockWaitSince;
    closed.push(record.phase);
  }
  if (closed.length && state.halt?.phase != null && closed.includes(state.halt.phase)) {
    state.halt = null;
    state.consecutiveFailures = 0;
  }
  return { changed: closed.length > 0, closed };
}

/**
 * Resolve a stopped run the board has already moved past.
 *
 * The reconciliation above answers "is anything still driving this?"; this
 * answers the question after it — "does what it stopped on still matter?" Both
 * are derived at read time from evidence that cannot be faked, which is the
 * only way a record written by a process that then died can ever be corrected.
 *
 * `board` is the engine's live classification (`phase-graph.sh --memory-block`,
 * `states` in `Board`). Every deciding phase must read `done` on it: an empty
 * or unreadable board therefore resolves nothing, which is the safe direction —
 * a run that still wants attention and does not get it is the failure this
 * whole surface exists to prevent, so uncertainty keeps the card.
 *
 * Returns whether anything changed, so callers only write when there is
 * something to write.
 */
export function autoResolveRun(state: RunState, board: Record<number, string>): boolean {
  if (state.resolved || state.reopenedAt) return false;
  if (!RESOLVABLE.includes(state.status)) return false;

  const phases = decidingPhases(state);
  if (!phases.length) return false;
  if (!phases.every((phase) => board[phase] === 'done')) return false;

  state.resolved = {
    at: new Date().toISOString(),
    auto: true,
    reason: `superseded — the board shows ${
      phases.length === 1 ? `phase ${phases[0]}` : `phases ${phases.join(', ')}`
    } done`,
  };
  return true;
}

/**
 * Which plans a batch of runs would need a board for.
 *
 * Split out from the batch itself so the caller can pay for exactly the engine
 * reads that could change something: a fleet of two hundred finished runs asks
 * for no boards at all, and twelve stopped runs across three plans ask for
 * three.
 */
export function slugsNeedingBoard(runs: readonly RunState[]): string[] {
  return [...new Set(
    runs
      .filter((run) => !run.resolved && !run.reopenedAt && RESOLVABLE.includes(run.status))
      .map((run) => run.slug),
  )];
}

/**
 * Apply the board resolver across a batch, and report what changed.
 *
 * A slug missing from `boards` — an engine failure, a plan that no longer
 * exists — resolves nothing, which is the same fail-safe `autoResolveRun`
 * takes on an empty board.
 */
export function resolveRunsAgainst(
  runs: readonly RunState[], boards: ReadonlyMap<string, Record<number, string>>,
): RunState[] {
  const changed: RunState[] = [];
  for (const run of runs) {
    const board = boards.get(run.slug);
    if (!board) continue;
    // Records first, run second: closing the overtaken phase records is what
    // makes the run-level "superseded" annotation match what the phase table
    // shows. Only stopped runs — a live loop owns its records and does the
    // same reconcile itself at the top of every drive tick.
    const records = RESOLVABLE.includes(run.status) && !run.reopenedAt
      ? reconcileRecordsAgainstBoard(run, board)
      : { changed: false, closed: [] };
    const resolved = autoResolveRun(run, board);
    if (records.changed || resolved) changed.push(run);
  }
  return changed;
}

/** Reclaim on read, and make the correction stick so it is done once. */
function settle(state: RunState, liveRunId?: LiveRuns): RunState {
  if (!reconcileRun(state, liveRunId)) return state;
  try { saveRun(state); } catch { /* a read must not fail because the disk did */ }
  return state;
}

export function loadRun(root: string, slug: string, id: string, liveRunId?: LiveRuns): RunState | null {
  try {
    return settle(JSON.parse(readFileSync(runFile(root, slug, id), 'utf8')) as RunState, liveRunId);
  } catch {
    return null;
  }
}

/** Every run recorded for a plan, newest first. */
export function listRuns(root: string, slug: string, liveRunId?: LiveRuns): RunState[] {
  const dir = runDir(root, slug);
  if (!existsSync(dir)) return [];
  const runs: RunState[] = [];
  for (const name of readdirSync(dir)) {
    const id = /^run-([0-9a-f]{8})\.json$/.exec(name)?.[1];
    if (!id) continue;
    const state = loadRun(root, slug, id, liveRunId);
    if (state) runs.push(state);
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The run to offer when someone opens a plan: the one still in flight, else the
 * most recent. A finished run is still worth showing — it is the record of what
 * happened — but it must never be silently resumed.
 */
export function latestRun(root: string, slug: string, liveRunId?: LiveRuns): RunState | null {
  const runs = listRuns(root, slug, liveRunId);
  return runs.find((r) => r.status !== 'finished') ?? runs[0] ?? null;
}

/** Is a process with this pid still alive? Used to reconcile after a restart. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
