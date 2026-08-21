/**
 * The service worker.
 *
 * It exists for two reasons, and it is worth being precise about which is
 * which, because they pull in opposite directions.
 *
 * **It runs when the app does not.** A push arriving at 3am has no tab to
 * arrive in; the browser wakes this file instead. That half is ported from
 * `web/sw.js` and is the reason the two subscriptions already registered
 * against this console keep working — the URL and scope are unchanged.
 *
 * **It makes the app open instantly, and open at all without a network.** That
 * half is new, and it is where the care goes: a console that shows you a board
 * from twenty minutes ago, with no sign that it is doing so, is worse than one
 * that says it cannot reach the server. So the shell is cached and the *data
 * never is*. `/api/*`, `/events`, `/hooks/*` and `/ws/*` are not intercepted at
 * all — no cache, no fallback, no clever staleness window. They reach the
 * network or they fail, and failing is what drives the reconnecting banner.
 *
 * The precache list is injected at build time by `vite-plugin-pwa`
 * (`injectManifest`); the terminal chunk is excluded from it, because 89 KB of
 * xterm is no use to someone who is offline and cannot open a shell anyway.
 *
 * There is deliberately no Workbox here. What this needs is one cache, one
 * fingerprint, and four listeners — the runtime would be larger than the file.
 */

// `self` in a service worker is a `ServiceWorkerGlobalScope`, but the lib types
// only say `WorkerGlobalScope`. Redeclaring it inside a module shadows the
// global for this file alone. `__WB_MANIFEST` is the injection point: the
// plugin refuses to build a worker that does not reference it.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Relative rather than the `@shared` alias the rest of the client uses: the
// worker is bundled by a second, separate Vite build that the plugin drives,
// and a path that needs no alias config cannot be broken by it.
import {
  answeredNotification,
  clickTarget,
  decisionOf,
  decisionRequest,
  notificationOptions,
  notificationTitle,
  parsePayload,
  readRequest,
  resubscribeRequest,
} from '../../shared/sw-push.js';

const MANIFEST = self.__WB_MANIFEST ?? [];

/**
 * One cache per build, named after the contents of the manifest.
 *
 * This is the whole cache-invalidation strategy, and it is deliberately blunt:
 * anything at all changing in the shell produces a different name, so a new
 * worker precaches into a fresh cache and drops every older one on activate.
 * There is no per-entry revision bookkeeping to get wrong, and no way to end up
 * serving last build's `index.html` beside this build's JavaScript — the pair
 * that produces a white screen and no error.
 */
const CACHE_PREFIX = 'phase-shell-';
const CACHE = `${CACHE_PREFIX}${fingerprint(MANIFEST)}`;

function fingerprint(entries: Array<{ url: string; revision: string | null }>): string {
  let hash = 5381;
  for (const entry of entries) {
    const line = `${entry.url}|${entry.revision ?? ''}`;
    for (let i = 0; i < line.length; i += 1) {
      hash = ((hash * 33) ^ line.charCodeAt(i)) >>> 0;
    }
  }
  return hash.toString(36);
}

/** Absolute URLs, resolved against `/sw.js` so a relative manifest entry lands at the root. */
const SHELL = MANIFEST.map((entry) => new URL(entry.url, self.location.href).href);
const SHELL_SET = new Set(SHELL);
const APP_SHELL = new URL('index.html', self.location.href).href;

/**
 * The live surfaces, which this worker must never answer for.
 *
 * `/api` and `/events` are the board: a cached one is a lie. `/hooks` is how a
 * running session asks for an approval — a replayed answer there would decide
 * something nobody decided. `/ws` is the terminal's socket, and a service
 * worker cannot proxy an upgrade at all; intercepting it only breaks it.
 */
