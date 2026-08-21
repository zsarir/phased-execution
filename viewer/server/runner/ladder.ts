/**
 * The remediation ladder: per situation, an ordered list of RUNGS — what the
 * autopilot may try next, by itself — bounded by attempts AND dollars, never
 * the same rung twice for one situation on one phase, and an ERRAND for a
 * person when the ladder is exhausted or the situation was theirs to begin
 * with.
 *
 * Pure: it reads the rung history the run carries (`recoveries[phase].rungs`,
 * `state.ts`), the caps (`ladderCaps(prefs)`) and an availability predicate
 * the caller supplies (which vehicles THIS console can drive today), and it
 * answers with a rung or a reason. It launches nothing. Whoever climbs the
 * rung records it with `accountRung` before spending, settles it with
 * `settleRung` when the session ends, and the next call to `nextRung` sees
 * both — that is the whole contract, and `test/ladder.test.ts` holds it.
 *
 * Why dollars as well as counts: the old healer counted launches (2 per
 * phase, 5 per run) and a $40 session followed by two $6 closeouts and a
 * $20 console closeout was "within budget". The caps here default to 3 rungs
 * and $100 per phase, 10 and $400 per run, $600 per day per console — all
 * prefs, all in Settings ▸ Automation (Phase 6 renders them).
 */

import type { Errand, RungRecord } from './state.ts';
import {
  SITUATIONS, SITUATION_ACTOR, situationKey, situationLabel, parseSituationKey,
} from '../../shared/situation-model.js';

export type SituationId = (typeof SITUATIONS)[number];

/**
 * Every vehicle a rung may name. The vocabulary is the design's, not the
 * console's current ability: a vehicle the console cannot drive yet is simply
 * never `available`, and the ladder skips it — so the tables below can state
 * the full ladder while Phase 2–4 land the vehicles one by one.
 */
export const RUNG_VEHICLES = [
  /** Reset the record and board the phase fresh from the engine's boot prompt (`retryPhase`). */
  'reboard-fresh',
  /** `claude -p --resume` the phase's own session through the runner, with an instruction. */
  'resume-own-session',
  /** Board fresh with a runner-appended resume brief (SKILL.md Mode 2 "RESUMING" + evidence). */
  'reboard-resume-brief',
  /** One bounded session explicitly allowed to do the work that unblocks a declared blocker. */
  'unblock-session',
  /** The phase's own session, asked only to verify, commit and write the handoff. */
  'closeout-own-session',
  /** A fresh briefed agent writing the handoff the phase never wrote. */
  'closeout-agent',
  /** A fresh briefed agent at a stronger model/effort fixing the failing verification. */
  'fix-agent',
  /** `scripts/repair-artefacts.sh` — deterministic plan/handoff/INDEX/lock-debris repair. */
  'plan-repair-script',
  /** The plan-repair agent (exists). */
  'plan-repair-agent',
  /** Continue under another registered account with headroom (`trySwitchAccount`). */
  'switch-account',
  /** Continue on the next model in the fallback chain. */
  'switch-model',
  /** Sleep until the usage window (or the first model's window) reopens. */
  'wait-window',
  /** Raise the phase/run budget once, within the policy cap. */
  'raise-budget',
  /** Take over an expired foreign claim (`stale-claim-takeover` agent class). */
  'stale-claim-takeover',
  /** Re-board and let the scheduler queue behind the lock holder. */
  'queue',
  /** Park and poll machine-checkable watch refs (`gh run`, PR state). */
  'poll-park',
  /** Park for a bounded time, then re-evaluate. */
  'timed-park',
  /** Re-check the declared watch refs after a wait elapsed. */
  'recheck-watch',
  /** Wait a bounded time for an MCP server to heal. */
  'wait-heal',
  /** Set the run's MCP policy to continue and re-board the parked phases (exists). */
  'mcp-continue',
] as const;
export type RungVehicle = (typeof RUNG_VEHICLES)[number];

