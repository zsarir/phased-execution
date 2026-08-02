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
  | 'approval' | 'halted' | 'parked' | 'phase' | 'finished' | 'ready' | 'changed' | 'health';

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
