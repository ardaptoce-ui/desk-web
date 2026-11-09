/* Desk service worker — cache app shell only.
   /d/ data is network-only (never cached). Push handler is a stub for later. */
const CACHE = "desk-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./chart.js",
  "./manifest.json",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).catch(function () {
        // Partial cache is fine on first install
        return Promise.all(
          SHELL.map(function (u) {
            return cache.add(u).catch(function () { return null; });
          })
        );
      });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          if (k !== CACHE) return caches.delete(k);
          return null;
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never cache Plan B data under /d/
  if (url.pathname.indexOf("/d/") !== -1) {
    event.respondWith(fetch(req));
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        // Cache successful same-origin shell responses
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(req, copy);
          });
        }
        return res;
      }).catch(function () {
        return caches.match("./index.html");
      });
    })
  );
});

/* Stub push handler — Plan B has no web push yet. */
self.addEventListener("push", function (event) {
  let title = "Desk";
  let body = "Update";
  try {
    if (event.data) {
      const data = event.data.json();
      title = data.title || title;
      body = data.body || data.text || body;
    }
  } catch (_) {
    try {
      body = event.data ? event.data.text() : body;
    } catch (__) {}
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const c = clientList[i];
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
      return null;
    })
  );
});
