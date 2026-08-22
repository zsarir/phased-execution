/**
 * Lane liveness: is the session that is nominally working actually working?
 *
 * The runner has always known whether a child process EXISTS. It has never
 * known whether that child is doing anything — and the two look identical from
 * every surface the console has: a lane reading `running` at $0.04 a minute
 * with a wedged `Bash` call, a lane reasoning in circles, and a lane about to
 * commit are one word and one spinner. Three real shapes, measured:
 *
 *   - a session whose `Bash` call was waiting on a prompt nobody would ever
 *     type, silent for 51 minutes;
 *   - a session that produced eleven turns of prose in a row because the file
 *     it needed was not there, calling nothing;
 *   - a phase re-attempted three times, each attempt exiting clean, each
 *     leaving the tree exactly as it found it.
 *
 * This file is the part of noticing all three that can be decided from
 * numbers, so it can be tested from numbers. It reads no clock, opens no file
 * and spawns nothing: `applyEvent` folds the stream the runner is already
 * reading into an accumulator, and `evaluateStall` turns an accumulator plus
 * three thresholds into a signal or nothing at all. Everything that needs the
 * world — the 60-second ticker, `git status`, the journal, the announcement —
 * lives in `runner.ts`, which is why that side is fake-clocked in the tests
 * and this side needs no fake at all.
 *
 * The vocabulary (`STALL_SIGNALS`, their labels and the shipped thresholds) is
 * `shared/attention-model.js`, imported rather than restated: the inbox row, the
 * Settings card and this detector must agree about what "ten minutes" is.
 */

import { STALL_DEFAULTS, STALL_SIGNALS } from '../../shared/attention-model.js';

import type { StreamEvent } from './spawn.ts';

export type StallSignal = (typeof STALL_SIGNALS)[number];

/** The three knobs, as `config.ts` spells them. */
export type StallThresholds = {
  /** No output at all for this long — `silent`. */
  stallSilentMs: number;
  /** This many consecutive turns with no tool call — `spinning`. */
  stallSpinTurns: number;
  /** This many consecutive attempts that changed nothing — `stalemate`. */
  stallStalemateAttempts: number;
};

/** One stall episode: what it is, when it started, and the sentence a person reads. */
export type StallState = {
  signal: StallSignal;
  /** ISO — when the condition BECAME true, not when it was noticed. */
  since: string;
  /** One line of evidence: the clock that ran out and, for `silent`, the open call. */
  detail: string;
};

/** A tool call that went out and has not come back. */
export type OpenTool = { id: string; name: string; since: string };

/**
 * What a lane looks like from outside, on the run payload.
 *
 * `commitsSinceStart` and `treeDirty` are the only two fields that cost a
 * subprocess, so they are refreshed on a slower cadence than the rest and are
 * allowed to be a few minutes stale — they answer "has this phase produced
 * anything at all", which does not change per turn.
 */
export type LaneLiveness = {
  phase: number;
  /** ISO — the last stream event of any kind. */
  lastOutputAt: string;
  /** ISO — the last tool call that went out. Absent until one has. */
  lastToolUseAt?: string;
  turnsSinceLastTool: number;
  commitsSinceStart: number;
  treeDirty: boolean;
  /** The call that has been open longest, when one is. */
  openTool?: OpenTool;
  /** The episode in progress, when the lane is in one. */
  stall?: StallState;
};

/**
 * The accumulator `applyEvent` folds the stream into.
 *
 * Milliseconds rather than ISO strings throughout: this is arithmetic, and a
 * type that has to `Date.parse` on every comparison is a type that will
 * eventually compare two strings by accident.
 */
export type LaneSignals = {
  /** When this ATTEMPT's session started — the window `spinning` counts in. */
  startedAt: number;
  lastOutputAt: number;
  lastToolUseAt?: number;
  turnsSinceLastTool: number;
  /** Insertion-ordered, so index 0 is the oldest unanswered call. */
  openTools: OpenToolAt[];
  /** Refreshed on the slow cadence; see `LaneLiveness`. */
  commitsSinceStart: number;
  treeDirty: boolean;
  /** Consecutive attempts of THIS phase that committed nothing and left a clean tree. */
  idleAttempts: number;
  /** True while the phase's own §Verification is running — every signal is suppressed. */
  verifying: boolean;
  /** The episode in progress, so a transition can be told from a repeat. */
  stall: StallState | null;
};

type OpenToolAt = { id: string; name: string; since: number };

/**
 * The same ceiling `spawn.ts` puts on its pending-tool map, and for the same
 * reason: a session that leaks call ids must cost memory that is bounded.
 */
const MAX_OPEN_TOOLS = 64;

/** A fresh accumulator for a lane that has just been spawned. */
export function newLaneSignals(startedAt: number, carry?: { idleAttempts?: number }): LaneSignals {
  return {
    startedAt,
    lastOutputAt: startedAt,
    turnsSinceLastTool: 0,
    openTools: [],
    commitsSinceStart: 0,
    treeDirty: false,
    idleAttempts: carry?.idleAttempts ?? 0,
    verifying: false,
    stall: null,
  };
}

/**
 * Fold one stream event in.
 *
 * Mutates rather than returning a new object, deliberately: this runs on every
 * `partial` delta of every lane, and the alternative is an allocation per
 * character. It is still a pure reducer in the sense that matters — `at` is
 * passed in, nothing here reads a clock, and a test drives it by handing it
 * numbers.
 */
