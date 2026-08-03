/**
 * What is worth waking someone for.
 *
 * The console already knew how to raise a notification; what it lacked was a
 * way to reach a device that is not looking at it. Push closes that, and the
 * moment it does, restraint becomes the whole design problem: a channel that
 * fires for everything is a channel that gets muted, and the notification it
 * gets muted for is the one that mattered.
 *
 * So the catalogue is graded. Things that stop work dead are on by default;
 * progress you would like to know about is on because it is infrequent; the
 * firehose of "a file changed" is present, off, and honest about why.
 *
 * Categories rather than one switch, because "tell me when a run needs me" and
 * "tell me when a phase lands" are different appetites, and a phone and a
 * laptop rarely want the same ones.
 */

export type CategoryId =
  | 'approval' | 'needs-you' | 'halted' | 'parked' | 'phase' | 'finished' | 'ready' | 'changed'
  | 'session' | 'health';

export type Category = {
  id: CategoryId;
  label: string;
  detail: string;
  /** On for a new subscription unless it is asked to be otherwise. */
  byDefault: boolean;
  /** Interrupts a focus mode and buzzes a wrist. Reserved for "nothing proceeds without you". */
  urgent: boolean;
};

export const CATEGORIES: readonly Category[] = [
  {
    id: 'approval',
    label: 'Permission needed',
    detail: 'A session is blocked on a decision only you can make — a command outside its rules, '
      + 'a gate, or a check it cannot make itself. Nothing proceeds until you answer.',
    byDefault: true,
    urgent: true,
  },
  {
    id: 'needs-you',
    label: 'A phase needs you',
    detail: 'A phase did its work and stopped at something no automation may sign off — a check '
      + 'written as prose, a verification only a person can make. It is not failed and not finished; '
      + 'it is waiting, and it will keep waiting.',
    byDefault: true,
    urgent: true,
  },
  {
    id: 'halted',
    label: 'Run halted',
    detail: 'A run stopped on something that must not be automated past — a failed verification, '
      + 'a phase that would not settle. Includes a run that was interrupted with nothing driving it.',
    byDefault: true,
    urgent: true,
  },
  {
    id: 'parked',
    label: 'Run parked or waiting',
    detail: 'Every remaining phase needs a person, or the run is asleep until a usage window '
      + 'reopens. Not an error — it just will not move on its own.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'phase',
    label: 'Phase finished or failed',
    detail: 'Each phase as it lands, with what it cost. The steady pulse of a run you are not '
      + 'watching.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'finished',
    label: 'Plan finished',
    detail: 'A run reached the end of its plan. The one you actually wanted to be told about.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'ready',
    label: 'Work became ready',
    detail: 'A phase became startable because what it was waiting on finished — including work '
      + 'finished by a session you ran yourself, elsewhere.',
    byDefault: false,
    urgent: false,
  },
  {
    id: 'changed',
    label: 'Plans changed on disk',
    detail: 'Any plan or handoff was written. Genuinely everything — an agent editing a handoff '
      + 'mid-phase fires this. Off by default because it is a firehose, not a signal.',
    byDefault: false,
    urgent: false,
  },
  {
    id: 'session',
    label: 'A session ended',
    detail: 'An agent session or terminal finished while you were not watching it, or exited with '
      + 'an error. Closing one yourself is not announced — you already know.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'health',
    label: 'Console problems',
    detail: 'The console degraded, its file watch went deaf, or it restarted after a crash. '
      + 'The supervisor failing quietly is the worst case, because everything else still looks fine.',
    byDefault: true,
    urgent: false,
  },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function isCategory(value: unknown): value is CategoryId {
  return typeof value === 'string' && BY_ID.has(value as CategoryId);
}

export function categoryOf(id: CategoryId): Category {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown category ${id}`);
  return found;
}

export function defaultCategories(): Record<CategoryId, boolean> {
  const out = {} as Record<CategoryId, boolean>;
  for (const c of CATEGORIES) out[c.id] = c.byDefault;
  return out;
}

/**
 * A client may send anything. Unknown keys are dropped and missing ones take
 * their default, so an older client's preferences survive a new category rather
 * than silently turning it on.
 */
export function sanitiseCategories(value: unknown): Record<CategoryId, boolean> {
  const out = defaultCategories();
  if (!value || typeof value !== 'object') return out;
  for (const [key, on] of Object.entries(value as Record<string, unknown>)) {
    if (isCategory(key) && typeof on === 'boolean') out[key] = on;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Where a notification goes when you tap it
 * ------------------------------------------------------------------ */

/** What a notification knows about itself, in as much as decides where it lands. */
export type RouteContext = {
  slug?: string | null;
  phase?: number | null;
  /** A terminal/agent session id — `session` notifications deep-link to the one that ended. */
  sessionId?: string | null;
  /** Which page owns it. A claude session lives on `#/agent`, a shell on `#/terminal`. */
  sessionKind?: 'shell' | 'claude' | null;
};

/**
 * The ONLY place a notification URL is constructed.
 *
 * It was written by hand at two call sites and was wrong at both: they built
 * `/#/plan/<slug>/autopilot`, while the tab is registered as `run`
 * (`web/views/plan.js`). An unknown tab is not an error the router reports — it
 * silently falls back — so every approval notification for the life of the
 * feature opened the Route tab, and the queue you were woken for was one more
 * tap away with nothing saying so.
 *
 * One builder does not make that impossible; it makes it a single line to fix
 * and a single line to test, which is why `test/notifications.test.ts` walks
 * this table against the client's own router rather than trusting it.
 *
 * A category whose payload is missing the slug it needs degrades upwards — to
 * the runs list, or the plan list — rather than producing `#/plan/undefined`.
 */
export function routeFor(category: CategoryId, context: RouteContext = {}): string {
  const slug = context.slug ? encodeURIComponent(context.slug) : null;
  const phase = typeof context.phase === 'number' && Number.isInteger(context.phase) && context.phase > 0
    ? context.phase : null;

  switch (category) {
    // Everything about a run in flight lands on the run itself, because that is
    // where the queue, the console and the controls are.
    case 'approval':
    case 'needs-you':
    case 'halted':
    case 'parked':
    case 'finished':
      return slug ? `/#/plan/${slug}/run` : '/#/runs';
    case 'phase':
      return slug && phase ? `/#/plan/${slug}/phase/${phase}` : slug ? `/#/plan/${slug}/run` : '/#/plans';
    case 'ready':
      return '/#/ready';
    case 'changed':
      return slug ? `/#/plan/${slug}/route` : '/#/plans';
    // The session that ended, on the page that owns its kind. Both pages keep
    // the ended record until it is dismissed, so this link is still good when
    // the notification is tapped an hour later — and if the record HAS gone,
    // the page falls back to its own list rather than a dead end.
    case 'session': {
      const head = context.sessionKind === 'claude' ? 'agent' : 'terminal';
      const id = context.sessionId ? encodeURIComponent(context.sessionId) : null;
      return id ? `/#/${head}/${id}` : `/#/${head}`;
    }
    case 'health':
      return '/#/settings';
    default: {
      // Exhaustiveness: a new category added to CATEGORIES without a route here
      // is a compile error, not a notification that silently opens the
      // dashboard.
      const unreachable: never = category;
      return String(unreachable);
    }
  }
}
