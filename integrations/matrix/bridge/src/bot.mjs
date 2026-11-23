// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The bot's /sync loop (read only; it never sends messages):
// - MX_BOT_AUTOJOIN=1: join rooms it is invited to when the inviter's homeserver is allowed,
//   leave the others.
// - With OC_API_KEY: when someone leaves or is kicked or banned from a room, close their access
//   to every canvas widget of that room at once (OpenCanvas role API, docs/05 §7,
//   `role: "none"`), so an open canvas does not outlive the membership.

import { serverAllowed, serverOfUserId } from "./openid.mjs";
import { fileIdFor } from "./launch.mjs";

const FILTER = JSON.stringify({
  room: {
    timeline: { types: ["m.room.member"], limit: 50 },
    state: { types: [] },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
});

/** Widget ids in a room that point at this bridge. */
async function canvasWidgets(cfg, roomId, auth) {
  const res = await fetch(`${cfg.botHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, {
    headers: auth,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const prefix = `${cfg.publicUrl}/widget`;
  return (await res.json())
    .filter((e) => e.type === "im.vector.modular.widgets" || e.type === "m.widget")
    .filter((e) => e.content && typeof e.content.url === "string")
    .filter((e) => e.content.url === prefix || e.content.url.startsWith(`${prefix}?`))
    .map((e) => e.state_key);
}

/** Revoke `userId` on every canvas of `roomId`. Returns the number of live connections closed. */
export async function revokeInRoom(cfg, roomId, userId, { fetchImpl = fetch, widgets } = {}) {
  let closed = 0;
  for (const widgetId of widgets) {
    const fileId = fileIdFor(roomId, widgetId);
    try {
      const res = await fetchImpl(`${cfg.ocApiUrl}/v1/files/${encodeURIComponent(fileId)}/role`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenCanvas-Host": cfg.hostId,
          "X-OpenCanvas-Key": cfg.apiKey,
        },
        body: JSON.stringify({ userId, role: "none" }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) closed += ((await res.json().catch(() => ({}))).connections || 0);
      else console.error(`revoke failed ${res.status}`);
    } catch {
      console.error("revoke failed: OpenCanvas unreachable");
    }
  }
  return closed;
}

/** Leave/kick/ban events in a sync response: [[roomId, userId]]. */
export function departures(body) {
  const out = [];
  for (const [roomId, room] of Object.entries((body.rooms && body.rooms.join) || {})) {
    for (const e of (room.timeline && room.timeline.events) || []) {
      if (e.type !== "m.room.member" || typeof e.state_key !== "string") continue;
      const m = e.content && e.content.membership;
      if (m === "leave" || m === "ban") out.push([roomId, e.state_key]);
    }
  }
  return out;
}

export async function startBot(cfg, { signal, onRevoke } = {}) {
  const base = cfg.botHomeserverUrl;
  const auth = { Authorization: `Bearer ${cfg.botAccessToken}` };
  let since = null;
  let backoff = 1000;
  while (!signal || !signal.aborted) {
    try {
      const q = new URLSearchParams({ timeout: since ? "30000" : "0", filter: FILTER });
      if (since) q.set("since", since);
      const res = await fetch(`${base}/_matrix/client/v3/sync?${q}`, { headers: auth, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`sync ${res.status}`);
      const body = await res.json();
      const first = since === null;
      since = body.next_batch;
      if (first) continue; // history before start-up is not acted on

      if (cfg.botAutojoin) {
        for (const [roomId, room] of Object.entries((body.rooms && body.rooms.invite) || {})) {
          const ev = ((room.invite_state && room.invite_state.events) || []).find(
            (e) => e.type === "m.room.member" && e.content && e.content.membership === "invite",
          );
          const inviter = ev && ev.sender;
          const action = inviter && serverAllowed(serverOfUserId(inviter), cfg) ? "join" : "leave";
          const url =
            action === "join"
              ? `${base}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`
              : `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`;
          const r = await fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
          console.log(`bot ${action} ${r.ok ? "ok" : `failed ${r.status}`}`);
        }
      }
      if (cfg.apiKey) {
        for (const [roomId, userId] of departures(body)) {
          const widgets = await canvasWidgets(cfg, roomId, auth);
          if (widgets.length === 0) continue;
          const closed = await revokeInRoom(cfg, roomId, userId, { widgets });
          console.log(`member left: access closed on ${widgets.length} canvas(es), ${closed} connection(s)`);
          if (onRevoke) onRevoke({ roomId, userId, canvases: widgets.length, connections: closed });
        }
      }
      backoff = 1000;
    } catch (e) {
      console.error(`bot sync error: ${e && e.message}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}
