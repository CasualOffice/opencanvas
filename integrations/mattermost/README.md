<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas in Mattermost

A Mattermost plugin that adds collaborative canvases to channels:

- **Create a canvas** from the channel header or with `/canvas new [title]`. A card is posted in
  the channel; everyone in the channel can open it and edit it live.
- **Meeting notes** with `/canvas notes [title]`: a canvas that starts with Agenda, Notes,
  Decisions and Action items.
- **Workspace panel:** canvases open in the right-hand sidebar, or expanded.
- **Stored in Mattermost.** The plugin is the OpenCanvas *host*: it keeps the `.ocanvas` file in
  Mattermost's file store and its index in the plugin KV store. OpenCanvas keeps nothing.
- **Access follows the channel.** Members edit; guests get the role you choose (default none);
  leaving the channel ends access at once.

Design and security: [DESIGN.md](DESIGN.md). Screens awaiting design: [UI-SCREENS.md](UI-SCREENS.md).

> The webapp is a scaffold: cards and the panel render plain placeholders until the screens
> are designed and approved. The server half is complete.

## Requirements

- Mattermost 9.11 or later (web or Desktop app; mobile shows the card as text).
- OpenCanvas 0.1.x reachable from browsers and from the Mattermost server.
- Go 1.24.3+ and Node 20+ to build.

## Build

```sh
integrations/mattermost/build.sh        # tests, Linux binaries, webapp, then the bundle
# -> integrations/mattermost/dist/com.casualoffice.opencanvas-0.1.0.tar.gz
```

The server half alone: `cd server/canvas && go test ./...` and `cd server && go test ./... && go build .`.

## Install

1. Generate two secrets: `openssl rand -hex 32` (shared secret) and `openssl rand -hex 32`
   (API key).
2. Mattermost: **System Console → Plugins → Plugin Management → Upload Plugin**, choose the
   `.tar.gz`, then enable **OpenCanvas**. (Needs `PluginSettings.EnableUploads`; or use
   `mmctl plugin add`.)
3. **System Console → Plugins → OpenCanvas:**
   - OpenCanvas URL: `https://canvas.example.com`
   - OpenCanvas API URL: only if the Mattermost server reaches OpenCanvas at another address
   - Host id: `mattermost`
   - Shared secret: the first secret
   - API key: the second secret
   - Guest access: `No access` (or View, Comment, Edit)
   - Launch token lifetime: 10
4. OpenCanvas `hosts.toml` (restart OpenCanvas after):
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
   `callback_base` is your Mattermost Site URL (with its subpath, if any) +
   `/plugins/com.casualoffice.opencanvas/oc`. Mattermost needs no CSP change: it sends no
   `frame-src`, so the OpenCanvas iframe is allowed.
5. In a channel: `/canvas new Sprint 42`, then open the card.

## Endpoints

| Path (under `/plugins/com.casualoffice.opencanvas`) | Caller | Auth |
|---|---|---|
| `GET/PUT /oc/files/{id}`, `POST /oc/files/{id}/copies`, `POST/GET /oc/files/{id}/assets[/{assetId}]`, `GET /oc/files/{id}/members`, `POST /oc/access` | OpenCanvas | `X-OpenCanvas-Signature` v2 |
| `POST /api/v1/canvases`, `POST /api/v1/canvases/{id}/launch`, `GET /api/v1/channels/{id}/canvases`, `GET /api/v1/canvases/{id}/assets/{assetId}` | webapp | Mattermost session |

## Test checklist (live)

- [ ] Plugin enables without errors; with a bad setting the log names the setting only.
- [ ] `/canvas new Test` posts a card; a second member opens it; edits appear for both.
- [ ] `/canvas notes` opens with the meeting sections.
- [ ] Edits survive closing the panel and reopening (a `.ocanvas` file appears in the channel's
      file storage, version grows on each save).
- [ ] A non-member who gets the post link cannot open the canvas (404).
- [ ] Removing a member from the channel closes their open canvas at once.
- [ ] A guest gets the configured role.
- [ ] Images pasted into the canvas show after a reload.
- [ ] `grep -iE 'token|secret'` in the Mattermost log shows no values.

## Status: verified vs not yet tested

Verified here (2026-11-24, Go 1.24.4, macOS):

- `cd server/canvas && go test ./...`: 13 tests pass: token claims (iss, aud, exp, jti, file,
  user, members without bots, guests or outsiders, no e-mail), callback-token binding, the
  membership → role rules, the signature against OpenCanvas's own reference vector
  (`host_client.rs`), refusal of missing, stale, future, wrong-key, method-, path- and body-
  swapped and v1-only signatures, subpath signatures, load/save with `If-Match` 409 and
  `Idempotency-Key` retry, the meeting-notes seed, members and `/access`, assets scoped to their
  canvas, conflict copies, and live revocation on leaving a channel. Disabling the signature
  check makes `TestCallbacksRejectBadSignatures` fail.
- `cd server && go vet ./... && go test ./... && go build .`: the Mattermost adapter compiles
  against `server/public` v0.1.15; slash-command parsing and autocomplete tests pass.

Not yet tested:

- **No run inside a real Mattermost server**, and no end-to-end run against OpenCanvas (launch,
  load, save, assets through `/v1/assets/fetch`).
- The webapp has not been built or type-checked (no `npm install` was run); it is a placeholder.
- Mattermost behaviour taken from source, not observed: prefix stripping in `ServeHTTP`, the
  `Authorization` header removal, `KVSetWithOptions` atomic semantics with a nil old value,
  orphan (post-less) uploads being kept, mobile fallback rendering.
- Built with SDK v0.1.15 (Go 1.24); the current SDK v0.6.1 needs Go 1.26.10. Upgrade before
  release, and confirm `min_server_version`.
- Desktop app clipboard and fullscreen inside the iframe; large channels (> 500 members).