export function applyEvent(signals: LaneSignals, event: StreamEvent, at: number): void {
  // Every event is output. `stderr` included: a session writing to stderr is a
  // session doing something, and a lane that only ever complained is not
  // silent — it is failing, which is a different card.
  signals.lastOutputAt = at;

  switch (event.kind) {
    case 'tool': {
      // A subagent's calls are its own. They are the phase's spend, but they
      // are not evidence that the phase's own conversation is acting — a
      // delegating turn that then waits is exactly the case `spinning` exists
      // to catch.
      if (event.parent) break;
      signals.lastToolUseAt = at;
      signals.turnsSinceLastTool = 0;
      if (event.id) {
        signals.openTools.push({ id: event.id, name: event.name, since: at });
        if (signals.openTools.length > MAX_OPEN_TOOLS) signals.openTools.shift();
      }
      break;
    }
    case 'tool-result': {
      if (event.parent) break;
      const i = signals.openTools.findIndex((tool) => tool.id === event.id);
      if (i >= 0) signals.openTools.splice(i, 1);
      break;
    }
    case 'step': {
      // `spawn.ts` emits this only for the phase's own turns, so there is no
      // parent to check. A turn that carried tool calls has already reset the
      // counter above; one that carried none advances it.
      if (event.tools > 0) signals.turnsSinceLastTool = 0;
      else signals.turnsSinceLastTool += 1;
      break;
    }
    case 'injected': {
      // An operator steering the session is the strongest possible evidence
      // that somebody is on it. Reset the spin counter so the nudge gets a
      // fair hearing instead of tripping the same card on the next turn.
      signals.turnsSinceLastTool = 0;
      break;
    }
    default:
      break;
  }
}

/** The oldest unanswered call, as it goes on the wire. */
export function oldestOpenTool(signals: LaneSignals): OpenTool | undefined {
  const tool = signals.openTools[0];
  return tool ? { id: tool.id, name: tool.name, since: new Date(tool.since).toISOString() } : undefined;
}

/** Fall back to the shipped numbers for anything a caller left out or spelled wrong. */
export function stallThresholds(prefs?: Partial<StallThresholds> | null): StallThresholds {
  const positive = (value: unknown, fallback: number): number =>
    (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    stallSilentMs: positive(prefs?.stallSilentMs, STALL_DEFAULTS.stallSilentMs),
    stallSpinTurns: positive(prefs?.stallSpinTurns, STALL_DEFAULTS.stallSpinTurns),
    stallStalemateAttempts: positive(prefs?.stallStalemateAttempts, STALL_DEFAULTS.stallStalemateAttempts),
  };
}

/** Whole minutes, rounded down, for a sentence rather than a chart. */
function minutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}

/**
 * Which signal, if any, holds right now.
 *
 * Worst-first over `STALL_SIGNALS`, returning the first that holds — so a lane
 * that is both spinning and now silent reports `silent`, which is the newer
 * and harder fact.
 *
 * **`verifying` suppresses everything**, and that is not a nicety. The runner
 * sets `verifying` while it runs the phase's own §Verification commands, which
 * is precisely the stretch where the session has exited and produced nothing
 * for as long as the test suite takes. A `npm test` that runs for twelve
 * minutes is silent and completely fine, and a console that raised a card for
 * it would raise one on every phase of every plan with a real suite.
 *
 * Returns null when nothing holds; the caller compares that against the
 * episode it already had to tell a clear from a quiet.
 */
export function evaluateStall(
  signals: LaneSignals,
  thresholds: StallThresholds,
  now: number,
): StallState | null {
  if (signals.verifying) return null;

  if (signals.idleAttempts >= thresholds.stallStalemateAttempts) {
    return {
      signal: 'stalemate',
      // The episode starts when the attempt that made it true ended, which is
      // the last thing that happened on this lane.
      since: new Date(signals.lastOutputAt).toISOString(),
      detail: `${signals.idleAttempts} attempts in a row ended with nothing committed and a clean tree`,
    };
  }

  const quietFor = now - signals.lastOutputAt;
  if (quietFor >= thresholds.stallSilentMs) {
    const open = signals.openTools[0];
    return {
      signal: 'silent',
      // When the silence began, not when the tick noticed it — otherwise the
      // card's clock restarts every minute and the episode never ages.
      since: new Date(signals.lastOutputAt).toISOString(),
      detail: `no output for ${minutes(quietFor)} min`
        + (open
          ? `; the oldest open tool call is ${open.name}, out for ${minutes(now - open.since)} min`
          : '; no tool call is open'),
    };
  }

  if (signals.turnsSinceLastTool >= thresholds.stallSpinTurns) {
    return {
      signal: 'spinning',
      since: new Date(signals.lastToolUseAt ?? signals.startedAt).toISOString(),
      detail: `${signals.turnsSinceLastTool} turns with no tool call`,
    };
  }

  return null;
}

/**
 * The wire view of a lane. Kept beside the evaluator so the two can never
 * disagree about which fields exist.
 */
export function livenessOf(phase: number, signals: LaneSignals): LaneLiveness {
  const open = oldestOpenTool(signals);
  return {
    phase,
    lastOutputAt: new Date(signals.lastOutputAt).toISOString(),
    ...(signals.lastToolUseAt ? { lastToolUseAt: new Date(signals.lastToolUseAt).toISOString() } : {}),
    turnsSinceLastTool: signals.turnsSinceLastTool,
    commitsSinceStart: signals.commitsSinceStart,
    treeDirty: signals.treeDirty,
    ...(open ? { openTool: open } : {}),
    ...(signals.stall ? { stall: signals.stall } : {}),
  };
}