export type Rung = {
  vehicle: RungVehicle;
  /** What distinguishes two rungs on the same vehicle (an escalation step, a mode). */
  params?: Record<string, string | number | boolean>;
  /** What the rung is called on a card and in the journal. */
  label: string;
  /** The promise: what starts, on what, roughly what it costs. */
  blurb: string;
  /** Whether climbing it spends a session (counts against the USD caps' intent). */
  spends: boolean;
};

const R = (vehicle: RungVehicle, label: string, blurb: string, spends: boolean, params?: Rung['params']): Rung =>
  ({ vehicle, label, blurb, spends, ...(params ? { params } : {}) });

/**
 * The ladder, per situation (or `situation:sub`). Order is the climb order.
 * An empty list means the situation has no automatic rung: the errand is
 * written at once (a person's), or nothing is done (a wait's).
 */
export const RUNGS_BY_SITUATION: Readonly<Record<string, readonly Rung[]>> = Object.freeze({
  'superseded': [],
  'qa-failed': [],
  'qa-pending': [],
  'foreign-live': [],
  'foreign-stale': [
    R('stale-claim-takeover', 'Take over the stale claim',
      'Takes the expired claim and continues the unfinished work — then the work-in-progress ladder applies. Costs a session.', true),
  ],
  'waiting-external': [
    R('recheck-watch', 'Re-check what it waits on',
      'Reads the declared watch refs again after the wait elapsed; resumes the own session when they have landed. Free.', false),
  ],
  'gated-manual': [],
  'plan-broken': [
    R('plan-repair-script', 'Deterministic repair',
      'Runs scripts/repair-artefacts.sh: depends_on from the graph, missing INDEX rows, dead-run lock debris. No session. Free.', false),
    R('plan-repair-agent', 'Repair the plan with a new agent',
      'Briefs a fresh agent with the lint/health findings and lets it edit the plan, handoffs or INDEX until validate.sh passes. Costs a session.', true),
  ],
  'mcp-unavailable': [
    R('wait-heal', 'Wait for the server',
      'Holds the phase a bounded time for the unreachable MCP server to come back. Free.', false),
    R('mcp-continue', 'Continue without it',
      'Sets this run\'s MCP policy to continue and re-boards the parked phases without the server; the session is told and records an errand. Costs the phase\'s own session.', true),
  ],
  'resource-wall:usage': [
    R('switch-account', 'Switch to an account with headroom',
      'Continues at once under the registered account whose usage window has the most room — same session when its transcript came along. Free to switch; the phase still costs.', false),
    R('switch-model', 'Switch model',
      'Continues on the next model in the fallback chain. Free to switch; the phase still costs.', false),
    R('wait-window', 'Wait for the window',
      'Sleeps until the usage window reopens, then continues. Free.', false),
  ],
  'resource-wall:auth': [
    R('switch-account', 'Switch to a signed-in account',
      'Continues under a registered account that is signed in. Free to switch; the phase still costs.', false),
  ],
  'resource-wall:budget': [
    R('raise-budget', 'Raise the budget once',
      'Raises the spent budget once, within the policy cap, and continues. The raise is the cost.', true),
  ],
  'resource-wall:model': [
    R('wait-window', 'Wait for the first model\'s window',
      'Sleeps until the first model\'s own limit resets, then continues on it. Free.', false),
  ],
  'blocked-declared:lock': [
    R('queue', 'Queue behind the lock',
      'Re-boards the phase and lets the scheduler wait for the holder — woken by the docs watcher, the lease expiry and the idle poll. Free until it boards.', false),
  ],
  'blocked-declared:credential': [],
  'blocked-declared:gate': [],
  'blocked-declared:external': [
    R('poll-park', 'Park and poll the refs',
      'Parks the phase and polls its machine-checkable watch refs (a gh run, a PR); resumes the own session when they land. Free until then.', false),
    R('timed-park', 'Park for a while',
      'Parks the phase for a bounded time and re-evaluates. Free.', false),
  ],
  'blocked-declared:unknown': [
    R('unblock-session', 'One bounded unblock session',
      'Resumes the phase\'s own session (or boards fresh with an unblock brief) carrying the Outstanding text, explicitly allowed to do the work that unblocks it. One try; costs a session.', true),
  ],
  'verify-red': [
    R('resume-own-session', 'Resume with the failure',
      'Resumes the phase\'s own session with the failing commands and their output, asking it to fix the cause and finish. Costs a session.', true, { mode: 'fix-verification' }),
    R('fix-agent', 'Fix with a stronger new agent',
      'Briefs a fresh agent at a stronger model/effort with the evidence and lets it fix and finish the phase. Costs a full session.', true, { escalate: 'model' }),
  ],
  'done-unrecorded': [
    R('closeout-own-session', 'Finish in its own session',
      'Resumes the phase\'s own session and asks it to verify, commit and write the handoff — nothing else. Costs little; its context is intact.', true),
    R('closeout-agent', 'Close out with a new agent',
      'Briefs a fresh agent to check the phase against the repository and write the handoff it never wrote. Costs a full session.', true),
  ],
  'work-in-progress': [
    R('resume-own-session', 'Continue in its own session',
      'Resumes the phase\'s own session: "you are RESUMING — read git status and git diff first, then carry the phase to its exit criteria". Costs a session.', true, { mode: 'continue' }),
    R('reboard-resume-brief', 'Board fresh with a resume brief',
      'Boards a fresh session from the engine\'s boot prompt plus a runner-appended resume brief (the evidence, SKILL.md Mode 2 RESUMING). Costs a full session.', true),
    R('reboard-resume-brief', 'Board fresh, stronger',
      'The same resume brief at the next model/effort step. Costs a full session.', true, { escalate: 'model' }),
  ],
  'never-started': [
    R('reboard-fresh', 'Re-board fresh',
      'Resets the record to pending and boards the phase from its boot prompt under normal admission — no closeout, no agent, no person. Costs the phase itself.', true),
  ],
  'unknown': [],
});

