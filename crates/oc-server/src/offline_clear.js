// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// The offline clear page (OFF-07, ADR-064, docs/05 §4c), loaded by the host's sign-out page in a
// hidden iframe so that it runs in the same storage partition as the embedded editor. It deletes
// the device keys first (crypto-shred: the copies are unreadable even if deleting the databases is
// interrupted), then every OpenCanvas offline database for the host (and person), then posts
// {"type":"OC_OfflineCleared", removed} to the parent. Keep the names in sync with
// web/packages/editor/src/offline/names.ts.
(function () {
  "use strict";
  var me = document.currentScript;
  var host = (me && me.getAttribute("data-host")) || "";
  var user = (me && me.getAttribute("data-user")) || "";
  var hostDb = "oc-offline/" + encodeURIComponent(host);
  // Without a host: every OpenCanvas copy in this partition (the registries included).
  var prefix = host ? hostDb + "/" : "oc-offline/";
  if (user) prefix += encodeURIComponent(user) + "/";
  function del(name) {
    return new Promise(function (ok) {
      try {
        var r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = function () { ok(); };
      } catch (e) { ok(); }
    });
  }
  function names() {
    if (!indexedDB.databases) return Promise.resolve([]);
    return indexedDB.databases().then(function (l) {
      return l.map(function (d) { return d.name || ""; });
    }, function () { return []; });
  }
  function registry() {
    // Browsers without indexedDB.databases(): the host registry lists the databases.
    if (!host) return Promise.resolve([]);
    return new Promise(function (ok) {
      try {
        var r = indexedDB.open(hostDb);
        r.onupgradeneeded = function () { r.result.createObjectStore("dbs"); };
        r.onerror = function () { ok([]); };
        r.onsuccess = function () {
          var db = r.result;
          if (!db.objectStoreNames.contains("dbs")) { db.close(); ok([]); return; }
          var q = db.transaction("dbs").objectStore("dbs").getAllKeys();
          q.onsuccess = function () { db.close(); ok(q.result.map(String)); };
          q.onerror = function () { db.close(); ok([]); };
        };
      } catch (e) { ok([]); }
    });
  }
  function unregister(list) {
    // With a user: drop that person's entries from the host registry.
    return new Promise(function (ok) {
      try {
        var r = indexedDB.open(hostDb);
        r.onupgradeneeded = function () { r.result.createObjectStore("dbs"); };
        r.onerror = function () { ok(); };
        r.onsuccess = function () {
          var db = r.result;
          var t = db.transaction("dbs", "readwrite");
          list.forEach(function (n) { t.objectStore("dbs").delete(n); });
          t.oncomplete = t.onerror = t.onabort = function () { db.close(); ok(); };
        };
      } catch (e) { ok(); }
    });
  }
  function openExisting(name) {
    // Never creates a database (that would leave an empty one behind).
    return new Promise(function (ok) {
      try {
        var r = indexedDB.open(name);
        r.onupgradeneeded = function () { r.transaction.abort(); };
        r.onerror = function () { ok(null); };
        r.onsuccess = function () { ok(r.result); };
      } catch (e) { ok(null); }
    });
  }
  function getAll(db, store) {
    return new Promise(function (ok) {
      if (!db || !db.objectStoreNames.contains(store)) { ok([]); return; }
      var q = db.transaction(store).objectStore(store).getAll();
      q.onsuccess = function () { ok(q.result || []); };
      q.onerror = function () { ok([]); };
    });
  }
  if (me && me.getAttribute("data-mode") === "files") {
    // OpenCanvas.offlineFiles(): the person's kept canvases, read with their device key.
    var userDb = prefix;
    Promise.all([openExisting(userDb + "key"), openExisting(userDb + "index")]).then(function (dbs) {
      return getAll(dbs[0], "k").then(function (keys) {
        var key = keys[0];
        return getAll(dbs[1], "files").then(function (rows) {
          if (dbs[0]) dbs[0].close();
          if (dbs[1]) dbs[1].close();
          if (!key) return [];
          return Promise.all(rows.map(function (s) {
            return crypto.subtle.decrypt({ name: "AES-GCM", iv: s.iv }, key, s.ct).then(function (b) {
              var e = JSON.parse(new TextDecoder().decode(b));
              return { id: e.file, title: e.title, bytes: e.bytes, pending: e.pending, lastSent: e.lastSent, validUntil: e.exp * 1000 };
            }, function () { return null; });
          }));
        });
      });
    }).then(function (files) {
      try {
        parent.postMessage({ type: "OC_OfflineFiles", host: host, files: (files || []).filter(Boolean) }, "*");
      } catch (e) { /* no parent */ }
    });
    return;
  }
  Promise.all([names(), registry()]).then(function (r) {
    var all = r[0].concat(r[1]).filter(function (n, i, a) {
      return n.indexOf(prefix) === 0 && a.indexOf(n) === i;
    });
    var keys = all.filter(function (n) { return /\/key$/.test(n); });
    var rest = all.filter(function (n) { return !/\/key$/.test(n); });
    var files = rest.filter(function (n) { return !/\/(uploads|index)$/.test(n); }).length;
    return Promise.all(keys.map(del))
      .then(function () { return Promise.all(rest.map(del)); })
      .then(function () { return user ? unregister(all) : host ? del(hostDb) : null; })
      .then(function () { return names(); })
      .then(function (left) {
        // The editor code cache (no content) goes with the last copy in this partition.
        if (left.some(function (n) { return n.indexOf("oc-offline/") === 0; }) || typeof caches === "undefined") return files;
        return caches.keys().then(function (ks) {
          return Promise.all(ks.filter(function (k) { return k.indexOf("oc-shell-") === 0; }).map(function (k) { return caches.delete(k); }));
        }).then(function () { return files; }, function () { return files; });
      });
  }).then(function (removed) {
    try {
      parent.postMessage({ type: "OC_OfflineCleared", host: host, removed: removed }, "*");
    } catch (e) { /* no parent */ }
  });
})();
