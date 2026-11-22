<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas in Jitsi Meet

`mod_opencanvas.lua` opens an OpenCanvas canvas in a Jitsi Meet call, in the shared-document
slot Etherpad uses. No Docker image or compose changes: one Prosody plugin plus `.env` lines.

## How it works

- Jitsi's client opens the `<etherpad>` value of a presence it receives in the shared-document
  iframe, if it resolves to the same origin as `config.etherpad_base`
  (`react/features/etherpad/middleware.ts`).
- The plugin, loaded on the MUC component, rewrites every presence the room delivers so
  `<etherpad>` is `https://canvas.example.com/v1/launch?token=<JWT>`, minted for that recipient
  (docs/05 §3). Other `<etherpad>` elements (Jicofo, clients) are removed.
- Hook: it shadows `room:route_stanza()` per room (on `muc-room-created`). In Prosody's
  `plugins/muc/muc.lib.lua` that is the only per-recipient step: `muc-broadcast-presence` and
  `muc-build-occupant-presence` fire once per broadcast, and `pre-presence/full` only fires for
  stanzas from c2s sessions (`core/stanza_router.lua`). See the comment at the top of the file.
- `file.id` = `jitsi-` + SHA-256 of room JID (includes the tenant) and `meetingId`
  (`mod_muc_meeting_id`): a new meeting with the same name gets a fresh canvas.
- Role: `edit` for moderators and owners, `opencanvas_guest_role` for everyone else.
- User: `id`, `name`, `avatar` from the Jitsi JWT context (`session.jitsi_meet_context_user`),
  else the presence nick and an opaque hash of the JID.
- One token per XMPP session and role, re-minted after half its TTL; a reload or rejoin is a new
  session and gets a new `jti`. Presence is resent on every mute, so per-delivery tokens would
  churn the document URL.
- Signing: HS256 with Jitsi's bundled `luajwtjitsi`; fallback to Prosody's `util.hashes`.
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
   XMPP_MUC_CONFIGURATION=opencanvas_url="https://canvas.example.com",opencanvas_host_id="acme-meet",opencanvas_secret="<hex1>",opencanvas_api_key="<hex2>",opencanvas_guest_role="edit",opencanvas_token_ttl=3600
   ETHERPAD_PUBLIC_URL=https://canvas.example.com/
   ```
   If `XMPP_MUC_MODULES` already has values, append `,opencanvas`.
   Optional: `opencanvas_enabled_rooms="^canvas%-"` (a Lua pattern on the room name; default all).
4. Restart: `docker compose up -d --force-recreate prosody web`
   (`web` picks up `ETHERPAD_PUBLIC_URL`).
5. OpenCanvas `hosts.toml`:
   ```toml
   [[host]]
   id              = "acme-meet"
   name            = "Acme Meet"
   mode            = "jwt"
   jwt_alg         = "HS256"
   jwt_secret      = "env:ACME_MEET_OC_SECRET"     # <hex1>
   api_key         = "env:ACME_MEET_OC_API_KEY"    # <hex2>
   storage         = "ephemeral"                    # no host storage; ends with the room
   allowed_origins = ["https://meet.acme.example"]

   [host.flags]
   export_formats  = ["md", "html", "pdf", "png"]
   ```
   `storage = "ephemeral"` is being added in parallel; until it lands the host needs a
   `callback_base`.

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
    opencanvas_host_id = "acme-meet"
    opencanvas_secret = "<hex1>"
    opencanvas_api_key = "<hex2>"
    opencanvas_guest_role = "edit"
    opencanvas_token_ttl = 3600
```

and in `/etc/jitsi/meet/meet.example.com-config.js`: `config.etherpad_base = 'https://canvas.example.com/';`
Then `systemctl restart prosody`.

## Test checklist

- [ ] Prosody log shows `signing launch tokens with luajwtjitsi (HS256)`, no errors.
- [ ] Two browsers join a room; the shared-document button appears; both open the same canvas.
- [ ] Moderator can edit; a guest gets `opencanvas_guest_role`.
- [ ] Reload one browser and open the document again: it opens (fresh `jti`).
- [ ] Leave and rejoin under the same room name after the room closed: a new, empty canvas.
- [ ] Prosody log shows `OpenCanvas session for … ended (2xx)` when the last person leaves.
- [ ] `grep -i token` in the Prosody log shows no JWT.

## Status: verified vs not yet tested

Verified here:
- Token minting and claim shape: `test/mint_test.lua` (27 checks, Lua 5.4) and
  `crates/oc-server/tests/jitsi_plugin.rs`, which verifies a plugin-minted token with
  OpenCanvas's own `jwt::verify` (and rejects it under a wrong secret). The Rust test skips
  when no Lua 5.3+ is installed; set `OC_LUA` to the interpreter.
- Hook choice read from Prosody 0.12 `plugins/muc/muc.lib.lua`, `core/stanza_router.lua`,
  `plugins/muc/mod_muc.lua`, and jitsi-meet `mod_short_lived_token.lua`,
  `mod_muc_meeting_id.lua`, `react/features/etherpad/middleware.ts`.

Not yet tested against a running Jitsi: the Prosody part (route_stanza shadowing, presence
rewriting, `luajwtjitsi` loading from the custom plugin dir, the room-end DELETE). Whether
Jitsi reloads the iframe when the `<etherpad>` value changes is also unconfirmed.
