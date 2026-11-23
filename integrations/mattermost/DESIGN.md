<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas for Mattermost: design

**Status:** draft, 2026-11-24 (tracker MM-01). The server half is built and unit-tested; the
webapp is a scaffold waiting for UI approval (ADR-011, [UI-SCREENS.md](UI-SCREENS.md)).

Owner request: *Create Canvas in channels, collaborative meeting notes, and an embedded
workspace panel.*

## 1. Research (sources checked 2026-11-24)

Abbreviations: **MM** = `https://github.com/mattermost/mattermost/blob/master`,
**ST** = `https://github.com/mattermost/mattermost-plugin-starter-template/blob/master`.

| Fact | Source |
|---|---|
| Plugin SDK is the Go module `github.com/mattermost/mattermost/server/public`; latest v0.6.1 (2026-11-10, needs Go 1.26.10). The starter template uses v0.6.0 and `min_server_version` 11.7.0. | https://proxy.golang.org/github.com/mattermost/mattermost/server/public/@latest, ST/go.mod, ST/plugin.json |
| `plugin.ClientMain(&Plugin{})`; `Plugin` embeds `plugin.MattermostPlugin`. Hooks: `OnActivate`, `OnConfigurationChange`, `ServeHTTP(c, w, r)`, `ExecuteCommand(c, args)`, `UserHasJoinedChannel`, `UserHasLeftChannel`. | MM/server/public/plugin/client.go, MM/server/public/plugin/hooks.go |
| API: `RegisterCommand`, `KVGet`, `KVSetWithOptions(key, v, PluginKVSetOptions{Atomic, OldValue, ExpireInSeconds})`, `UploadFile(data, channelId, filename)`, `GetFile`, `GetChannelMember`, `GetUsersInChannel`, `GetUser`, `CreatePost`, `GetConfig` (`ServiceSettings.SiteURL`), `LogWarn/LogError`. | MM/server/public/plugin/api.go |
| `ServeHTTP` gets `{subpath}/plugins/{id}/…` with that prefix **stripped**. The server deletes client-sent `Mattermost-User-Id` and sets it only for a valid session (MFA and CSRF checked). It also **removes `Authorization`, `Cookie`, `Referer` and the `access_token` query parameter**. Unauthenticated requests still reach `ServeHTTP` without a user id. A cookie-authenticated non-GET without `X-CSRF-Token` counts as unauthenticated. | MM/server/channels/app/plugin_requests.go |
| Manifest: `id`, `version`, `min_server_version`, `server.executables`, `webapp.bundle_path`, `settings_schema` (types `text`, `number`, `dropdown`, `bool`, `generated`, …; `secret: true` hides the value in the System Console and API). | MM/server/public/model/manifest.go |
| Slash-command autocomplete: `model.NewAutocompleteData`, `AddCommand`, `AddTextArgument`. | MM/server/public/model/command_autocomplete.go |
| Webapp: `registerRightHandSidebarComponent(component, title)` → `{id, showRHSPlugin, hideRHSPlugin, toggleRHSPlugin}` (actions to dispatch); `registerPostTypeComponent(type, component)` (types must start with `custom_`; the component gets `post`); `registerChannelHeaderButtonAction(icon, action, dropdownText, tooltipText)`; `registerFileDropdownMenuAction(match, text, action)`; `registerSlashCommandWillBePostedHook`; `registerWebSocketEventHandler` (plugin events arrive as `custom_{pluginId}_{event}`). | MM/webapp/channels/src/plugins/registry.ts |
| CSP: Mattermost sends `frame-ancestors 'self' <FrameAncestors>; script-src 'self' …` and no `frame-src`, `child-src` or `default-src`. **An iframe to another origin is not blocked**; `FrameAncestors` only controls who may frame Mattermost. `script-src 'self'` means remote scripts cannot load into the Mattermost page, so we use the iframe, not `embed.js`. | MM/server/channels/web/handlers.go |
| Desktop app: navigation inside the window is denied; external windows open in the browser. Permission requests (clipboard write, media) from untrusted origins are refused unless the origin is in `trustedEmbeddedMediaOrigins`. | https://docs.mattermost.com/developers/contribute/more-info/desktop/architecture/navigation, https://github.com/mattermost/desktop/blob/master/src/main/security/permissionsManager.ts |
| Mobile apps do not run webapp plugins; use posts and interactive dialogs. | https://docs.mattermost.com/developers/integrate/plugins/components/mobile |
| Guests: `User.IsGuest()` (role `system_guest`). | MM/server/public/model/user.go |
| Prior art: the Collabora plugin form-POSTs its token into a named iframe from a root component; the Jitsi plugin embeds an iframe. | https://github.com/CollaboraOnline/collabora-mattermost/blob/master/webapp/src/components/wopi_file_preview.tsx, https://github.com/mattermost/mattermost-plugin-jitsi/blob/master/webapp/src/components/conference/conference.tsx |

