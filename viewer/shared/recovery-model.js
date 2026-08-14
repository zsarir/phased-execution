/**
 * The recovery model: ONE table of every way forward the console can offer a
 * stuck run or phase, and one vocabulary for what each way is called and what
 * it will actually do.
 *
 * Before this file there were two unrelated systems both called "recovery" —
 * a fresh briefed agent session ("Fix with AI", `server/recovery.ts`) and the
 * runner's resume-of-the-phase's-own-session verbs (`recheck`/`closeout`/
 * `resume`) — five word-books describing them, four different subsets of the
 * same actions on one page, and a halt-kind classification duplicated in
 * three places that disagreed about `phase-blocked`. Every one of those
 * consumers now reads THIS module:
 *
 *   - `server/recovery.ts` re-exports `RECOVERY_CLASSES`/`RECOVERY_TITLES`;
 *   - `server/service.ts` builds `PhaseDiagnosis.actions` and the unattended
 *     `autoRecoveryClass` from `recoveryActionsFor`/`KIND_PROFILE`;
 *   - `client/src/lib/recovery.ts` re-exports the classifiers and words;
 *   - `client/src/components/recovery-actions.tsx` renders the actions.
 *
 * Dependency-free ESM (`.js` + JSDoc), the `phase-model.js` precedent: the
 * client imports it as `@shared/recovery-model.js`, the server as
 * `../shared/recovery-model.js`, and the node tests directly — so one parity
 * test can hold every layer to the same ids and words by import identity.
 */

/* ------------------------------------------------------------------ *
 * Mechanisms — the user-visible taxonomy
 * ------------------------------------------------------------------ */

/**
 * @typedef {'check'|'own-session'|'new-agent'|'run-control'|'claim'|'mcp'} Mechanism
 */

/**
 * What each mechanism IS, said once. The badge sits on the button; the blurb
 * is the legend a surface shows when two mechanisms are on offer side by side
 * — the exact confusion ("Fix with AI" vs "Finish this phase") this module
 * exists to end.
 * @type {Record<Mechanism, { badge: string, blurb: string }>}
 */
export const MECHANISMS = {
  'check': {
    badge: 'check',
    blurb: 'A deterministic re-read: board, §Verification commands, validate.sh. No AI session. Free.',
  },
  'own-session': {
    badge: 'own session',
    blurb: "Resumes this phase's OWN Claude session (claude -p --resume) inside the runner — its context is intact, and the run's settings, deny rules and hooks all apply.",
  },
  'new-agent': {
    badge: 'new agent',
    blurb: 'Opens a FRESH interactive Claude session briefed by the console with the evidence. Fresh eyes — it knows the facts, not the conversation. Costs a full session.',
  },
  'run-control': {
    badge: 'run',
    blurb: 'Acts on the run record and the loop — no new AI session by itself.',
  },
  'claim': {
    badge: 'claim',
    blurb: 'Edits the phase-lock file only.',
  },
  'mcp': {
    badge: 'MCP',
    blurb: "Changes this run's MCP policy and retries only the phases that policy parked.",
  },
};

/** The one-line legend shown when both AI mechanisms are on offer together. */
export const MECHANISM_LEGEND =
  'Two ways to hand this to AI: resume the phase\'s own session (cheap — its '
  + 'context is intact), or brief a new agent (fresh eyes — it knows the '
  + 'evidence, not the conversation).';

/* ------------------------------------------------------------------ *
 * Halt kinds — one profile, three consumers
 * ------------------------------------------------------------------ */

/**
 * Every `kind` a halt can carry. The runner writes these at the halt site;
 * `state.ts` mirrors this list as the `HaltKind` union and a parity test
 * holds the two identical. Records written before kinds existed have none
 * and fall to the legacy reason-regexes below.
 */
export const HALT_KINDS = [
  'verify-failed',
  'no-handoff',
  'phase-blocked',
  'waiting-external-timeout',
  'needs-human',
  'plan-lint',
  'phase-crashed',
  'budget',
  'plan-unreadable',
  'failure-streak',
  'models-exhausted',
  'verification-preflight',
  'mcp-preflight',
  // Kinds added when the formerly-kindless halt sites were named:
  'run-preflight',      // start() refused: auth/config preflight failed
  'recovery-failed',    // a recovery attempt crashed or explained why it could not finish
  'orphaned-session',   // adopt() found a live session from an earlier console
  'runner-crashed',     // the drive loop itself threw
];

