/**
 * Subscribing *this browser* to push.
 *
 * There are two notification paths in this console and they are not the same
 * thing. `lib/notify.ts` is the permission for the one the page raises —
 * instant, free, and gone the moment the tab is. This one registers a service
 * worker with a push service, so the notification arrives with nothing open at
 * all. That is the difference between "I saw it because I was there" and "I was
 * told", and it is the whole reason an unattended run is worth starting.
 *
 * Ported from `web/push.js`. It stays a module of its own rather than growing
 * into `notify.ts`, which is deliberately only the permission surface.
 *
 * Everything here degrades rather than throws. A browser without push, a
 * refused permission, an iPhone in a Safari tab where the API exists but cannot
 * be used — each is a state to report, not an error to handle.
 *
 * ⚠️ The service worker URL and scope (`/sw.js`, `/`) are a contract with the
 * subscriptions that already exist against this console — a subscription
 * belongs to a registration, and a registration is its scope. Phase 7 replaced
 * what that file *contains* (vite-plugin-pwa, `injectManifest`) and left where
 * it lives alone. Registration itself now belongs to `lib/pwa.ts`, which does
 * it at boot for everyone; this module no longer owns that decision, it just
 * waits for the result.
 */

import { api, type PushDevice, type PushState } from './api';
import { registerServiceWorker } from './pwa';

const SUPPORTED = typeof navigator !== 'undefined'
  && 'serviceWorker' in navigator
  && typeof PushManager !== 'undefined'
  && typeof Notification !== 'undefined';

export interface PushOutcome {
  ok: boolean;
  detail?: string;
  device?: PushDevice;
  state?: PushState;
}

/**
 * On iOS, push exists only for a site added to the Home Screen — in a Safari
 * tab `Notification.requestPermission` cannot even be called usefully. There is
 * no capability check for "installed", so this asks the two questions that
 * together mean it: is this iOS, and is it running standalone.
 */
export function iosNeedsInstall(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  const ios = /iP(hone|ad|od)/.test(platform)
    || (/Mac/.test(platform) && (navigator.maxTouchPoints ?? 0) > 1);
  if (!ios) return false;
  const standalone = (navigator as { standalone?: boolean }).standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true;
  return !standalone;
}

/** Why this browser cannot subscribe, or `null` if it can. */
export function blocker(): string | null {
  if (!SUPPORTED) return 'This browser does not support push notifications.';
  if (iosNeedsInstall()) {
    return 'On iOS, notifications only work once this is added to the Home Screen: Share → Add to '
      + 'Home Screen, then open it from there.';
  }
  if (!window.isSecureContext) {
    return 'Push needs a secure context — https, or localhost. Reach the console over HTTPS and try again.';
  }
  if (Notification.permission === 'denied') {
    return 'Notification permission was refused for this site. It has to be changed in browser '
      + 'settings; the page cannot ask twice.';
  }
  return null;
}

/** What this browser is, in as few words as will still tell two of them apart. */
export function describeBrowser(): string {
  const ua = navigator.userAgent ?? '';
  const browser = /Firefox\//.test(ua) ? 'Firefox'
    : /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const platform = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Mac OS X/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux' : '';
  return platform ? `${platform} · ${browser}` : browser;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  const registered = await registerServiceWorker();
  if (!registered) throw new Error('This console has no service worker to subscribe with.');
  return registered;
}

/** The endpoint identifies this browser to the server; nothing else does. */
export async function currentEndpoint(): Promise<string | null> {
  if (!SUPPORTED) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * Permission is asked for here and nowhere else, and only from a button.
 * A page that demands it on load gets refused by reflex, and that refusal is
 * permanent — one impatient click and the feature is gone for good.
 */
export async function enable(categories?: Record<string, boolean>): Promise<PushOutcome> {
  const why = blocker();
  if (why) return { ok: false, detail: why };

  if (Notification.permission !== 'granted') {
    const answer = await Notification.requestPermission();
    if (answer !== 'granted') return { ok: false, detail: 'Permission was not granted.' };
  }

  const { publicKey } = await api.push();
  if (!publicKey) return { ok: false, detail: 'The console has no signing key for push.' };

  const reg = await registration();
  // `ready` rather than the register() promise: a worker that has registered
  // has not necessarily activated, and subscribing against an inactive one
  // fails in a way that reads like a permissions problem.
  await navigator.serviceWorker.ready;

  const existing = await reg.pushManager.getSubscription();
  const subscription = existing ?? await reg.pushManager.subscribe({
    // Not optional, and not only a policy: a push that shows nothing is what
    // gets an app's push privileges withdrawn.
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });

  const result = await api.pushSubscribe({
    subscription: subscription.toJSON(),
    label: describeBrowser(),
    ...(categories ? { categories } : {}),
  });
  if (result.error) return { ok: false, detail: result.error };
  return { ok: true, device: result.device, state: result.state };
}

export async function disable(): Promise<void> {
  const endpoint = await currentEndpoint();
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch { /* the server row is what matters; a stale local one is harmless */ }
  if (endpoint) await api.pushUnsubscribe(endpoint);
}
