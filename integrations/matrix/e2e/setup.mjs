// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Synapse fixtures for the Element end-to-end run (element-e2e.mjs): users, a room with the
// bot, and the OpenCanvas widget pinned to the top of the room.

import crypto from "node:crypto";

export async function mx(hs, method, path, token, body) {
  const res = await fetch(hs + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${res.status} ${json.errcode || ""}`);
  return json;
}

export async function register(hs, regSecret, username, displayName) {
  const { nonce } = await mx(hs, "GET", "/_synapse/admin/v1/register");
  const password = crypto.randomBytes(12).toString("hex");
  const mac = crypto.createHmac("sha1", regSecret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest("hex");
  const r = await mx(hs, "POST", "/_synapse/admin/v1/register", null, { nonce, username, password, admin: false, mac });
  if (displayName) {
    await mx(hs, "PUT", `/_matrix/client/v3/profile/${encodeURIComponent(r.user_id)}/displayname`, r.access_token, { displayname: displayName });
  }
  return { id: r.user_id, token: r.access_token, username, password, name: displayName };
}

export async function roomWithWidget(hs, { owner, members, bot, bridgeUrl, name = "Acme planning" }) {
  const { room_id: roomId } = await mx(hs, "POST", "/_matrix/client/v3/createRoom", owner.token, {
    preset: "private_chat",
    name,
    invite: [bot.id, ...members.map((m) => m.id)],
  });
  for (const u of [bot, ...members]) {
    await mx(hs, "POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, u.token, {});
  }
  const widgetId = `opencanvas_${crypto.randomBytes(4).toString("hex")}`;
  const room = encodeURIComponent(roomId);
  await mx(hs, "PUT", `/_matrix/client/v3/rooms/${room}/state/im.vector.modular.widgets/${widgetId}`, owner.token, {
    type: "m.custom",
    name: "Canvas",
    url: `${bridgeUrl}/widget?roomId=$matrix_room_id&wid=$matrix_widget_id`,
    data: { title: "Temporary: download to keep a copy" },
    waitForIframeLoad: true,
  });
  // Pin it to the top of the room for everyone (Element's layout state event).
  await mx(hs, "PUT", `/_matrix/client/v3/rooms/${room}/state/io.element.widgets.layout/`, owner.token, {
    widgets: { [widgetId]: { container: "top", index: 0, width: 100, height: 80 } },
  });
  return { roomId, widgetId };
}
