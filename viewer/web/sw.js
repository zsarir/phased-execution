/**
 * The service worker. It exists for one reason: to be running when the app is
 * not.
 *
 * Everything else in this client only works while a tab is open. A push
 * arriving at 3am has no tab to arrive in — the browser wakes this file
 * instead, hands it the encrypted payload the browser has already decrypted,
 * and gives it a moment to show something. That is the whole job.
 *
 * It deliberately does not cache anything. An offline console showing a stale
 * board would be worse than an offline console saying so, because the board is
 * the one thing here that must never be out of date.
 */

// A new worker should take over immediately rather than waiting for every tab
// to close — otherwise a notification fix ships and does nothing for days.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // Every push here carries a payload, but a push service is allowed to deliver
  // an empty one, and on iOS a push that shows no notification counts against
  // the app's standing. So there is always something to show.
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* fall through to the default */ }

  const title = data.title || 'Phase Console';
  const options = {
    body: data.body || 'Something needs you.',
    // Same tag replaces rather than stacks: a run that re-renders three times
    // is one line on a lock screen, not three.
    tag: data.tag || 'phase-console',
    renotify: false,
    data: { url: data.url || '/', category: data.category || null },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse a window that is already here rather than opening a third console.
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if ('navigate' in client) { try { await client.navigate(target); } catch { /* focus alone is enough */ } }
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/**
 * A subscription can be rotated by the push service at any time, and a rotated
 * one that nobody re-registers is a device that has silently stopped being
 * notified. The browser tells us exactly once, here.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const response = await fetch('/api/push');
      const { publicKey } = await response.json();
      if (!publicKey) return;
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-phase-console': '1' },
        body: JSON.stringify({ subscription: subscription.toJSON(), label: 'a browser (re-registered)' }),
      });
    } catch { /* nothing here can usefully report a failure */ }
  })());
});
