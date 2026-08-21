/**
 * The client half of the ladder vocabulary — a re-export, like `lib/situation.ts`
 * and `lib/recovery.ts`: the vehicles, the rung table per situation, the
 * shipped caps and the words for a climbed rung live in
 * `shared/ladder-model.js`, imported by the server's ladder and by this client
 * alike, so Ways forward says "tried: Continue in its own session → did not
 * hold · next: Board fresh with a resume brief" in exactly the words the
 * journal and the errand carry. `test/ladder.test.ts` holds the two identical
 * by import identity.
 *
 * Below the re-exports: the one derivation every surface renders from —
 * `ladderView()` — what the machine tried on a phase, what it is doing now,
 * what it tries next, or the single errand it left when the ladder ran out.
 */

// Relative, not `@shared/…`: the node test suite imports THIS file directly
// and node resolves no Vite alias.
export {
  RUNG_VEHICLES,
  RUNGS_BY_SITUATION,
  DEFAULT_LADDER_CAPS,
  LADDER_CAP_PREFS,
  RUNG_OUTCOME_LABELS,
  rungsFor,
  rungKey,
  untriedRungs,
  rungLabel,
} from '../../../shared/ladder-model.js';

import {
  RUNG_OUTCOME_LABELS as OUTCOME_WORDS,
  untriedRungs as untried,
  rungLabel as labelOf,
} from '../../../shared/ladder-model.js';
// `.ts` spelled out: the node test suite imports this file directly and node's
// resolver adds no extensions (the client's bundler and tsc both accept it).
import { SITUATION_ACTOR, SITUATION_LABELS, parseSituationKey, situationKey, situationLabel } from './situation.ts';
import type { Errand, RecoverySlot, RungRecord } from './api';

export type RungVehicle =
  | 'reboard-fresh' | 'resume-own-session' | 'reboard-resume-brief' | 'unblock-session'
  | 'closeout-own-session' | 'closeout-agent' | 'fix-agent' | 'plan-repair-script' | 'plan-repair-agent'
  | 'switch-account' | 'switch-model' | 'wait-window' | 'raise-budget' | 'stale-claim-takeover'
  | 'queue' | 'poll-park' | 'timed-park' | 'recheck-watch' | 'wait-heal' | 'mcp-continue';

/** One row of the shared rung table. */
export interface Rung {
  vehicle: RungVehicle | string;
  params?: Record<string, string | number | boolean>;
  label: string;
  blurb: string;
  spends: boolean;
}

/** The run fields the ladder view reads — every surface holds at least these. */
export interface LadderRunLike {
  recoveries?: Record<string, RecoverySlot> | undefined;
  errand?: Errand | null | undefined;
  resolved?: unknown;
}

/** A climbed rung, in words. */
export interface TriedRung {
  rung: string;
  label: string;
  situation: string;
  at: string;
  outcome?: RungRecord['outcome'];
  /** `RUNG_OUTCOME_LABELS[outcome]` — "did not hold", "running"… */
  outcomeLabel?: string;
  costUsd?: number;
  note?: string;
}

export interface LadderSituation {
  key: string;
  id: string;
  sub?: string;
  label: string;
  actor: 'machine' | 'person' | 'wait' | 'none';
}

/** What one surface renders for a phase under the ladder (or a run-level wall). */
export interface LadderView {
  situation?: LadderSituation;
  /** Every rung climbed on the phase, oldest first. */
  tried: TriedRung[];
  /** The rung in flight right now, if one is. */
  running?: TriedRung;
  /** The first untried rung of the situation's table — what the autopilot tries next. */
  next?: Rung;
  /** The one ask for a person; its presence IS exhaustion (or the situation was a person's). */
  errand?: Errand;
  /** Nothing to say: no situation, no history, no errand. */
  empty: boolean;
}