/** The rung list for a situation, by `id:sub` first and then by `id`. */
export function rungsFor(situationKeyOrId: string): readonly Rung[] {
  if (situationKeyOrId in RUNGS_BY_SITUATION) return RUNGS_BY_SITUATION[situationKeyOrId];
  const { id } = parseSituationKey(situationKeyOrId);
  return RUNGS_BY_SITUATION[id] ?? [];
}

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

export type LadderCaps = {
  perPhaseRungs: number;
  perPhaseUsd: number;
  perRunRungs: number;
  perRunUsd: number;
  perDayUsd: number;
};

export const DEFAULT_LADDER_CAPS: Readonly<LadderCaps> = Object.freeze({
  perPhaseRungs: 3, perPhaseUsd: 100, perRunRungs: 10, perRunUsd: 400, perDayUsd: 600,
});

/** The caps from prefs — the five `ladder*` keys, defaults for anything missing or unusable. */
export function ladderCaps(prefs: {
  ladderPerPhaseRungs?: number; ladderPerPhaseUsd?: number; ladderPerRunRungs?: number;
  ladderPerRunUsd?: number; ladderPerDayUsd?: number;
} | null | undefined): LadderCaps {
  const num = (value: unknown, fallback: number): number =>
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  return {
    perPhaseRungs: num(prefs?.ladderPerPhaseRungs, DEFAULT_LADDER_CAPS.perPhaseRungs),
    perPhaseUsd: num(prefs?.ladderPerPhaseUsd, DEFAULT_LADDER_CAPS.perPhaseUsd),
    perRunRungs: num(prefs?.ladderPerRunRungs, DEFAULT_LADDER_CAPS.perRunRungs),
    perRunUsd: num(prefs?.ladderPerRunUsd, DEFAULT_LADDER_CAPS.perRunUsd),
    perDayUsd: num(prefs?.ladderPerDayUsd, DEFAULT_LADDER_CAPS.perDayUsd),
  };
}

/* ------------------------------------------------------------------ *
 * Choosing the next rung
 * ------------------------------------------------------------------ */

export type NextRungInput = {
  /** The situation to climb for — `id:sub` key (from `Situation.key`). */
  situation: string;
  /** Every rung already climbed on THIS phase, any situation. */
  history: readonly RungRecord[];
  /** Every rung climbed on this RUN, all phases (the per-run caps). */
  runHistory?: readonly RungRecord[];
  /** Every rung climbed by this console TODAY, all runs (the per-day cap). Absent = unknown = uncounted. */
  dayHistory?: readonly RungRecord[];
  caps?: Partial<LadderCaps>;
  /** Which vehicles this console can drive right now. Absent = every vehicle. */
  available?: (rung: Rung) => boolean;
};

