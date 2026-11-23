// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Widget side of the Matrix widget API (matrix-widget-api / MSC2762 postMessage protocol):
// answer the client's `capabilities` request (we ask for none), then `get_openid` (MSC1960),
// send the token to the bridge, and open the canvas in a nested frame with a form POST so the
// launch token never sits in a URL. Screens S1-S4 follow the approved prototype
// (docs/prototypes/matrix-approved, 2026-11-24); S5-S7 are the editor's, in room wording
// (`temporary_wording = "room"`, OpenCanvas ADR-049).

(() => {
  const qs = new URLSearchParams(location.search);
  const roomId = qs.get("roomId") || "";
  // Element adds `widgetId` itself: the id widget API messages must carry. `wid` is our
  // template parameter ($matrix_widget_id): which canvas is asked for (the bridge checks it).
  const widgetId = qs.get("widgetId") || qs.get("wid") || "";
  const canvasWidgetId = qs.get("wid") || widgetId;
  let parentOrigin = null;
  try {
    parentOrigin = qs.get("parentUrl") ? new URL(qs.get("parentUrl")).origin : null;
  } catch {}
  const theme = qs.get("theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

  // Lucide icons (ISC), inlined: the page loads nothing from elsewhere.
  const ICONS = {
    "shield-x": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m14.5 9.5-5 5"/><path d="m9.5 9.5 5 5"/>',
    "shield-check": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    "bot": '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    "copy": '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    "rotate-cw": '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    "user-x": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>',
    "server-off": '<path d="M7 2h13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-5"/><path d="M10 10 2.5 2.5C2 2 2 2.5 2 5v3a2 2 0 0 0 2 2h6z"/><path d="M22 17v-1a2 2 0 0 0-2-2h-1"/><path d="M4 14a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16.5l1-.5.5.5-8-8H4z"/><path d="M6 18h.01"/><path d="m2 2 20 20"/>',
    "trash-2": '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    "cloud-off": '<path d="m2 2 20 20"/><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/>',
    "timer": '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
    "app-window": '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
    "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  };
  const statusEl = document.getElementById("status");
  const screenEl = document.getElementById("screen");
  const skeleton = screenEl.querySelector(".skel"); // S1, shown again while launching

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "onclick") e.addEventListener("click", v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  function icon(name) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "ic");
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = ICONS[name] || "";
    return s;
  }
  /** Text with **bold** parts. */
  function rich(text) {
    const f = document.createDocumentFragment();
    text.split(/\*\*(.+?)\*\*/).forEach((part, i) => f.append(i % 2 ? el("b", {}, part) : part));
    return f;
  }
  const reload = () => location.reload();
  const tryAgain = () => el("button", { type: "button", class: "btn pri", onclick: reload }, icon("rotate-cw"), "Try again");

  /** One screen: the live region says it in words; the card shows it. */
  function show(state, spoken, card, full = false) {
    statusEl.dataset.state = state; // loading | permission | denied | error | open
    statusEl.textContent = spoken;
    screenEl.replaceChildren();
    if (card) screenEl.append(el("div", { class: "wrap" + (full ? " full" : "") }, card));
  }
  function card(tone, iconName, title, lines, actions, fine) {
    return el(
      "section",
      { class: "card", "aria-labelledby": "t" },
      el("div", { class: `tile ${tone}` }, icon(iconName)),
      el("h1", { id: "t" }, title),
      ...lines.map((l) => el("p", {}, rich(l))),
      actions && actions.length ? el("div", { class: "acts" }, ...actions) : null,
      fine ? el("p", { class: "fine" }, rich(fine)) : null,
    );
  }

  // S2: Element shows its own "verify your identity" dialog over this.
  function showPermission() {
    const c = card("amber", "shield-check", "Confirm it's you", [
      "Element is asking whether this canvas may check your Matrix ID. It only checks that you're a member of this room. It can't read your messages or act for you.",
    ]);
    c.append(el("div", { class: "tip" }, icon("info"), el("span", {}, rich("Tick **Remember this** in Element's dialog so you aren't asked again on this device."))));
    show("permission", "Waiting for permission to confirm your Matrix identity.", c);
  }
  // S3: the person chose Deny.
  function showDenied() {
    show(
      "denied",
      "The canvas needs to confirm it's you.",
      card(
        "amber",
        "shield-x",
        "The canvas needs to confirm it's you",
        ["You chose Deny in Element. The canvas only checks that you're a member of this room; no messages are read."],
        [el("button", { type: "button", class: "btn pri", onclick: reload }, icon("rotate-cw"), "Reload and allow")],
        "If Element doesn't ask again, open the widget's options (…) and choose **Revoke permissions**, then reload.",
      ),
    );
  }
  // S4: errors. No codes, no addresses; who can fix it.
  function showError(code, ctx = {}) {
    const server = ctx.server || "your homeserver";
    let c;
    switch (code) {
      case "NOT_MEMBER":
        c = card("gray", "user-x", "Join the room to open this canvas", ["Only members of this room can open its canvas. Once you have joined, open the widget again."]);
        break;
      case "SERVER_NOT_ALLOWED":
        c = card("gray", "server-off", "Your homeserver can't open this canvas", [
          `This canvas only accepts accounts from approved homeservers, and ${server} isn't one of them.`,
          "If you think this is wrong, ask a room admin to contact whoever runs the canvas service for this room.",
        ]);
        break;
      case "BOT_NOT_IN_ROOM": {
        const acts = [];
        if (ctx.botUserId) {
          const copy = el("button", { type: "button", class: "btn sec" }, "Copy user ID");
          copy.addEventListener("click", () => copyId(ctx.botUserId, copy));
          acts.push(copy);
        }
        acts.push(el("button", { type: "button", class: "btn ghost", onclick: reload }, icon("rotate-cw"), "Try again"));
        c = card("amber", "bot", "The canvas bot isn't in this room", ["A room admin needs to invite the canvas bot. It only reads who is in the room; it never posts."], acts);
        if (ctx.botUserId) {
          const b = el("button", { type: "button", class: "copy", "aria-label": "Copy user ID", title: "Copy user ID" }, icon("copy"));
          b.addEventListener("click", () => copyId(ctx.botUserId, b));
          c.insertBefore(el("div", { class: "id" }, icon("bot"), el("span", {}, ctx.botUserId), b), c.querySelector(".acts"));
        }
        break;
      }
      case "WIDGET_UNKNOWN":
        c = card("gray", "trash-2", "This canvas is no longer in the room", ["Someone removed it from the room, or the link is wrong. You can close this panel."]);
        break;
      case "HOMESERVER_UNREACHABLE":
        c = card("gray", "cloud-off", "Your homeserver didn't answer", [`The canvas couldn't confirm your account with ${server} just now. This is usually brief.`], [tryAgain()]);
        break;
      case "OPENID_INVALID":
        c = card("gray", "shield-x", "Element couldn't confirm your identity this time", ["This is usually brief."], [tryAgain()]);
        break;
      case "RATE_LIMITED":
        c = card("gray", "timer", "Too many tries in a short time", ["Wait a minute, then try again."], [tryAgain()]);
        break;
      case "OUTSIDE":
        c = card("gray", "app-window", "Open this canvas from a Matrix room", [
          "This page only works inside a Matrix app such as Element, as a widget in a room. Go to the room and open the canvas from there.",
        ]);
        show("error", c.querySelector("h1").textContent, c, true);
        return;
      default: // network, BAD_REQUEST, anything unknown
        c = card("gray", "cloud-off", "Can't reach the canvas service", ["Check your connection, then try again."], [tryAgain()]);
    }
    show("error", c.querySelector("h1").textContent, c);
  }
  async function copyId(id, btn) {
    try {
      await navigator.clipboard.writeText(id);
      btn.setAttribute("data-copied", "1");
      statusEl.textContent = "User ID copied";
    } catch {
      const span = btn.closest(".card").querySelector(".id span");
      if (span) getSelection().selectAllChildren(span);
      statusEl.textContent = "Select the user ID and copy it";
    }
  }

  if (!roomId || !widgetId || window.parent === window) {
    showError("OUTSIDE");
    return;
  }

  let seq = 0;
  const pending = new Map();
  let openidRequested = false;
  let launched = false;
  let ocOrigin = null;
  let asking = null;

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
    // Remembered permission answers at once; show S2 only if Element is actually asking.
    // Any answer clears it: in the real Element run a quick Continue arrived first and S2 then
    // replaced the open canvas's state.
    asking = setTimeout(() => {
      if (!launched) showPermission();
    }, 400);
    const res = await request("get_openid", {});
    const r = res && res.response;
    if (!r) return;
    if (r.state === "allowed") {
      clearTimeout(asking);
      onCredentials(r);
    } else if (r.state === "blocked") {
      clearTimeout(asking);
      showDenied();
    }
    // "request": the client is asking the person; `openid_credentials` follows.
  }

  async function onCredentials(c) {
    clearTimeout(asking);
    if (launched) return;
    if (c.state === "blocked") {
      showDenied();
      return;
    }
    launched = true;
    const server = c.matrix_server_name;
    show("loading", "Loading canvas…", null);
    if (skeleton) screenEl.replaceChildren(skeleton);
    let res, body;
    try {
      res = await fetch("api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          widgetId: canvasWidgetId,
          openid: { access_token: c.access_token, matrix_server_name: server },
        }),
      });
      body = await res.json();
    } catch {
      showError("NETWORK");
      launched = false;
      return;
    }
    if (!res.ok) {
      showError(body.error, { server, botUserId: body.botUserId });
      return;
    }
    const form = document.getElementById("launch");
    const frame = document.getElementById("canvas");
    ocOrigin = new URL(body.launchUrl).origin;
    form.action = body.launchUrl;
    form.elements.token.value = body.token;
    Object.assign(frame.style, { position: "fixed", inset: "0", width: "100%", height: "100%", border: "0" });
    frame.hidden = false;
    form.submit();
    form.elements.token.value = "";
    // S5: no extra notice from the widget; the editor says the canvas is temporary.
    show("open", "Canvas open", null);
  }

  window.addEventListener("message", (ev) => {
    // The canvas frame (docs/05 §4): "Start a new canvas" on the ended screen (MX S6a).
    const frame = document.getElementById("canvas");
    if (ocOrigin && ev.source === frame.contentWindow && ev.origin === ocOrigin) {
      if (ev.data && ev.data.MessageId === "UI_StartNew") reload();
      return;
    }
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
      case "theme_change": {
        const name = msg.data && msg.data.name;
        if (name === "dark" || name === "light") document.documentElement.dataset.theme = name;
        reply(msg, {});
        break;
      }
      default:
        // language_change, visibility and anything new: acknowledge.
        reply(msg, {});
    }
  });

  // A client that never sends `capabilities` (no waitForIframeLoad handshake) still gets asked.
  setTimeout(askOpenId, 3000);
})();
