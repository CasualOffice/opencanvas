<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas in Nextcloud

`opencanvas/` is a Nextcloud app (app id `opencanvas`, Nextcloud 30–32, PHP 8.1+). It lets
people create `.ocanvas` files in Files and edit them together in OpenCanvas: rich text,
databases and whiteboards in one file. Nextcloud keeps the files, sharing, permissions and
versions. OpenCanvas does the editing and stores no documents.

- Nextcloud is a **WOPI host** for OpenCanvas, the same way it is one for Collabora through
  Nextcloud Office.
- Design and decisions: [DESIGN.md](DESIGN.md).
- Screens waiting for prototypes: [UI-SCREENS.md](UI-SCREENS.md).

**Status: alpha.**
- The backend works end to end in a real Nextcloud 31 with real browsers (see "Verified").
- Every Nextcloud-side screen is an **unstyled placeholder** until its prototype is approved:
  New-menu entries, file icon, Viewer handler, guest page, Talk, admin page.
- The front-end sources in `src/` are not built yet.

## How it works

1. **Open.** Someone opens an `.ocanvas` file. Nextcloud mints a short-lived access token for
   that person and file, and the page form-POSTs it into an iframe at
   `{opencanvas}/v1/launch?WOPISrc={nextcloud}/index.php/apps/opencanvas/wopi/files/{fileId}`.
2. **Load.** OpenCanvas calls the app's WOPI endpoints:
   - CheckFileInfo returns who the person is and what they may do.
   - GetFile returns the file.
3. **Save.** Saves are PutFile calls. Each save is a normal Nextcloud write, so it shows in
   **Versions** and in Activity under the editor's name.
4. **Conflicts.** If the file changed outside the canvas, OpenCanvas saves a
   "(conflict copy)" next to it (PUT_RELATIVE).
5. **Proof keys.** Every WOPI call carries an RSA proof signed by OpenCanvas. The app checks it
   against OpenCanvas's discovery, so only your OpenCanvas server can read or write files
   through these endpoints. Calls without a valid proof get `500`.
6. **Access checks.** Every call checks access live. When a share is removed or changed, the
   app also calls OpenCanvas's role API, so an open canvas switches to read-only or closes at
   once.
7. **One room per file.** Everyone who opens the same file edits the same live canvas: the room
   id is the WOPISrc.

**Permissions:**

| Nextcloud | In the canvas |
|---|---|
| Owner, or a share with "Can edit" | edit |
| Read-only share | view (read-only, no typing) |
| Share without "Allow download", or a public link with "Hide download" | editing as above, but no export, download or print |
| Share removed | the open canvas closes; opening again is refused |
| Share changed to read-only | the open canvas switches to read-only |

**New files:**
- "New canvas" in the Files **+ New** menu creates an empty file. OpenCanvas opens it on its own
  start screen: blank, database, board, templates, import.
- `POST /apps/opencanvas/api/v1/create` with `kind = blank | database | whiteboard` creates a
  starter file. The "New database" and "New whiteboard" menu entries in `src/files.js` call it.

## Install

You need a running OpenCanvas server. See
[Operations](../../docs/13-OPERATIONS-AND-DEPLOYMENT.md).

**1. OpenCanvas: register Nextcloud as a WOPI host** in `opencanvas.hosts.toml`:

```toml
[[host]]
id              = "nextcloud"
name            = "Nextcloud"
mode            = "wopi"
wopi_allowlist  = ["https://cloud.example.com/index.php/apps/opencanvas/wopi"]
allowed_origins = ["https://cloud.example.com"]
api_key         = "env:NC_OC_API_KEY"      # lets Nextcloud switch open canvases when shares change
[host.flags]
on_conflict     = "copy"
```

Start OpenCanvas with a proof key. It refuses a WOPI host without one:

```sh
openssl genrsa -out proof.pem 2048
OC_WOPI_PROOF_KEY=/path/to/proof.pem NC_OC_API_KEY=$(openssl rand -hex 24) opencanvas
```

