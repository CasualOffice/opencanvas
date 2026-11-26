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
  var prefix = hostDb + "/";
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
  Promise.all([names(), registry()]).then(function (r) {
    var all = r[0].concat(r[1]).filter(function (n, i, a) {
      return n.indexOf(prefix) === 0 && a.indexOf(n) === i;
    });
    var keys = all.filter(function (n) { return /\/key$/.test(n); });
    var rest = all.filter(function (n) { return !/\/key$/.test(n); });
    var files = rest.filter(function (n) { return !/\/(uploads|index)$/.test(n); }).length;
    return Promise.all(keys.map(del))
      .then(function () { return Promise.all(rest.map(del)); })
      .then(function () { return user ? unregister(all) : del(hostDb); })
      .then(function () { return files; });
  }).then(function (removed) {
    try {
      parent.postMessage({ type: "OC_OfflineCleared", host: host, removed: removed }, "*");
    } catch (e) { /* no parent */ }
  });
})();
