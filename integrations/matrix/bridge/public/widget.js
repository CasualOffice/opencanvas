// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Widget side of the Matrix widget API (matrix-widget-api / MSC2762 postMessage protocol):
// answer the client's `capabilities` request (we ask for none), then `get_openid` (MSC1960),
// send the token to the bridge, and open the canvas in a nested frame with a form POST so the
// launch token never sits in a URL. Plain text states only (UI-SCREENS.md).

(() => {
  const qs = new URLSearchParams(location.search);
  const roomId = qs.get("roomId") || "";
  // Element adds `widgetId` itself; `wid` is our template parameter ($matrix_widget_id).
  const widgetId = qs.get("widgetId") || qs.get("wid") || "";
  let parentOrigin = null;
  try {
    parentOrigin = qs.get("parentUrl") ? new URL(qs.get("parentUrl")).origin : null;
  } catch {}

  const statusEl = document.getElementById("status");
  const show = (state, text) => {
    statusEl.dataset.state = state; // loading | permission | denied | error | open
    statusEl.textContent = text;
  };

  const MESSAGES = {
    SERVER_NOT_ALLOWED: "Your homeserver is not allowed to open this canvas.",
    NOT_MEMBER: "Only members of this room can open the canvas.",
    OPENID_INVALID: "Your homeserver could not confirm who you are. Reload to try again.",
    BOT_NOT_IN_ROOM: "The canvas bot is not in this room. Ask a room admin to invite it.",
    WIDGET_UNKNOWN: "This canvas widget is no longer in the room.",
    HOMESERVER_UNREACHABLE: "Could not reach the homeserver. Try again in a moment.",
    RATE_LIMITED: "Too many attempts. Wait a minute and reload.",
  };

  if (!roomId || !widgetId || window.parent === window) {
    show("error", "Open this page as a widget in a Matrix room.");
    return;
  }

  let seq = 0;
  const pending = new Map();
  let openidRequested = false;
  let launched = false;

  const post = (msg) => window.parent.postMessage(msg, parentOrigin || "*");

  function request(action, data) {
    const requestId = `oc-${Date.now()}-${++seq}`;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      post({ api: "fromWidget", widgetId, requestId, action, data });
    });
  }

  function reply(msg, response) {
    post({ ...msg, response });
  }

  async function askOpenId() {
    if (openidRequested) return;
    openidRequested = true;
    show("permission", "Waiting for permission to confirm your Matrix identity...");
    const res = await request("get_openid", {});
    const r = res && res.response;
    if (!r) return;
    if (r.state === "allowed") onCredentials(r);
    else if (r.state === "blocked") show("denied", "The canvas needs to confirm your identity. Reload and allow it to continue.");
    // "request": the client is asking the person; `openid_credentials` follows.
  }

  async function onCredentials(c) {
    if (launched) return;
    if (c.state === "blocked") {
      show("denied", "The canvas needs to confirm your identity. Reload and allow it to continue.");
      return;
    }
    launched = true;
    show("loading", "Opening canvas...");
    let res, body;
    try {
      res = await fetch("api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          widgetId,
          openid: { access_token: c.access_token, matrix_server_name: c.matrix_server_name },
        }),
      });
      body = await res.json();
    } catch {
      show("error", "Could not reach the canvas service. Reload to try again.");
      launched = false;
      return;
    }
    if (!res.ok) {
      show("error", MESSAGES[body.error] || "The canvas could not be opened.");
      return;
    }
    const form = document.getElementById("launch");
    const frame = document.getElementById("canvas");
    form.action = body.launchUrl;
    form.elements.token.value = body.token;
    Object.assign(frame.style, { position: "fixed", inset: "0", width: "100%", height: "100%", border: "0" });
    frame.hidden = false;
    form.submit();
    form.elements.token.value = "";
    show("open", body.storage === "ephemeral" ? "Temporary canvas: export to keep a copy." : "");
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent) return;
    if (parentOrigin && ev.origin !== parentOrigin) return;
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.api === "fromWidget" && msg.response && pending.has(msg.requestId)) {
      pending.get(msg.requestId)(msg);
      pending.delete(msg.requestId);
      return;
    }
    if (msg.api !== "toWidget") return;
    switch (msg.action) {
      case "capabilities":
        reply(msg, { capabilities: [] });
        // Some clients send notify_capabilities next; do not depend on it.
        setTimeout(askOpenId, 300);
        break;
      case "notify_capabilities":
        reply(msg, {});
        askOpenId();
        break;
      case "supported_api_versions":
        reply(msg, { supported_versions: ["0.0.1", "0.0.2"] });
        break;
      case "openid_credentials":
        reply(msg, {});
        onCredentials(msg.data || {});
        break;
      default:
        // theme_change, language_change, visibility and anything new: acknowledge.
        reply(msg, {});
    }
  });

  // A client that never sends `capabilities` (no waitForIframeLoad handshake) still gets asked.
  setTimeout(askOpenId, 3000);
})();
