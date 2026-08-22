/**
 * The situation classifier: evidence about ONE phase in, ONE named situation
 * out — pure, deterministic, and the only thing the remediation ladder reads.
 *
 * Two halves, deliberately separate:
 *
 *   - `collectEvidence()` gathers facts that already exist — the board line
 *     (`phase-graph.sh --memory-block`, read by the caller), the handoff's
 *     status and Outstanding text (the store), the run's record and halt, the
 *     lock (`phase-lock.sh status` or the store's parsed file), the working
 *     tree (`git status` / `git log --since`, the same two questions the
 *     runner's `producedWork` asks), the gate, QA, MCP, health, and the
 *     session registry when one exists. It shells only what exists and never
 *     invents a fact it could not read: an unreadable tree is `did: null`,
 *     not `false`.
 *   - `classifySituation()` walks `SITUATIONS` in precedence order and returns
 *     the first whose evidence holds, with the sentences that decided it. No
 *     I/O, no clock, no dependency on the halt site's opinion beyond the halt
 *     kind as one witness among others.
 *
 * Why this exists: the healer used to pick its remedy from the halt kind
 * (`autoRecoveryClass`) — a word about where the runner stopped. The three
 * measured dead ends were all a phase mis-named by that word: a never-started
 * phase read as `interrupted` (settled, parked, "no phase to anchor"), an
 * in-progress handoff read as missing paperwork (two closeout loops), a
 * declared blocker read as "no handoff" (closeouts re-confirming the blocker
 * for $68). `test/situation.test.ts` pins each of those specimens, built from
 * the journal facts, to the situation it really was.
 */

import { execFile } from 'node:child_process';

import {
  SITUATIONS, SITUATION_ACTOR, SITUATION_BLURBS, SITUATION_LABELS, SUB_KINDS,
  isSituation, parseSituationKey, situationKey, situationLabel,
} from '../../shared/situation-model.js';
import type { PhaseRecord, RunState } from './state.ts';

export {
  SITUATIONS, SITUATION_ACTOR, SITUATION_BLURBS, SITUATION_LABELS, SUB_KINDS,
  isSituation, parseSituationKey, situationKey, situationLabel,
};

export type SituationId = (typeof SITUATIONS)[number];
export type SituationActor = 'machine' | 'person' | 'wait' | 'none';

export type Situation = {
  id: SituationId;
  sub?: string;
  /** `id:sub` — the key the journal, the rung history and the errand carry. */
  key: string;
  label: string;
  blurb: string;
  actor: SituationActor;
  /** The evidence that decided it, as short sentences in the order it was weighed. */
  why: string[];
};

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

export type WorkEvidence = {
  /** True: something landed. False: provably nothing. Null: could not read the tree. */
  did: boolean | null;
  why: string;
  dirty?: number;
  commits?: number;
};

export type LockEvidence = {
  holder: string;
  /** The holder is this console's own run (or this console's recovery owner). */
  ours: boolean;
  expired: boolean;
  leaseUntil?: number;
  scope?: string[];
  /** The holder's session id when the lock carries one (Phase 5 `session=`). */
  session?: string;
  /** The registry's answer about that session, when it has one. */
  live?: boolean;
};

/**
 * Everything the classifier may weigh. Every field is a FACT read from
 * somewhere real; `collectEvidence` names where. Nullable means "not
 * available here", which the classifier treats differently from "no".
 */
