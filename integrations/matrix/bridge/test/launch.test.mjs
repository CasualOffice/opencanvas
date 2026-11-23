// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { loadConfig } from "../src/config.mjs";
import { verifyOpenId } from "../src/openid.mjs";
import { botStateReader, checkRoomAccess } from "../src/room.mjs";
import { createHandler, launch } from "../src/server.mjs";
import { fileIdFor } from "../src/launch.mjs";
import { FederationError } from "../src/federation.mjs";

const SECRET = "test-secret-0123456789abcdef0123456789";
const ROOM = "!room:acme.example";
const WIDGET = "canvas_1";

function config(extra = {}) {
  const { cfg, errors } = loadConfig({
    MX_PUBLIC_URL: "https://canvas-bridge.acme.example",
    OC_URL: "https://canvas.acme.example",
    OC_HOST_ID: "acme-matrix",
    OC_JWT_SECRET: SECRET,
    MX_BOT_HOMESERVER_URL: "http://127.0.0.1:1",
    MX_BOT_ACCESS_TOKEN: "bot-token",
    MX_BOT_USER_ID: "@canvasbot:acme.example",
    ...extra,
  });
  assert.deepEqual(errors, []);
  return cfg;
}

const userinfo = (status, body) => async () => ({ status, body: JSON.stringify(body) });

// ---- OpenID verification ----

test("a token the homeserver vouches for yields its user", async () => {
  const cfg = config();
  let asked;
  const get = async (server, path) => {
    asked = { server, path };
    return { status: 200, body: JSON.stringify({ sub: "@alice:acme.example" }) };
  };
  const sub = await verifyOpenId({ accessToken: "tok123", serverName: "acme.example" }, cfg, get);
  assert.equal(sub, "@alice:acme.example");
  assert.equal(asked.server, "acme.example");
  assert.equal(asked.path, "/_matrix/federation/v1/openid/userinfo?access_token=tok123");
});

test("token verification failures", async () => {
  const cfg = config();
  const cases = [
    ["rejected token", userinfo(401, { errcode: "M_UNKNOWN_TOKEN" }), "OPENID_INVALID"],
    ["user of another server", userinfo(200, { sub: "@mallory:evil.example" }), "OPENID_INVALID"],
    ["no sub", userinfo(200, {}), "OPENID_INVALID"],
    ["server error", userinfo(500, {}), "HOMESERVER_UNREACHABLE"],
    ["network error", async () => { throw new Error("ECONNREFUSED"); }, "HOMESERVER_UNREACHABLE"],
    ["private address", async () => { throw new FederationError("PRIVATE_ADDRESS", "p"); }, "SERVER_NOT_ALLOWED"],
  ];
  for (const [label, get, code] of cases) {
    await assert.rejects(verifyOpenId({ accessToken: "tok", serverName: "acme.example" }, cfg, get), (e) => e.code === code, label);
  }
  for (const [token, server] of [["", "acme.example"], ["a b", "acme.example"], [undefined, "acme.example"], ["tok", "bad name"]]) {
    await assert.rejects(verifyOpenId({ accessToken: token, serverName: server }, cfg, userinfo(200, {})), (e) => e.code === "BAD_REQUEST");
  }
});

test("a homeserver outside the allow-list is refused before any call", async () => {
  const cfg = config({ MX_ALLOWED_SERVERS: "acme.example, partner.example" });
  let called = false;
  const get = async () => { called = true; return { status: 200, body: "{}" }; };
  await assert.rejects(verifyOpenId({ accessToken: "t", serverName: "other.example" }, cfg, get), (e) => e.code === "SERVER_NOT_ALLOWED");
  assert.equal(called, false);
});

