// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// OpenCanvas launch token (docs/05-INTEGRATION-GUIDE.md §3), HS256, signed with the host's
// `jwt_secret`. One canvas per (room, widget): file.id is an opaque hash of both, so a new
// widget in the same room is a new canvas, and room ids never reach OpenCanvas.

import crypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function signHs256(claims, secret) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function fileIdFor(roomId, widgetId) {
  return "mx-" + crypto.createHash("sha256").update(`${roomId}\n${widgetId}`).digest("hex").slice(0, 40);
}

/** Claims for one person opening one room widget. */
export function launchClaims({ cfg, userId, displayName, role, roomId, widgetId, widgetName, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  return {
    iss: cfg.hostId,
    aud: "opencanvas",
    iat,
    exp: iat + cfg.tokenTtlSecs,
    jti: crypto.randomUUID(),
    file: { id: fileIdFor(roomId, widgetId), name: widgetName },
    // The Matrix user id is the stable identity; it is also the second line that tells
    // two people with the same display name apart.
    user: { id: userId, name: displayName, detail: userId },
    role,
    perms: { export: true, download: true, print: true, commitMessage: false, mention: false },
    mode: role === "view" ? "view" : "edit",
  };
}
