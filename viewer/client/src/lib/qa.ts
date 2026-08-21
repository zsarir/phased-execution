/**
 * QA sessions, from the offering side.
 *
 * The server owns the brief and the guards; this owns the *offer* — what the
 * button says, when it is a chip instead, and how a recorded verdict reads on a
 * row. Pure, and deliberately free of React and of `api.ts`, so
 * `test/qa-session.test.ts` can import it directly and hold `qaKey` equal to
 * the server's rather than trusting two implementations to agree.
 */

/** What `qa-record.sh` writes, plus the parser's word for a row it could not read. */
export type QaResult = 'pass' | 'fail' | 'waived' | 'pending' | 'unknown';

/** A verdict that answers the question. Mirrors `isVerdict` on the server. */
export function isVerdict(result: string | undefined): boolean {
  return result === 'pass' || result === 'fail' || result === 'waived';
}

/**
 * The identity a duplicate is judged by — `(slug, phase)`, mirroring
 * `qaKey` in `server/qa-session.ts`, which is what actually enforces it.
 *
 * Two reviewers of one phase write the same report path and race each other's
 * `qa-record.sh` row, so the second is never what anyone meant to press.
 */
export function qaKey(target: { slug?: string; phase?: number }): string {
  return `${target.slug ?? ''}#${target.phase ?? ''}`;
}

/** A minimal session shape, so this file need not import the API types. */
type SessionLike = {
  id: string;
  exited?: unknown;
  meta?: { qa?: { slug: string; phase: number } };
};

/**
 * The live QA session for a phase, if one is running.
 *
 * Read off the sessions list every page already holds — which is what makes the
 * button become a chip with no extra request, and change back the moment the
 * `sessions` event says the process ended.
 */
export function liveQa<T extends SessionLike>(
  sessions: readonly T[] | undefined,
  target: { slug?: string; phase?: number },
): T | undefined {
  if (!sessions?.length) return undefined;
  const key = qaKey(target);
  return sessions.find((session) => !session.exited && session.meta?.qa && qaKey(session.meta.qa) === key);
}

/**
 * The two permission profiles a QA session may start under.
 *
 * `trusted` is an autopilot idea — it means no approval card is raised, and
 * there is no card here: a review runs in a terminal a person is looking at, so
 * the only real question is whether the CLI asks that person before acting.
 */
export const QA_PROFILES = ['guarded', 'bypass'] as const;
export type QaProfile = (typeof QA_PROFILES)[number];

export const QA_PROFILE_LABEL: Record<QaProfile, string> = {
  guarded: 'Guarded — the CLI asks you before it acts',
  bypass: 'Bypass — the CLI stops asking too',
};

/** Which phases are worth reviewing. A phase nobody has finished has no diff to read. */
export function canQa(state: string): boolean {
  return state !== 'waiting';
}
