// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Address guard for outbound calls to Matrix homeservers (DESIGN.md §6 SSRF).
// Every address the bridge connects to on behalf of a widget passes `isPublicAddress`
// unless the operator allow-listed that server name for private addresses.

import net from "node:net";

const v4 = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) v4.addSubnet(a, p, "ipv4");

const v6 = new net.BlockList();
for (const [a, p] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) v6.addSubnet(a, p, "ipv6");

/** Embedded IPv4 of an IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) or compatible address. */
function embeddedV4(ip) {
  const lower = ip.toLowerCase();
  const m = lower.match(/^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  // Hex form, e.g. ::ffff:7f00:1 or 64:ff9b::7f00:1
  const h = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (h) {
    const hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when `ip` is a globally routable unicast address. Anything unparsable is not public. */
export function isPublicAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return !v4.check(ip, "ipv4");
  if (fam === 6) {
    const e = embeddedV4(ip);
    if (e) return !v4.check(e, "ipv4");
    return !v6.check(ip, "ipv6");
  }
  return false;
}
