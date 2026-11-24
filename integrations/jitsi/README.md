<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas in Jitsi Meet

`mod_opencanvas.lua` opens an OpenCanvas canvas in a Jitsi Meet call, in the shared-document
slot Etherpad uses. No Docker image or compose changes: one Prosody plugin plus `.env` lines.

- Everyone in the meeting opens the same canvas from **Shared document** and edits it live.
- The canvas is **temporary**: nothing is stored by Jitsi or by your host. It is deleted when
  the meeting ends; people download or export (PDF, Word, Markdown, `.ocanvas`) to keep it.
- It starts blank, or from a template you choose (`template = "meeting"`).
- A reload, a dropped network or an OpenCanvas restart rejoins the same canvas.

The integration was introduced in OpenCanvas 0.1.1. Version 0.1.2 improves how role changes
apply to links minted earlier in the meeting. See the [release notes](../../docs/31-RELEASE-v0.1.2.md).

## How it works

- Jitsi's client opens the `<etherpad>` value of a presence it receives in the shared-document
  iframe, if it resolves to the same origin as `config.etherpad_base`
  (`react/features/etherpad/middleware.ts`).
- The plugin, loaded on the MUC component, rewrites every presence the room delivers so
  `<etherpad>` is `https://canvas.example.com/v1/launch?token=<JWT>&ep=`, minted for that recipient.
  Jitsi appends its Etherpad options with `?` as if the URL had no query; `&ep=` gives them a
  parameter of their own so the token stays intact
  (docs/05 §3). Other `<etherpad>` elements (Jicofo, clients) are removed.
- Hook: it shadows `room:route_stanza()` per room (on `muc-room-created`). In Prosody's
  `plugins/muc/muc.lib.lua` that is the only per-recipient step: `muc-broadcast-presence` and
  `muc-build-occupant-presence` fire once per broadcast, and `pre-presence/full` only fires for
  stanzas from c2s sessions (`core/stanza_router.lua`). See the comment at the top of the file.
- `file.id` = `jitsi-` + SHA-256 of room JID (includes the tenant) and `meetingId`
  (`mod_muc_meeting_id`): a new meeting with the same name gets a fresh canvas.
- Role: `edit` for moderators and owners, `opencanvas_guest_role` for everyone else.
  A role that changes later (Jicofo grants moderator a moment after the join, or a moderator
  promotes someone) is sent to OpenCanvas's role API: the open canvas switches at once, and a
  link minted before the change opens with the new role (docs/05 §7).
- With Jitsi's own JWT sign-in, Jicofo makes every signed-in user a moderator, so signed-in
  people edit and guests (joining without a token, `ENABLE_GUESTS=1`) get
  `opencanvas_guest_role`. With `token_affiliation` and `ENABLE_AUTO_OWNER=0`, the token's
  `moderator` claim decides.
- User: `id`, `name`, `avatar` from the Jitsi JWT context (`session.jitsi_meet_context_user`),
  else the presence nick and an opaque hash of the JID.
- One token per XMPP session and role, re-minted after half its TTL; a reload or rejoin is a new
  session and gets a new `jti`. Presence is resent on every mute, so per-delivery tokens would
  churn the document URL.
- Signing: HS256 with Prosody's `util.hashes`. Jitsi's bundled `luajwtjitsi` is not used: in
  stable-11509-1 its signature segment is not standard base64url, so tokens fail to verify.
- Room destroyed: `DELETE /v1/files/{fileId}/session` with `X-OpenCanvas-Host` /
  `X-OpenCanvas-Key`, async; failures are logged and the idle timeout ends the canvas anyway.
- Tokens and secrets are never logged.

## Install (docker-jitsi-meet)

1. Copy the plugin:
   ```sh
   mkdir -p ${CONFIG}/prosody/prosody-plugins-custom
   cp mod_opencanvas.lua ${CONFIG}/prosody/prosody-plugins-custom/
   ```
2. Generate comma-free hex secrets: `openssl rand -hex 32` (twice).
3. Add to `.env` (values must not contain commas; `XMPP_MUC_CONFIGURATION` is split on them):
   ```sh
   XMPP_MUC_MODULES=opencanvas
   XMPP_MUC_CONFIGURATION=opencanvas_url="https://canvas.example.com",opencanvas_api_url="https://canvas.example.com",opencanvas_host_id="acme-meet",opencanvas_secret="<hex1>",opencanvas_api_key="<hex2>",opencanvas_guest_role="edit",opencanvas_token_ttl=3600
   ETHERPAD_PUBLIC_URL=https://canvas.example.com/
   ```
   If `XMPP_MUC_MODULES` already has values, append `,opencanvas`.
   Optional: `opencanvas_enabled_rooms="^canvas%-"` (a Lua pattern on the room name; default all).
   `opencanvas_api_url` is where Prosody calls OpenCanvas when a meeting ends; set it when
   Prosody reaches OpenCanvas at another address than browsers do (default: `opencanvas_url`).