/**
 * How each kind is treated, decided ONCE:
 *
 *   - `sessionShaped`: the halt banner may offer the phase's own session
 *     (`closeout`). `phase-blocked` is DELIBERATELY false since 2026-08-14 —
 *     the session already wrote its blocked handoff, and the measured failure
 *     was four closeout resumes looping on a phase whose brief forbade the
 *     work that would unblock it. Its session-path is `resume` (with an
 *     instruction, after the blocker is cleared), never `closeout`.
 *   - `humanClass`: which agent briefing the "new agent" button offers a
 *     PERSON — null means an agent session is the wrong tool (a budget halt
 *     wants Continue; a needs-human park wants the person it asked for).
 *   - `autoClass`: what the UNATTENDED healer may launch by itself — strictly
 *     narrower, null for anything ambiguous, human-shaped or resource-shaped.
 *   - `park`: the kind describes a parked run, not a halted one.
 *
 * @type {Record<string, { sessionShaped: boolean, humanClass: string|null, autoClass: string|null, park?: boolean }>}
 */
export const KIND_PROFILE = {
  'verify-failed':            { sessionShaped: true,  humanClass: 'halted-verification',    autoClass: 'halted-verification' },
  'no-handoff':               { sessionShaped: true,  humanClass: 'halted-missing-handoff', autoClass: 'halted-missing-handoff' },
  'phase-blocked':            { sessionShaped: false, humanClass: null,                     autoClass: null },
  'waiting-external-timeout': { sessionShaped: true,  humanClass: 'halted-missing-handoff', autoClass: 'halted-missing-handoff' },
  'needs-human':              { sessionShaped: false, humanClass: null,                     autoClass: null },
  'plan-lint':                { sessionShaped: false, humanClass: 'plan-repair',            autoClass: 'halted-verification' },
  'phase-crashed':            { sessionShaped: false, humanClass: 'interrupted-resume',     autoClass: 'interrupted-resume' },
  'budget':                   { sessionShaped: false, humanClass: null,                     autoClass: null },
  'plan-unreadable':          { sessionShaped: false, humanClass: 'plan-repair',            autoClass: null },
  'failure-streak':           { sessionShaped: false, humanClass: 'interrupted-resume',     autoClass: null },
  'models-exhausted':         { sessionShaped: false, humanClass: null,                     autoClass: null },
  'verification-preflight':   { sessionShaped: false, humanClass: 'plan-repair',            autoClass: 'plan-repair', park: true },
  'mcp-preflight':            { sessionShaped: false, humanClass: null,                     autoClass: null, park: true },
  'run-preflight':            { sessionShaped: false, humanClass: null,                     autoClass: null, park: true },
  'recovery-failed':          { sessionShaped: false, humanClass: 'interrupted-resume',     autoClass: null },
  'orphaned-session':         { sessionShaped: false, humanClass: null,                     autoClass: null, park: true },
  'runner-crashed':           { sessionShaped: false, humanClass: 'interrupted-resume',     autoClass: null },
};

/**
 * Legacy reason-matching for records written before halt kinds existed.
 * The OFFER pair is what a button may be shown on (loose is fine — a person
 * decides); the AUTO pair is what an unattended loop may act on (strict:
 * only the runner's own unmistakable sentences).
 */
export const NO_HANDOFF_OFFER_RE = /no handoff was written|not marked complete|ended cleanly but the board/i;
export const VERIFICATION_OFFER_RE = /did not verify|failing validate\.sh|verification/i;
export const NO_HANDOFF_AUTO_RE = /no handoff was written|not marked complete/i;
export const VERIFICATION_AUTO_RE = /did not verify|failing validate\.sh/i;

/* ------------------------------------------------------------------ *
 * Agent classes — one word-book
 * ------------------------------------------------------------------ */

