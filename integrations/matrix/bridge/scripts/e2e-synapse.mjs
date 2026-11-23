// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// End-to-end check against a real Synapse and a real OpenCanvas (README "Verified").
// Drives the widget's server side over the real APIs; it does not run Element.
//
//   HS=http://127.0.0.1:8008 SERVER_NAME=hs.local REG_SECRET=<registration_shared_secret>
//   OC=http://127.0.0.1:18080 OC_JWT_SECRET=<host secret> node scripts/e2e-synapse.mjs
//
// Steps: register alice (room admin), bob (not in the room), carol (member, power 0) and the
// bot; alice creates a room, invites the bot, the bot joins; alice adds the widget state
// event; the bridge (started in-process, HS as a private-address override) verifies real
// OpenID tokens from Synapse; the minted token is posted to OpenCanvas /v1/launch.

import crypto from "node:crypto";
import http from "node:http";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { createHandler } from "../src/server.mjs";

const HS = process.env.HS || "http://127.0.0.1:8008";
const SERVER_NAME = process.env.SERVER_NAME || "hs.local";
const OC = process.env.OC || "http://127.0.0.1:18080";
const REG_SECRET = process.env.REG_SECRET;
const OC_JWT_SECRET = process.env.OC_JWT_SECRET;
if (!REG_SECRET || !OC_JWT_SECRET) throw new Error("set REG_SECRET and OC_JWT_SECRET");

async function mx(method, path, token, body) {
  const res = await fetch(HS + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${res.status} ${json.errcode || ""}`);
  return json;
}

async function register(user) {
  const { nonce } = await mx("GET", "/_synapse/admin/v1/register");
  const password = crypto.randomBytes(12).toString("hex");
  const mac = crypto.createHmac("sha1", REG_SECRET).update(`${nonce}\0${user}\0${password}\0notadmin`).digest("hex");
  const r = await mx("POST", "/_synapse/admin/v1/register", null, { nonce, username: user, password, admin: false, mac });
  return { id: r.user_id, token: r.access_token };
}

const suffix = Date.now().toString(36);
const [alice, bob, carol, bot] = await Promise.all(["alice", "bob", "carol", "canvasbot"].map((u) => register(`${u}${suffix}`)));

// Bridge in-process, listening on an ephemeral port.
const bridgeSrv = http.createServer();
await new Promise((r) => bridgeSrv.listen(0, "127.0.0.1", r));
const BRIDGE = `http://127.0.0.1:${bridgeSrv.address().port}`;
const { cfg, errors } = loadConfig({
  MX_PUBLIC_URL: BRIDGE,
  OC_URL: OC,
  OC_HOST_ID: "acme-matrix",
  OC_JWT_SECRET,
  MX_BOT_HOMESERVER_URL: HS,
  MX_BOT_ACCESS_TOKEN: bot.token,
  MX_ALLOWED_SERVERS: SERVER_NAME,
  MX_FEDERATION_OVERRIDES: JSON.stringify({ [SERVER_NAME]: HS }),
  MX_MEMBER_ROLE: "view",
});
assert.deepEqual(errors, []);
bridgeSrv.on("request", createHandler(cfg));

const { room_id: roomId } = await mx("POST", "/_matrix/client/v3/createRoom", alice.token, {
  preset: "private_chat",
  invite: [bot.id, carol.id],
  name: "Acme planning",
});
await mx("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, bot.token, {});
await mx("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, carol.token, {});
const widgetId = `opencanvas_${suffix}`;
await mx(
  "PUT",
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/im.vector.modular.widgets/${encodeURIComponent(widgetId)}`,
  alice.token,
  { type: "m.custom", name: "Canvas", url: `${BRIDGE}/widget?roomId=$matrix_room_id&wid=$matrix_widget_id`, data: {}, waitForIframeLoad: true },
);
console.log("room, bot and widget ready");

async function openid(user) {
  return mx("POST", `/_matrix/client/v3/user/${encodeURIComponent(user.id)}/openid/request_token`, user.token, {});
}

async function launchAs(user, override = {}) {
  const o = await openid(user);
  const res = await fetch(`${BRIDGE}/api/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId,
      widgetId,
      openid: { access_token: o.access_token, matrix_server_name: o.matrix_server_name },
      ...override,
    }),
  });
  return { status: res.status, body: await res.json() };
}

const results = [];
const check = (name, ok) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

// 1. Admin gets an edit token that OpenCanvas accepts.
const a = await launchAs(alice);
check("alice (power 100) gets a token", a.status === 200 && a.body.role === "edit");
const oc = await fetch(a.body.launchUrl, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token: a.body.token }),
});
check("OpenCanvas /v1/launch accepts the token (303 to the editor)", oc.status === 303 && /#t=/.test(oc.headers.get("location") || ""));
const ticket = (oc.headers.get("location") || "").split("#t=")[1];
if (ticket) {
  const s = await fetch(`${OC}/v1/sessions/${ticket.split("&")[0]}`);
  const sj = await s.json().catch(() => ({}));
  check("session is ephemeral, user is the Matrix id", s.ok && sj.storage === "ephemeral" && JSON.stringify(sj).includes(alice.id));
}
// Single use.
const replay = await fetch(a.body.launchUrl, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token: a.body.token }),
});
check("the same token is refused a second time (jti)", replay.status >= 400);

// 2. Member with power 0 gets MX_MEMBER_ROLE.
const c = await launchAs(carol);
check("carol (power 0) gets the member role (view)", c.status === 200 && c.body.role === "view");

// 3. Not a member.
const b = await launchAs(bob);
check("bob (not in the room) is refused NOT_MEMBER", b.status === 403 && b.body.error === "NOT_MEMBER");

// 4. Forged / reused-by-another-server tokens.
const f = await launchAs(alice, { openid: { access_token: "forged-token", matrix_server_name: SERVER_NAME } });
check("a forged OpenID token is refused", f.status === 401 && f.body.error === "OPENID_INVALID");
const o2 = await openid(alice);
const g = await fetch(`${BRIDGE}/api/launch`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ roomId, widgetId, openid: { access_token: o2.access_token, matrix_server_name: "other.example" } }),
});
check("a homeserver outside the allow-list is refused", g.status === 403 && (await g.json()).error === "SERVER_NOT_ALLOWED");

// 5. Widget id that is not in the room.
const w = await (async () => {
  const o = await openid(alice);
  const r = await fetch(`${BRIDGE}/api/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, widgetId: "nope", openid: { access_token: o.access_token, matrix_server_name: o.matrix_server_name } }),
  });
  return { status: r.status, body: await r.json() };
})();
check("an unknown widget id is refused", w.status === 404 && w.body.error === "WIDGET_UNKNOWN");

// 6. Bot leaves: the bridge says so.
await mx("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, bot.token, {});
const l = await launchAs(alice);
check("bot not in the room is reported", l.status === 403 && l.body.error === "BOT_NOT_IN_ROOM");

// 7. The widget page is served.
const page = await fetch(`${BRIDGE}/widget?roomId=x&wid=y`);
check("widget page served with CSP", page.ok && /frame-src/.test(page.headers.get("content-security-policy") || ""));

bridgeSrv.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
