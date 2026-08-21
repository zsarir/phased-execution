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
 * prefs, all in Settings ▸ Automation. The table itself lives in
 * `shared/ladder-model.js` so the client renders the same rungs by identity.
 */

import type { Errand, RungRecord } from './state.ts';
import {
  SITUATIONS, SITUATION_ACTOR, situationKey, situationLabel, parseSituationKey,
} from '../../shared/situation-model.js';
import {
  RUNG_VEHICLES as SHARED_RUNG_VEHICLES,
  RUNGS_BY_SITUATION as SHARED_RUNGS_BY_SITUATION,
  DEFAULT_LADDER_CAPS as SHARED_DEFAULT_LADDER_CAPS,
  rungsFor as sharedRungsFor,
  rungKey as sharedRungKey,
} from '../../shared/ladder-model.js';

export type SituationId = (typeof SITUATIONS)[number];

/**
 * Every vehicle a rung may name, and the rung table per situation — the
 * SHARED vocabulary (`shared/ladder-model.js`), re-exported here by identity
 * so the server climbs exactly the table the client renders and the journal
 * names. The vocabulary is the design's, not the console's current ability:
 * a vehicle the console cannot drive yet is simply never `available`, and the
 * ladder skips it. Per-vehicle notes live beside the list in the shared file.
 */
export const RUNG_VEHICLES = SHARED_RUNG_VEHICLES;
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

/**
 * The ladder, per situation (or `situation:sub`). Order is the climb order.
 * An empty list means the situation has no automatic rung: the errand is
 * written at once (a person's), or nothing is done (a wait's).
 */
export const RUNGS_BY_SITUATION: Readonly<Record<string, readonly Rung[]>> =
  SHARED_RUNGS_BY_SITUATION as Readonly<Record<string, readonly Rung[]>>;

/** The rung list for a situation, by `id:sub` first and then by `id`. */
export function rungsFor(situationKeyOrId: string): readonly Rung[] {
  return sharedRungsFor(situationKeyOrId) as readonly Rung[];
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

/** The shipped caps — the shared table's numbers, so docs, Settings and the server agree. */
export const DEFAULT_LADDER_CAPS: Readonly<LadderCaps> = SHARED_DEFAULT_LADDER_CAPS;

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

/** The identity a "same rung" is judged by: situation key + vehicle + params (the shared helper). */
export function rungKey(situation: string, rung: Pick<Rung, 'vehicle' | 'params'>): string {
  return sharedRungKey(situation, rung);
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
