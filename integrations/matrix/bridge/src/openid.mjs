// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Widget OpenID verification (DESIGN.md §4). The widget gets an OpenID token from the Matrix
// client (`fromWidget` `get_openid`, MSC1960) and posts it to us. We ask the homeserver that
// issued it who it belongs to:
//   GET https://<resolved server>/_matrix/federation/v1/openid/userinfo?access_token=<token>
//   -> 200 {"sub": "@alice:example.org"}
// (https://spec.matrix.org/v1.19/server-server-api/#openid). The answer is trusted only when
// `sub` is a user of the server we asked. The token is never logged.

import { FederationError, parseServerName, pinnedGet, resolveServerName } from "./federation.mjs";

export class AuthError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const TOKEN = /^[\x21-\x7e]{1,1024}$/;
const USER_ID = /^@([^:\s]{1,255}):(.{1,255})$/;

/** Server part of a Matrix user id, or null. */
export function serverOfUserId(userId) {
  const m = typeof userId === "string" ? userId.match(USER_ID) : null;
  return m ? m[2] : null;
}

/** True when `serverName` may use this bridge (empty allow-list = any server). */
export function serverAllowed(serverName, cfg) {
  return cfg.allowedServers.length === 0 || cfg.allowedServers.includes(serverName);
}

/** Default transport: an operator override URL, else spec resolution with the address guard. */
async function defaultGet(serverName, path, cfg) {
  const override = cfg.federationOverrides[serverName];
  if (override) {
    const u = new URL(override);
    return pinnedGet({
      scheme: u.protocol === "http:" ? "http" : "https",
      address: u.hostname.replace(/^\[|\]$/g, ""),
      port: Number(u.port) || (u.protocol === "http:" ? 80 : 443),
      path: (u.pathname.replace(/\/$/, "") || "") + path,
      hostHeader: u.host,
      tlsName: u.hostname,
    });
  }
  const t = await resolveServerName(serverName, { allowPrivate: cfg.privateAllowed.includes(serverName) });
  let lastErr;
  for (const address of t.addresses.slice(0, 3)) {
    try {
      return await pinnedGet({ scheme: "https", address, port: t.port, path, hostHeader: t.hostHeader, tlsName: t.tlsName });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new FederationError("UNREACHABLE", "homeserver unreachable");
}

/**
 * Verify a widget OpenID token. Returns the Matrix user id. Throws AuthError with code
 * BAD_REQUEST, SERVER_NOT_ALLOWED, OPENID_INVALID or HOMESERVER_UNREACHABLE.
 */
export async function verifyOpenId({ accessToken, serverName }, cfg, get = defaultGet) {
  if (typeof accessToken !== "string" || !TOKEN.test(accessToken)) {
    throw new AuthError("BAD_REQUEST", 400, "missing or malformed OpenID token");
  }
  if (!parseServerName(serverName)) throw new AuthError("BAD_REQUEST", 400, "invalid matrix_server_name");
  if (!serverAllowed(serverName, cfg)) {
    throw new AuthError("SERVER_NOT_ALLOWED", 403, "this homeserver is not allowed to use this canvas");
  }
  const path = `/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(accessToken)}`;
  let res;
  try {
    res = await get(serverName, path, cfg);
  } catch (e) {
    if (e instanceof FederationError && (e.code === "PRIVATE_ADDRESS" || e.code === "BAD_SERVER_NAME")) {
      throw new AuthError("SERVER_NOT_ALLOWED", 403, "homeserver address is not allowed");
    }
    throw new AuthError("HOMESERVER_UNREACHABLE", 502, "could not reach the homeserver");
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new AuthError("OPENID_INVALID", 401, "the homeserver did not accept the OpenID token");
  }
  if (res.status !== 200) throw new AuthError("HOMESERVER_UNREACHABLE", 502, "unexpected homeserver answer");
  let sub;
  try {
    sub = JSON.parse(res.body).sub;
  } catch {
    throw new AuthError("OPENID_INVALID", 401, "unreadable userinfo answer");
  }
  // A homeserver may only vouch for its own users.
  if (serverOfUserId(sub) !== serverName) {
    throw new AuthError("OPENID_INVALID", 401, "userinfo named a user of another server");
  }
  return sub;
}