/**
 * The failure classes a briefed agent session exists for. The server refuses
 * anything off this list by name; `server/recovery.ts` re-exports this array
 * so the two can never drift.
 */
export const RECOVERY_CLASSES = [
  'halted-verification',
  'halted-missing-handoff',
  'interrupted-resume',
  'auth-interrupted',
  'stale-claim-takeover',
  'plan-repair',
];

/** @param {unknown} value */
export function isRecoveryClass(value) {
  return typeof value === 'string' && RECOVERY_CLASSES.includes(value);
}

/**
 * What a notification and a card heading call each class — a short noun
 * phrase naming the JOB, reused as the running-chip label ("Fix the failing
 * verification — running") so two differently-labelled buttons can no longer
 * silently share one session unnoticed.
 * @type {Record<string, string>}
 */
export const RECOVERY_TITLES = {
  'halted-verification': 'Fix the failing verification',
  'halted-missing-handoff': 'Finish the closeout',
  'interrupted-resume': 'Resume where it stopped',
  'auth-interrupted': 'Continue after signing in',
  'stale-claim-takeover': 'Take over the claim',
  'plan-repair': 'Repair the plan',
};

/**
 * What the BUTTON says. Every label names the mechanism ("a new agent") so it
 * can never read as the same thing as the own-session verbs beside it.
 * @type {Record<string, string>}
 */
export const RECOVERY_LABELS = {
  'halted-verification': 'Fix with a new agent',
  'halted-missing-handoff': 'Close out with a new agent',
  'interrupted-resume': 'Pick up with a new agent',
  'auth-interrupted': 'Pick up with a new agent',
  'stale-claim-takeover': 'Take over with a new agent',
  'plan-repair': 'Repair the plan with a new agent',
};

/** Appended to every agent blurb — the cost is part of the promise. */
const AGENT_COST =
  ' Opens a fresh interactive session — a new conversation, not the phase\'s '
  + 'own — briefed with the evidence. Costs a full session; you choose model '
  + 'and skills next, and watch it in the Agent tab.';

/**
 * What each agent class will actually do — the tooltip contract: exactly what
 * starts, on what, and what it costs.
 * @type {Record<string, string>}
 */
export const RECOVERY_BLURBS = {
  'halted-verification':
    'Diagnoses the failing verification, fixes the cause and finishes the phase.' + AGENT_COST,
  'halted-missing-handoff':
    'Checks the phase against the repository and writes the handoff it never wrote.' + AGENT_COST,
  'interrupted-resume':
    'Reads the working tree, claims the phase and carries it to its exit criteria.' + AGENT_COST,
  'auth-interrupted':
    'Picks the phase up now that the CLI is signed in again.' + AGENT_COST,
  'stale-claim-takeover':
    'Takes the expired claim and finishes the phase.' + AGENT_COST,
  'plan-repair':
    'Repairs the plan, its handoffs or its INDEX until validate.sh passes.' + AGENT_COST,
};

/** What every surface heads its action group with. */
export const WAYS_FORWARD = 'Ways forward';

/* ------------------------------------------------------------------ *
 * Deterministic actions — one vocabulary
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} RecoveryActionView
 * @property {string} id
 * @property {Mechanism} mechanism
 * @property {string} label
 * @property {string} blurb   Exactly what will happen: what starts, on which session, what it costs, what changes on disk.
 * @property {'run'|'agent'|'writes'|null} flag   Which console capability gates it.
 * @property {'primary'|'secondary'|'overflow'} group
 * @property {string} [recoveryClass]   Set on `fix-agent` — which briefing to launch.
 * @property {string} [disabledReason]  Present ⇒ render disabled, with this exact sentence.
 */

/**
 * The non-agent vocabulary. `fix-agent` composes its words from the class
 * tables above; everything else is one row here.
 * @type {Record<string, { label: string, blurb: string, mechanism: Mechanism, flag: 'run'|'agent'|'writes'|null }>}
 */
