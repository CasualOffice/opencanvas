// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// matrix-opencanvas bridge: the OpenCanvas host for Matrix rooms (DESIGN.md).
//   GET  /widget       the widget page Matrix clients load (unstyled; UI-SCREENS.md)
//   GET  /widget.js    its script (widget API handshake, get_openid, launch)
//   POST /api/launch   {roomId, widgetId, openid:{access_token, matrix_server_name}}
//                      -> {launchUrl, token, role, storage}
//   GET  /healthz
// No framework, no dependencies. Tokens are never logged.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, loadConfig } from "./config.mjs";
import { AuthError, verifyOpenId } from "./openid.mjs";
import { botStateReader, checkRoomAccess, validRoomId, validWidgetId } from "./room.mjs";
import { launchClaims, signHs256 } from "./launch.mjs";
import { startAutojoin } from "./bot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new AuthError("BAD_REQUEST", 413, "request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AuthError("BAD_REQUEST", 400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Small fixed-window limiter per client address. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      if (hits.size > 10000) hits.clear();
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}

/**
 * The launch decision, separated from HTTP for tests: verify the OpenID token, check the
 * room, sign the token.
 */
export async function launch(body, cfg, deps) {
  const roomId = body && body.roomId;
  const widgetId = body && body.widgetId;
  const openid = (body && body.openid) || {};
  if (!validRoomId(roomId) || !validWidgetId(widgetId)) {
    throw new AuthError("BAD_REQUEST", 400, "missing or invalid roomId or widgetId");
  }
  const userId = await deps.verifyOpenId(
    { accessToken: openid.access_token, serverName: openid.matrix_server_name },
    cfg,
  );
  const access = await deps.checkRoomAccess({ roomId, widgetId, userId }, cfg, deps.getState);
  const claims = launchClaims({ cfg, userId, roomId, widgetId, ...access, now: deps.now() });
  return {
    launchUrl: `${cfg.ocUrl}/v1/launch`,
    token: signHs256(claims, cfg.jwtSecret),
    role: claims.role,
    storage: "ephemeral",
  };
}

export function createHandler(cfg, overrides = {}) {
  const deps = {
    verifyOpenId,
    checkRoomAccess,
    getState: botStateReader(cfg),
    now: () => Date.now(),
    ...overrides,
  };
  const allow = limiter(30, 60_000);
  const page = fs.readFileSync(path.join(PUBLIC, "widget.html"));
  const script = fs.readFileSync(path.join(PUBLIC, "widget.js"));
  const pageCsp = [
    "default-src 'none'",
    "script-src 'self'",
    "connect-src 'self'",
    `frame-src ${cfg.ocUrl}`,
    `form-action ${cfg.ocUrl}`,
    "base-uri 'none'",
    // Any Matrix client may show the widget; the page itself carries no credentials.
    "frame-ancestors *",
  ].join("; ");

  return async (req, res) => {
    const url = new URL(req.url, "http://bridge.invalid");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/widget") {
        return send(res, 200, page, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": pageCsp });
      }
      if (req.method === "GET" && url.pathname === "/widget.js") {
        return send(res, 200, script, { "Content-Type": "text/javascript; charset=utf-8" });
      }
      if (req.method === "POST" && url.pathname === "/api/launch") {
        if (!allow(req.socket.remoteAddress || "?")) {
          return send(res, 429, { error: "RATE_LIMITED", message: "too many requests" });
        }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) {
          return send(res, 415, { error: "BAD_REQUEST", message: "JSON only" });
        }
        const out = await launch(await readJson(req), cfg, deps);
        return send(res, 200, out);
      }
      return send(res, 404, { error: "NOT_FOUND" });
    } catch (e) {
      if (e instanceof AuthError) {
        console.log(`launch refused: ${e.code}`);
        return send(res, e.status, { error: e.code, message: e.message });
      }
      console.error(`internal error: ${e && e.name}`);
      return send(res, 500, { error: "INTERNAL", message: "internal error" });
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { cfg, errors } = loadConfig();
  if (errors.length) {
    for (const e of errors) console.error(`config: ${e}`);
    process.exit(2);
  }
  http.createServer(createHandler(cfg)).listen(cfg.port, () => {
    console.log(`matrix-opencanvas bridge listening ${JSON.stringify(describe(cfg))}`);
  });
  if (cfg.botAutojoin) startAutojoin(cfg);
}
