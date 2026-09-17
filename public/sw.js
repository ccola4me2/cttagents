// The bit that runs when the tab is closed.
//
// A push arrives carrying nothing, on purpose: the message is a knock, and
// this asks the portal what is actually waiting. So what a notification says
// is true at the moment it is read rather than at the moment it was queued,
// and nothing about a client ever passes through a push service.
//
// userVisibleOnly is not a preference. A browser grants push on the promise
// that every one of them shows something, and a push that quietly shows
// nothing is how a browser takes the permission back. So every path here ends
// in a notification, including the paths where the fetch failed.

const TAG = 'portal-alerts';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'Something needs you';
    let body = 'Open the portal to see what.';
    let href = '/app/';

    try {
      // Same origin, so the session cookie rides along. Nothing here knows
      // who the advisor is; the portal answers for whoever this browser is
      // signed in as, which is the only correct answer.
      const res = await fetch('/api/alerts', { credentials: 'same-origin' });
      if (res.ok) {
        const d = await res.json();
        const items = (d.items || []).filter((i) => i.at > (d.seenAt || 0) && i.at <= (d.now || 0));
        if (!items.length) {
          // Nothing new by the time this was opened. Say so rather than
          // inventing something: a notification that turns out to be about
          // nothing is the one that gets the permission revoked.
          title = 'Nothing new';
          body = 'Whatever this was about has been dealt with.';
        } else {
          const first = items[0];
          title = first.title;
          // Their name, and nothing else about them. A notification sits on a
          // lock screen where anybody standing there can read it.
          body = items.length > 1
            ? `${first.detail || ''}${first.detail ? '  ·  ' : ''}and ${items.length - 1} more`
            : (first.detail || 'Open the portal to see it.');
          href = first.href || href;
        }
      }
    } catch { /* the fallback above is already a true thing to say */ }

    await self.registration.showNotification(title, {
      body,
      tag: TAG,            // One at a time. A stack of these is noise.
      renotify: true,
      icon: '/logo-mark.png',
      badge: '/logo-mark.png',
      data: { href },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || '/app/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // A tab that is already open is the one somebody wants, rather than a
    // fourth copy of the portal.
    for (const client of all) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client) await client.navigate(href);
        return;
      }
    }
    await self.clients.openWindow(href);
  })());
});
