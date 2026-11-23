// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Room checks through the bridge's own bot account (DESIGN.md §5): the widget exists in the
// room and points at this bridge, the verified user is joined, and their power level picks
// the OpenCanvas role. The bot must be joined to the room (it reads room state through the
// Client-Server API: https://spec.matrix.org/v1.19/client-server-api/#get_matrixclientv3roomsroomidstateeventtypestatekey).

import { AuthError } from "./openid.mjs";

const ROOM_ID = /^![\x21-\x7e]{1,254}$/;
const WIDGET_ID = /^[\x20-\x7e]{1,255}$/;
// Room versions whose creators hold power outside `users` (MSC4289, room version 12).
const LEGACY_ROOM_VERSIONS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);

export function validRoomId(v) {
  return typeof v === "string" && ROOM_ID.test(v);
}
export function validWidgetId(v) {
  return typeof v === "string" && WIDGET_ID.test(v);
}

/** Bot-authenticated state read. null when the event does not exist. */
export function botStateReader(cfg) {
  const read = async (roomId, type, stateKey, { asEvent = false } = {}) => {
    const url =
      `${cfg.botHomeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}` +
      `/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}` +
      (asEvent ? "?format=event" : "");
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.botAccessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AuthError("HOMESERVER_UNREACHABLE", 502, "the bridge's homeserver is unreachable");
    }
    if (res.status === 404) return null;
    if (res.status === 403) throw new AuthError("BOT_NOT_IN_ROOM", 403, "the canvas bot is not in this room");
    if (!res.ok) throw new AuthError("HOMESERVER_UNREACHABLE", 502, "unexpected homeserver answer");
    return res.json();
  };
  // The bot's own user id (whoami, cached), to check that it is still joined: a bot that left
  // or was kicked still reads the room state as it was when it left.
  let me = cfg.botUserId || null;
  read.botUserId = async () => {
    if (me) return me;
    let res;
    try {
      res = await fetch(`${cfg.botHomeserverUrl}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${cfg.botAccessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AuthError("HOMESERVER_UNREACHABLE", 502, "the bridge's homeserver is unreachable");
    }
    if (!res.ok) throw new AuthError("HOMESERVER_UNREACHABLE", 502, "the bot token was not accepted");
    me = (await res.json()).user_id;
    return me;
  };
  return read;
}

/** Power level of `userId` in a power_levels content (spec defaults when absent). */
export function powerLevel(pl, userId) {
  if (!pl) return null;
  const u = pl.users && Number.isInteger(pl.users[userId]) ? pl.users[userId] : null;
  if (u !== null) return u;
  return Number.isInteger(pl.users_default) ? pl.users_default : 0;
}

/**
 * Returns { role, displayName, widgetName }. Throws AuthError WIDGET_UNKNOWN, NOT_MEMBER,
 * BOT_NOT_IN_ROOM or HOMESERVER_UNREACHABLE.
 */
export async function checkRoomAccess({ roomId, widgetId, userId }, cfg, getState) {
  const botId = getState.botUserId ? await getState.botUserId() : cfg.botUserId;
  const botMember = botId ? await getState(roomId, "m.room.member", botId) : null;
  if (!botMember || botMember.membership !== "join") {
    throw new AuthError("BOT_NOT_IN_ROOM", 403, "the canvas bot is not in this room");
  }

  const widget =
    (await getState(roomId, "im.vector.modular.widgets", widgetId)) ||
    (await getState(roomId, "m.widget", widgetId));
  const prefix = `${cfg.publicUrl}/widget`;
  if (!widget || typeof widget.url !== "string" || !(widget.url === prefix || widget.url.startsWith(`${prefix}?`))) {
    throw new AuthError("WIDGET_UNKNOWN", 404, "this canvas widget is not in the room");
  }

  const member = await getState(roomId, "m.room.member", userId);
  if (!member || member.membership !== "join") {
    throw new AuthError("NOT_MEMBER", 403, "you are not a member of this room");
  }

  // Role: creator (room v12+) or power level >= state_default edits; others get memberRole.
  const create = await getState(roomId, "m.room.create", "", { asEvent: true });
  const createContent = create && (create.content || create);
  const version = createContent && typeof createContent.room_version === "string" ? createContent.room_version : "1";
  let isCreator = false;
  if (create && !LEGACY_ROOM_VERSIONS.has(version)) {
    const extra = Array.isArray(createContent.additional_creators) ? createContent.additional_creators : [];
    isCreator = create.sender === userId || extra.includes(userId);
  }
  const pl = await getState(roomId, "m.room.power_levels", "");
  let level, stateDefault;
  if (pl) {
    level = powerLevel(pl, userId);
    stateDefault = Number.isInteger(pl.state_default) ? pl.state_default : 50;
  } else {
    // No power_levels event: the creator has 100, everyone else 0, state_default 0.
    const creator = create && (create.sender || (createContent && createContent.creator));
    level = creator === userId ? 100 : 0;
    stateDefault = 0;
  }
  const role = isCreator || level >= stateDefault ? "edit" : cfg.memberRole;

  const dn = typeof member.displayname === "string" ? member.displayname.trim().slice(0, 128) : "";
  const wn = typeof widget.name === "string" ? widget.name.trim().slice(0, 128) : "";
  return { role, displayName: dn || userId, widgetName: wn || "Canvas" };
}
