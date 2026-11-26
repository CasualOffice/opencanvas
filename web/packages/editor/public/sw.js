// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The editor's service worker (OFF-03, ADR-063), registered only for hosts with offline copies.
// It caches the editor code (never content: the copies live in IndexedDB), serves /app/ when
// the network is gone, and turns a launch that cannot reach the server into an offline open of
// the copy on this device, when the launch asked for it (`offline=1`, `<open-canvas offline>`).
// Everything else goes to the network untouched.
const PREFIX = "oc-shell-";
let current = null;

async function shellName() {
  if (current) return current;
  const keys = await caches.keys();
  current = keys.find((k) => k.startsWith(PREFIX)) || null;
  return current;
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const r = await fetch("/app/shell.json", { cache: "no-store" });
      const shell = await r.json();
      const name = PREFIX + shell.version;
      const cache = await caches.open(name);
      await cache.addAll(["/app/", ...shell.files.map((f) => "/app/" + f)]);
      current = name;
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keep = await shellName();
      for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== keep) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

function claims(token) {
  try {
    const p = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "===".slice((p.length + 3) % 4)));
  } catch {
    return null;
  }
}

async function fromCache(req) {
  const name = await shellName();
  if (!name) return null;
  // ignoreVary: module scripts send Origin, the precache requests did not.
  return (await caches.open(name)).match(req, { ignoreSearch: true, ignoreVary: true });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // A launch that can't reach the server: open the copy on this device (the editor checks the
  // offline grant; without a copy it says so).
  if (req.method === "POST" && url.pathname === "/v1/launch" && req.mode === "navigate") {
    const copy = req.clone();
    e.respondWith(
      fetch(req).catch(async () => {
        const form = await copy.formData().catch(() => null);
        const c = form && form.get("offline") === "1" ? claims(form.get("token")) : null;
        if (!c || !c.iss || !c.file || !c.user) return new Response("You're offline.", { status: 503, headers: { "content-type": "text/plain" } });
        const h = new URLSearchParams({ offline: "1", h: c.iss, u: c.user.id, f: c.file.id });
        return Response.redirect(self.location.origin + "/app/#" + h.toString(), 303);
      }),
    );
    return;
  }
  if (req.method !== "GET" || !url.pathname.startsWith("/app/")) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(async () => (await fromCache("/app/")) || Response.error()));
    return;
  }
  if (url.pathname.startsWith("/app/assets/")) {
    // Hashed names never change: the cache first.
    e.respondWith((async () => (await fromCache(req)) || fetch(req))());
  }
});
