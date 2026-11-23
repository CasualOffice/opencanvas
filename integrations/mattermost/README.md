<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas in Mattermost

A Mattermost plugin that adds collaborative canvases to channels:

- **Create a canvas** from the channel header or with `/canvas new [title]`. A card is posted in
  the channel, and everyone in the channel can open it and edit it live.
- **Meeting notes** with `/canvas notes [title]`: a canvas that starts with Agenda, Notes,
  Decisions and Action items.
- **Workspace panel:** canvases open in Mattermost's right-hand panel, which can be expanded.
- **Stored in Mattermost.** The plugin is the OpenCanvas *host*. It keeps each `.ocanvas` file
  in Mattermost's file store and the list of canvases in the plugin key-value store. OpenCanvas
  keeps nothing once a canvas is closed.
- **Access follows the channel.** Channel members edit. Someone who leaves the channel loses
  access at once, even with the canvas open. Guests get the role you choose (default: none).

> **Status: alpha.** The server plugin is complete and was tested end to end in Mattermost
> 12.1.0. The webapp follows the screens approved on 2026-11-24 (MM-02): the card, the panel and
> its states, the create dialog and the slash replies; they follow your Mattermost theme. New
> canvases open on the page, not the template picker (the plugin sends `"start": "page"`).
> Design and security details: [DESIGN.md](DESIGN.md).

## How it works

1. **Create.** The plugin checks that you can edit in the channel, saves a canvas record and
   posts a `custom_opencanvas` card as you. Mobile apps, notifications and search show the
   card's text: "Canvas: <title> (open it in Mattermost on the web or desktop)".
2. **Open.** Clicking **Open** asks the plugin for a launch token. The plugin checks that you
   are a channel member and signs a short-lived token (HS256, 10 minutes by default, single use)
   with your name, the channel's members and your role. The panel posts the token to OpenCanvas
   in a form, so it never appears in a URL.
3. **Load and save.** OpenCanvas calls the plugin back under
   `/plugins/com.casualoffice.opencanvas/oc`: `GET` to load the file, `PUT` to save it (autosave),
   plus assets, members and conflict copies. Each save is a new file in the channel's file
   storage; the plugin keeps the version and the last 50 saves.
4. **Callback security.** The plugin accepts a callback only with a valid
   `X-OpenCanvas-Signature` v2 (HMAC-SHA256 over time, method, path, query and body, within 5
   minutes). Mattermost removes the `Authorization` header before a plugin sees a request, so
   OpenCanvas also sends the callback token as `X-OpenCanvas-Callback-Token` (OpenCanvas releases after
   0.1.1); the plugin checks that it belongs to the same canvas. Mattermost also re-sorts the
   query string, which the plugin allows for.
5. **Access changes.** When someone leaves a channel, the plugin tells OpenCanvas (role API,
   `none`), which closes their open canvas at once. When someone joins, the @mention list is
   refreshed.

| Who | Role in the channel's canvases |
|---|---|
| Channel member | edit |
| Guest account that is a channel member | the **Guest access** setting: none (default), view, comment or edit |
| Anyone else, bots, deactivated accounts | none: no token, the card says "You don't have access" |

In a **public channel**, any team member can join, and Mattermost joins them automatically when
they open the channel. Joining gives edit access, the same as reading and posting. Use a private
channel for canvases that only some people may edit.

## Requirements

- Mattermost 9.11 or later (tested: 12.1.0 Team Edition), web or Desktop app.
- OpenCanvas 0.1.x, reachable from browsers and from the Mattermost server. Releases after 0.1.1 also
  send the callback token header (older versions work with signature-only checks).
- To build: Go 1.24.3 or later, Node 20 or later.

## Build

```sh
integrations/mattermost/build.sh        # tests, Linux binaries (amd64, arm64), webapp, bundle
# -> integrations/mattermost/dist/com.casualoffice.opencanvas-0.1.0.tar.gz
```

Parts: `cd server/canvas && go test ./...`, `cd server && go test ./...`,
`cd webapp && npm ci && npm run check && npm run build && npm test`.

## Install