test("verification over real HTTP through an operator override", async () => {
  const srv = http.createServer((req, res) => {
    const ok = req.url === "/_matrix/federation/v1/openid/userinfo?access_token=good";
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { sub: "@bob:hs.local" } : { errcode: "M_UNKNOWN_TOKEN" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const cfg = config({ MX_FEDERATION_OVERRIDES: JSON.stringify({ "hs.local": `http://127.0.0.1:${srv.address().port}` }) });
  try {
    assert.equal(await verifyOpenId({ accessToken: "good", serverName: "hs.local" }, cfg), "@bob:hs.local");
    await assert.rejects(verifyOpenId({ accessToken: "bad", serverName: "hs.local" }, cfg), (e) => e.code === "OPENID_INVALID");
    // Without the override, the same server name resolves to loopback and is refused.
    await assert.rejects(
      verifyOpenId({ accessToken: "good", serverName: `127.0.0.1:${srv.address().port}` }, config()),
      (e) => e.code === "SERVER_NOT_ALLOWED",
    );
  } finally {
    srv.close();
  }
});

// ---- Room checks ----

function roomState({ botMembership = "join", membership = "join", level = 0, stateDefault = 50, widgetUrl, roomVersion = "10", creator = "@admin:acme.example", noPl = false } = {}) {
  const cfg = config();
  const state = {
    [`im.vector.modular.widgets|${WIDGET}`]: { type: "m.custom", name: "Sprint board", url: widgetUrl ?? `${cfg.publicUrl}/widget?roomId=$matrix_room_id&wid=$matrix_widget_id` },
    "m.room.member|@alice:acme.example": membership ? { membership, displayname: "Alice" } : null,
    "m.room.member|@canvasbot:acme.example": botMembership ? { membership: botMembership } : null,
    "m.room.create|": { type: "m.room.create", sender: creator, content: { room_version: roomVersion } },
    "m.room.power_levels|": noPl ? null : { users: { "@alice:acme.example": level }, users_default: 0, state_default: stateDefault },
  };
  return async (_room, type, key) => state[`${type}|${key}`] ?? null;
}

const access = (getState, cfg = config()) =>
  checkRoomAccess({ roomId: ROOM, widgetId: WIDGET, userId: "@alice:acme.example" }, cfg, getState);

test("membership denied: invited, left, banned or absent", async () => {
  for (const membership of ["invite", "leave", "ban", null]) {
    await assert.rejects(access(roomState({ membership })), (e) => e.code === "NOT_MEMBER" && e.status === 403, String(membership));
  }
});

test("a non-member asking for a forged widget id is told NOT_MEMBER, nothing about widgets", async () => {
  // Found in Element: a widget in another room naming this room and a made-up widget id.
  await assert.rejects(access(roomState({ membership: null, widgetUrl: "https://evil.example/widget" })), (e) => e.code === "NOT_MEMBER");
});

test("a widget that is not ours, or not in the room, is refused", async () => {
  await assert.rejects(access(roomState({ widgetUrl: "https://evil.example/widget" })), (e) => e.code === "WIDGET_UNKNOWN");
  await assert.rejects(access(async (_r, type) => (type === "m.room.member" ? { membership: "join" } : null)), (e) => e.code === "WIDGET_UNKNOWN");
});

test("role follows power level against state_default", async () => {
  assert.equal((await access(roomState({ level: 50 }))).role, "edit");
  assert.equal((await access(roomState({ level: 100 }))).role, "edit");
  assert.equal((await access(roomState({ level: 0 }))).role, "edit"); // default MX_MEMBER_ROLE
  assert.equal((await access(roomState({ level: 0 }), config({ MX_MEMBER_ROLE: "view" }))).role, "view");
  assert.equal((await access(roomState({ level: 10, stateDefault: 10 }), config({ MX_MEMBER_ROLE: "view" }))).role, "edit");
  // Room v12: the creator has no entry in `users` but outranks everyone.
  assert.equal(
    (await access(roomState({ level: undefined, roomVersion: "12", creator: "@alice:acme.example" }), config({ MX_MEMBER_ROLE: "view" }))).role,
    "edit",
  );
  // No power_levels event: the creator has 100 and state_default is 0, so everyone edits.
  assert.equal((await access(roomState({ noPl: true }), config({ MX_MEMBER_ROLE: "view" }))).role, "edit");
  const a = await access(roomState({ level: 50 }));
  assert.equal(a.displayName, "Alice");
  assert.equal(a.widgetName, "Sprint board");
});

test("a bot that left or was kicked is not trusted with stale state", async () => {
  // Found end to end: Synapse still answers state reads for a bot that left (state as of
  // its leave), so a 200 does not prove the bot is in the room.
  for (const botMembership of ["leave", "ban", null]) {
    await assert.rejects(access(roomState({ botMembership })), (e) => e.code === "BOT_NOT_IN_ROOM", String(botMembership));
  }
});

test("a widget URL on another path of the bridge origin is refused", async () => {
  const cfg = config();
  await assert.rejects(access(roomState({ widgetUrl: `${cfg.publicUrl}/widgetx?roomId=1` })), (e) => e.code === "WIDGET_UNKNOWN");
});

test("bot not in the room is reported as such (real HTTP)", async () => {
  let auth;
  const srv = http.createServer((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errcode: "M_FORBIDDEN" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const cfg = config({ MX_BOT_HOMESERVER_URL: `http://127.0.0.1:${srv.address().port}` });
  try {
    await assert.rejects(access(botStateReader(cfg), cfg), (e) => e.code === "BOT_NOT_IN_ROOM");
    assert.equal(auth, "Bearer bot-token");
  } finally {
    srv.close();
  }
});

// ---- Launch token ----

function decode(jwt) {
  const [h, b, s] = jwt.split(".");
  const expect = crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url");
  assert.equal(s, expect, "HS256 signature");
  return { head: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(b, "base64url")) };
}

const okDeps = (extra = {}) => ({
  verifyOpenId: async () => "@alice:acme.example",
  checkRoomAccess: async () => ({ role: "edit", displayName: "Alice", widgetName: "Sprint board" }),
  getState: null,
  now: () => 1_800_000_000_000,
  ...extra,
});

test("launch token claims shape", async () => {
  const cfg = config();
  const body = { roomId: ROOM, widgetId: WIDGET, openid: { access_token: "t", matrix_server_name: "acme.example" } };
  const out = await launch(body, cfg, okDeps());
  assert.equal(out.launchUrl, "https://canvas.acme.example/v1/launch");
  assert.equal(out.storage, "ephemeral");
  const { head, claims } = decode(out.token);
  assert.deepEqual(head, { alg: "HS256", typ: "JWT" });
  assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "file", "iat", "iss", "jti", "mode", "perms", "role", "user"]);
  assert.equal(claims.iss, "acme-matrix");
  assert.equal(claims.aud, "opencanvas");
  assert.equal(claims.iat, 1_800_000_000);
  assert.equal(claims.exp - claims.iat, 600);
  assert.match(claims.jti, /^[0-9a-f-]{36}$/);
  assert.deepEqual(claims.file, { id: fileIdFor(ROOM, WIDGET), name: "Sprint board" });
  assert.match(claims.file.id, /^mx-[0-9a-f]{40}$/);
  assert.deepEqual(claims.user, { id: "@alice:acme.example", name: "Alice", detail: "@alice:acme.example" });
  assert.equal(claims.role, "edit");
  assert.equal(claims.mode, "edit");
  assert.ok(!out.token.includes(Buffer.from(ROOM).toString("base64url")), "no room id in the token");
  assert.ok(!JSON.stringify(claims).includes(ROOM), "no room id in the claims");
  // Fresh jti every launch; same canvas for the same room and widget.
  const again = decode((await launch(body, cfg, okDeps())).token).claims;
  assert.notEqual(again.jti, claims.jti);
  assert.equal(again.file.id, claims.file.id);
  assert.notEqual(fileIdFor(ROOM, "canvas_2"), claims.file.id);
  // View role opens in view mode.
  const v = decode((await launch(body, cfg, okDeps({ checkRoomAccess: async () => ({ role: "view", displayName: "A", widgetName: "C" }) }))).token).claims;
  assert.equal(v.mode, "view");
});

test("no token is minted when a check fails", async () => {
  const cfg = config();
  const { AuthError } = await import("../src/openid.mjs");
  const body = { roomId: ROOM, widgetId: WIDGET, openid: { access_token: "t", matrix_server_name: "acme.example" } };
  await assert.rejects(launch(body, cfg, okDeps({ checkRoomAccess: async () => { throw new AuthError("NOT_MEMBER", 403, "x"); } })), (e) => e.code === "NOT_MEMBER");
  await assert.rejects(launch({ ...body, roomId: "room" }, cfg, okDeps()), (e) => e.code === "BAD_REQUEST");
  await assert.rejects(launch({ ...body, widgetId: "" }, cfg, okDeps()), (e) => e.code === "BAD_REQUEST");
});

// ---- HTTP ----

test("HTTP: widget page CSP, JSON errors, content type", async () => {
  const cfg = config();
  const { AuthError } = await import("../src/openid.mjs");
  const handler = createHandler(cfg, okDeps({ checkRoomAccess: async () => { throw new AuthError("NOT_MEMBER", 403, "x"); } }));
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const page = await fetch(`${base}/widget?roomId=x`);
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /frame-src https:\/\/canvas\.acme\.example/);
    assert.match(csp, /form-action https:\/\/canvas\.acme\.example/);
    const body = JSON.stringify({ roomId: ROOM, widgetId: WIDGET, openid: { access_token: "SECRET-OPENID", matrix_server_name: "acme.example" } });
    let r = await fetch(`${base}/api/launch`, { method: "POST", body, headers: { "Content-Type": "text/plain" } });
    assert.equal(r.status, 415);
    r = await fetch(`${base}/api/launch`, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "NOT_MEMBER");
    assert.ok(!logs.join("\n").includes("SECRET-OPENID"), "token not logged");
  } finally {
    console.log = orig;
    srv.close();
  }
});
