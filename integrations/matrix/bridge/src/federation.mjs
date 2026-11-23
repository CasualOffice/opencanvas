// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Matrix server-name resolution (Server-Server API, "Resolving server names", spec v1.19:
// https://spec.matrix.org/v1.19/server-server-api/#resolving-server-names) and a guarded
// HTTPS GET to the resolved federation endpoint. Every address is checked before we connect
// and the connection is pinned to that checked address (no second DNS lookup, so no DNS
// rebinding). Redirects are not followed except for /.well-known/matrix/server, as the spec
// requires, and then only to https URLs that pass the same guard.

import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isPublicAddress } from "./netguard.mjs";

export class FederationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const HOSTNAME = /^(?=.{1,255}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

/**
 * Parse a server name (`hostname [":" port]`, IPv4 literal or `[IPv6]`, spec appendix
 * "Server name"). Returns { host, port|null, ipLiteral } or null.
 */
export function parseServerName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return null;
  let host, port = null;
  const v6 = name.match(/^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/);
  if (v6) {
    host = v6[1];
    if (net.isIP(host) !== 6) return null;
    port = v6[2] ? Number(v6[2]) : null;
  } else {
    const m = name.match(/^([^:]+)(?::(\d{1,5}))?$/);
    if (!m) return null;
    host = m[1];
    port = m[2] ? Number(m[2]) : null;
    if (net.isIP(host) !== 4 && !HOSTNAME.test(host)) return null;
  }
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { host: host.toLowerCase(), port, ipLiteral: net.isIP(host) !== 0 };
}

const defaultDeps = {
  lookup: async (host) => dns.lookup(host, { all: true, verbatim: true }),
  resolveSrv: async (name) => {
    try {
      return await dns.resolveSrv(name);
    } catch {
      return [];
    }
  },
};

/** Resolve a host to addresses and refuse unless every one passes the guard. */
async function guardedAddresses(host, allowPrivate, deps) {
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      addrs = await deps.lookup(host);
    } catch {
      throw new FederationError("RESOLVE_FAILED", `cannot resolve ${host}`);
    }
  }
  if (!addrs || addrs.length === 0) throw new FederationError("RESOLVE_FAILED", `no address for ${host}`);
  if (!allowPrivate) {
    for (const a of addrs) {
      if (!isPublicAddress(a.address)) {
        throw new FederationError("PRIVATE_ADDRESS", `${host} resolves to a non-public address`);
      }
    }
  }
  return addrs.map((a) => a.address);
}

/** Pick the first SRV target (lowest priority) for a name; [] when there is none. */
async function srv(name, deps) {
  const recs = (await deps.resolveSrv(name)) || [];
  return recs
    .filter((r) => r && r.name && r.port)
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
}

/**
 * Resolve `serverName` to a connection target:
 * { addresses: [ip], port, hostHeader, tlsName }. `tlsName` is the name the certificate must
 * be valid for (null for an IP literal: no SNI). Steps follow the spec in order.
 */
export async function resolveServerName(serverName, opts = {}) {
  const deps = { ...defaultDeps, ...(opts.deps || {}) };
  const allowPrivate = Boolean(opts.allowPrivate);
  const p = parseServerName(serverName);
  if (!p) throw new FederationError("BAD_SERVER_NAME", "invalid server name");

  // 1. IP literal.
  if (p.ipLiteral) {
    const addresses = await guardedAddresses(p.host, allowPrivate, deps);
    return { addresses, port: p.port ?? 8448, hostHeader: serverName, tlsName: null };
  }
  // 2. Hostname with an explicit port.
  if (p.port !== null) {
    const addresses = await guardedAddresses(p.host, allowPrivate, deps);
    return { addresses, port: p.port, hostHeader: serverName, tlsName: p.host };
  }
  // 3. /.well-known/matrix/server
  const wk = await fetchWellKnown(p.host, allowPrivate, deps);
  if (wk) {
    const d = parseServerName(wk);
    if (d) {
      if (d.ipLiteral) {
        const addresses = await guardedAddresses(d.host, allowPrivate, deps);
        return { addresses, port: d.port ?? 8448, hostHeader: wk, tlsName: null };
      }
      if (d.port !== null) {
        const addresses = await guardedAddresses(d.host, allowPrivate, deps);
        return { addresses, port: d.port, hostHeader: wk, tlsName: d.host };
      }
      for (const rec of [
        ...(await srv(`_matrix-fed._tcp.${d.host}`, deps)),
        ...(await srv(`_matrix._tcp.${d.host}`, deps)),
      ].slice(0, 1)) {
        const addresses = await guardedAddresses(rec.name, allowPrivate, deps);
        return { addresses, port: rec.port, hostHeader: d.host, tlsName: d.host };
      }
      const addresses = await guardedAddresses(d.host, allowPrivate, deps);
      return { addresses, port: 8448, hostHeader: d.host, tlsName: d.host };
    }
  }
  // 4./5. SRV on the server name itself.
  for (const rec of [
    ...(await srv(`_matrix-fed._tcp.${p.host}`, deps)),
    ...(await srv(`_matrix._tcp.${p.host}`, deps)),
  ].slice(0, 1)) {
    const addresses = await guardedAddresses(rec.name, allowPrivate, deps);
    return { addresses, port: rec.port, hostHeader: p.host, tlsName: p.host };
  }
  // 6. Plain hostname, port 8448.
  const addresses = await guardedAddresses(p.host, allowPrivate, deps);
  return { addresses, port: 8448, hostHeader: p.host, tlsName: p.host };
}

async function fetchWellKnown(host, allowPrivate, deps) {
  if (deps.getWellKnown) return deps.getWellKnown(host);
  let url = new URL(`https://${host}/.well-known/matrix/server`);
  for (let hop = 0; hop < 4; hop++) {
    let res;
    try {
      const addresses = await guardedAddresses(url.hostname, allowPrivate, deps);
      res = await pinnedGet({
        scheme: "https",
        address: addresses[0],
        port: Number(url.port) || 443,
        path: url.pathname + url.search,
        hostHeader: url.host,
        tlsName: net.isIP(url.hostname) ? null : url.hostname,
        maxBytes: 16 * 1024,
        timeoutMs: 4000,
      });
    } catch {
      return null; // well-known errors fall through to SRV (spec step 4)
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, url);
      if (next.protocol !== "https:") return null;
      url = next;
      continue;
    }
    if (res.status !== 200) return null;
    try {
      const body = JSON.parse(res.body);
      return typeof body["m.server"] === "string" ? body["m.server"] : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** One GET to a fixed address with the given Host header and TLS name; bounded size and time. */
export function pinnedGet({ scheme, address, port, path, hostHeader, tlsName, maxBytes = 65536, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const mod = scheme === "http" ? http : https;
    const req = mod.request(
      {
        host: address,
        port,
        path,
        method: "GET",
        headers: { Host: hostHeader, Accept: "application/json", "User-Agent": "opencanvas-matrix-bridge" },
        servername: tlsName || undefined,
        // Certificate is checked against tlsName (Node uses `servername` for the identity check).
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let size = 0;
        const chunks = [];
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new FederationError("TOO_LARGE", "response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new FederationError("TIMEOUT", "request timed out")));
    req.on("error", reject);
    req.end();
  });
}