Not confirmed from a primary source: how mobile renders an unknown `custom_` post type (we set
`Message` as the fallback text); whether a reverse proxy in front of Mattermost limits plugin
request bodies (the server itself does not, apart from CSRF form parsing).

## 2. Architecture

```
 Mattermost web/desktop                    Mattermost server                 OpenCanvas
 ┌───────────────────────┐   /api/v1/*    ┌──────────────────────────┐
 │ webapp plugin          │──────────────▶│ server plugin = the HOST │
 │  post card (custom_)   │ (MM session)  │  membership check → JWT  │
 │  RHS panel  ┌────────┐ │               │  KV: canvas index        │◀─── callbacks /oc/* ───┐
 │             │ iframe │─┼── form POST token ──────────────────────────────────▶ /v1/launch  │
 │             └────────┘ │               │  file store: .ocanvas    │   (HMAC v2 signed)     │
 └───────────────────────┘               └──────────────────────────┘── role / invalidate ──▶│
```

- **The server plugin is the OpenCanvas host** (docs/05). It decides who opens which canvas with
  which role, mints the launch JWT, and stores the file. OpenCanvas stores nothing (ADR-001).
- **Code split.** `server/canvas/` is a Go module with only the standard library: tokens,
  signatures, the index, callbacks and the user API, behind a `Backend` interface. `server/`
  (package `main`) adapts Mattermost's `plugin.API` to `Backend`, registers `/canvas` and the
  channel hooks. Tests run on the core with an in-memory fake.
- **Storage.** Each canvas is a KV record `f:<fileId>` →
  `{id, channelId, title, template, creatorId, postId, version, fileInfoId, history[], size}`;
  `c:<channelId>` → the channel's canvas ids (newest first; compare-and-set). The `.ocanvas`
  bytes are in Mattermost's file store (`UploadFile` to the channel, not attached to a post);
  each save uploads a new file and pushes the previous id into `history` (capped at 50) for
  version history later. Assets: `UploadFile`, bound to their canvas by `a:<fileId>:<assetId>`.
  Idempotency keys: `i:<fileId>:<hash>` → version, expiring after 24 h.
- **File id** = `mm_` + 24 random hex characters. The channel is in the record, not the id.

## 3. Flows

**Create (channel header button, or `/canvas new [title]`).** The plugin checks that the user's
role in that channel is `edit` (member, not a guest without edit, not a bot or deactivated),
creates the record and posts a `custom_opencanvas` card as that user. Props:
`opencanvas_file_id`, `opencanvas_title`, `opencanvas_template`. `Message` is
"Canvas: <title> (open it in Mattermost on the web or desktop)", for mobile, notifications and
search. The webapp opens it in the panel right away.

