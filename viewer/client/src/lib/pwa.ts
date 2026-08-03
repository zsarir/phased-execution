/**
 * The service worker, from the page's side: registering it, noticing when a new
 * one is ready, and knowing whether there is a network at all.
 *
 * Two things here are deliberate and easy to get wrong in the other direction.
 *
 * **Registration is unconditional.** It used to happen inside the push
 * subscribe flow, which meant the worker existed only for people who had opted
 * into notifications — so the app could not open offline for anyone else, and
 * the first thing a new device did when it *did* opt in was install a worker
 * and then immediately ask it to subscribe. Registering at boot separates the
 * two: the worker is how the app loads, and push is a thing the worker can
 * additionally do.
 *
 * **An update is offered, never taken.** The old worker called `skipWaiting()`
 * from its own install handler, which swapped the JavaScript under whatever was
 * on screen. Here the new worker waits, a toast says so, and only a click
 * activates it. That also removes the loop the naive fix creates: reload on
 * `controllerchange` fires on the *first* install too, so an app that reloads
 * whenever the controller changes reloads itself the first time it is ever
 * opened, installs, changes controller, and goes round again.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { dismissToast, toast } from '@/components/ui';

/**
 * ⚠️ Both halves of this pair are a contract with every device already
 * subscribed to push: a subscription belongs to a *registration*, and a
 * registration is identified by its scope. Serve the worker from somewhere
 * else, or register it with a narrower scope, and every one of them stops being
 * reachable — silently, because nothing is broken from the browser's point of
 * view. It simply is not the same registration any more.
 */
const SW_URL = '/sw.js';
const SW_SCOPE = '/';

let pending: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Register once per page, whoever asks first. `lib/push.ts` calls this too
 * rather than registering its own — two `register()` calls for the same URL are
 * harmless, but two call sites are two places to get the scope wrong.
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  pending ??= (async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    // There is no worker in dev: it is emitted by the build, and the dev server
    // deliberately does not proxy `/sw.js` to the console — registering the
    // production worker against :5173 would precache asset URLs that only exist
    // in `dist`. Anything about the worker is verified against a real build.
    if (import.meta.env.DEV) return null;
    try {
      return await navigator.serviceWorker.register(SW_URL, {
        scope: SW_SCOPE,
        // The script is served `no-store` anyway, but saying so here means an
        // update check can never be answered out of the HTTP cache.
        updateViaCache: 'none',
      });
    } catch (error) {
      // A refused registration is a console that loads from the network and
      // cannot be notified — worth saying, not worth failing over.
      console.warn('[pwa] service worker did not register', error);
      return null;
    }
  })();
  return pending;
}

/** Test seam: forget the memoised registration between cases. */
export function resetServiceWorkerForTests(): void {
  pending = null;
}

/**
 * Registers at boot, and offers an update when one is waiting.
 *
 * Mounted once, by the shell.
 */
export function useServiceWorker(): void {
  useEffect(() => {
    let cancelled = false;
    let offered: number | null = null;
    // Only a reload we asked for. The controller also changes on a first
    // install, and again if the console is rolled back to the legacy client
    // (that worker activates itself) — neither is a reason to throw away
    // whatever is on screen.
    let applying = false;

    const offer = (worker: ServiceWorker) => {
      if (cancelled || offered !== null) return;
      offered = toast(
        'A new version of the console is ready.',
        'info',
        0,
        {
          label: 'Reload',
          onSelect: () => {
            applying = true;
            worker.postMessage({ type: 'SKIP_WAITING' });
          },
        },
      );
    };

    const onControllerChange = () => {
      if (!applying) return;
      window.location.reload();
    };

    let registration: ServiceWorkerRegistration | null = null;
    let onUpdateFound: (() => void) | null = null;

    navigator.serviceWorker?.addEventListener('controllerchange', onControllerChange);

    void registerServiceWorker().then((reg) => {
      if (!reg || cancelled) return;
      registration = reg;

      // `controller` is what distinguishes an update from a first install: on a
      // first install there is nothing to interrupt, so the worker simply takes
      // over and nobody is told.
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

      onUpdateFound = () => {
        const installing = reg.installing;
        if (!installing) return;
        const onState = () => {
          if (installing.state !== 'installed') return;
          installing.removeEventListener('statechange', onState);
          if (navigator.serviceWorker.controller) offer(installing);
        };
        installing.addEventListener('statechange', onState);
      };
      reg.addEventListener('updatefound', onUpdateFound);

      // One check per load. The browser does this on its own schedule too, but
      // its schedule can be a day, and "I just deployed and it is still old" is
      // exactly the confusion this is here to prevent.
      void reg.update().catch(() => { /* offline, or the server is gone */ });
    });

    return () => {
      cancelled = true;
      if (offered !== null) dismissToast(offered);
      if (registration && onUpdateFound) registration.removeEventListener('updatefound', onUpdateFound);
      navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);
}

/* ---------------- online / offline ---------------- */

function subscribeOnline(notify: () => void): () => void {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}

/**
 * Whether this device thinks it has a network.
 *
 * It is a hint in one direction only, and the UI treats it that way. `false` is
 * reliable — the browser knows when the interface is down — so it can say
 * "you're offline" outright. `true` means very little: the console lives on
 * this machine or behind a tailnet, and a laptop on a café network with no
 * route to either is emphatically "online". So a failed request is still what
 * decides whether the console is reachable; this only sharpens the wording.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}
