/* Kaliber prisjakt — offline-skydd.

   Sidan ligger som en ikon på hemskärmen. Utan det här skulle en dålig
   uppkoppling ge honom webbläsarens felsida utan adressfält och utan väg vidare,
   trots att sidan har ett sparat pris inbakat i sig just för det fallet.

   Regel: allt som utgör själva appen ligger i cachen och serveras därifrån först
   (snabbt och fungerar offline). Priserna hämtas alltid från nätet först, med
   cachen som skyddsnät. Bara samma-origin GET rörs — butikslänkarna passerar orörda.
*/

var CACHE = 'kaliber-prisjakt-v1';
var SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // addAll fallerar helt om EN fil saknas — lägg till var för sig i stället.
      .then(function (c) {
        return Promise.all(SHELL.map(function (u) {
          return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;      // butikernas sidor rörs aldrig

  // Priserna: nätet först, cachen som skyddsnät.
  if (url.pathname.indexOf('prices.json') !== -1) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('prices.json', copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('prices.json').then(function (hit) {
          return hit || new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
        });
      })
    );
    return;
  }

  // Appen själv: cachen först, nätet i bakgrunden för nästa gång.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      var live = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return null; });

      if (hit) return hit;
      return live.then(function (res) {
        if (res) return res;
        // Navigering utan nät och utan träff → ge honom appen ändå.
        if (req.mode === 'navigate') {
          return caches.match('index.html').then(function (page) {
            return page || caches.match('./');
          });
        }
        return new Response('', { status: 504 });
      });
    })
  );
});
