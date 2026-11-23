// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Optional (MX_BOT_AUTOJOIN=1): the bot joins rooms it is invited to, when the inviter's
// homeserver is allowed. A long-poll /sync loop with a filter that only carries invites.
// The bot reads state only; it never sends messages.

import { serverAllowed, serverOfUserId } from "./openid.mjs";

const FILTER = JSON.stringify({
  room: { timeline: { limit: 0 }, state: { types: [] }, ephemeral: { types: [] }, account_data: { types: [] } },
  presence: { types: [] },
  account_data: { types: [] },
});

export async function startAutojoin(cfg, { signal } = {}) {
  const base = cfg.botHomeserverUrl;
  const auth = { Authorization: `Bearer ${cfg.botAccessToken}` };
  let since = null;
  let backoff = 1000;
  while (!signal || !signal.aborted) {
    try {
      const q = new URLSearchParams({ timeout: "30000", filter: FILTER });
      if (since) q.set("since", since);
      const res = await fetch(`${base}/_matrix/client/v3/sync?${q}`, { headers: auth, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`sync ${res.status}`);
      const body = await res.json();
      since = body.next_batch;
      for (const [roomId, room] of Object.entries((body.rooms && body.rooms.invite) || {})) {
        const ev = ((room.invite_state && room.invite_state.events) || []).find(
          (e) => e.type === "m.room.member" && e.content && e.content.membership === "invite",
        );
        const inviter = ev && ev.sender;
        if (!inviter || !serverAllowed(serverOfUserId(inviter), cfg)) {
          await fetch(`${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
            method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}",
          });
          continue;
        }
        const j = await fetch(`${base}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
          method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}",
        });
        console.log(`bot join ${j.ok ? "ok" : `failed ${j.status}`}`);
      }
      backoff = 1000;
    } catch (e) {
      console.error(`bot sync error: ${e && e.message}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}
