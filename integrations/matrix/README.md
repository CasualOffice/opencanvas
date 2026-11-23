<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas in Matrix rooms (Element)

A room widget, like an Etherpad or Jitsi widget: everyone in the room opens the same canvas
from the room's widget panel and edits it live. Design: [DESIGN.md](DESIGN.md). Screens still
to prototype: [UI-SCREENS.md](UI-SCREENS.md).

- **Identity is verified**, not taken from the URL: the widget asks the Matrix client for an
  OpenID token and the bridge checks it with the user's homeserver.
- **Only room members** open it; a bot account checks membership and power levels.
  Moderators (power level ≥ `state_default`) edit; others get `MX_MEMBER_ROLE`.
- **Temporary**: the canvas is deleted when everyone has left it for the idle grace. People
  export (PDF, Word, Markdown, `.ocanvas`) to keep it. Persistent canvases are phase 2.
- **Not end-to-end encrypted**, also in encrypted rooms (DESIGN.md §7).

## Parts

- `bridge/`: the OpenCanvas host for Matrix. Node 24, no dependencies.
  `src/server.mjs` (HTTP), `openid.mjs` (token check), `federation.mjs` + `netguard.mjs`
  (server-name resolution with SSRF guard), `room.mjs` (bot reads room state), `launch.mjs`
  (JWT), `bot.mjs` (optional auto-join), `public/` (unstyled widget page).
- `bridge/scripts/add-widget.mjs`: add the widget to a room.
- `bridge/scripts/e2e-synapse.mjs`: end-to-end check against Synapse and OpenCanvas.

## Install

1. **Bot account** on your homeserver (for example `@canvasbot:acme.example`), and an access
   token for it (log in once; keep the token secret). It only reads room state.
2. **OpenCanvas** `hosts.toml`:
   ```toml
   [[host]]
   id              = "acme-matrix"
   name            = "Matrix"
   mode            = "jwt"
   jwt_alg         = "HS256"
   jwt_secret      = "env:ACME_MATRIX_OC_SECRET"     # openssl rand -hex 32
   api_key         = "env:ACME_MATRIX_OC_API_KEY"
   storage         = "ephemeral"
   # The editor is framed by the bridge page inside the Matrix client: list the bridge and
   # every client origin your users use (DESIGN.md §8 gap 1).
   allowed_origins = ["https://canvas-bridge.acme.example", "https://element.acme.example", "https://app.element.io"]
   [host.flags]
   export_formats  = ["md", "html", "docx", "pdf", "ocanvas", "png"]
   ```
3. **Bridge** (behind TLS, at its own origin):
   ```sh
   cd integrations/matrix/bridge
   PORT=8090 \
   MX_PUBLIC_URL=https://canvas-bridge.acme.example \
   OC_URL=https://canvas.acme.example \
   OC_HOST_ID=acme-matrix \
   OC_JWT_SECRET=<same secret as jwt_secret> \
   MX_BOT_HOMESERVER_URL=https://matrix.acme.example \
   MX_BOT_ACCESS_TOKEN=<bot token> \
   MX_ALLOWED_SERVERS=acme.example \
   MX_BOT_AUTOJOIN=1 \
   node src/server.mjs
   ```

   | Variable | Meaning |
   |---|---|
   | `MX_PUBLIC_URL` | where clients load the widget (`<url>/widget`); widget URLs must start with it |
   | `OC_URL` | OpenCanvas as browsers see it |
   | `OC_HOST_ID`, `OC_JWT_SECRET` | the host `id` and `jwt_secret` (≥ 32 characters) |
   | `OC_TOKEN_TTL` | launch token life, 60–3600 s (default 600) |
   | `MX_BOT_HOMESERVER_URL`, `MX_BOT_ACCESS_TOKEN` | the bot's homeserver (Client-Server API base URL) and token |
   | `MX_BOT_USER_ID` | optional; otherwise read with `whoami` |
   | `MX_BOT_AUTOJOIN=1` | join invites from allowed homeservers, leave others |
   | `MX_ALLOWED_SERVERS` | comma list of homeservers whose users may open canvases; empty = any |
   | `MX_PRIVATE_ALLOWED` | server names allowed to resolve to private addresses (intranet) |
   | `MX_FEDERATION_OVERRIDES` | JSON `{"server.name": "https://fixed-url"}`; operator-trusted, skips resolution |
   | `MX_MEMBER_ROLE` | role below `state_default`: `edit` (default), `comment`, `view` |

   Logs carry error codes only; tokens and secrets are never printed.

