/**
 * Server access, plus a tiny request cache so switching tabs does not refetch
 * what is already on screen. Every cache entry is dropped when the server
 * reports a change, which is what keeps the board honest.
 */

const cache = new Map();
let inflight = new Map();

/** @param {string} path */
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'x-phase-console': '1', ...(options.headers ?? {}) },
  });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === 'string' ? body : body?.error ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

/** Cached GET — repeated views of the same plan cost one request. */
export function get(path) {
  if (cache.has(path)) return Promise.resolve(cache.get(path));
  if (inflight.has(path)) return inflight.get(path);
  const promise = request(path)
    .then((body) => { cache.set(path, body); inflight.delete(path); return body; })
    .catch((error) => { inflight.delete(path); throw error; });
  inflight.set(path, promise);
  return promise;
}

export function fresh(path) {
  cache.delete(path);
  return get(path);
}

export function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export function clearCache(slugs) {
  if (!slugs?.length) { cache.clear(); inflight = new Map(); return; }
  for (const key of [...cache.keys()]) {
    if (!key.startsWith('/api/plans/')) { cache.delete(key); continue; }
    if (slugs.some((slug) => key.startsWith(`/api/plans/${encodeURIComponent(slug)}`))) cache.delete(key);
  }
  cache.delete('/api/plans');
  cache.delete('/api/stats');
  cache.delete('/api/state');
}

/* ---------------- endpoints ---------------- */

export const api = {
  state: () => fresh('/api/state'),
  browse: (path) => request(`/api/fs?path=${encodeURIComponent(path ?? '')}`),
  checkRoot: (path) => request(`/api/root?path=${encodeURIComponent(path)}`),
  openRoot: (path) => post('/api/root', { path }),
  savePrefs: (patch) => post('/api/prefs', patch),

  plans: () => get('/api/plans'),
  stats: () => get('/api/stats'),
  search: (query) => request(`/api/search?q=${encodeURIComponent(query)}`),

  plan: (slug, model) => get(`/api/plans/${encodeURIComponent(slug)}${model ? `?model=${encodeURIComponent(model)}` : ''}`),
  planRaw: (slug) => get(`/api/plans/${encodeURIComponent(slug)}/raw`),
  handoff: (slug, phase) => get(`/api/plans/${encodeURIComponent(slug)}/handoff/${phase}`),
  prompt: (slug, phase) => get(`/api/plans/${encodeURIComponent(slug)}/prompt/${phase}`),
  nextPrompt: (slug, phase) => get(`/api/plans/${encodeURIComponent(slug)}/next-prompt/${phase ?? 'none'}`),
  qaPrompt: (slug, phase) => get(`/api/plans/${encodeURIComponent(slug)}/qa-prompt/${phase}`),
  boardText: (slug) => get(`/api/plans/${encodeURIComponent(slug)}/board`),
  memoryBlock: (slug) => get(`/api/plans/${encodeURIComponent(slug)}/memory-block`),
  gate: (slug, phase) => get(`/api/plans/${encodeURIComponent(slug)}/gate/${phase}`),
  sessionPlan: (slug, model) => get(`/api/plans/${encodeURIComponent(slug)}/session-plan${model ? `?model=${encodeURIComponent(model)}` : ''}`),

  write: (body, dry) => post(`/api/write${dry ? '?dry=1' : ''}`, body),

  /* ---- autopilot ---- */
  runs: () => request('/api/runs'),
  run: (slug) => request(`/api/run/${encodeURIComponent(slug)}`),
  runJournal: (slug, id, limit) => request(
    `/api/run/${encodeURIComponent(slug)}/journal${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`,
  ),
  runStart: (slug, options) => post(`/api/run/${encodeURIComponent(slug)}/start`, options),
  runPause: (slug) => post(`/api/run/${encodeURIComponent(slug)}/pause`),
  runStop: (slug) => post(`/api/run/${encodeURIComponent(slug)}/stop`),
  runSkip: (slug, phase) => post(`/api/run/${encodeURIComponent(slug)}/skip`, { phase }),
  runRetry: (slug, phase) => post(`/api/run/${encodeURIComponent(slug)}/retry`, { phase }),

  approvals: () => request('/api/approvals'),
  decide: (id, decision, reason) => post(`/api/approvals/${encodeURIComponent(id)}`, { decision, reason, by: 'console' }),
};

/** Server-sent events: the board on screen follows the repo. */
export function subscribe(onChange) {
  const source = new EventSource('/events');
  source.addEventListener('changed', (event) => {
    try {
      const data = JSON.parse(event.data);
      clearCache(data.slugs);
      onChange(data);
    } catch { /* malformed event — ignore */ }
  });
  source.addEventListener('warm', () => { clearCache(); onChange({ warm: true }); });
  return () => source.close();
}

/**
 * The run channel.
 *
 * Separate from `subscribe` because run traffic is a different rhythm: a phase
 * emits a line every few seconds for an hour, and none of it should invalidate
 * the plan cache the way a file change does. Reconnection is the browser's own
 * — `Last-Event-ID` is honoured server-side, so a laptop that slept catches up
 * rather than showing a run frozen where it left off.
 */
export function subscribeRun(handlers = {}) {
  const source = new EventSource('/events');
  const on = (name, fn) => source.addEventListener(name, (event) => {
    try { fn(JSON.parse(event.data)); } catch { /* malformed event — ignore */ }
  });
  for (const name of ['run', 'phase', 'stream', 'journal', 'verify']) {
    on(`run:${name}`, (data) => handlers[name]?.(data));
  }
  on('approval', (data) => handlers.approval?.(data));
  on('health', (data) => handlers.health?.(data));
  return () => source.close();
}