1. Generate two secrets: `openssl rand -hex 32` (shared secret) and `openssl rand -hex 32`
   (API key).
2. Install the bundle: **System Console → Plugins → Plugin Management → Upload Plugin**
   (needs `PluginSettings.EnableUploads`), or `mmctl plugin add <bundle>.tar.gz`. Then enable
   **OpenCanvas**.
3. Fill in the plugin settings (below).
4. Add Mattermost to OpenCanvas `hosts.toml` (below) and restart OpenCanvas.
5. In a channel: `/canvas new Sprint 42`, then click **Open** on the card.

### Plugin settings

**System Console → Plugins → OpenCanvas:**

| Setting | Value |
|---|---|
| OpenCanvas URL | `https://canvas.example.com` (what browsers open) |
| OpenCanvas API URL | only if the Mattermost server reaches OpenCanvas at another address |
| Host id | `mattermost` |
| Shared secret | the first secret |
| Callback secret | empty, unless `hosts.toml` sets `callback_secret` |
| API key | the second secret |
| Guest access | No access, View, Comment or Edit |
| Launch token lifetime | 10 (minutes, 1 to 60) |

A wrong value turns the plugin's endpoints off (`503 NOT_CONFIGURED`) and the server log names
the setting, never its value.

### OpenCanvas hosts.toml

```toml
[[host]]
id              = "mattermost"
name            = "Mattermost"
mode            = "jwt"
jwt_alg         = "HS256"
jwt_secret      = "env:MM_OC_SECRET"      # the shared secret
api_key         = "env:MM_OC_API_KEY"     # the API key
callback_base   = "https://chat.acme.example/plugins/com.casualoffice.opencanvas/oc"
allowed_origins = ["https://chat.acme.example"]
[host.flags]
on_conflict     = "copy"
```

`callback_base` is your Mattermost Site URL, with its subpath if it has one, followed by
`/plugins/com.casualoffice.opencanvas/oc`. Mattermost needs no CSP change: it sends no
`frame-src`, so the OpenCanvas frame is allowed.

## Endpoints

| Path under `/plugins/com.casualoffice.opencanvas` | Caller | Authentication |
|---|---|---|
| `GET` and `PUT /oc/files/{id}`, `POST /oc/files/{id}/copies`, `POST /oc/files/{id}/assets`, `GET /oc/files/{id}/assets/{assetId}`, `GET /oc/files/{id}/members`, `POST /oc/access` | OpenCanvas | `X-OpenCanvas-Signature` v2, plus `X-OpenCanvas-Callback-Token` when sent |
| `POST /api/v1/canvases`, `POST /api/v1/canvases/{id}/launch`, `GET /api/v1/channels/{id}/canvases`, `GET /api/v1/canvases/{id}/assets/{assetId}` | Mattermost webapp | Mattermost session |

## Limits

- 100 MB per canvas file, 10 MB per image or attachment.
- Titles: one line, at most 120 characters.
- The launch token lists up to 500 members; larger channels use the members callback, which
  reads up to 5,000 people.
- Mobile apps show the card as text only (Mattermost mobile runs no plugin UI).
- The Desktop app may refuse clipboard writes from the canvas frame unless the OpenCanvas origin
  is trusted in the Desktop app settings.
- Each save keeps a new file in Mattermost's file storage. The plugin remembers the last 50 per
  canvas; older files are not deleted yet.
- Guest accounts need a Mattermost license (not available in Team Edition).

## Test checklist

