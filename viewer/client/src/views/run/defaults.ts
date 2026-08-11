/**
 * What a run starts as, and the vocabularies the controls offer.
 *
 * ## The defaults moved, and why
 *
 * Every run used to begin on `sonnet` / no effort / `halt-on-everything` /
 * `guarded`. That was the right posture for the first weeks of an unattended
 * system — stop and show your work — and the wrong one for what the autopilot
 * turned out to be used for: a phase of real engineering, left running while
 * nobody watches. On those settings a phase would think less hard than the
 * operator would have asked for, and then stop at the first commit to ask
 * permission for something the deny list already governs. The two failures
 * compound: the cheap model needs supervision most, and the supervision is what
 * nobody is there to give.
 *
 * So: **opus / max / keep-going / trusted**. Trusted is not "unguarded" — the
 * deny list still refuses pushes, destructive git, deploys and publishes, and it
 * does so from inside the CLI, which means it holds even with this console dead.
 * What changes is that the *reversible* things stop raising a card.
 *
 * ## One definition, three readers
 *
 * These are the client's opening values for a fresh run. The server has its own
 * fallbacks (`server/runner/state.ts` `newRun`) for callers that are not this
 * client, and `server/api/routes.ts` keeps `guarded` as the fallback for an
 * unrecognised profile — a typo must never be the reason a run takes the guard
 * rails off. The client therefore sends `trusted` **explicitly** rather than
 * relying on an omission to mean it.
 */

import type { Autonomy, McpDegradation, PermissionProfile } from '@/lib/api';

export interface RunDefaults {
  model: string;
  effort: string;
  autonomy: Autonomy;
  permissionProfile: PermissionProfile;
}

export const DEFAULTS: Readonly<RunDefaults> = Object.freeze({
  model: 'opus',
  effort: 'max',
  autonomy: 'keep-going',
  permissionProfile: 'trusted',
});

/** Every model the autopilot may start a phase on, strongest first. */
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/** The five the CLI accepts, plus blank for "whatever this machine defaults to". */
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * What each level is for, read while choosing it rather than after.
 *
 * These were a note beside the select, which made the field lay out three
 * columns and overlap. In the options they are both a smaller layout and a
 * better moment to read them.
 */
export const EFFORT_NOTE: Record<string, string> = {
  '': "default · this machine's",
  low: 'low · mechanical work',
  medium: 'medium · balanced',
  high: 'high · implementation',
  xhigh: 'xhigh · hard reasoning',
  max: 'max · hardest, slowest',
};

export const PROFILE_LABEL: Record<PermissionProfile, string> = {
  guarded: 'Guarded — ask me about the irreversible',
  trusted: 'Trusted — only the deny list stops it',
  bypass: 'Bypass — the CLI stops asking too',
};

/**
 * Why a phase went without a server it asked for — the client half of the
 * server's `mcpReasonText`, and the reason each maps to a different errand:
 * "sign this in" and "this is not registered here" are not the same job.
 */
export const MCP_REASON: Record<McpDegradation['reason'], string> = {
  'needs-auth': 'needs signing in',
  failed: 'would not connect',
  unregistered: 'is not registered here',
  'switched-off': 'is switched off',
};

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  'halt-on-everything': 'Stop and ask me',
  'keep-going': 'Keep going where it safely can',
};

/**
 * Statuses that mean a loop is genuinely behind this run right now.
 *
 * `frozen` belongs here even though nothing is being scheduled: there is a live
 * child holding a warm session, so the controls that act on one — Stop, Steer,
 * Continue — all still apply, and treating it as idle would offer a Start button
 * that refuses because a run is already in progress.
 *
 * `queued` belongs for the same reason read from the other end: it holds no child
 * and no lock — which is exactly why the server keeps it out of its own
 * `IN_FLIGHT` — but a loop IS behind it, sitting in `admit()`. Left out, a queued
 * run fell through `outcomeOf`'s tail and the fleet called it **interrupted**,
 * while its plan offered a Start button the server answers with a 409.
 */
export const LIVE_STATUSES = [
  // `halting` is a drain: sessions are still live and Stop must stay offered.
  'running', 'waiting', 'pausing', 'stopping', 'frozen', 'queued', 'halting',
] as const;

export const isLive = (status: string | undefined): boolean =>
  (LIVE_STATUSES as readonly string[]).includes(status ?? '');

/**
 * The ten statuses collapsed to the five words an operator uses.
 *
 * `RunStatus` is precise because the runner needs it to be — `pausing` and
 * `paused` are genuinely different to a loop deciding what to do next. To
 * somebody reading a list of runs they are one thing, and a filter offering ten
 * chips is a filter nobody uses. The distinction that survives is what the run
 * is *asking of you*: nothing (in flight), a decision (waiting), an
 * investigation (halted), or nothing ever again (finished, interrupted).
 *
 * This lives here rather than in either view's model because both the fleet and
 * the plan list read it, and a second copy would eventually disagree about where
 * `paused` belongs.
 */
export const OUTCOMES = [
  { id: 'live', label: 'In flight', hint: 'a loop is driving it right now' },
  { id: 'attention', label: 'Waiting on you', hint: 'stopped until a person moves it' },
  { id: 'halted', label: 'Halted', hint: 'stopped on something that must not be automated past' },
  { id: 'finished', label: 'Finished', hint: 'nothing left to do on that plan' },
  { id: 'interrupted', label: 'Interrupted', hint: 'nothing is driving it, and nothing said why' },
] as const;

export type OutcomeId = (typeof OUTCOMES)[number]['id'];

/**
 * Every `RunStatus` maps to exactly one outcome.
 *
 * `paused` is "waiting on you", not "in flight": the loop has genuinely stopped
 * and only a person restarts it. `frozen` is the opposite call — a live child
 * still holds a warm session, so it belongs with the running ones.
 */
export function outcomeOf(status: string | undefined): OutcomeId {
  if (isLive(status)) return 'live';
  if (status === 'parked' || status === 'paused') return 'attention';
  if (status === 'halted') return 'halted';
  if (status === 'finished') return 'finished';
  return 'interrupted';
}

/** Plans write these as prose; only a known alias is a choice. */
export function modelAlias(text: string | undefined): string | undefined {
  const match = /\b(fable|opus|sonnet|haiku)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

export function effortAlias(text: string | undefined): string | undefined {
  const match = /\b(low|medium|high|xhigh|max)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}