export type PhaseEvidence = {
  slug: string;
  phase: number;
  /** The engine's word: done | in-progress | stuck | ready | waiting | unknown. */
  board: string;
  handoff: { exists: boolean; status?: string; outstanding?: string };
  record: {
    status?: string;
    attempts?: number;
    sessionId?: string | null;
    resumable?: boolean;
    startedAt?: string | null;
    endedAt?: string | null;
    verification?: { ok: boolean; failed?: number; ran?: number; skipped?: number } | null;
    closeout?: { at: string; ok: boolean; note?: string } | null;
    note?: string | null;
    said?: string | null;
    gate?: { clear: boolean; kind: string; detail?: string } | null;
    parkedUntil?: string | null;
    parkReason?: string | null;
    watch?: string[];
    waits?: number;
    costUsd?: number;
    turns?: number;
    /** A lane of THIS console is driving the phase right now. */
    live?: boolean;
    mcpDegraded?: string[];
  } | null;
  run: {
    status?: string;
    halt?: { kind?: string; reason?: string; phase?: number } | null;
    waitUntil?: string | null;
    resolved?: boolean;
    onLimit?: string;
    limits?: { status?: string; utilization?: number; resetsAt?: number } | null;
  } | null;
  lock: LockEvidence | null;
  work: WorkEvidence;
  /** The outcome the session declared (`phase-outcome.sh`), when one is known. */
  declared: { status: string; reason?: string; watch?: string[]; writtenAt?: string } | null;
  /** The gate as the engine answers it (`--gate-status`): kind `clear|manual|ai|blocked|OVERDUE|…`. */
  gate: { clear: boolean; kind: string; detail?: string } | null;
  /**
   * Has the operator delegated human gates on this console
   * (`Prefs.delegateHumanGates`)? A delegated gate is not a person's to clear:
   * the boot prompt briefs the session to verify each condition against evidence
   * it can cite, so the phase is boardable and the ladder owns it.
   *
   * The pref reached the RUNNER (a gated phase boots like an `ai` one) and not
   * the classifier, so a phase already recorded `gated` before delegation was
   * switched on kept classifying `gated-manual` — actor `person`, no rungs, an
   * errand at once. Delegation silently did nothing for exactly the phases that
   * were already stuck, which are the ones it gets turned on for.
   */
  gateDelegated?: boolean;
  mcp: { unreachable: string[]; policy?: string } | null;
  health: Array<{ kind: string; severity: string; phase?: number; detail?: string }>;
  /** A live-session registry hit for this phase (Phase 5); null until then. */
  registry: { live: boolean; sessionId?: string; owner?: string } | null;
  qa: { mode: string; result?: string } | null;
  auth: { signedIn: boolean | null; note?: string } | null;
  /** When the evidence was gathered (ISO). */
  at: string;
};

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

export type EvidenceDeps = {
  root: string;
  /** The store's parsed handoff for the phase, when one exists. */
  handoff?: (slug: string, phase: number) => { status?: string; outstanding?: string } | null | undefined;
  /** The lock, parsed — from the store's lock file or `parseLockStatus(phase-lock.sh status)`. */
  lock?: (slug: string, phase: number) => Promise<LockEvidence | null> | LockEvidence | null;
  qa?: (slug: string, phase: number) => Promise<PhaseEvidence['qa']> | PhaseEvidence['qa'];
  health?: (slug: string) => Promise<PhaseEvidence['health']> | PhaseEvidence['health'];
  /** `Prefs.delegateHumanGates` — see `PhaseEvidence.gateDelegated`. */
  gateDelegated?: () => boolean;
  gate?: (slug: string, phase: number) => Promise<PhaseEvidence['gate']> | PhaseEvidence['gate'];
  registry?: (slug: string, phase: number) => PhaseEvidence['registry'];
  auth?: () => Promise<PhaseEvidence['auth']> | PhaseEvidence['auth'];
  declared?: (slug: string, phase: number) => PhaseEvidence['declared'];
  /**
   * The directories (relative to `root`) the phase's SCOPE names and that exist
   * on disk — where `workEvidence` looks. Absent or empty means the root itself.
   */
  repos?: (slug: string, phase: number) => Promise<string[]> | string[];
  /** `git <args>` in `root`; stdout, or null when git could not answer. Defaults to a real git. */
  git?: (args: string[]) => Promise<string | null>;
  now?: () => Date;
};