4. Restart: `docker compose up -d --force-recreate prosody web`
   (`web` picks up `ETHERPAD_PUBLIC_URL`).
5. OpenCanvas `hosts.toml`:
   ```toml
   [[host]]
   id              = "acme-meet"
   name            = "Meeting"
   mode            = "jwt"
   jwt_alg         = "HS256"
   jwt_secret      = "env:ACME_MEET_OC_SECRET"     # <hex1>
   api_key         = "env:ACME_MEET_OC_API_KEY"    # <hex2>
   storage         = "ephemeral"                    # no host storage; ends with the meeting
   # template      = "meeting"                      # optional: a built-in template; unset = blank
   allowed_origins = ["https://meet.acme.example"]

   [host.flags]
   export_formats  = ["md", "html", "docx", "pdf", "ocanvas", "png"]
   ```
   Template ids: `meeting`, `standup`, `retro`, `oneonone`, `brainstorm`, `allhands`, and the
   other built-in templates (an unknown id stops OpenCanvas at startup and lists them all).
   See docs/05 §8a.

## Debian packages (jitsi-meet-prosody)

Put the file in a plugin path (for example `/usr/share/jitsi-meet/prosody-plugins/` or a
directory added to `plugin_paths`) and edit `/etc/prosody/conf.d/meet.example.com.cfg.lua`:

```lua
Component "conference.meet.example.com" "muc"
    modules_enabled = {
        -- ... existing modules ...
        "opencanvas";
    }
    opencanvas_url = "https://canvas.example.com"
    opencanvas_api_url = "https://canvas.example.com"
    opencanvas_host_id = "acme-meet"
    opencanvas_secret = "<hex1>"
    opencanvas_api_key = "<hex2>"
    opencanvas_guest_role = "edit"
    opencanvas_token_ttl = 3600
```

and in `/etc/jitsi/meet/meet.example.com-config.js`: `config.etherpad_base = 'https://canvas.example.com/';`
Then `systemctl restart prosody`.

## Test checklist

- [ ] Prosody log shows `signing launch tokens with util.hashes (HS256)`, no errors.
- [ ] Two browsers join a room; the shared-document button appears; both open the same canvas.
- [ ] Moderator can edit; a guest gets `opencanvas_guest_role`.
- [ ] Reload one browser and open the document again: it opens (fresh `jti`).
- [ ] Leave and rejoin under the same room name after the room closed: a new, empty canvas.
- [ ] Prosody log shows `OpenCanvas session for … ended (2xx)` when the last person leaves.
- [ ] `grep -i token` in the Prosody log shows no JWT.

## Status: verified

Tested end to end on 2026-11-23 against a stock docker-jitsi-meet `stable-11509-1` (web,
prosody, jicofo, jvb) with only the plugin file and the `.env` lines above, and OpenCanvas
0.1.x with `storage = "ephemeral"`, driven by two separate browsers (Playwright):

- Prosody loads the module on the MUC component; `config.js` gets `etherpad_base`.
- Each person gets their own token; both open the same canvas from **Shared document**.
- The canvas opens blank (no template picker, no host name), says "Not saved · temporary".
- Text typed by one person appears for the other, both ways.
- A reload rejoins the same canvas with a fresh `jti`.
- When the meeting ends Prosody calls `DELETE …/session` (200) and OpenCanvas deletes the canvas:
  no rows left in the database.
- Restarting OpenCanvas mid-meeting keeps the canvas (`tests/ephemeral.rs`).

Also covered by tests: token minting and claim shape (`test/mint_test.lua`, Lua 5.4), a
plugin-minted token verified by OpenCanvas's own `jwt::verify`
(`crates/oc-server/tests/jitsi_plugin.rs`, skips without Lua 5.3+; set `OC_LUA`).

Jitsi's own JWT sign-in, tested 2026-11-24 (`ENABLE_AUTH=1`, `AUTH_TYPE=jwt`,
`ENABLE_GUESTS=1`, `opencanvas_guest_role="view"`): the signed-in moderator edits and the canvas
shows their name from the Jitsi token; a guest without a token gets view with the view-only
notice and sees the moderator's text live. Before the role push the moderator opened as view,
because their link was sent before Jicofo made them a moderator (fixed; see Role above).

Not tested yet: Debian-package installs and multi-shard deployments.
