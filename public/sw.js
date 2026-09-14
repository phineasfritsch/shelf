// Service worker — share target ONLY. It caches nothing: index.html, JS, CSS, /api/*, /ws and /f/* all go
// straight to the network, so a deploy is picked up on the next load and the app never serves a stale client.
//
// Android/Chrome (installed PWA over HTTPS) POSTs the shared files/text as multipart to /share. We intercept
// that request entirely on the client, park each part in the Cache API bucket 'share-inbox', and redirect to
// the app, which drains the inbox on load (app.js drainInbox). The page — not the worker — performs the
// upload, so this works even when the session had expired (the server 302s to /login, the user logs in,
// / loads, the inbox drains). The server never parses multipart.

const INBOX = 'share-inbox';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function inboxKey() {
  const id = (self.crypto && typeof self.crypto.randomUUID === 'function')
    ? self.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return new Request('/_inbox/' + id);
}

self.addEventListener('fetch', (event) => {
  let url;
  try { url = new URL(event.request.url); } catch { return; }
  if (event.request.method !== 'POST' || url.pathname !== '/share') return; // everything else: browser default, nothing cached
  event.respondWith((async () => {
    try {
      const fd = await event.request.formData();
      const cache = await caches.open(INBOX);
      for (const f of fd.getAll('files')) {
        if (!(f instanceof File)) continue;
        await cache.put(inboxKey(), new Response(f, { headers: {
          'X-Kind': 'file',
          'X-Name': encodeURIComponent(f.name || 'shared'),
          'X-Type': f.type || 'application/octet-stream',
        } }));
      }
      const text = [fd.get('title'), fd.get('text'), fd.get('url')]
        .filter((v) => typeof v === 'string' && v.trim() !== '')
        .join('\n');
      if (text) await cache.put(inboxKey(), new Response(text, { headers: { 'X-Kind': 'text' } }));
    } catch (err) {
      // A malformed share must still land the user in the app rather than on an error page.
      console.warn('sw: share intake failed', err);
    }
    return Response.redirect('/?shared=1', 303);
  })());
});
