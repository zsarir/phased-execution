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
 * **An update is taken at the boundaries where nothing can be lost, offered
 * everywhere else.** The old worker called `skipWaiting()` from its own
 * install handler, which swapped the JavaScript under whatever was on screen;
 * then updates were offered-only, and a dismissed (or never-seen) toast left
 * tabs on a stale shell indefinitely — an operator shipped new options and
 * their own browser kept rendering the app from before them. Now a waiting
 * worker is auto-applied at page load and on return-to-tab — the two moments
 * nothing on screen is mid-flight — guarded by a sessionStorage one-shot (a
 * worker that cannot take over falls back to the toast instead of looping)
 * and suppressed over live pty surfaces and focused inputs. Mid-session
 * updates keep the toast, and `controllerchange` still reloads only a change
 * we asked for: the first-install reload loop stays dead.
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
 * Pull the newest interface into THIS tab, deterministically.
 *
 * The missing path, learned the hard way: the update toast offers once per
 * page-mount, a dismissal leaves no second chance, and restarting the SERVER
 * changes nothing in the browser — the worker keeps serving the old bundle,
 * by design. An operator who "restarted and still sees the old app" had
 * nothing to press. This is that button's engine: check for a new worker,
 * and when one is waiting, activate it and reload.
 *
 * `reload` is injectable only as a test seam — jsdom cannot navigate.
 */
export async function applyUpdateNow(
  reload: () => void = () => window.location.reload(),
): Promise<'reloading' | 'current' | 'unsupported'> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  const reg = await registerServiceWorker();
  if (!reg) return 'unsupported';
  try {
    await reg.update();
  } catch {
    /* offline — judge from what is already here */
  }
  const waiting = reg.waiting;
  if (!waiting) return 'current';
  await new Promise<void>((resolve) => {
    const once = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', once);
      resolve();
    };
    navigator.serviceWorker.addEventListener('controllerchange', once);
    waiting.postMessage({ type: 'SKIP_WAITING' });
    // The takeover is near-instant; the timer only covers a worker that dies
    // between the message and the switch, so the button can never hang.
    setTimeout(once, 3_000);
  });
  reload();
  return 'reloading';
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
      offered = toast('A new version of the console is ready.', 'info', 0, {
        label: 'Reload',
        onSelect: () => {
          applying = true;
          worker.postMessage({ type: 'SKIP_WAITING' });
        },
      });
    };

    const onControllerChange = () => {
      if (!applying) return;
      window.location.reload();
    };

    // Auto-apply, at the two boundaries where nothing on screen can be lost:
    // this page load (the stale shell was JUST served from cache — replacing
    // it now is free) and return-to-tab. Three guards, in order of what they
    // protect: never over a live pty surface or a focused input (scrollback
    // and half-typed text do not survive a reload); never twice in a minute
    // (a worker that cannot take over must fall back to the toast, not loop);
    // and `controllerchange` above still reloads only a change we asked for.
    const AUTO_KEY = 'pc-sw-auto-applied';
    const autoApplySafe = () => {
      if (/^#\/(terminal|agent)/.test(window.location.hash)) return false;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
      ) {
        return false;
      }
      return true;
    };
    const autoApply = (worker: ServiceWorker): boolean => {
      if (!autoApplySafe()) return false;
      let last: { at?: number } = {};
      try {
        last = JSON.parse(sessionStorage.getItem(AUTO_KEY) ?? '{}') as typeof last;
      } catch {
        /* an unreadable marker is no marker */
      }
      if (typeof last.at === 'number' && Date.now() - last.at < 60_000) return false;
      try {
        sessionStorage.setItem(AUTO_KEY, JSON.stringify({ at: Date.now() }));
      } catch {
        /* private mode — the toast path still works */
      }
      applying = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
      return true;
    };

    let registration: ServiceWorkerRegistration | null = null;
    let onUpdateFound: (() => void) | null = null;

    navigator.serviceWorker?.addEventListener('controllerchange', onControllerChange);

    void registerServiceWorker().then((reg) => {
      if (!reg || cancelled) return;
      registration = reg;

      // `controller` is what distinguishes an update from a first install: on a
      // first install there is nothing to interrupt, so the worker simply takes
      // over and nobody is told. A boot-time waiting worker is the reported
      // failure exactly — the cached shell just rendered — so it is applied,
      // not offered, unless a guard says otherwise.
      if (reg.waiting && navigator.serviceWorker.controller && !autoApply(reg.waiting)) {
        offer(reg.waiting);
      }

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
      void reg.update().catch(() => {
        /* offline, or the server is gone */
      });
    });

    // …and one per return to the tab. A console left open across a deploy
    // never re-checked, so the person who deployed was the person the toast
    // most reliably missed. Coming back is also the other safe boundary —
    // nothing was mid-read — so a waiting worker applies here too.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !registration || cancelled) return;
      void registration.update().catch(() => {
        /* offline */
      });
      if (registration.waiting && navigator.serviceWorker.controller && !autoApply(registration.waiting)) {
        offer(registration.waiting);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (offered !== null) dismissToast(offered);
      if (registration && onUpdateFound) registration.removeEventListener('updatefound', onUpdateFound);
      document.removeEventListener('visibilitychange', onVisible);
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