export const ACTION_VOCAB = {
  'recheck': {
    label: 'Re-check',
    mechanism: 'check',
    flag: 'run',
    blurb: 'Re-reads the board, re-runs this phase\'s §Verification commands and validate.sh. '
      + 'Starts no session and costs nothing; if the work is already done on disk this closes the phase and clears the halt.',
  },
  'closeout': {
    label: 'Finish in its own session',
    mechanism: 'own-session',
    flag: 'run',
    blurb: 'Resumes this phase\'s own session (claude -p --resume) through the runner and asks it to '
      + 'verify, commit and write the handoff — nothing else. Its context is intact; the run\'s settings, deny rules and hooks all apply.',
  },
  'resume': {
    label: 'Resume with an instruction',
    mechanism: 'own-session',
    flag: 'run',
    blurb: 'The same resume of the phase\'s own session, carrying the words you type first — '
      + 'for when it must fix something before closing out.',
  },
  'retry': {
    label: 'Retry from scratch',
    mechanism: 'run-control',
    flag: 'run',
    blurb: 'Resets this phase\'s record and continues the run from here: a fresh session boots from the '
      + 'phase\'s boot prompt, under normal admission. Discards the stopped session\'s conversation; committed work stays.',
  },
  'skip': {
    label: 'Skip',
    mechanism: 'run-control',
    flag: 'run',
    blurb: 'Marks the phase abandoned in this run and moves on. The board will still read it as not done; nothing on disk is deleted.',
  },
  'mcp-continue': {
    label: 'Continue without these servers',
    mechanism: 'mcp',
    flag: 'run',
    blurb: 'Sets this run\'s MCP policy to continue and retries exactly the phases that parked on unreachable '
      + 'servers. They run without those servers, are told so in their prompt, and record it in the handoff.',
  },
  'continue-run': {
    label: 'Continue',
    mechanism: 'run-control',
    flag: 'run',
    blurb: 'Restarts the loop from the board — nothing is re-run; the board decides what is next.',
  },
  'release': {
    label: 'Release the claim',
    mechanism: 'claim',
    flag: 'writes',
    blurb: 'Deletes the expired lock file so the phase reads free again. Nobody is in it — the lease ran out.',
  },
  'force-release': {
    label: 'Force release',
    mechanism: 'claim',
    flag: 'writes',
    blurb: 'Deletes a LIVE claim held by someone else. Only do this if you know that session is dead — '
      + 'two sessions on one phase overwrite each other\'s work.',
  },
  'dismiss': {
    label: 'Dismiss',
    mechanism: 'run-control',
    flag: 'run',
    blurb: 'Stops this run\'s card asking for attention. The record is untouched and stays on the Runs page.',
  },
};

/** Disabled-state sentences, one per capability flag. */
export const FLAG_OFF = {
  run: 'Runs are disabled. Restart the console with --allow-run.',
  agent: 'Agent sessions are disabled. Restart the console with --allow-agent.',
  writes: 'Writes are disabled. Restart the console with --allow-writes.',
};

/** The mutual-exclusion sentence both AI families show while one is live. */
export const RECOVERY_BUSY =
  'A recovery session is already working on this phase — open it instead.';

/* ------------------------------------------------------------------ *
 * Classification — one place
 * ------------------------------------------------------------------ */

/**
 * @typedef {{ status: string, halt?: { reason?: string, kind?: string, phase?: number } | null, resolved?: unknown }} RunLike
 */

/**
 * Which agent briefing a stopped RUN wants — or undefined when an agent is
 * the wrong tool. Auth first (every other reading of an auth halt is wrong);
 * then the halt's own kind through `KIND_PROFILE`; legacy records fall to
 * the reason-regexes and then to the generic resume.
 *
 * @param {RunLike | null | undefined} run
 * @param {{ authFailure?: boolean }} [opts]
 * @returns {string | undefined}
 */
export function classifyRun(run, opts = {}) {
  if (!run) return undefined;
  if (run.status === 'parked') {
    const profile = run.halt?.kind ? KIND_PROFILE[run.halt.kind] : undefined;
    return profile?.park ? profile.humanClass ?? undefined : undefined;
  }
  if (run.status !== 'halted' && run.status !== 'interrupted') return undefined;
  if (opts.authFailure) return 'auth-interrupted';
  if (run.status === 'interrupted') return 'interrupted-resume';

  const kind = run.halt?.kind;
  if (kind && KIND_PROFILE[kind]) return KIND_PROFILE[kind].humanClass ?? undefined;

  const reason = run.halt?.reason ?? '';
  if (NO_HANDOFF_OFFER_RE.test(reason)) return 'halted-missing-handoff';
  if (VERIFICATION_OFFER_RE.test(reason)) return 'halted-verification';
  return 'interrupted-resume';
}