## Add the canvas to a room

Any of:

- In Element: `/addwidget https://canvas-bridge.acme.example/widget?roomId=$matrix_room_id&wid=$matrix_widget_id`,
  then invite the bot (`/invite @canvasbot:acme.example`).
- Script (invites the bot too):
  ```sh
  MX_HOMESERVER_URL=https://matrix.acme.example MX_ACCESS_TOKEN=<your token> \
  MX_PUBLIC_URL=https://canvas-bridge.acme.example MX_BOT_USER_ID=@canvasbot:acme.example \
  node scripts/add-widget.mjs '!abc:acme.example' "Planning canvas"
  ```
- The state event by hand (Element `/devtools` → Send custom state event):
  ```json
  {
    "type": "im.vector.modular.widgets",
    "state_key": "opencanvas_1a2b3c",
    "content": {
      "type": "m.custom",
      "name": "Planning canvas",
      "url": "https://canvas-bridge.acme.example/widget?roomId=$matrix_room_id&wid=$matrix_widget_id",
      "data": { "title": "Temporary canvas: export to keep a copy" },
      "waitForIframeLoad": true
    }
  }
  ```

Each widget id is its own canvas. **Element `config.json`:** nothing to add; Element has no key
that registers a widget type or pre-trusts a widget URL (DESIGN.md §9).

## Error codes (`POST /api/launch`)

`BAD_REQUEST` 400, `OPENID_INVALID` 401, `SERVER_NOT_ALLOWED` 403, `NOT_MEMBER` 403,
`BOT_NOT_IN_ROOM` 403, `WIDGET_UNKNOWN` 404, `RATE_LIMITED` 429, `HOMESERVER_UNREACHABLE` 502.

## Status: verified vs not yet tested

**Verified** (2026-11-24):

- Unit tests, `cd bridge && npm test` (`node --test`): 18 pass. Address guard (loopback,
  RFC 1918, link-local/metadata, CGNAT, IPv6 ULA/link-local, IPv4-mapped and NAT64 forms);
  server-name grammar; resolution through well-known, SRV and 8448 fallback, and refusal when
  any hop leads to a private address; OpenID success, rejected token, user of another server,
  allow-list refused before any call, over real HTTP; membership denied (invite, leave, ban,
  absent); bot not joined; foreign widget URL; roles from power levels, room v12 creators and
  rooms without power levels; launch claim shape (HS256, `aud`, `iss`, fresh `jti`, stable
  opaque `file.id`, no room id); token never logged. Mutation check: disabling the private
  address guard, the `sub` server check or the membership check makes tests fail.
- End to end against **Synapse (matrixdotorg/synapse:latest, Docker)** and **OpenCanvas 0.1.1**
  (`storage = "ephemeral"`), `scripts/e2e-synapse.mjs`, 11/11: real OpenID tokens from
  Synapse verified through `/_matrix/federation/v1/openid/userinfo`; admin gets `edit`, a
  power-0 member gets `view` (with `MX_MEMBER_ROLE=view`); the minted token is accepted by
  OpenCanvas `/v1/launch` (303 to the editor, ephemeral session for the Matrix user id) and
  refused on replay; non-member, forged token, server outside the allow-list, unknown widget
  id and a bot that left are refused. The bot-left case **failed first** (Synapse answers state
  reads for a departed member with the state at its leave) and is fixed: the bridge now checks
  the bot's own membership.

**Not yet tested:**

- **Element itself**: the widget page in a real Element (consent screen, `capabilities`
  handshake, the OpenID prompt, `openid_credentials` after "request"), and editing in the
  nested frame. `widget.js` follows matrix-widget-api's protocol but has not run against it.
- Real federation: server-name resolution against live `.well-known`/SRV and TLS on 8448
  (covered by unit tests with stubbed DNS only); users from a second homeserver.
- `MX_BOT_AUTOJOIN` loop, `add-widget.mjs` against a live server.
- Element X / mobile clients, other Matrix clients, popped-out widgets.
- The `frame-ancestors` gap (DESIGN.md §8) in a browser.