**2. Nextcloud: install and enable the app.**

```sh
cp -r opencanvas /var/www/nextcloud/custom_apps/   # or apps/
chown -R www-data: /var/www/nextcloud/custom_apps/opencanvas
occ app:enable opencanvas                 # registers .ocanvas (config/mimetypemapping.json)
occ maintenance:mimetype:update-js        # so the browser knows the type too
```

**3. Configure the app.**

```sh
occ config:app:set opencanvas opencanvas_url --value=https://canvas.example.com
occ config:app:set opencanvas opencanvas_api_key --value=<same as NC_OC_API_KEY> --sensitive
# optional
occ config:app:set opencanvas opencanvas_internal_url --value=http://opencanvas:8080
occ config:app:set opencanvas wopi_base --value=https://cloud.example.com/index.php/apps/opencanvas/wopi
occ config:app:set opencanvas opencanvas_host_id --value=nextcloud
```

| Key | Meaning | Default |
|---|---|---|
| `opencanvas_url` | Where browsers reach OpenCanvas | required |
| `opencanvas_internal_url` | Where Nextcloud reaches OpenCanvas (discovery, role API) | `opencanvas_url` |
| `wopi_base` | The WOPI base OpenCanvas calls. It must be reachable from OpenCanvas and match its `wopi_allowlist`. | `{overwrite.cli.url}/index.php/apps/opencanvas/wopi` |
| `opencanvas_api_key` (sensitive) | The host's `api_key` in OpenCanvas. Without it, share changes take effect only at the next WOPI call or reopen. | empty |
| `opencanvas_host_id` | The host `id` in OpenCanvas | `nextcloud` |
| `allow_public_links` | Guests on public link shares | `true` |
| `allow_comment_role` | Read-only shares with the `opencanvas`/`comment` share attribute get the comment role | `false` |

- The token secret is generated on first use and stored as a sensitive value.
- If Nextcloud runs on a private address (Docker, LAN), also set
  `occ config:system:set allow_local_remote_servers --value=true --type=boolean`. Otherwise
  Nextcloud refuses to fetch discovery from OpenCanvas.

**4. Check the connection.** As an admin, run:

```sh
curl -u admin -X POST -H 'OCS-APIREQUEST: true' https://cloud.example.com/index.php/apps/opencanvas/settings/check
```

It should answer
`{"discovery":true,"ocanvasAction":true,"proofKey":true,"wopiBase":"…"}`.
Put the `wopiBase` it shows into OpenCanvas's `wopi_allowlist`.

**5. Front end:** bundle `src/files.js` and `src/viewer.js` to `js/opencanvas-files.js` and
`js/opencanvas-viewer.js`. This waits for the approved UI. Until then, open a canvas at
`/index.php/apps/opencanvas/open/{fileId}` (an unstyled page holding the editor iframe).

## Verified

All runs on 2026-11-24.

**Real Nextcloud.** Setup:
- Nextcloud: official image `nextcloud:31-apache` (31.0.14) on SQLite in Docker, with this app
  mounted in `custom_apps`.
- OpenCanvas: built from this branch (`cargo build --release -p oc-server`) with a proof key,
  run on the host.
- Browsers: headless Chromium through Playwright, `tests/browser/nextcloud.e2e.mjs`.

