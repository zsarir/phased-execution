/**
 * Server access — the transport every `lib/api/*` domain module speaks through.
 *
 * There is no request cache here, unlike `web/api.js`. TanStack Query is the
 * cache now, and two caches that invalidate on different signals is how a board
 * ends up showing yesterday's state confidently. This module only knows how to
 * make a request; `queries.ts` decides when it is stale.
 *
 * `request`, `post` and `q` were private to the one-file `lib/api.ts`. They are
 * exported here so the domain modules (`./state`, `./plans`, `./runs`, …) share
 * one fetch path, one CSRF header and one error shape; views keep importing
 * `api` from `@/lib/api` and never call these directly.
 */

/** Every request carries this; non-GETs additionally need a same-origin Origin,
 *  which the dev proxy rewrites (see vite.config.ts). */
const CSRF = { 'x-phase-console': '1' } as const;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    /**
     * The parsed error body, when there was one.
     *
     * A refusal often carries more than a sentence — the recovery mint's 409
     * names the session already working on that phase, so the caller can offer
     * it instead of only saying no. Optional and untyped: every existing
     * handler reads `message` and is unaffected.
     */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { ...CSRF, ...(options.headers ?? {}) },
  });
  const type = res.headers.get('content-type') ?? '';
  const body: unknown = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message =
      typeof body === 'string' && body
        ? body
        : ((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
    throw new ApiError(message, res.status, path, body);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

export const q = encodeURIComponent;