const LIVE = /^\/(api|events|hooks|ws)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` bypasses the HTTP cache: hashed assets are served with a day of
      // max-age, and precaching a copy the browser already had would defeat the
      // point of a fresh build.
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
      // No `skipWaiting()` here. The old worker keeps serving the tab that is
      // open until someone says otherwise — see the `message` listener. A worker
      // that takes over mid-session swaps the JavaScript under a running app.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      // Control the pages that are already open. On a first install this is what
      // makes the worker useful without a reload; on an update it has already
      // been asked for explicitly.
      await self.clients.claim();
    })(),
  );
});

/**
 * The update handshake.
 *
 * `lib/pwa.ts` shows a toast when a new worker is waiting and sends this
 * message if it is clicked. Nothing else activates an update, which is the
 * point: the old behaviour (`skipWaiting()` on install) reloaded people out of
 * whatever they were reading, and a reload triggered by an install that is
 * triggered by a load is a loop.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (LIVE.test(url.pathname)) return;

  // Any navigation gets the shell: this is a hash-routed app, so every route is
  // the same document, and answering from cache is what makes it open at once
  // — and open at all when there is no network.
  if (request.mode === 'navigate') {
    event.respondWith(shell());
    return;
  }

  if (SHELL_SET.has(url.href)) {
    event.respondWith(precached(request));
  }
  // Everything else — an icon that is not in the manifest, a source map, a
  // request from an extension — is left to the browser. Not caching something
  // is always a safe answer here; caching the wrong thing is not.
});

async function shell(): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(APP_SHELL);
  if (hit) return hit;
  // Not precached yet (the very first load, or a cache the browser evicted).
  // The network is the only other answer, and if it fails the browser's own
  // offline page is a truer thing to show than a blank document.
  return fetch(APP_SHELL);
}

async function precached(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  return hit ?? fetch(request);
}

/* ------------------------------------------------------------------ *
 * Push. Ported from `web/sw.js`; the decisions live in shared/sw-push.js
 * so they can be tested without a browser.
 * ------------------------------------------------------------------ */

self.addEventListener('push', (event) => {
  const data = parsePayload(event.data ? event.data.text() : null);
  event.waitUntil(self.registration.showNotification(notificationTitle(data), notificationOptions(data)));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const info = (event.notification.data ?? {}) as {
    url?: string;
    approvalId?: string | null;
    notificationId?: string | null;
  };
  const target = clickTarget(info, self.location.origin);
  const decision = decisionOf(event.action);

  event.waitUntil(
    (async () => {
      const read = readRequest(info.notificationId);
      if (read) {
        try {
          await fetch(read.url, read.init);
        } catch {
          /* the row simply stays unread */
        }
      }

      if (decision && info.approvalId) {
        let answered = false;
        try {
          const { url, init } = decisionRequest(info.approvalId, decision);
          const response = await fetch(url, init);
          answered = response.ok;
        } catch {
          /* fall through to opening the queue */
        }

        if (answered) {
          // The decision landed and is already broadcast to every open client.
          // Opening a window on top of that would be the console interrupting you
          // a second time for something you have finished with.
          const [title, options] = answeredNotification(decision, info);
          await self.registration.showNotification(title, options);
          return;
        }
        // It did not land — the run may have ended, or this console may have been
        // started without --allow-run. Open the queue so it can be seen.
      }

      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Reuse a window that is already here rather than opening a third console.
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) {
          try {
            await client.navigate(target);
          } catch {
            /* focus alone is enough */
          }
        }
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});

/**
 * A subscription can be rotated by the push service at any time, and a rotated
 * one that nobody re-registers is a device that has silently stopped being
 * notified. The browser tells us exactly once, here.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const response = await fetch('/api/push');
        const { publicKey } = (await response.json()) as { publicKey?: string };
        if (!publicKey) return;
        const subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        });
        const { url, init } = resubscribeRequest(subscription.toJSON());
        await fetch(url, init);
      } catch {
        /* nothing here can usefully report a failure */
      }
    })(),
  );
});