/**
 * Which agent briefing a phase ROW wants, from its own record's status.
 * `done` and `skipped` want nothing — a recovery is only ever offered for a
 * phase that is genuinely stuck.
 *
 * @param {string} status
 * @param {RunLike | null} [run]
 * @param {{ authFailure?: boolean }} [opts]
 * @returns {string | undefined}
 */
export function classifyPhase(status, run, opts = {}) {
  if (opts.authFailure) return 'auth-interrupted';
  switch (status) {
    case 'failed': {
      const kind = run?.halt?.kind;
      if (kind && KIND_PROFILE[kind]) return KIND_PROFILE[kind].humanClass ?? undefined;
      return NO_HANDOFF_OFFER_RE.test(run?.halt?.reason ?? '')
        ? 'halted-missing-handoff' : 'halted-verification';
    }
    case 'interrupted':
    case 'running':
    case 'verifying':
    case 'pending':
      return 'interrupted-resume';
    case 'parked':
      return run?.halt?.kind === 'verification-preflight' ? 'plan-repair' : undefined;
    default:
      return undefined;
  }
}

/** Every health issue is repaired by the same class; the prompt branches by kind.
 * @param {{ severity?: string }} issue */
export function classifyIssue(issue) {
  return issue.severity === 'error' || issue.severity === 'warning' ? 'plan-repair' : undefined;
}

/** A phase the BOARD calls stuck (handoff blocked/in-progress, often with no
 * run record at all) — plan-repair's stale-handoff job.
 * @param {string} state */
export function classifyBoardPhase(state) {
  return state === 'stuck' ? 'plan-repair' : undefined;
}

/* ------------------------------------------------------------------ *
 * The pure action function
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} RecoveryContext
 * @property {string} [boardState]  The engine's word for the phase (`done` ⇒ nothing to offer).
 * @property {{ status: string, resumable?: boolean } | null} [record]  This run's record of the phase.
 * @property {RunLike | null} [run]
 * @property {{ allowRun?: boolean, allowWrites?: boolean, allowAgent?: boolean }} [flags]
 * @property {{ recoverySessionId?: string | null }} [live]  A live agent recovery on this exact target.
 * @property {{ holder?: string | null, expired?: boolean }} [lock]
 * @property {boolean} [authFailure]
 * @property {boolean} [planIssues]  The plan itself fails lint/health — plan-repair's own case.
 */

/**
 * Every way forward for this state, ordered primary → secondary → overflow.
 *
 * The invariant (held by `test/recovery-model.test.ts`, widened from the old
 * `recoveryActions`): **a phase that is not done always yields at least one
 * action**, disabled ones carrying the exact sentence that says why. Flags
 * disable rather than hide — a button that vanishes teaches nothing.
 *
 * @param {RecoveryContext} ctx
 * @returns {RecoveryActionView[]}
 */