| Step | Result |
|---|---|
| `occ app:enable opencanvas` | enabled. The repair step wrote `ocanvas` → `application/vnd.opencanvas+zip`, and WebDAV reports that type for new files. |
| Admin connection check | `{"discovery":true,"ocanvasAction":true,"proofKey":true}` |
| `api/v1/create` blank / database / whiteboard | `201`, files created in the user's Files |
| Open an `.ocanvas` from Nextcloud (logged-in user, `/apps/opencanvas/open/{id}`) | editor loads. CheckFileInfo and GetFile pass the proof check. |
| Edit as the owner | edits |
| Save | autosave writes the `.ocanvas` into Nextcloud (the edit is in the file). The next save adds a Nextcloud version (versions listed 2 → 3). |
| Read-only user share (permissions 1) | opens view-only (`contenteditable=false`) |
| Second user with an edit share | co-edits live: the text reached the owner and the read-only viewer in about 100 ms |
| Share downgraded to read-only while open | the open editor switches to read-only |
| Share removed while open | the open editor loses access. Opening again is refused (`404`). |
| File changed outside the canvas (WebDAV PUT), then a save (`tests/browser/conflict-copy.sh`) | the save answers `409`, and OpenCanvas writes `<name> (conflict copy).ocanvas` into Nextcloud with the edit (PUT_RELATIVE) |

Commands, with the containers and OpenCanvas running as above:

```sh
PLAYWRIGHT=<e2e/node_modules/playwright> NC=http://localhost:8090 NC_PASS_ALICE=… NC_PASS_BOB=… NC_PASS_CAROL=… \
  node opencanvas/tests/browser/nextcloud.e2e.mjs        # RESULT: PASS (3 runs)
NC_PASS_ALICE=… NC_OC_API_KEY=… opencanvas/tests/browser/conflict-copy.sh   # PASS
```

Before the run, setup creates the users `alice`, `bob` and `carol` (`occ user:add`) and turns
off the first-run wizard (`occ app:disable firstrunwizard`). The test then logs in through
Nextcloud's own login page and makes shares through the files_sharing OCS API.

The downgrade and revoke rows failed before the role sync was added (`ShareDeletedEvent` listener plus the
`post_update_permissions` hook, which call `POST /v1/files/{WOPISrc}/role`): "still editable
10 s after the downgrade" and "… after the revoke". They pass with it. Turning the sync off
again (no `opencanvas_api_key`) brings back both failures.

**Without Nextcloud:**
- `php tests/run-without-phpunit.php`: 22 passed. Covers tokens, permission mapping, proof
  verification, UTF-7 conflict names and starter files. PHPUnit is not installed here; the same
  classes run under `phpunit -c phpunit.xml`.
- `OC_BIN=… tests/e2e/run.sh`: PASS. Runs a real OpenCanvas against a `php -S` harness of the
  app's core classes: PutFile, 409 then conflict copy, starters round-trip, unsigned call
  refused.

## Not yet tested

| What | Why |
|---|---|
| Opening from the Files list, Viewer modal, "+ New" menu entries, file icon | Their UI is not approved yet (UI-SCREENS S1–S6). `src/*.js` is not built, so tests open `/apps/opencanvas/open/{id}` directly. |
| Public link guests (incl. password-protected links) | Needs the guest page (S7). The token API exists but has not run in a browser. |
| Talk (share into a conversation, open beside the call) | Needs S9–S11. Talk was not installed in the test container. |
| Group shares, folder shares, federated shares; MySQL/PostgreSQL Nextcloud; Nextcloud 30, 32, 36 | Not run |
| Members list from share recipients, @mention notifications | Not built: OpenCanvas WOPI mode has neither (gap G1 in DESIGN.md) |

## Limits

- **Mentions.** The @mention list is the people who have opened the canvas, not everyone it is
  shared with, and mentions send no Nextcloud notifications (OpenCanvas WOPI mode; DESIGN.md G1).
- **Sessions.** They last at most 10 h, then the canvas relaunches.
- **Images.** Pictures are stored inside the `.ocanvas`: 10 MB per image, 50 MB per file, files
  up to 100 MB.
- **Comment role.** Read-only shares get view, not comment, unless an admin turns on the comment
  role (DESIGN.md §5).
- **Versions.** Each autosave is a version. Nextcloud's version expiry thins them out. Named
  versions are not supported yet (G3).
- **Locks.** None. An outside change to an open file produces a conflict copy.