- [ ] The plugin enables without errors.
- [ ] `/canvas new Test` posts a card; a second member opens it; edits appear for both.
- [ ] `/canvas notes` opens with Agenda, Notes, Decisions and Action items.
- [ ] After closing and reopening, the edits are still there (`.ocanvas` files appear in the
      channel's storage).
- [ ] Removing a member from the channel closes their open canvas.
- [ ] Someone outside a private channel cannot open its canvas.
- [ ] `grep` for the shared secret in the Mattermost and OpenCanvas logs finds nothing.

## Status: verified vs not yet tested

**Verified in a real Mattermost (2026-11-24):** Mattermost Team Edition 12.1.0 (official image,
amd64 emulated on Apple silicon) with PostgreSQL 16, OpenCanvas built from this branch, and two
signed-in browser users (Playwright, Chromium). Compose file: `e2e/docker-compose.yml`.

- The bundle installs with `mmctl plugin add` and enables. Settings were applied with
  `mmctl config patch`.
- Create through the plugin API: `201`, with a `custom_opencanvas` card posted in the channel for
  both a canvas and meeting notes. A non-member trying to create gets `403 NO_ACCESS`.
- Launch: `200`, `Cache-Control: no-store`. The token has `iss mattermost`, `aud opencanvas`,
  role `edit`, a 600 s lifetime, a 32-character `jti`, user `Alice Doe` / `@alice`, the channel
  as context, and the channel members. OpenCanvas accepts it (`303`); replaying the same token is
  refused (`401`). A non-member's launch gets `404 NO_ACCESS`.
- In the browser: the card's **Open** opens the panel with the editor. Text typed by one user
  shows up for the second user live, and the second user sees the first by name. Meeting notes
  open with their sections. Switching from one canvas to another in the panel works.
- Callbacks, recorded by a pass-through between OpenCanvas and Mattermost:
  - `GET` and `PUT /oc/files/{id}` and `GET …/members` reached the plugin with
    `x-opencanvas-signature` and `x-opencanvas-callback-token` and were answered `200`.
  - Autosave versions 1 and 2 were stored as `.ocanvas` files in the channel's file storage.
- Bad callbacks are refused with `401`: wrong key, a timestamp 10 minutes old, no signature, a
  v1-only signature, and a forged callback token.
- Removing a member from the channel while their canvas was open: OpenCanvas logged "role changed
  by host … none" and their editor showed the loss of access within seconds.
- Neither log contains the shared secret.

Bugs that run found, now fixed:

- Mattermost re-sorts the query string, so the members callback failed its signature check
  (`TestSignatureSurvivesQueryReordering`, seen failing first).
- The webapp bundle loaded its own `react` instead of Mattermost's (`npm test` bundle check, seen failing first).
- Switching canvases in the panel did nothing. Fixed in the placeholder panel with one stable
  frame name; checked in the browser run, no unit test.

**Unit tests:** `server/canvas` 15 tests (token claims, signatures against OpenCanvas's own
reference vector, membership roles, load/save with `If-Match` and `Idempotency-Key`, assets
scoped to their canvas, conflict copies, revocation, the callback token header);
`server` 2 tests; OpenCanvas `callback_token_also_sent_in_its_own_header`.

**MM-02 webapp, verified 2026-11-24** in Mattermost 12.1.0 with two signed-in users in the light
theme (`e2e/setup.sh`, then `MAIN_ONLY=1 node e2e/mm-e2e.mjs`, 13/13): the App Bar's Create canvas
opens the dialog (placeholder "Untitled canvas", meeting notes default title, the channel note,
busy Create); the new canvas opens in the panel on its page with no template picker; the second
user sees the card (title, "Canvas · Edited …", Open on the title row, the menu with Download
greyed "Later"), Copy link without clipboard permission shows the link selected, clicking the card
body opens the panel, the card gets its ring, and the first user's text shows live; the canvas
follows the Mattermost theme. Screenshots: `docs/prototypes/mattermost-approved/real-host/`.
Built but not checked in the real host: the dark theme, S2 error states (no access, not set up,
unreachable, closed + Reopen), expanded view, rename, `/canvas notes` opening the panel, the
channel canvases list (S4), the System Console help text (S6) and the Desktop app (S7).

**Not yet tested:**

- **Guest accounts.** Team Edition has no guests ("Your license does not support guest
  accounts"). The guest rules are unit-tested only.
- **A non-member in the browser.** Public channels add the visitor automatically, so this was
  tested through the API (`404`), not with a private channel in the browser.
- Images and attachments in a canvas, conflict copies and very large channels, in a real run.
- The channel header button: it works through the same create API, but it was not clicked.
- Mattermost Desktop, mobile, a subpath Site URL, high availability.
- Upgrading to the current plugin SDK (v0.6.x needs Go 1.26); built with v0.1.15.
