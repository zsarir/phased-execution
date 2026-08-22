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
import { isLiveStatus } from '@/lib/status-vocab';

interface RunDefaults {
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

/**
 * Every model the autopilot may start a phase on, strongest first, each with
 * its 1M-window variant where that window is actually available.
 *
 * The source of this list is `scripts/models.env` (`MODEL_ALIASES` and
 * `MODEL_1M_CAPABLE`), which the server reads through
 * `server/runner/models.ts` and mirrors as `offeredModels()`. It is spelled
 * out again here because a browser cannot read the file; Phase 6 rebuilds this
 * form against the server's own list and should delete this copy then.
 *
 * `haiku[1m]` is deliberately absent: the API answers "the long context beta
 * is not yet available for this subscription" for it today. The SERVER still
 * accepts the name — offering and accepting are different questions, and a
 * subscription can gain the beta without the console shipping a new version.
 */
export const MODELS = ['fable', 'fable[1m]', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku'] as const;

/**
 * What a model choice buys, read while choosing it.
 *
 * Only the variants need a note: a bare alias is self-explanatory, and `[1m]`
 * is not — it is the difference between a 200K session and a 1M one, which is
 * the single biggest lever on how many phases fit in one run.
 */
export const MODEL_NOTE: Record<string, string> = {
  'fable[1m]': 'fable · 1M context',
  'opus[1m]': 'opus · 1M context',
  'sonnet[1m]': 'sonnet · 1M context',
};

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
 * run fell through the status mapping's tail and the fleet called it **interrupted**,
 * while its plan offered a Start button the server answers with a 409.
 */
export const isLive = (status: string | undefined): boolean => isLiveStatus(status);

/** Plans write these as prose; only a known alias is a choice. */
export function modelAlias(text: string | undefined): string | undefined {
  const match = /\b(fable|opus|sonnet|haiku)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

export function effortAlias(text: string | undefined): string | undefined {
  const match = /\b(low|medium|high|xhigh|max)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}
