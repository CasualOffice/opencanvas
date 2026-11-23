// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import test from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress } from "../src/netguard.mjs";
import { parseServerName, resolveServerName } from "../src/federation.mjs";

test("private, loopback, link-local, mapped and reserved addresses are not public", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1",
    "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::10.0.0.1",
    "2001:db8::1", "ff02::1", "not-an-ip", "",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "172.32.0.1"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("server names parse per the spec grammar", () => {
  assert.deepEqual(parseServerName("example.org"), { host: "example.org", port: null, ipLiteral: false });
  assert.deepEqual(parseServerName("example.org:8448"), { host: "example.org", port: 8448, ipLiteral: false });
  assert.deepEqual(parseServerName("[::1]:8448"), { host: "::1", port: 8448, ipLiteral: true });
  assert.equal(parseServerName("1.2.3.4").ipLiteral, true);
  for (const bad of ["", "exa mple.org", "example.org:0", "example.org:70000", "user@example.org",
    "example.org/path", "[nothex]", "-bad.org", "a".repeat(300)]) {
    assert.equal(parseServerName(bad), null, bad);
  }
});

const deps = (dns, { srv = {}, wk = {} } = {}) => ({
  lookup: async (h) => {
    if (!(h in dns)) throw new Error("NXDOMAIN");
    return dns[h].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
  resolveSrv: async (n) => srv[n] || [],
  getWellKnown: async (h) => wk[h] ?? null,
});

test("resolution refuses names that lead to private addresses", async () => {
  const cases = [
    ["IP literal", "127.0.0.1", deps({})],
    ["IP literal v6", "[::1]:8448", deps({})],
    ["metadata IP", "169.254.169.254:80", deps({})],
    ["hostname -> loopback", "evil.example", deps({ "evil.example": ["127.0.0.1"] })],
    ["mixed public and private A records", "mixed.example", deps({ "mixed.example": ["8.8.8.8", "10.0.0.5"] })],
    ["well-known delegates inward", "deleg.example",
      deps({ "deleg.example": ["8.8.8.8"], "internal.example": ["192.168.0.10"] }, { wk: { "deleg.example": "internal.example:8008" } })],
    ["SRV points inward", "srv.example",
      deps({ "srv.example": ["8.8.8.8"], "db.internal": ["10.0.0.9"] },
        { srv: { "_matrix-fed._tcp.srv.example": [{ name: "db.internal", port: 5432, priority: 0, weight: 0 }] } })],
  ];
  for (const [label, name, d] of cases) {
    await assert.rejects(resolveServerName(name, { deps: d }), (e) => e.code === "PRIVATE_ADDRESS", label);
  }
});

test("resolution follows well-known, SRV and the 8448 fallback", async () => {
  const pub = { "a.example": ["8.8.8.8"], "b.example": ["9.9.9.9"], "c.example": ["1.1.1.1"] };
  let t = await resolveServerName("a.example", { deps: deps(pub, { wk: { "a.example": "b.example:443" } }) });
  assert.deepEqual(t, { addresses: ["9.9.9.9"], port: 443, hostHeader: "b.example:443", tlsName: "b.example" });
  t = await resolveServerName("a.example", {
    deps: deps(pub, { srv: { "_matrix-fed._tcp.a.example": [{ name: "c.example", port: 8443, priority: 0, weight: 0 }] } }),
  });
  assert.deepEqual(t, { addresses: ["1.1.1.1"], port: 8443, hostHeader: "a.example", tlsName: "a.example" });
  t = await resolveServerName("a.example", { deps: deps(pub) });
  assert.deepEqual(t, { addresses: ["8.8.8.8"], port: 8448, hostHeader: "a.example", tlsName: "a.example" });
  t = await resolveServerName("8.8.8.8", { deps: deps(pub) });
  assert.equal(t.tlsName, null);
});

test("an operator allow-list entry permits private addresses for that server only", async () => {
  const d = deps({ "hs.lan": ["192.168.1.20"] });
  const t = await resolveServerName("hs.lan:8448", { deps: d, allowPrivate: true });
  assert.deepEqual(t.addresses, ["192.168.1.20"]);
  await assert.rejects(resolveServerName("hs.lan:8448", { deps: d }), (e) => e.code === "PRIVATE_ADDRESS");
});
