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

/* ------------------------------------------------------------------ *
 * One connection, many listeners
 * ------------------------------------------------------------------ *
 *
 * Every view that wanted live data used to open its own `EventSource`. A
 * browser allows about six connections per host over HTTP/1.1, and the shell,
 * the dashboard, the runs page and a plan's autopilot tab together held most of
 * them open forever — so the *fetches* those same views depend on queued behind
 * connections that never finish. The symptom is precise and misleading: the
 * page looks alive, and nothing updates until you reload.
 *
 * So there is exactly one stream, and it is shared. Views subscribe to it.
 */

const listeners = new Map(); // event name → Set<fn>
let stream = null;
let generation = 0;

function ensureStream() {
  if (stream) return;
  const source = new EventSource('/events');
  stream = source;

  const relay = (name) => source.addEventListener(name, (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (name === 'changed') clearCache(data.slugs);
    if (name === 'warm') clearCache();
    for (const fn of listeners.get(name) ?? []) {
      try { fn(data); } catch { /* one bad listener must not stop the rest */ }
    }
  });

  for (const name of [
    'changed', 'warm', 'health', 'approval',
    'run:run', 'run:phase', 'run:stream', 'run:journal', 'run:verify', 'run:state',
  ]) relay(name);

  // The browser reconnects on its own and the server replays from Last-Event-ID,
  // so an error here is worth noting and nothing more.
  source.addEventListener('error', () => { generation++; });
}

function on(name, fn) {
  if (!fn) return () => {};
  ensureStream();
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => {
    listeners.get(name)?.delete(fn);
    // The stream stays open even with no listeners: opening and closing it as
    // views mount costs a reconnect each time and buys nothing.
  };
}

/** Server-sent events: the board on screen follows the repo. */
export function subscribe(onChange) {
  const offChanged = on('changed', onChange);
  const offWarm = on('warm', () => onChange({ warm: true }));
  return () => { offChanged(); offWarm(); };
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
  const offs = [];
  for (const name of ['run', 'phase', 'stream', 'journal', 'verify']) {
    if (handlers[name]) offs.push(on(`run:${name}`, handlers[name]));
  }
  if (handlers.approval) offs.push(on('approval', handlers.approval));
  if (handlers.health) offs.push(on('health', handlers.health));
  return () => { for (const off of offs) off(); };
}
