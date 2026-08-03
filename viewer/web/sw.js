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
    data: {
      url: data.url || '/',
      category: data.category || null,
      approvalId: data.approvalId || null,
      notificationId: data.notificationId || null,
    },
    // Answering from the lock screen, without unlocking and finding the queue.
    // A card is the only thing here with a yes and a no, so it is the only
    // thing that gets buttons. (Android and desktop honour these; iOS ignores
    // the array and shows the notification, which is the correct degradation.)
    actions: data.approvalId
      ? [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }]
      : undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/** Same header the app sends: the server refuses a mutation without it. */
const CONSOLE_HEADERS = { 'content-type': 'application/json', 'x-phase-console': '1' };

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const info = event.notification.data ?? {};
  const target = new URL(info.url || '/', self.location.origin).href;
  const decision = event.action === 'allow' ? 'allow' : event.action === 'deny' ? 'deny' : null;

  event.waitUntil((async () => {
    // Marking it read here rather than on arrival: a notification you never saw
    // must still be waiting in the inbox when you do look.
    if (info.notificationId) {
      try {
        await fetch('/api/notifications/read', {
          method: 'POST', headers: CONSOLE_HEADERS, body: JSON.stringify({ ids: [info.notificationId] }),
        });
      } catch { /* the row simply stays unread */ }
    }

    if (decision && info.approvalId) {
      let answered = false;
      try {
        const response = await fetch(`/api/approvals/${encodeURIComponent(info.approvalId)}`, {
          method: 'POST',
          headers: CONSOLE_HEADERS,
          body: JSON.stringify({ decision, by: 'notification' }),
        });
        answered = response.ok;
      } catch { /* fall through to opening the queue */ }

      if (answered) {
        // The decision landed and is already broadcast to every open client.
        // Opening a window on top of that would be the console interrupting you
        // a second time for something you have finished with.
        await self.registration.showNotification('Phase Console', {
          body: decision === 'allow' ? 'Allowed. The session is carrying on.' : 'Denied. The session was told.',
          tag: `answered-${info.approvalId}`,
          data: { url: info.url },
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
        });
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
