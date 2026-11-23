/* SFAX service worker: lets the site be installed as an app and shows a friendly page when offline.
   It never touches /api/ (messages, logins, codes) and never stores anything a person typed. */
const V = 'sfax-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(['/', '/assets/trigun-logo.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/admin') return;   // network only
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then((res) => { if (u.pathname === '/' && res.ok) { const cp = res.clone(); caches.open(V).then((c) => c.put('/', cp)); } return res; })
      .catch(() => caches.match('/').then((x) => x || new Response('SFAX is offline. Please reconnect and try again.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
    return;
  }
  if (u.pathname.startsWith('/assets/')) e.respondWith(caches.match(r).then((x) => x || fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(V).then((c) => c.put(r, cp)); } return res; })));
});
