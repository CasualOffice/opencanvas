// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import test from "node:test";
import assert from "node:assert/strict";
import { departures, revokeInRoom } from "../src/bot.mjs";
import { fileIdFor } from "../src/launch.mjs";

test("leave, kick and ban events are departures; joins and profile changes are not", () => {
  const ev = (state_key, membership) => ({ type: "m.room.member", state_key, content: { membership } });
  const body = {
    rooms: {
      join: {
        "!a:x": { timeline: { events: [ev("@b:x", "leave"), ev("@c:x", "join"), ev("@d:x", "ban"), { type: "m.room.message" }] } },
        "!b:x": { timeline: { events: [ev("@e:x", "invite")] } },
      },
    },
  };
  assert.deepEqual(departures(body), [["!a:x", "@b:x"], ["!a:x", "@d:x"]]);
  assert.deepEqual(departures({}), []);
});

test("a departure revokes the user on every canvas of the room with the host key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ connections: 1, sessions: 1 }) };
  };
  const cfg = { ocApiUrl: "https://canvas.acme.example", hostId: "acme-matrix", apiKey: "k" };
  const closed = await revokeInRoom(cfg, "!a:x", "@b:x", { fetchImpl, widgets: ["w1", "w2"] });
  assert.equal(closed, 2);
  assert.deepEqual(calls.map((c) => c.url), [
    `https://canvas.acme.example/v1/files/${fileIdFor("!a:x", "w1")}/role`,
    `https://canvas.acme.example/v1/files/${fileIdFor("!a:x", "w2")}/role`,
  ]);
  assert.deepEqual(calls[0].body, { userId: "@b:x", role: "none" });
  assert.equal(calls[0].headers["X-OpenCanvas-Host"], "acme-matrix");
  assert.equal(calls[0].headers["X-OpenCanvas-Key"], "k");
});