export function recoveryActionsFor(ctx = {}) {
  const { boardState, record, run, flags = {}, live = {}, lock, authFailure, planIssues } = ctx;
  if (boardState === 'done') return [];
  const status = record?.status;
  if (record && (status === 'done' || status === 'skipped')) return [];

  const kind = run?.halt?.kind;
  const profile = kind ? KIND_PROFILE[kind] : undefined;
  const resumable = Boolean(record?.resumable);
  const busy = live.recoverySessionId ? RECOVERY_BUSY : undefined;

  /** @type {RecoveryActionView[]} */
  const out = [];
  const gate = (/** @type {'run'|'agent'|'writes'|null} */ flag) => {
    if (flag === 'run' && flags.allowRun === false) return FLAG_OFF.run;
    if (flag === 'agent' && flags.allowAgent === false) return FLAG_OFF.agent;
    if (flag === 'writes' && flags.allowWrites === false) return FLAG_OFF.writes;
    return undefined;
  };
  const push = (/** @type {string} */ id, /** @type {'primary'|'secondary'|'overflow'} */ group, disabled = undefined) => {
    const vocab = ACTION_VOCAB[id];
    if (!vocab || out.some((a) => a.id === id)) return;
    const disabledReason = disabled ?? gate(vocab.flag);
    out.push({ id, mechanism: vocab.mechanism, label: vocab.label, blurb: vocab.blurb, flag: vocab.flag, group, ...(disabledReason ? { disabledReason } : {}) });
  };
  const pushAgent = (/** @type {string|undefined} */ cls, /** @type {'primary'|'secondary'|'overflow'} */ group) => {
    if (!cls || out.some((a) => a.id === 'fix-agent')) return;
    const disabledReason = busy ?? gate('agent');
    out.push({
      id: 'fix-agent', mechanism: 'new-agent', label: RECOVERY_LABELS[cls],
      blurb: RECOVERY_BLURBS[cls], flag: 'agent', group, recoveryClass: cls,
      ...(disabledReason ? { disabledReason } : {}),
    });
  };

  /* -- Run-level shapes with a dedicated remedy come first -- */

  if (kind === 'mcp-preflight') {
    push('mcp-continue', 'primary');
    if (record) push('retry', 'overflow', busy);
    push('dismiss', 'overflow');
    return out;
  }

  /* -- Phase-level actions, when the caller holds a record -- */

  if (record) {
    const sessionShaped = profile ? profile.sessionShaped : true;
    if (resumable && sessionShaped) {
      push('closeout', 'primary', busy);
      push('resume', 'secondary', busy);
    } else if (resumable && kind === 'phase-blocked') {
      // The declared blocker's session path: resume WITH WORDS once the
      // blocker is cleared — never the closeout that looped on it.
      push('resume', 'primary', busy);
    }
    push('recheck', out.length ? 'secondary' : 'primary');
    pushAgent(
      authFailure ? 'auth-interrupted'
        : run ? (classifyRun(run, { authFailure }) ?? classifyPhase(status ?? '', run, { authFailure }))
          : classifyPhase(status ?? '', run, { authFailure }),
      out.some((a) => a.group === 'primary') ? 'secondary' : 'primary',
    );
    if (kind === 'phase-blocked') pushAgent('plan-repair', 'overflow');
    push('retry', 'overflow', busy);
    push('skip', 'overflow');
    if (lock?.holder) push(lock.expired ? 'release' : 'force-release', 'overflow');
    return out;
  }

  /* -- A phase the BOARD calls stuck, with no run record: a blocked or
        in-progress handoff whose work happened in another session. The board
        state itself is the fact, and the repair is plan-repair's
        stale-handoff job — establish what really happened, finish it if
        finishable, set the status the repository supports. -- */

  if (boardState === 'stuck') {
    pushAgent('plan-repair', 'primary');
    return out;
  }

  /* -- The plan itself fails lint or health checks: plan-repair's own case. -- */
  if (planIssues) {
    pushAgent('plan-repair', 'primary');
    return out;
  }

  /* -- Run-only surfaces (fleet rows, dashboard cards) -- */

  if (run) {
    if (run.status === 'halted' || run.status === 'interrupted' || run.status === 'parked') {
      push('continue-run', 'primary');
      pushAgent(classifyRun(run, { authFailure }), 'secondary');
      push('dismiss', 'overflow');
    }
    return out;
  }

  /* -- A bare lock (ready page) -- */
  if (lock?.holder) {
    push(lock.expired ? 'release' : 'force-release', 'primary');
    if (lock.expired) pushAgent('stale-claim-takeover', 'secondary');
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * The identity a duplicate recovery is judged by — `(slug, phase)`, never the
 * class: two sessions repairing one phase from different angles edit the same
 * files, and the second is never what anyone meant to press.
 * @param {{ slug?: string, phase?: number }} target
 */
export function recoveryKey(target) {
  return `${target.slug ?? ''}#${target.phase ?? ''}`;
}
