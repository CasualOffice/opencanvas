// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// MX-02: what the approved widget screens need from the bridge. S4c shows the bot's user ID
// to everyone, so the BOT_NOT_IN_ROOM answer carries it; the page loads its own stylesheet
// under a CSP that still allows no inline code.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loadConfig } from "../src/config.mjs";
import { AuthError } from "../src/openid.mjs";
import { createHandler } from "../src/server.mjs";

function config() {
  const { cfg } = loadConfig({
    MX_PUBLIC_URL: "https://canvas-bridge.acme.example",
    OC_URL: "https://canvas.acme.example",
    OC_HOST_ID: "acme-matrix",
    OC_JWT_SECRET: "test-secret-0123456789abcdef0123456789",
    MX_BOT_HOMESERVER_URL: "http://127.0.0.1:1",
    MX_BOT_ACCESS_TOKEN: "bot-token",
    MX_BOT_USER_ID: "@canvasbot:acme.example",
  });
  return cfg;
}

async function serve(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    srv.close();
  }
}

const body = JSON.stringify({ roomId: "!room:acme.example", widgetId: "canvas_1", openid: { access_token: "t", matrix_server_name: "acme.example" } });

test("BOT_NOT_IN_ROOM names the bot so the widget can show it (S4c)", async () => {
  const handler = createHandler(config(), {
    verifyOpenId: async () => "@alice:acme.example",
    checkRoomAccess: async () => {
      throw new AuthError("BOT_NOT_IN_ROOM", 403, "x");
    },
  });
  await serve(handler, async (base) => {
    const r = await fetch(`${base}/api/launch`, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.error, "BOT_NOT_IN_ROOM");
    assert.equal(j.botUserId, "@canvasbot:acme.example");
  });
});

test("other refusals do not name the bot", async () => {
  const handler = createHandler(config(), {
    verifyOpenId: async () => "@alice:acme.example",
    checkRoomAccess: async () => {
      throw new AuthError("NOT_MEMBER", 403, "x");
    },
  });
  await serve(handler, async (base) => {
    const r = await fetch(`${base}/api/launch`, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    assert.equal((await r.json()).botUserId, undefined);
  });
});

test("the widget page loads widget.css under a CSP with no inline code", async () => {
  await serve(createHandler(config()), async (base) => {
    const page = await fetch(`${base}/widget?roomId=x`);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(await page.text(), /<link rel="stylesheet" href="widget.css">/);
    const css = await fetch(`${base}/widget.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
  });
});
