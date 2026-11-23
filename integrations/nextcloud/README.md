<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas in Nextcloud (alpha scaffold)

`opencanvas/` is a Nextcloud app (id `opencanvas`, Nextcloud 30–32, PHP 8.1+). It makes
Nextcloud a **WOPI host** for OpenCanvas, the same way Nextcloud Office is one for Collabora.
Nextcloud keeps the `.ocanvas` files, permissions and versions; OpenCanvas edits them live and
stores nothing. Design: [DESIGN.md](DESIGN.md). Screens to prototype: [UI-SCREENS.md](UI-SCREENS.md).

**Status: backend scaffold, not installed in a real Nextcloud yet.** The UI is unstyled
placeholders and the front-end sources in `src/` are not built.

## Verified vs not yet tested

| Verified (2026-11-24) | How |
|---|---|
| Token creation/validation (expiry, file binding, tampering, other secret), permission mapping, proof-key verification (current/old/rotated keys, stale timestamp, other URL/token/time), discovery key parsing, UTF-7 conflict names, starter files | `php tests/run-without-phpunit.php`: 22 passed on PHP 8.5 (PHPUnit itself not installed here; the same test classes run under `phpunit -c phpunit.xml`) |
| A real OpenCanvas server (release build of 2026-11-23, WOPI mode, proof keys on) against the app's token, proof, permission, conflict and starter code: launch, edit vs view, every call's proof accepted, PutFile, 409 then PUT_RELATIVE copy, database and whiteboard starters open and round-trip, unsigned call refused | `OC_BIN=…/opencanvas opencanvas/tests/e2e/run.sh`: PASS. It runs `tests/e2e/harness.php` under `php -S`, **not** Nextcloud |
| All PHP files parse | `php -l` |

**Not yet tested:**
- Installing the app in Nextcloud. Nothing has been run there: `info.xml` validation, DI wiring,
  routes, controllers, OCP calls such as `getFirstNodeById`, `setVolatileActiveUser` and share
  attributes, the repair step, the admin settings page, or CSP on the editor page. No container
  was run (Docker was available, but the disk was 97 % full and image downloads were not
  approved in this session).
- Public link guests, including the password-protected link session key
  (`public_link_authenticated_token`).
- Talk.
- Nextcloud versions and the activity entry.
- `src/files.js` and `src/viewer.js` (no bundler config; never built).
- Nextcloud 36 (Viewer moved into server).

## Install (for testing)

1. **OpenCanvas**, `opencanvas.hosts.toml` (docs/05 §6):
   ```toml
   [[host]]
   id              = "nextcloud"
   name            = "Nextcloud"
   mode            = "wopi"
   wopi_allowlist  = ["https://cloud.example.com/index.php/apps/opencanvas/wopi"]
   allowed_origins = ["https://cloud.example.com"]
   [host.flags]
   on_conflict     = "copy"
   ```
   Set `OC_WOPI_PROOF_KEY` to a 2048-bit RSA key. Proof keys are required, and the app refuses
   calls without them.
2. **Nextcloud**:
   ```sh
   cp -r opencanvas /var/www/nextcloud/apps/
   occ app:enable opencanvas          # runs the MIME repair step
   occ maintenance:mimetype:update-js # after the alias is added
   occ config:app:set opencanvas opencanvas_url --value=https://canvas.example.com
   # optional: where Nextcloud reaches OpenCanvas for discovery, and the WOPI base OpenCanvas calls
   occ config:app:set opencanvas opencanvas_internal_url --value=http://opencanvas:8080
   occ config:app:set opencanvas wopi_base --value=https://cloud.example.com/index.php/apps/opencanvas/wopi
   ```
   The WOPI base must be reachable from OpenCanvas and must match its `wopi_allowlist`.
   `POST /apps/opencanvas/settings/check` (as an admin) reports whether discovery, the `.ocanvas`
   action and the proof key are present.
3. **Front end**: bundle `src/files.js` and `src/viewer.js` to `js/opencanvas-files.js` and
   `js/opencanvas-viewer.js` (not set up yet; it waits for the approved UI).

Unit tests: `php opencanvas/tests/run-without-phpunit.php`, or `phpunit -c opencanvas/phpunit.xml`.