function gitIn(root: string): (args: string[]) => Promise<string | null> {
  return (args) => new Promise((resolve) => {
    execFile('git', args, {
      cwd: root, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

/**
 * The working tree's answer — the runner's `producedWork` questions, asked
 * without a runner: is the tree dirty, did anything commit since the phase
 * started. Asked per directory in the phase's SCOPE (`dirs`, default the
 * root): in a superproject whose run root is a docs hub, the root's own
 * `git status` is permanently dirty with submodule pointers and its log
 * carries every other phase's handoff commits — the measured P12 specimen
 * was read as "uncommitted changes" by exactly that false witness, while the
 * repo the phase actually touched was clean. Submodule pointer changes are
 * ignored for the same reason. `did: null` when git could not answer (not a
 * repository, no git) — "I could not look" is a different fact from
 * "nothing is there", and the classifier treats them differently.
 */
export async function workEvidence(
  git: (args: string[]) => Promise<string | null>,
  startedAt?: string | null,
  dirs: string[] = ['.'],
): Promise<WorkEvidence> {
  const where = dirs.length ? dirs : ['.'];
  let readable = 0;
  let dirty = 0;
  let commits = 0;
  const notes: string[] = [];
  for (const dir of where) {
    const prefix = dir === '.' ? [] : ['-C', dir];
    const status = await git([...prefix, 'status', '--porcelain', '--ignore-submodules=all']);
    if (status === null) { notes.push(`${dir}: unreadable`); continue; }
    readable += 1;
    const d = status.split('\n').filter((line) => line.trim()).length;
    dirty += d;
    let c = 0;
    if (startedAt) {
      const log = await git([...prefix, 'log', '--oneline', `--since=${startedAt}`]);
      c = log === null ? 0 : log.split('\n').filter((line) => line.trim()).length;
      commits += c;
    }
    notes.push(`${dir}: ${d ? `${d} uncommitted path${d === 1 ? '' : 's'}` : 'clean tree'}`
      + (startedAt ? `, ${c} commit${c === 1 ? '' : 's'} since the phase started` : ''));
  }
  if (!readable) return { did: null, why: 'the working tree could not be read' };
  if (dirty || commits) return { did: true, why: notes.join('; '), dirty, commits };
  return { did: false, why: notes.join('; ') + (startedAt ? '' : ' (no start time to count commits from)'), dirty, commits };
}

/**
 * `phase-lock.sh <slug> status N` → evidence. Output shapes (the script's
 * own, never reformatted here):
 *   `phase 3: free`
 *   `phase 3: held by OWNER since DATE, lease until DATE [scope: a, b]`
 *   `phase 3: held by OWNER since DATE, lease until DATE (EXPIRED — free to take over) [scope: a]`
 */
export function parseLockStatus(stdout: string, ownerIsOurs: (owner: string) => boolean = () => false): LockEvidence | null {
  const line = stdout.trim().split('\n')[0] ?? '';
  if (!line || /:\s*free\b/.test(line)) return null;
  const m = /held by (\S+)(?: since [^,]*)?(?:, lease until ([^\[(]*))?/.exec(line);
  if (!m) return null;
  const holder = m[1];
  const expired = /EXPIRED/i.test(line);
  const scope = /\[scope:\s*([^\]]*)\]/.exec(line)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean);
  const session = /\bsession[=:]\s*(\S+)/.exec(line)?.[1];
  return { holder, ours: ownerIsOurs(holder), expired, ...(scope?.length ? { scope } : {}), ...(session ? { session } : {}) };
}

/**
 * Gather the facts for one phase. Shells and reads only what exists; a
 * dependency that is absent leaves its field null.
 */
export async function collectEvidence(
  deps: EvidenceDeps,
  slug: string,
  phase: number,
  run: RunState | null,
  board: Record<number, string>,
): Promise<PhaseEvidence> {
  const now = deps.now?.() ?? new Date();
  const record = run?.phases[String(phase)] ?? null;
  const handoff = deps.handoff?.(slug, phase) ?? null;
  const git = deps.git ?? gitIn(deps.root);
  const dirs = await Promise.resolve(deps.repos?.(slug, phase) ?? []).catch((): string[] => []);
  const [lock, qa, health, gate, auth, work] = await Promise.all([
    Promise.resolve(deps.lock?.(slug, phase) ?? null).catch(() => null),
    Promise.resolve(deps.qa?.(slug, phase) ?? null).catch(() => null),
    Promise.resolve(deps.health?.(slug) ?? []).catch(() => []),
    Promise.resolve(deps.gate?.(slug, phase) ?? null).catch(() => null),
    Promise.resolve(deps.auth?.() ?? null).catch(() => null),
    workEvidence(git, record?.startedAt ?? null, dirs).catch((): WorkEvidence => ({ did: null, why: 'the working tree could not be read' })),
  ]);
  return {
    slug,
    phase,
    board: board[phase] ?? 'unknown',
    handoff: handoff
      ? { exists: true, status: handoff.status, ...(handoff.outstanding ? { outstanding: handoff.outstanding } : {}) }
      : { exists: false },
    record: record ? recordEvidence(record) : null,
    run: run ? {
      status: run.status,
      halt: run.halt ? { kind: run.halt.kind, reason: run.halt.reason, phase: run.halt.phase } : null,
      waitUntil: run.waitUntil ?? null,
      resolved: Boolean(run.resolved),
      ...(run.onLimit ? { onLimit: run.onLimit } : {}),
      limits: run.limits ? { status: run.limits.status, utilization: run.limits.utilization, resetsAt: run.limits.resetsAt } : null,
    } : null,
    lock,
    work,
    declared: deps.declared?.(slug, phase) ?? null,
    gate: gate ?? (record?.gate ? { clear: record.gate.clear, kind: record.gate.kind, detail: record.gate.detail } : null),
    ...(deps.gateDelegated?.() === true ? { gateDelegated: true } : {}),
    mcp: record?.mcpDegraded?.length
      ? { unreachable: record.mcpDegraded.map((d) => d.id) }
      : null,
    health,
    registry: deps.registry?.(slug, phase) ?? null,
    qa,
    auth,
    at: now.toISOString(),
  };
}

/** The record fields the classifier reads, and nothing it should not. */
export function recordEvidence(record: PhaseRecord): NonNullable<PhaseEvidence['record']> {
  return {
    status: record.status,
    attempts: record.attempts,
    sessionId: record.sessionId ?? record.resumeSessionId ?? null,
    resumable: Boolean(record.sessionId ?? record.resumeSessionId),
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    verification: record.verification
      ? {
        ok: record.verification.ok,
        failed: record.verification.ran?.filter((r) => !r.ok).length ?? 0,
        ran: record.verification.ran?.length ?? 0,
        skipped: record.verification.skipped?.length ?? 0,
      }
      : null,
    closeout: record.closeout ? { at: record.closeout.at, ok: record.closeout.ok, note: record.closeout.note } : null,
    note: record.note ?? null,
    said: record.said ?? null,
    gate: record.gate ?? null,
    parkedUntil: record.parkedUntil ?? null,
    parkReason: record.parkReason ?? null,
    ...(record.watch?.length ? { watch: record.watch } : {}),
    ...(record.waits != null ? { waits: record.waits } : {}),
    costUsd: record.costUsd,
    ...(record.turns != null ? { turns: record.turns } : {}),
    ...(record.mcpDegraded?.length ? { mcpDegraded: record.mcpDegraded.map((d) => d.id) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/** The runner's own park notes (mirrored from runner.ts; `test/situation.test.ts` pins them equal). */
export const VERIFICATION_PARK_RE = /§Verification|states no verification/;
export const MCP_PARK_RE = /MCP server/;

const AUTH_RE = /auth-expired|signed out|not signed in|sign(ed)? in|log ?in required|authentication|invalid api key|OAuth token|credentials? (expired|missing|refused)/i;
const USAGE_RE = /usage limit|rate limit|too many requests|window (reopens|resets)|limit reached|resets at/i;
const BUDGET_RE = /budget (of \$|is spent|spent)|spent the .*budget|\bbudget\b.*\bspent\b/i;

/*
 * Sub-kind detection reads the BLOCKER STATEMENT — the declared reason, the
 * halt's words, and the first block of the handoff's Outstanding section — and
 * matches "blocked on X" PHRASES, never bare nouns. The measured trap: a
 * blocked handoff whose Outstanding opened "nothing external blocks it" and
 * then listed ledger items mentioning a CI token and "no credential exists
 * today" — noun matching read it as a credential blocker; it was two exit
 * criteria left unbuilt (sub-kind unknown → one unblock session).
 */
const LOCK_RE = /\b(lock(ed)?|claim(ed)?|held|owned) by\b|phase-lock|another session (holds|is in|has claimed|is working)|\block:\S+/i;
const CREDENTIAL_RE = /\b(need|needs|needed|missing|lack|lacks|lacking|require|requires|required|without|no|waiting (on|for)|blocked (on|by))\s+(a |an |the |my |its |valid |new )?(credentials?|tokens?|api[- ]?keys?|ssh[- ]?keys?|sign[- ]?in|login|password|secret|2fa|mfa|access to)\b|permission denied|not signed in|signed out|sign(ed)? ?in (is )?(required|needed|first)|authenticat(e|ion) (failed|required|needed)|credentials? (is|are) (missing|expired|invalid|required|needed)/i;
const GATE_RE = /\b(need|needs|needed|await|awaits|awaiting|pending|require|requires|required|waiting (on|for)|blocked (on|by))\s+(a |an |the )?(manual |human |operator |your )?(gate|approval|sign[- ]?off|go[- ]ahead|confirmation)\b|gate (is )?(not )?(approved|cleared|open)|operator must approve|\b(must|needs? to|has to|should) be (confirmed|approved|authori[sz]ed|signed[- ]off|cleared)\b|\bconfirm(ed|ation)? (by|from|with) (a |the )?(person|operator|human|someone)\b/i;
const EXTERNAL_RE = /\b(wait(s|ing)? (on|for)|blocked (on|by)|pending|until|after)\s+(a |an |the |its |our )?(CI|pipeline|build|deploy(ment)?|release|PR|pull request|merge|auto-?merge|window|third[- ]party|upstream|vendor|maintainer|image|run|job)\b|auto-?merge|\bci (is )?(running|pending|red|down|queued)|(build|deploy|pipeline) (is )?(running|in progress|pending|queued)/i;

/**
 * The first block of an Outstanding section — up to the next heading, capped
 * — which is where a handoff states its blocker. The rest of the section is
 * ledger: errands, follow-ups, servers that were missing. Reading all of it
 * for a sub-kind is how incidental nouns became the diagnosis.
 */
export function blockerStatement(outstanding: string | undefined | null, cap = 1_500): string {
  if (!outstanding) return '';
  const lines = outstanding.split('\n');
  const out: string[] = [];
  let seenText = false;
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s/.test(line);
    // A heading before any body text titles the block; one after it starts the next.
    if (heading && seenText) break;
    if (!heading && line.trim()) seenText = true;
    out.push(line);
    if (out.join('\n').length >= cap) break;
  }
  return out.join('\n').slice(0, cap);
}

/** Build a `Situation` from an id + sub + why — the one place the words are looked up. */
export function situation(id: SituationId, why: string[], sub?: string): Situation {
  return {
    id,
    ...(sub ? { sub } : {}),
    key: situationKey(id, sub),
    label: situationLabel(id, sub),
    blurb: SITUATION_BLURBS[id],
    actor: SITUATION_ACTOR[id],
    why,
  };
}

/** The sub-kind of a declared blocker, from what the session wrote and what it watches. */
export function blockerSubKind(text: string, refs: string[] = []): 'lock' | 'credential' | 'gate' | 'external' | 'unknown' {
  const lower = text ?? '';
  if (refs.some((r) => r.startsWith('lock:')) || LOCK_RE.test(lower)) return 'lock';
  if (CREDENTIAL_RE.test(lower)) return 'credential';
  if (GATE_RE.test(lower)) return 'gate';
  if (refs.some((r) => /^(gh|pr|ci|deploy|run|url|http):/i.test(r)) || EXTERNAL_RE.test(lower)) return 'external';
  return 'unknown';
}

/**
 * The classifier. Pure. Walks `SITUATIONS` in order; the first situation whose
 * evidence holds wins. See the module comment for why the order is what it is.
 */
export function classifySituation(e: PhaseEvidence): Situation {
  const rec = e.record;
  const hstatus = e.handoff.exists ? (e.handoff.status ?? 'unknown') : undefined;
  // The run's halt speaks for this phase only when anchored to it (or to no phase at all).
  const halt = e.run?.halt && (e.run.halt.phase == null || e.run.halt.phase === e.phase) ? e.run.halt : null;
  const haltKind = halt?.kind ?? '';
  const haltReason = halt?.reason ?? '';
  const note = rec?.note ?? '';

  /* A lane of this console is in it right now: the drive loop owns it. */
  if (rec?.live) {
    return situation('work-in-progress', ['a session of this console is running the phase right now']);
  }

  /* 1–2. QA verdicts on a phase the board reads done, then superseded. */
  if (e.board === 'done') {
    // `on`, not "anything but off". `waived` is a gate the operator RELEASED —
    // the verdicts stay recorded and reported, they simply stop holding
    // dependents — so a done phase under a waiver is settled work like any
    // other. Admitting it here made the healer write a QA errand for a plan
    // whose gate had been explicitly turned off. Same predicate as
    // `Service.qaHolds`, because there is one question here, not two.
    if (e.qa && e.qa.mode === 'on') {
      if (e.qa.result === 'fail') {
        return situation('qa-failed', ['the board reads done', `QA is ${e.qa.mode} and the recorded verdict is fail`]);
      }
      if (!e.qa.result || e.qa.result === 'pending' || e.qa.result === 'unknown') {
        return situation('qa-pending', ['the board reads done', `QA is ${e.qa.mode} and no verdict is recorded`]);
      }
    }
    return situation('superseded', ['the board reads done — whatever the record says, the work is recorded']);
  }

  /* 3–4. Somebody else's claim. */
  if (e.lock && !e.lock.ours) {
    const liveByRegistry = e.lock.live ?? e.registry?.live;
    if (!e.lock.expired && liveByRegistry !== false) {
      return situation('foreign-live', [
        `the phase lock is held by ${e.lock.holder}${e.lock.expired ? '' : ' and the lease has not expired'}`,
        ...(liveByRegistry === true ? ['the session registry says that session is live'] : []),
      ]);
    }
    const unfinished = hstatus === 'in-progress' || hstatus === 'blocked' || e.work.did === true;
    if (unfinished) {
      return situation('foreign-stale', [
        `the phase lock is held by ${e.lock.holder} but ${e.lock.expired ? 'its lease has expired' : 'its session has ended'}`,
        hstatus === 'in-progress' || hstatus === 'blocked'
          ? `a handoff exists and reads ${hstatus}`
          : e.work.why,
      ]);
    }
    // Debris over nothing: the lock is not the story; fall through.
  }

  /* 5. A declared external wait — the park machinery owns it. */
  if (rec?.status === 'waiting' || e.declared?.status === 'waiting-external') {
    const reason = e.declared?.reason ?? rec?.parkReason ?? null;
    const refs = e.declared?.watch ?? rec?.watch ?? [];
    const elapsed = rec?.parkedUntil ? Date.parse(rec.parkedUntil) <= Date.parse(e.at) : false;
    return situation('waiting-external', [
      `the session declared it is waiting on external work${reason ? `: ${reason}` : ''}`,
      ...(refs.length ? [`watching ${refs.join(', ')}`] : []),
      ...(elapsed ? ['the declared wait has elapsed'] : []),
    ]);
  }
  /* An automatic gate that is simply not met yet (another phase, a date, a command) is a wait too. */
  if (e.gate && !e.gate.clear && (e.gate.kind === 'blocked')) {
    return situation('waiting-external', [`the gate is not met yet: ${e.gate.detail ?? e.gate.kind}`]);
  }

  /* 6. A gate only a person clears.
   *
   * `--gate-status` refuses to RUN a `cmd` gate unless PHASE_EXEC_GATES=1, and
   * prints `manual: cmd gate not executed (…)` when it does not. The read this
   * classifier uses is the page-safe one, so every unapproved command gate came
   * back `manual` — actor `person`, no rungs, an errand written at once — and
   * the console asked somebody to clear a gate that is a COMMAND, and one that
   * would clear itself the moment the runner boarded the phase (boarding does
   * pass the flag). "I could not check" and "a person must decide" are
   * different facts; the MCP probe already draws exactly this line. Falling
   * through is safe because nothing is boarded on this verdict — the runner
   * re-reads the gate for real before it spawns anything. */
  const gateUnevaluated = /\bnot executed\b/i.test(e.gate?.detail ?? '');
  const gateIsAPersons = !e.gateDelegated;
  if (gateIsAPersons && e.gate && !e.gate.clear && !gateUnevaluated && /^(manual|human|OVERDUE)$/i.test(e.gate.kind)) {
    return situation('gated-manual', [`the gate is ${e.gate.kind}: ${e.gate.detail ?? ''}`.trim()]);
  }
  // The record's snapshot may only speak when the LIVE read could not run, or
  // when it agrees. It used to re-ask the same question one line after the live
  // check with no reference to it, so a gate the operator had just approved —
  // the engine answering `clear`, the board reading `ready` — still classified
  // `gated-manual`, for ever. That is the exact invariant CLAUDE.md pins ("the
  // engine is the authority on gate state, including for the healer"); the
  // fallback had quietly grown back around it.
  if (gateIsAPersons && !e.gate?.clear && !gateUnevaluated
    && rec?.status === 'gated' && rec.gate && !rec.gate.clear
    && !/\bnot executed\b/i.test(rec.gate.detail ?? '')
    && /^(manual|human|OVERDUE)$/i.test(rec.gate.kind)) {
    return situation('gated-manual', [`the record is gated (${rec.gate.kind}): ${rec.gate.detail ?? ''}`.trim()]);
  }

  /* 7. The plan itself is broken — cheaper to repair than anything below. */
  if (haltKind === 'plan-lint' || haltKind === 'plan-unreadable' || haltKind === 'verification-preflight') {
    const sub = haltKind === 'plan-lint' ? 'lint' : haltKind === 'plan-unreadable' ? 'unreadable' : 'verification';
    return situation('plan-broken', [`the run halted with kind ${haltKind}: ${haltReason.slice(0, 160)}`.trim()], sub);
  }
  if (rec?.status === 'parked' && VERIFICATION_PARK_RE.test(note)) {
    return situation('plan-broken', [`the phase is parked on its §Verification: ${note.slice(0, 160)}`], 'verification');
  }
  const planIssue = e.health.find((i) => i.severity === 'error' && (i.phase == null || i.phase === e.phase));
  if (planIssue) {
    return situation('plan-broken', [`the plan has a ${planIssue.severity} health issue (${planIssue.kind})${planIssue.detail ? `: ${planIssue.detail.slice(0, 120)}` : ''}`], planIssue.kind || 'issue');
  }

  /* 8. MCP servers the phase needs cannot connect. */
  if (haltKind === 'mcp-preflight' || (rec?.status === 'parked' && MCP_PARK_RE.test(note))
    || (e.mcp && e.mcp.unreachable.length && e.mcp.policy === 'require')) {
    const names = e.mcp?.unreachable.length ? e.mcp.unreachable.join(', ') : undefined;
    return situation('mcp-unavailable', [
      names ? `MCP server(s) unreachable: ${names}` : (haltKind === 'mcp-preflight' ? haltReason.slice(0, 160) : note.slice(0, 160)),
    ]);
  }

  /* 9. Resource walls: money, windows, sign-in, models. */
  if (haltKind === 'budget' || BUDGET_RE.test(haltReason)) {
    return situation('resource-wall', [`the run stopped on its budget: ${haltReason.slice(0, 160)}`], 'budget');
  }
  if (haltKind === 'models-exhausted') {
    return situation('resource-wall', [`every model fell back: ${haltReason.slice(0, 160)}`], 'model');
  }
  if (e.auth?.signedIn === false || (haltKind === 'run-preflight' && AUTH_RE.test(haltReason))
    || AUTH_RE.test(note) || (haltKind === 'needs-human' && AUTH_RE.test(haltReason))) {
    return situation('resource-wall', [
      e.auth?.signedIn === false ? 'the CLI is signed out' : `a sign-in is needed: ${(AUTH_RE.test(note) ? note : haltReason).slice(0, 160)}`,
    ], 'auth');
  }
  if ((e.run?.status === 'waiting' && e.run.waitUntil) || USAGE_RE.test(haltReason) || USAGE_RE.test(note)
    || e.run?.limits?.status === 'limited') {
    return situation('resource-wall', [
      e.run?.waitUntil ? `the run is waiting on the usage window until ${e.run.waitUntil}` : `a usage limit: ${(USAGE_RE.test(note) ? note : haltReason).slice(0, 160)}`,
    ], 'usage');
  }

  /* 10. The session itself said it is blocked (handoff, outcome or halt). */
  const declaredBlocked = hstatus === 'blocked' || e.board === 'stuck'
    || haltKind === 'phase-blocked' || haltKind === 'needs-human' || haltKind === 'waiting-external-timeout'
    || e.declared?.status === 'blocked' || e.declared?.status === 'needs-human'
    || (rec?.status === 'parked' && /needs a person|asked for a person/i.test(note));
  if (declaredBlocked) {
    const text = [e.declared?.reason ?? '', haltReason, note, blockerStatement(e.handoff.outstanding)].filter(Boolean).join('\n');
    const refs = [...(e.declared?.watch ?? []), ...(rec?.watch ?? [])];
    const sub = haltKind === 'waiting-external-timeout' ? 'external' : blockerSubKind(text, refs);
    const why = [
      hstatus === 'blocked' ? 'the handoff reads blocked'
        : e.board === 'stuck' ? 'the board reads stuck (a handoff that is not complete)'
          : haltKind === 'phase-blocked' ? 'the session declared itself blocked'
            : haltKind === 'waiting-external-timeout' ? 'the external wait budget is spent'
              : haltKind === 'needs-human' || e.declared?.status === 'needs-human' ? 'the session asked for a person'
                : 'the session declared itself blocked',
      ...(e.handoff.outstanding ? [`Outstanding: ${e.handoff.outstanding.replace(/\s+/g, ' ').slice(0, 160)}`] : []),
      ...(e.declared?.reason ? [`reason: ${e.declared.reason.slice(0, 160)}`] : []),
      ...(refs.length ? [`watching ${refs.join(', ')}`] : []),
      `sub-kind ${sub}`,
    ];
    return situation('blocked-declared', why, sub);
  }

  /* 11. Red verification. */
  if ((rec?.verification && rec.verification.ok === false) || haltKind === 'verify-failed') {
    return situation('verify-red', [
      rec?.verification && rec.verification.ok === false
        ? `${rec.verification.failed ?? '?'} of ${rec.verification.ran ?? '?'} verification command(s) failed`
        : `the run halted with kind verify-failed: ${haltReason.slice(0, 160)}`,
    ]);
  }

  /* 12. The work is done; the paperwork is not. */
  const endedOnItsOwn = rec?.status !== 'interrupted' && rec?.status !== 'running' && rec?.status !== 'verifying';
  if (endedOnItsOwn && hstatus !== 'in-progress' && e.work.did !== false
    && (haltKind === 'no-handoff' || rec?.verification?.ok === true)) {
    return situation('done-unrecorded', [
      haltKind === 'no-handoff' ? 'the session ended cleanly and the board still reads not done' : 'verification is green',
      e.work.did === true ? e.work.why : 'the working tree could not be read, so the session is trusted to know what it did',
      hstatus ? `a handoff exists but reads ${hstatus}` : 'no handoff exists',
    ]);
  }

  /* 13. Unfinished work is on disk. */
  if (hstatus === 'in-progress' || e.board === 'in-progress' || e.work.did === true
    || rec?.status === 'running' || rec?.status === 'verifying') {
    return situation('work-in-progress', [
      ...(hstatus === 'in-progress' || e.board === 'in-progress' ? ['a handoff exists and reads in-progress'] : []),
      ...(e.work.did === true ? [e.work.why] : []),
      ...(rec?.status === 'running' || rec?.status === 'verifying' ? [`the record reads ${rec.status}`] : []),
      ...(e.handoff.outstanding ? [`Outstanding: ${e.handoff.outstanding.replace(/\s+/g, ' ').slice(0, 160)}`] : []),
    ]);
  }

  /* 14. Nothing ever happened. */
  if (!e.handoff.exists && (e.work.did === false || !rec || rec.status === 'pending' || rec.status === 'queued')) {
    return situation('never-started', [
      'no handoff exists',
      e.work.did === false ? e.work.why : `the record reads ${rec?.status ?? 'absent'} and nothing shows work`,
      ...(rec?.status === 'interrupted' ? [`the session was interrupted${note ? ` (${note.slice(0, 100)})` : ''}`] : []),
      ...(rec?.closeout?.note ? [`closeout: ${rec.closeout.note.slice(0, 120)}`] : []),
    ]);
  }
  /* An interrupted session over a tree we could not read: resume it rather than guess. */
  if (rec?.status === 'interrupted' && e.work.did === null) {
    return situation('work-in-progress', [
      'the session was interrupted and the working tree could not be read — its own session is the witness',
    ]);
  }

  return situation('unknown', [
    `board ${e.board}`, `handoff ${hstatus ?? 'absent'}`, `record ${rec?.status ?? 'absent'}`,
    ...(haltKind ? [`halt ${haltKind}`] : []), e.work.why,
  ]);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

/** The evidence as short lines for a panel or a journal — every field that is known, nothing invented. */
export function summariseEvidence(e: PhaseEvidence): string[] {
  const out: string[] = [`board: ${e.board}`];
  out.push(e.handoff.exists
    ? `handoff: ${e.handoff.status ?? 'unknown'}${e.handoff.outstanding ? ` — Outstanding: ${e.handoff.outstanding.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`
    : 'handoff: none');
  if (e.record) {
    const r = e.record;
    out.push(`record: ${r.status ?? 'unknown'}${r.attempts != null ? ` · ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}` : ''}`
      + `${r.resumable ? ' · session resumable' : ' · no session to resume'}`
      + `${r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ''}${r.turns != null ? ` · ${r.turns} turns` : ''}`);
    if (r.verification) out.push(`verification: ${r.verification.ok ? 'green' : 'red'} (${(r.verification.ran ?? 0) - (r.verification.failed ?? 0)}/${r.verification.ran ?? 0} ok${r.verification.skipped ? `, ${r.verification.skipped} skipped` : ''})`);
    if (r.closeout) out.push(`closeout: ${r.closeout.ok ? 'ran' : 'did not complete'}${r.closeout.note ? ` (${r.closeout.note})` : ''}`);
    if (r.note) out.push(`note: ${r.note.slice(0, 160)}`);
    if (r.parkedUntil) out.push(`parked until ${r.parkedUntil}${r.parkReason ? ` — ${r.parkReason}` : ''}`);
    if (r.gate && !r.gate.clear) out.push(`gate: ${r.gate.kind} — ${r.gate.detail ?? ''}`.trim());
  } else {
    out.push('record: none in this run');
  }
  if (e.run?.halt) out.push(`halt: ${e.run.halt.kind ?? 'unkinded'}${e.run.halt.phase != null ? ` on phase ${e.run.halt.phase}` : ''} — ${(e.run.halt.reason ?? '').slice(0, 160)}`);
  out.push(e.lock
    ? `lock: held by ${e.lock.holder}${e.lock.ours ? ' (ours)' : ''}${e.lock.expired ? ' — expired' : ''}${e.lock.live === false ? ' — session ended' : ''}`
    : 'lock: free');
  out.push(`work: ${e.work.why}`);
  if (e.declared) out.push(`declared: ${e.declared.status}${e.declared.reason ? ` — ${e.declared.reason.slice(0, 140)}` : ''}${e.declared.watch?.length ? ` (watching ${e.declared.watch.join(', ')})` : ''}`);
  if (e.gate && !e.gate.clear) out.push(`gate: ${e.gate.kind}${e.gate.detail ? ` — ${e.gate.detail}` : ''}`);
  if (e.mcp?.unreachable.length) out.push(`mcp: unreachable ${e.mcp.unreachable.join(', ')}${e.mcp.policy ? ` (policy ${e.mcp.policy})` : ''}`);
  if (e.health.length) out.push(`health: ${e.health.map((i) => `${i.severity} ${i.kind}`).join(', ')}`);
  if (e.registry) out.push(`registry: ${e.registry.live ? 'a live session' : 'no live session'}${e.registry.owner ? ` (${e.registry.owner})` : ''}`);
  if (e.qa && e.qa.mode !== 'off') out.push(`qa: ${e.qa.mode}${e.qa.result ? ` — ${e.qa.result}` : ' — no verdict'}`);
  if (e.auth && e.auth.signedIn === false) out.push(`auth: signed out${e.auth.note ? ` (${e.auth.note})` : ''}`);
  return out;
}