export type NextRung =
  | { ok: true; rung: Rung; index: number; key: string }
  | { ok: false; exhausted: boolean; reason: string; key: string };

const usd = (records: readonly RungRecord[]): number =>
  records.reduce((sum, r) => sum + (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);

/** The identity a "same rung" is judged by: situation key + vehicle + params. */
export function rungKey(situation: string, rung: Pick<Rung, 'vehicle' | 'params'>): string {
  const params = rung.params ? Object.entries(rung.params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',') : '';
  return `${situation}|${rung.vehicle}${params ? `|${params}` : ''}`;
}

/**
 * The next rung to climb, or why not. Caps first (a capped phase climbs
 * nothing, whatever the situation), then the first untried, available rung in
 * the situation's table.
 */
export function nextRung(input: NextRungInput): NextRung {
  const caps = { ...DEFAULT_LADDER_CAPS, ...(input.caps ?? {}) };
  const key = input.situation;
  const { id } = parseSituationKey(key);
  const phaseRungs = input.history.length;
  const runRungs = (input.runHistory ?? input.history).length;
  if (phaseRungs >= caps.perPhaseRungs) {
    return { ok: false, exhausted: true, key, reason: `the phase's ladder budget is spent (${phaseRungs} of ${caps.perPhaseRungs} rungs)` };
  }
  const phaseUsd = usd(input.history);
  if (phaseUsd >= caps.perPhaseUsd) {
    return { ok: false, exhausted: true, key, reason: `the phase's ladder budget is spent ($${phaseUsd.toFixed(2)} of $${caps.perPhaseUsd})` };
  }
  if (runRungs >= caps.perRunRungs) {
    return { ok: false, exhausted: true, key, reason: `the run's ladder budget is spent (${runRungs} of ${caps.perRunRungs} rungs)` };
  }
  const runUsd = usd(input.runHistory ?? input.history);
  if (runUsd >= caps.perRunUsd) {
    return { ok: false, exhausted: true, key, reason: `the run's ladder budget is spent ($${runUsd.toFixed(2)} of $${caps.perRunUsd})` };
  }
  if (input.dayHistory) {
    const dayUsd = usd(input.dayHistory);
    if (dayUsd >= caps.perDayUsd) {
      return { ok: false, exhausted: true, key, reason: `today's ladder budget is spent ($${dayUsd.toFixed(2)} of $${caps.perDayUsd})` };
    }
  }

  const actor = SITUATION_ACTOR[id];
  const table = rungsFor(key);
  if (!table.length) {
    return {
      ok: false, exhausted: actor === 'machine', key,
      reason: actor === 'person' ? `${situationLabel(id)} is a person's to settle`
        : actor === 'wait' ? `${situationLabel(id)} settles itself — nothing to climb`
          : actor === 'none' ? 'nothing is wrong'
            : `no automatic rung exists for ${key}`,
    };
  }
  const tried = new Set(input.history.map((r) => rungKey(r.situation, { vehicle: r.rung as RungVehicle, params: r.params })));
  let sawUnavailable = false;
  for (let index = 0; index < table.length; index += 1) {
    const rung = table[index];
    if (tried.has(rungKey(key, rung))) continue;
    if (input.available && !input.available(rung)) { sawUnavailable = true; continue; }
    return { ok: true, rung, index, key };
  }
  return {
    ok: false, exhausted: true, key,
    reason: sawUnavailable && !tried.size
      ? `no rung for ${key} is available on this console yet`
      : `every rung for ${key} has been tried on this phase`,
  };
}

/* ------------------------------------------------------------------ *
 * Bookkeeping
 * ------------------------------------------------------------------ */

export type RecoverySlot = {
  attempts: number;
  lastAt: string;
  lastReason?: string;
  fixed?: boolean;
  lastOutcome?: 'fixed' | 'no-defect' | 'superseded' | 'failed';
  rungs?: RungRecord[];
  errand?: Errand;
  bootResumes?: number;
};

/**
 * Record a rung BEFORE it is climbed — bumped and persisted before the spend,
 * so a console that dies mid-rung still remembers it tried. Keeps `attempts`
 * and `lastAt` in step for readers that predate rungs.
 */
export function accountRung(
  slot: RecoverySlot,
  entry: { situation: string; rung: RungVehicle | string; params?: Rung['params']; at?: string; note?: string },
): RungRecord {
  const at = entry.at ?? new Date().toISOString();
  const record: RungRecord = {
    situation: entry.situation, rung: entry.rung, at, outcome: 'running',
    ...(entry.params ? { params: entry.params } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  };
  (slot.rungs ??= []).push(record);
  slot.attempts = (slot.attempts ?? 0) + 1;
  slot.lastAt = at;
  delete slot.errand;
  return record;
}

/** Settle the newest open rung with how it ended and what it cost. */
export function settleRung(
  slot: RecoverySlot,
  outcome: NonNullable<RungRecord['outcome']>,
  costUsd?: number,
  note?: string,
): RungRecord | null {
  const open = [...(slot.rungs ?? [])].reverse().find((r) => r.outcome === 'running' || r.outcome == null) ?? null;
  if (!open) return null;
  open.outcome = outcome;
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) open.costUsd = (open.costUsd ?? 0) + costUsd;
  if (note) open.note = note;
  if (outcome === 'fixed') { slot.fixed = true; slot.lastOutcome = 'fixed'; delete slot.lastReason; }
  else if (outcome === 'no-defect' || outcome === 'superseded' || outcome === 'failed') { slot.lastOutcome = outcome; }
  return open;
}

/* ------------------------------------------------------------------ *
 * Errands
 * ------------------------------------------------------------------ */

type Ask = { need: string; how: string };

/** What a person is asked for, per situation — the one card, in words a stranger can act on. */
const ASKS: Readonly<Record<string, Ask>> = Object.freeze({
  'superseded': {
    need: 'Nothing — the board reads this phase done.',
    how: 'If the record still shows otherwise, press Re-check; the run reconciles on its next tick anyway.',
  },
  'qa-failed': {
    need: 'A QA verdict of pass or waived for this phase — the recorded fail holds every dependent.',
    how: 'Fix what the QA report names, then run QA again from the phase page (the QA launcher), or record a waiver with qa-record.sh.',
  },
  'qa-pending': {
    need: 'A QA verdict for this phase — the plan gates on QA and none is recorded.',
    how: 'Run QA from the phase page (the QA launcher) or record pass/waived with qa-record.sh.',
  },
  'foreign-live': {
    need: 'Nothing — another live session holds this phase; the autopilot waits for it.',
    how: 'If that session is dead, release its claim from the phase page (Force release) and the run queues in.',
  },
  'foreign-stale': {
    need: 'Permission to take over an expired claim over unfinished work.',
    how: 'Press Take over on the phase page, or release the claim and Retry.',
  },
  'waiting-external': {
    need: 'The external work the session declared it is waiting on to land.',
    how: 'Check the watch refs on the phase page; when they have landed, press Re-check (or Resume the session).',
  },
  'gated-manual': {
    need: 'A person to clear the manual gate — its numbered steps are on the Gate card.',
    how: 'Do the steps, then press Approve on the phase\'s Gate card (or run gate-approve.sh); the run retries the phase.',
  },
  'plan-broken': {
    need: 'A plan, handoff or INDEX that passes validate.sh (or a runnable §Verification for the phase).',
    how: 'Open the plan, fix what the health panel names, then Retry — or press Repair with a new agent.',
  },
  'mcp-unavailable': {
    need: 'The named MCP server signed in and reachable, or a decision to run without it.',
    how: 'Sign the server in under Settings ▸ MCP, or press Continue without these servers on the run page.',
  },
  'resource-wall': {
    need: 'Headroom: an account with usage left, a sign-in, more budget, or a model that is not limited.',
    how: 'Register or sign in an account under Settings ▸ Accounts, raise the budget on the run page, or wait for the window shown on the meter.',
  },
  'resource-wall:usage': {
    need: 'An account whose usage window has room, or the current window to reopen.',
    how: 'Pick another account on the run page, or wait for the reset time the meter shows; the run continues by itself.',
  },
  'resource-wall:auth': {
    need: 'A signed-in Claude account for this run.',
    how: 'Run claude login for the machine account, or sign in a console profile under Settings ▸ Accounts, then Continue.',
  },
  'resource-wall:budget': {
    need: 'More budget — the run or phase has spent what it was allowed.',
    how: 'Raise the budget on the run page and press Continue.',
  },
  'resource-wall:model': {
    need: 'A model that is not rate-limited, or the first model\'s window to reopen.',
    how: 'Pick a model on the run page, or wait for the reset the meter shows.',
  },
  'blocked-declared': {
    need: 'What the session said it is blocked on — read its Outstanding section.',
    how: 'Clear the blocker, then Retry (or Resume the session with an instruction).',
  },
  'blocked-declared:lock': {
    need: 'The lock holder to finish or release — the phase queues behind it.',
    how: 'Nothing, usually; if the holder is dead, Force release on the phase page.',
  },
  'blocked-declared:credential': {
    need: 'The credential the session named and no session holds (a sign-in, a key, a token).',
    how: 'Provide it where the handoff says, then Resume the session with an instruction or Retry.',
  },
  'blocked-declared:gate': {
    need: 'The approval or sign-off the session said it is waiting for.',
    how: 'Give it (or clear the gate), then Retry.',
  },
  'blocked-declared:external': {
    need: 'The external thing the session is waiting on (CI, a PR, a deploy window) to land.',
    how: 'Check its watch refs; when it has landed, Re-check or Retry.',
  },
  'blocked-declared:unknown': {
    need: 'A reading of the session\'s Outstanding section — the blocker it named fits no machine category and one unblock session did not clear it.',
    how: 'Clear what it names, then Resume the session with an instruction or Retry; or split the remaining work into a new phase.',
  },
  'verify-red': {
    need: 'The phase\'s §Verification to pass — the ladder\'s sessions could not make it green.',
    how: 'Read What failed on the phase page, fix it (or fix the verification command if it is wrong), then Re-check or Retry.',
  },
  'done-unrecorded': {
    need: 'A complete handoff for work that verifies green.',
    how: 'Run new-handoff.sh for the phase and commit it, or Resume the session and ask it to close out.',
  },
  'work-in-progress': {
    need: 'Someone to finish the phase — the ladder\'s sessions did not carry it to its exit criteria.',
    how: 'Resume the session with an instruction, or boot the phase by hand from its boot prompt; commit and hand off when done.',
  },
  'never-started': {
    need: 'The phase to be run — it never started and the ladder could not board it.',
    how: 'Press Retry, or boot it by hand from its boot prompt.',
  },
  'unknown': {
    need: 'A person to read the evidence — it fits no situation the autopilot knows.',
    how: 'Open Why is this not done? on the phase page; act on what it shows, then Retry or Re-check — and file the shape so the classifier learns it.',
  },
});

/**
 * The errand for a situation once its rungs are spent (or at once, for a
 * person's). `tried` is the list of rung labels already climbed, so nobody
 * repeats them by hand. Every situation in `SITUATIONS` has a non-empty
 * `need` and `how` — `test/ladder.test.ts` walks the whole list.
 */
export function errandFor(
  situationKeyOrId: string,
  tried: readonly (RungRecord | string)[] = [],
  phase = 0,
  at = new Date().toISOString(),
): Errand {
  const { id, sub } = parseSituationKey(situationKeyOrId);
  const key = situationKey(id, sub);
  const ask = ASKS[key] ?? ASKS[id] ?? ASKS.unknown;
  return {
    phase,
    situation: key,
    tried: tried.map((t) => (typeof t === 'string' ? t : `${t.rung}${t.params?.mode ? ` (${t.params.mode})` : ''}${t.outcome ? ` → ${t.outcome}` : ''}`)),
    need: ask.need,
    how: ask.how,
    at,
  };
}

export { SITUATIONS, SITUATION_ACTOR, situationKey, situationLabel, parseSituationKey };
