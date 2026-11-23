<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas in Matrix rooms: design

**Status:** draft, 2026-11-24 (tracker MX-01); verified in Element Web, see README. Owner request: "Add an OpenCanvas widget to
Matrix rooms, similar to how collaborative Etherpad and Jitsi widgets are embedded today."

## 1. Research summary (sources checked 2026-11-24)

**Widgets in rooms.** A room widget is a state event. Element sends and reads the legacy
type `im.vector.modular.widgets` (state key = widget id); `m.widget` is the spec-track name
(MSC1236, MSC2764) and Element still has a TODO to support it
(element-web `apps/web/src/utils/WidgetUtils.ts`, `setRoomWidgetContent` →
`sendStateEvent(roomId, "im.vector.modular.widgets", content, widgetId)`; issue
https://github.com/vector-im/element-web/issues/13111). Content: `type`, `url`, `name`,
`data`, optional `avatar_url`, `waitForIframeLoad`. Sending it needs the power level for that
state event (Element: `maySendStateEvent("im.vector.modular.widgets")`).

**Widget types.** Element knows `m.jitsi`/`jitsi`, `m.stickerpicker`, `m.integration_manager`,
`m.custom`, `m.call` (`apps/web/src/widgets/WidgetType.ts`); any other string becomes a
generic widget (`WidgetType.fromString`). matrix-widget-api's enum is `m.custom`, `m.jitsi`,
`m.stickerpicker` (https://github.com/matrix-org/matrix-widget-api/blob/master/src/interfaces/WidgetType.ts).
**Etherpad has no built-in support in Element**: there is no `etherpad` key in Element's
config (https://github.com/element-hq/element-web/blob/develop/docs/config.md) and no
Etherpad code in `WidgetUtils.ts`. Etherpad widgets are created by an integration manager
(Scalar, Dimension) or bots (for example Nordeck's matrix-meetings) as a state event of type
`etherpad` pointing at a pad URL; Element renders it as a generic widget. OpenCanvas follows
the same path: a state event with a URL, type `m.custom` (no integration manager needed).

**URL template variables.** Element fills `$matrix_user_id`, `$matrix_room_id`,
`$matrix_display_name`, `$matrix_avatar_url`, `$matrix_widget_id`,
`$org.matrix.msc2873.client_theme`, `$org.matrix.msc2873.client_language`, `$theme`
(`WidgetUtils.getLocalJitsiWrapperUrl` lists them; matrix-widget-api `runTemplate`), and for
non-popout widgets appends `widgetId` and `parentUrl` itself
(`apps/web/src/stores/widgets/WidgetMessaging.ts`, "legacy support sprinkles"). **Anyone can
open the widget URL with any values**, so they are hints for routing and display only.

**Widget API.** postMessage between the client and the widget iframe (MSC2762 / MSC2871 /
matrix-widget-api). The client sends `toWidget` `capabilities`; the widget answers the
capabilities it wants (we ask for none); the client may send `notify_capabilities`, theme and
language changes. The widget asks `fromWidget` `get_openid` (MSC1960,
https://github.com/matrix-org/matrix-spec-proposals/blob/old_master/proposals/1960-integrations-openid.md):
answer `state: "allowed"` with the credentials, `"blocked"`, or `"request"` followed later by
`toWidget` `openid_credentials` with `original_request_id`. Credentials: `access_token`,
`token_type: "Bearer"`, `matrix_server_name`, `expires_in` (from the Client-Server endpoint
`POST /_matrix/client/v3/user/{userId}/openid/request_token`).

**Verifying the token.** `GET /_matrix/federation/v1/openid/userinfo?access_token=…` on the
user's homeserver answers `{"sub": "@alice:example.org"}` or 401 `M_UNKNOWN_TOKEN`
(https://spec.matrix.org/v1.19/server-server-api/#openid). The homeserver is found by
server-name resolution (https://spec.matrix.org/v1.19/server-server-api/#resolving-server-names):
IP literal → that IP (8448 default); hostname with port → A/AAAA; else
`https://<host>/.well-known/matrix/server` (`m.server`, follow redirects), then SRV
`_matrix-fed._tcp`, deprecated `_matrix._tcp`, then A/AAAA on 8448; Host header and TLS name
per step.

**Permission prompts in Element.** (1) A widget added by someone else shows the
"widget added by … / shared data" consent before it loads (`AppPermission.tsx`: name, avatar,
user id, device id, theme, language, Element URL, room id, widget id) plus a warning in
encrypted rooms ("widget|unencrypted_warning"). (2) Requested capabilities show
`WidgetCapabilitiesPromptDialog` (we request none, so no dialog). (3) `get_openid` shows
`WidgetOpenIDPermissionsDialog` with "remember" unless a module pre-approves identity
(`ElementWidgetDriver.askOpenID`: `ModuleApi.widgetLifecycle.preapproveIdentity`, then the
stored `widgetPermissionStore` state). There is **no `config.json` key** that registers a
widget type or trusts a widget URL; pre-approval needs an Element module.

**Element `widget_build_url`.** Only used for the call button (returns a call widget); it does
not apply to a canvas.

## 2. Goals and non-goals

- One shared canvas per widget in a room; everyone joined can open it; the role comes from the
  room's power levels.
- Identity from the homeserver, never from the URL. No passwords, no Matrix access tokens of
  users reach the bridge.
- No change to the OpenCanvas server (ADR-001: OpenCanvas never persists documents).
- Non-goal for v1: storing canvases in Matrix (phase 2, §8), mobile Element X (its widget
  support is limited to Element Call today), styling (UI-SCREENS.md waits for a prototype).

## 3. Trust model

URL template variables are **not authentication**. `$matrix_user_id` is filled by the client
of whoever opens the iframe, and the URL can be opened directly with any value. The bridge
uses `roomId` and `widgetId` only to know *which* canvas is asked for, then proves:

1. **Who**: the OpenID token, verified with the user's own homeserver (§4).
2. **Room**: that user is `join`ed to that room, the widget id exists in that room's state and
   points at this bridge, read by the bridge's own bot account (§5).
3. **Role**: from the room's power levels (§5).

Only then is an OpenCanvas launch token minted (docs/05 §3), for this user, this canvas, with
that role, for 10 minutes, single use (`jti`).

What a homeserver can do: a malicious homeserver can vouch for its own users only (we check
the `sub` server equals the server we asked). It cannot make a user of another server appear.
Its users still need to be joined to the room, which the bot sees from room state.

## 4. Architecture

```
Element (any origin) ── iframe ──> bridge /widget  (unstyled page, widget API)
   │  toWidget capabilities  <──>  []                         │
   │  fromWidget get_openid  ───>  prompt / remember          │
   │  openid credentials     ───>  POST /api/launch ─────────>│ bridge
   │                                                          │  1 resolve server name (guarded)
   │                                                          │  2 GET userinfo ─> user's homeserver
   │                                                          │  3 bot reads room state ─> bot's homeserver
   │                                                          │  4 sign launch JWT (HS256)
   │  nested iframe form POST token ──> OpenCanvas /v1/launch ─> 303 /app/#t=<ticket>
```

`integrations/matrix/bridge/` is that host: Node 24, no dependencies.

- `GET /widget`: the widget page. CSP: scripts from self, `frame-src` and `form-action` the
  OpenCanvas origin, `frame-ancestors *` (any Matrix client must be able to show it; the page
  carries no credential).
- `widget.js`: answers `capabilities` with none, sends `get_openid` after the handshake (or
  after 3 s for clients without one), posts the credentials to `/api/launch`, then form-POSTs
  the launch token into a nested iframe so the token never appears in a URL, history or a
  referrer. It keeps the widget API alive in the outer page.
- `POST /api/launch`: JSON in, `{launchUrl, token, role, storage}` out. 30 requests per
  minute per address. Errors are `{error, message}` with stable codes (README).

**SSRF protections** (`federation.mjs`, `netguard.mjs`). The server name comes from the
browser, so resolving it is an SSRF vector:

- Server names are parsed with the spec grammar; anything else is refused.
- Optional `MX_ALLOWED_SERVERS` allow-list is checked before any network call.
- Every A/AAAA answer for every hop (well-known host, delegated host, SRV target) must be
  public: loopback, RFC 1918, CGNAT, link-local (including 169.254.169.254), multicast,
  reserved, documentation, ULA, IPv4-mapped/NAT64 forms of those are refused. One private
  answer refuses the whole name (no mixed-record tricks).
- The connection goes to the checked IP (pinned; no second lookup, so no DNS rebinding), with
  the spec's Host header and TLS name; certificates are verified.
- No redirects, except for `/.well-known/matrix/server` as the spec requires, and then only to
  `https` URLs that pass the same checks. 5 s timeout, 64 KB response cap.
- `MX_PRIVATE_ALLOWED` names servers that may resolve privately (an intranet homeserver);
  `MX_FEDERATION_OVERRIDES` maps a server name to a fixed URL (operator-trusted, for local
  development or a split-horizon setup).

## 5. Room membership and roles

The bridge cannot read a room with a user's OpenID token (it only proves identity). It uses a
**bot account** (`MX_BOT_ACCESS_TOKEN`) joined to the room, and reads state with the
Client-Server API:

- the bot's own `m.room.member`: must be `join`. Found end to end: Synapse still answers state
  reads for a bot that **left** (state as of its leave), which would trust stale membership;
- `m.room.member` of the verified user: must be `join` (invite, knock, leave, ban refused).
  Checked before the widget, so a non-member learns nothing about the room's widgets (found in
  Element: a forged widget in another room naming this room got `WIDGET_UNKNOWN` first);
- `im.vector.modular.widgets` (or `m.widget`) with the widget id: must exist and its `url`
  must be this bridge's `/widget`. The widget page sends our `wid` template parameter as the
  canvas id; Element's own `widgetId` parameter is used only for widget API messages;
- `m.room.power_levels` and `m.room.create`: role = `edit` when the user's level ≥
  `state_default` (default 50), or the user is a room creator in room version 12+ (MSC4289:
  creators sit outside `users`); everyone else gets `MX_MEMBER_ROLE` (`edit` default, or
  `comment`/`view`). Without a power-levels event the creator has 100 and `state_default` is 0.

Getting the bot in: room admins invite it (the add-widget script does), and
`MX_BOT_AUTOJOIN=1` makes the bridge join invites from allowed homeservers. An application
service registration would avoid invites but needs homeserver admin access on every server
that hosts rooms; it is phase 2.

Without a bot there is no way to check membership for rooms on other servers; we do **not**
offer an "insecure" mode that trusts `$matrix_room_id`.

**Leaving the room.** The bot's `/sync` loop (with `OC_API_KEY`) sees `leave` and `ban`
membership events and calls `POST /v1/files/{fileId}/role {"userId","role":"none"}` for every
canvas widget of the room, so an open editor (also a popped-out one) closes at once.
Verified in Element: 1 live connection closed. **Power-level changes** apply at the next
launch (tokens last 10 minutes); phase 2: the bot maps them to the role API too.

## 6. Storage decision

**v1: temporary per widget, `storage = "ephemeral"` (ADR-043), like Jitsi.** Recommended.

- No change to OpenCanvas, no host storage, nothing written to Matrix.
- The canvas lives while someone has it open, survives reloads and OpenCanvas restarts, and is
  destroyed when the last person leaves and `OC_ROOM_IDLE_MS` passes. People export to keep it.
- Honest limit: chat rooms are long-lived and asynchronous, so "temporary" is a bigger
  surprise than in a meeting. The widget must say so (UI-SCREENS.md S5) and the widget title
  says "export to keep a copy".

**Phase 2: persistent, stored in Matrix.** The bridge implements the docs/05 §5 callbacks:
`GET /files/{id}` downloads the latest `.ocanvas` via authenticated media
(`/_matrix/client/v1/media/download`, MSC3916) referenced from a room state event (for example
`org.opencanvas.file`, state key = widget id, content `{mxc, version, size, sha256}`);
`PUT /files/{id}` uploads (`/_matrix/media/v3/upload`) and updates that state event as the bot.
Costs: media is **not end-to-end encrypted** (state events and media uploads are plaintext to
every homeserver in the room; encrypting with a key kept in room state protects nothing),
media retention and quota policies, every save is a state event in the room history, and the
bot needs power to send that state event. Needs `jwt` host mode with `callback_base` on the
bridge, `If-Match` versions from the state event, and an `on_conflict` policy.

## 7. Federation and encryption

- Users from any federated homeserver can open the canvas if their server passes
  `MX_ALLOWED_SERVERS` (empty = any) and the server-name checks, and they are joined.
- **Encrypted rooms:** the canvas is **not** end-to-end encrypted. Content goes over TLS to the
  OpenCanvas server, which holds it in memory and its transient room store until the room
  closes. The widget state event (URL, name) is room state and is never encrypted in Matrix.
  Element already warns in encrypted rooms that widgets are not encrypted. The bridge sees
  user ids, display names, room ids and widget ids, not canvas content.
- What reaches OpenCanvas: the Matrix user id (as `user.id` and `detail`), the display name,
  the widget name, an opaque `file.id` = SHA-256 of room id + widget id. No room id, no avatar
  (Matrix avatars are `mxc://` and authenticated media needs a token).

## 8. OpenCanvas gaps (no server change made)

1. **`frame-ancestors` was one list for the whole server** (closed in MX-01). The editor frame
   is nested inside the bridge page inside the Matrix client, and CSP `frame-ancestors` checks
   every ancestor, so every Matrix client origin had to be added to the server-wide list.
   Now a host may set `frame_ancestors`: its launches redirect to `/app/?h=<host id>`, and only
   that page carries the extra origins (`crates/oc-server/tests/embed_origins.rs`, seen
   failing first). The `h` parameter grants nothing: the editor holds no cookies and its
   session is the ticket in the fragment. Hosts without the setting are unchanged. Verified in
   Element: without it the editor frame is blocked, with it the canvas loads.
2. **No room-close signal from Matrix** (still open). Removing the widget does not end the canvas; it ends
   at idle. Phase 2: the bot sees the widget state event removed and calls
   `DELETE /v1/files/{fileId}/session`.
3. **Token refresh** (`Token_Expiring` / `Action_RefreshToken`) is documented but not
   implemented (tracker DOC-05): a session longer than the ticket life needs a reload.
4. **Avatars**: OpenCanvas accepts http(s) avatars only; Matrix avatars need an authenticated
   media proxy in the bridge.

## 9. Element configuration

None is required: the widget is a room state event. Element has no `config.json` key that
registers a widget type or trusts a widget URL. Optional: an Element module implementing
`widgetLifecycle.preapproveIdentity` for the bridge URL would skip the OpenID prompt on a
self-hosted Element. `/addwidget <url>` in Element adds the same widget (type `m.custom`) for
anyone allowed to send widget state.
