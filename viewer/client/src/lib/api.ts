// Minimal data layer for the Phase 1 shell. The full TanStack Query + SSE layer
// arrives in Phase 2; this proves the toolchain and the dev proxy end to end.

// Every non-GET must carry this header (and, in the browser, a same-origin Origin,
// which the dev proxy rewrites — see vite.config.ts).
const CSRF = { 'x-phase-console': '1' } as const;

export async function getState(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/state', { headers: CSRF });
  if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
  return res.json();
}

/**
 * POST a prefs patch. Used in Phase 1 only to prove the dev-proxy Origin rewrite:
 * a browser POST from :5173 that reaches the console on :4123 and is accepted by
 * its CSRF guard means Host and Origin were rewritten correctly.
 */
export async function savePrefs(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/prefs', {
    method: 'POST',
    headers: { ...CSRF, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`POST /api/prefs → ${res.status}`);
  return res.json();
}
