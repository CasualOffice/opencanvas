// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Add an OpenCanvas widget to a room as a room admin (README "Add the canvas to a room").
// Sends the `im.vector.modular.widgets` state event Element reads, and invites the bot.
//
//   MX_HOMESERVER_URL=https://matrix.acme.example MX_ACCESS_TOKEN=<your token> \
//   MX_PUBLIC_URL=https://canvas-bridge.acme.example MX_BOT_USER_ID=@canvasbot:acme.example \
//   node scripts/add-widget.mjs '!roomid:acme.example' "Planning canvas"
//
// --print only prints the event JSON (to paste into Element's devtools, /devtools).

import crypto from "node:crypto";

const [roomId, name = "Canvas"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const printOnly = process.argv.includes("--print");
const bridge = (process.env.MX_PUBLIC_URL || "").replace(/\/+$/, "");
if (!roomId || !bridge) {
  console.error("usage: MX_PUBLIC_URL=... node scripts/add-widget.mjs <roomId> [name] [--print]");
  process.exit(2);
}

const widgetId = `opencanvas_${crypto.randomBytes(6).toString("hex")}`;
const content = {
  type: "m.custom",
  name,
  // Template variables are filled in by the client; they are hints, never trusted (DESIGN.md §3).
  url: `${bridge}/widget?roomId=$matrix_room_id&wid=$matrix_widget_id`,
  data: { title: "Temporary: download to keep a copy" },
  waitForIframeLoad: true,
};

if (printOnly) {
  console.log(JSON.stringify({ type: "im.vector.modular.widgets", state_key: widgetId, content }, null, 2));
  process.exit(0);
}

const hs = (process.env.MX_HOMESERVER_URL || "").replace(/\/+$/, "");
const token = process.env.MX_ACCESS_TOKEN;
if (!hs || !token) {
  console.error("set MX_HOMESERVER_URL and MX_ACCESS_TOKEN (or use --print)");
  process.exit(2);
}
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const room = encodeURIComponent(roomId);

if (process.env.MX_BOT_USER_ID) {
  const r = await fetch(`${hs}/_matrix/client/v3/rooms/${room}/invite`, {
    method: "POST", headers: auth, body: JSON.stringify({ user_id: process.env.MX_BOT_USER_ID }),
  });
  const j = await r.json().catch(() => ({}));
  // M_FORBIDDEN "already in the room" is fine.
  console.log(`invite bot: ${r.status}${j.errcode ? ` ${j.errcode}` : ""}`);
}
const r = await fetch(`${hs}/_matrix/client/v3/rooms/${room}/state/im.vector.modular.widgets/${encodeURIComponent(widgetId)}`, {
  method: "PUT", headers: auth, body: JSON.stringify(content),
});
const j = await r.json().catch(() => ({}));
if (!r.ok) {
  console.error(`widget not added: ${r.status} ${j.errcode || ""}`);
  process.exit(1);
}
console.log(`widget ${widgetId} added`);