**Meeting notes (`/canvas notes [title]`, or the create dialog's "Meeting notes").** The same,
with `template = "meeting"` and the default title "Meeting notes YYYY-MM-DD". OpenCanvas has no
per-launch template for host-stored canvases (§8 gap 2), so the first load answers a Markdown
skeleton (Agenda, Notes, Decisions, Action items; docs/05 §5 allows Markdown on load). After
the first save the file is a normal `.ocanvas`.

**Open (card → RHS panel or expanded view).** The webapp POSTs
`/plugins/com.casualoffice.opencanvas/api/v1/canvases/{id}/launch` (session cookie and CSRF
token). The plugin checks membership, computes the role, and mints a fresh token (new `jti`)
with `members` when the channel has ≤ 500 visible members. The webapp form-POSTs `token` to
`<OpenCanvas>/v1/launch` into a named iframe (docs/05 §4 option A), so the token is never in a
URL or the browser history. Non-members and unknown ids get the same `404 NO_ACCESS`.

**Load / save.** OpenCanvas calls `GET/PUT {callback_base}/files/{id}` under
`/plugins/com.casualoffice.opencanvas/oc`. `PUT` honours `If-Match` (409 with the current
version), `Idempotency-Key` (a retry returns the same version) and uses KV compare-and-set so
two concurrent saves can't both win. `POST …/copies` makes "<title> (conflict copy)" in the same
channel with its own card, and answers that post's permalink (`/_redirect/pl/<postId>`).

**People.** Members = channel members minus bots, deactivated users, and guests when guests
have no access. `name` = first and last name (else username), `detail` = "Position · @username".
No e-mail and no avatar: Mattermost's avatar URL needs the viewer's cookie, which the canvas
origin does not send, so OpenCanvas shows initials. `GET …/members?q=&limit=` and
`POST /access` answer from the same rules.

**Access changes.** `UserHasLeftChannel` → `POST /v1/files/{id}/role {"role":"none"}` for every
canvas of the channel (the session closes at once), then `members/invalidate`.
`UserHasJoinedChannel` → `members/invalidate`. Without an API key, access ends when the session
expires.

## 4. Permissions

| Who | Role |
|---|---|
| Channel member (regular user) | `edit` |
| Channel member who is a guest | setting **Guest access**: `none` (default), `view`, `comment` or `edit` |
| Not a member, bot, deactivated, unknown | `none`: no token, `404` |

Only `edit` users can create canvases. Archived channels and public-channel non-members get no
access (joining the channel is the way in). Exports, download and print are on for everyone with
access; `commitMessage` for editors, `mention` for comment and edit.

## 5. Configuration

Plugin settings (System Console → Plugins → OpenCanvas): **OpenCanvas URL**, **OpenCanvas API
URL** (optional, server-to-server), **Host id** (default `mattermost`), **Shared secret**
(`secret`, ≥ 32 characters), **Callback secret** (optional, `secret`), **API key** (`secret`),
**Guest access**, **Launch token lifetime** (minutes, 1-60, default 10). A bad value disables
the endpoints (`503 NOT_CONFIGURED`) and logs the setting's name, never its value.

OpenCanvas `hosts.toml`:

```toml
[[host]]
id              = "mattermost"                       # = plugin "Host id"
name            = "Mattermost"
mode            = "jwt"
jwt_alg         = "HS256"
jwt_secret      = "env:MM_OC_SECRET"                 # = plugin "Shared secret"
api_key         = "env:MM_OC_API_KEY"                # = plugin "API key"
callback_base   = "https://chat.acme.example/plugins/com.casualoffice.opencanvas/oc"
allowed_origins = ["https://chat.acme.example"]      # the Mattermost site URL origin
[host.flags]
on_conflict     = "copy"
autosave_secs   = 60
```

With Mattermost on a subpath (`https://acme.example/chat`), `callback_base` includes it; the
plugin checks signatures against the same path. The Desktop app embeds from the server's origin, so
the same `allowed_origins` entry covers it.

## 6. Security

- **Callbacks are authenticated by the v2 signature only.** Mattermost strips `Authorization`
  before `ServeHTTP` (§1), so the `callbackToken` bearer never reaches the plugin. The plugin
  recomputes `HMAC-SHA256(secret, "<t>.<METHOD>.<subpath>/plugins/<id><path>?<query>.<body>")`,
  compares in constant time, rejects `|now - t| > 5 min` and ignores `v1` (it does not bind the
  method and path). The body is read (≤ 100 MB) before checking. Tests: wrong key, stale,
  future, method swap, path swap, body swap, missing header and v1-only are all `401`.
- **Assets are bound to their canvas** in KV, so a valid signature for one canvas never reads an
  arbitrary Mattermost file by id. Non-image assets and SVG are served as attachments with
  `nosniff` and `CSP: default-src 'none'; sandbox`.
- **User API** trusts only `Mattermost-User-Id`, which Mattermost sets for a valid session and
  strips from clients. The launch is a POST (CSRF-checked by Mattermost), `Cache-Control:
  no-store`, and the token goes into a form, not a URL.
- **Tokens:** HS256, `aud = "opencanvas"`, `iss = host id`, `iat`, `nbf` (−5 s), `exp` = TTL
  (default 10 min, max 60), random 128-bit `jti`. The `callbackToken` inside is still minted
  (file- and user-bound, HMAC with a derived key, 24 h) so it starts working if a future
  Mattermost or OpenCanvas change lets it through (§8 gap 1).
- **No secrets or content in logs:** the plugin logs only setting names, counts and Mattermost
  error messages.
- **Limits:** 100 MB per file, 10 MB per asset, titles one line ≤ 120 characters, member lists
  ≤ 5 000 people read from Mattermost (larger channels are truncated in the @mention list).

## 7. Mobile

Mattermost mobile runs no webapp plugins. On mobile the card is the post's `Message` text. A
later step can add a link that opens the canvas in the system browser through a plugin page
(`/plugins/<id>/open/<fileId>` that launches with the session), listed in UI-SCREENS.md S8.

## 8. Server gaps found (described, not fixed)

1. **Callback auth on hosts that strip `Authorization`.** *Fixed in this branch (MM-01):
   OpenCanvas now also sends `X-OpenCanvas-Callback-Token`; the plugin verifies it when
   present (file-bound, HMAC) and falls back to the signature alone for older servers.* OpenCanvas sends the callback token
   only as `Authorization: Bearer`. Mattermost removes that header, so per-user binding of
   callbacks is lost and the signature is the only proof. Proposal: also send the token in
   `X-OpenCanvas-Callback-Token` (already the header name the patch API reads, docs/05 §7) and
   cover it by the v2 signature.
2. **No per-launch template for `storage = "host"`.** `template` exists only for ephemeral hosts
   and only host-wide. Meeting notes therefore use a Markdown first load, which loses rich
   template features (databases, callouts). Proposal: an optional `file.template` claim applied
   once when the host answers `404` on first load.
3. **Asset URLs for the browser.** The asset `url` we return is the signed callback URL; the
   editor fetches it through OpenCanvas (`/v1/assets/fetch`, signed). To confirm in a live run
   that inline images display without a Mattermost cookie.
4. **Token refresh** (`POST /tokens/refresh`, `Action_RefreshToken`) is documented but not
   implemented in OpenCanvas (DOC-05), so a long-open panel relaunches when its session ends.