/** This phase's recovery slot on the run, when it has one. */
export function ladderSlot(run: LadderRunLike | null | undefined, phase: number | undefined): RecoverySlot | undefined {
  if (!run || phase == null) return undefined;
  return run.recoveries?.[String(phase)];
}

/**
 * Every open errand of a run: the phase ones in phase order, then the run-level
 * one (a wall with no phase to hang it on). The dashboard's "Waiting on you"
 * and the run page's parked note list exactly these.
 */
export function errandsOf(run: LadderRunLike | null | undefined): Errand[] {
  if (!run) return [];
  const phased = Object.entries(run.recoveries ?? {})
    .filter(([key, slot]) => slot?.errand && /^\d+$/.test(key))
    .map(([, slot]) => slot.errand!)
    .sort((a, b) => a.phase - b.phase);
  return [...phased, ...(run.errand ? [run.errand] : [])];
}

function situationOf(key: string | undefined): LadderSituation | undefined {
  if (!key) return undefined;
  const { id, sub } = parseSituationKey(key);
  const actor = (SITUATION_ACTOR as Record<string, LadderSituation['actor']>)[id] ?? 'person';
  return { key: situationKey(id, sub), id, sub, label: situationLabel(id, sub), actor };
}

function triedOf(slot: RecoverySlot | undefined): TriedRung[] {
  return (slot?.rungs ?? []).map((r) => ({
    rung: r.rung,
    label: labelOf(r.rung, r.params, r.situation),
    situation: r.situation,
    at: r.at,
    ...(r.outcome ? { outcome: r.outcome, outcomeLabel: (OUTCOME_WORDS as Record<string, string>)[r.outcome] ?? r.outcome } : {}),
    ...(typeof r.costUsd === 'number' ? { costUsd: r.costUsd } : {}),
    ...(r.note ? { note: r.note } : {}),
  }));
}

/**
 * The view for one target. The situation comes from the first of: the
 * caller's own (the diagnosis endpoint's), the record's cached one, the
 * errand's, the newest rung's. A phase-less target reads the run-level errand
 * (an auth, usage or budget wall). A resolved run shows nothing — settled
 * questions are not relitigated, and that includes the errand they left.
 */
export function ladderView(input: {
  run?: LadderRunLike | null | undefined;
  phase?: number | undefined;
  situation?: { id: string; sub?: string } | { key: string } | null | undefined;
  record?: { situation?: { key: string } | undefined } | null | undefined;
}): LadderView {
  const { run, phase } = input;
  if (run?.resolved) return { tried: [], empty: true };
  const slot = ladderSlot(run, phase);
  const tried = triedOf(slot);
  const errand = phase != null
    ? (slot?.errand ?? (run?.errand && run.errand.phase === phase ? run.errand : undefined))
    : (run?.errand ?? undefined);
  const given = input.situation
    ? ('key' in input.situation ? input.situation.key : situationKey(input.situation.id, input.situation.sub))
    : undefined;
  const key = given
    ?? input.record?.situation?.key
    ?? errand?.situation
    ?? (tried.length ? tried[tried.length - 1].situation : undefined);
  const situation = situationOf(key);
  const running = [...tried].reverse().find((t) => t.outcome === 'running');
  const next = !errand && !running && situation
    ? (untried(situation.key, slot?.rungs ?? [])[0] as Rung | undefined)
    : undefined;
  return {
    ...(situation ? { situation } : {}),
    tried,
    ...(running ? { running } : {}),
    ...(next ? { next } : {}),
    ...(errand ? { errand } : {}),
    empty: !situation && !tried.length && !errand,
  };
}

/** The label the shared table gives a situation id (for surfaces that hold only the id). */
export function situationWord(id: string): string {
  return (SITUATION_LABELS as Record<string, string>)[id] ?? id;
}

/** The label for a full `id:sub` key — what an errand or a rung record carries. */
export function situationLabelFor(key: string): string {
  const { id, sub } = parseSituationKey(key);
  return situationLabel(id, sub);
}
