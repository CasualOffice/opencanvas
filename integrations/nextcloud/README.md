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
- Screens: [UI-SCREENS.md](UI-SCREENS.md); approved prototype in
  `docs/prototypes/nextcloud-approved/`, with screenshots of the built app in its `screenshots/`.

**Status: alpha.**
- The backend and the approved screens S1-S8, S12 and S13 work end to end in a real Nextcloud 31
  with real browsers (see "Verified").
- Talk screens (S9-S11) are not built: canvases shared into Talk open through the Viewer handler,
  with no Talk-specific card or message action yet.

*Nextcloud is a registered trademark of Nextcloud GmbH. Mattermost is a trademark of Mattermost, Inc. OpenCanvas is an independent open-source project, not affiliated with or endorsed by either company.*

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

**In Files:**
- Clicking a canvas opens it in Nextcloud's **Viewer**; the row's "…" menu has **Open in full
  page** (`/apps/opencanvas/open/{id}`, with a bar back to the folder, Share and Download).
- The **+ New** menu has, after a separator: **New canvas** (Nextcloud's own name dialog and
  template picker; OpenCanvas opens it on its start screen), **New database canvas** and **New
  whiteboard canvas** (our name dialog, then `POST api/v1/create` with `kind`). The file opens as
  soon as it is created.
- `.ocanvas` files show the indigo canvas icon.
- The Sharing tab shows what each share level means in a canvas. With the admin's comment switch
  on, a view-only share's advanced settings get **Can comment in OpenCanvas**.
- **Public links** to a canvas open it under Nextcloud's public header. Guests on edit links give
  a name first (kept in the browser); view-only guests open at once as "Guest".
- When a canvas can't open (not set up, OpenCanvas down, proof rejected, over 100 MB, no access,
  not found, links turned off) a Nextcloud screen says what happened and what to do; admins get
  the fix.

**In Nextcloud search (SRCH-05, ADR-065).** Canvases appear in the unified search (the
magnifier in the header) under **Canvases**:
- Every save of an `.ocanvas` (OpenCanvas's PutFile, a conflict copy, an upload, a WebDAV PUT,
  a copy) carries `search.json`, the canvas's plain text with block ids. The app reads it into
  its own table `oc_opencanvas_search` (text only; deleted with the file). This is Nextcloud's
  index: OpenCanvas keeps none. Files saved before OpenCanvas 0.3 have no `search.json` and are
  indexed on their next save.
- Results are only files the person can open in Nextcloud, checked at search time, so a removed
  share hides a canvas at once. A result shows the canvas title, the matching text, its heading
  and its folder, and opens the canvas on the full page at the matching block (`#block=<id>`,
  sent to the editor as `Action_ScrollToBlock` once it has loaded).
- `occ opencanvas:search-index [user…]` indexes existing canvases (run once after an upgrade).
- Comments are in `search.json` only when OpenCanvas's `[host.search] comments = true`.

## Install

Use an OpenCanvas 0.1.2 server for the features described in this guide. See
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

**4. Check the connection.** Open **Administration > OpenCanvas**: enter the address (and the
internal address and API key), save, copy the WOPI base into `wopi_allowlist`, and the
connection check runs its four steps (OpenCanvas answers, opens `.ocanvas`, publishes a proof
key, accepts this Nextcloud) with the fix for any failing one. Or, from a shell:

```sh
curl -u admin -X POST -H 'OCS-APIREQUEST: true' https://cloud.example.com/index.php/apps/opencanvas/settings/check
```

It should answer `{"ok":true,"steps":[…],"discovery":true,"ocanvasAction":true,"proofKey":true,
"accepts":true,"wopiBase":"…"}`. Put the `wopiBase` it shows into OpenCanvas's `wopi_allowlist`.

**5. Front end.** The app's screens are built with Nextcloud's standard tooling
(`@nextcloud/vite-config`, Vue 2.7, `@nextcloud/vue` 8, `@nextcloud/files` 3). Build before
installing from git; `js/` is not committed, as for other app-store apps:

```sh
cd opencanvas && npm ci && npm run build   # writes js/opencanvas-{files,viewer,fullpage,public,admin}.mjs
npm test                                   # JS unit tests (vitest)
```

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

**The screens (NC-02), 2026-11-24.** Same setup, the front end built with `npm run build`.
`tests/browser/nextcloud-ui.e2e.mjs` drives them from the Files list in light and dark and saves
screenshots to `docs/prototypes/nextcloud-approved/screenshots/<frame>-<theme>.png`:

| Step | Result |
|---|---|
| Files list (S2b) | `.ocanvas` rows show the canvas icon |
| + New (S1a) | "New canvas", "New database canvas", "New whiteboard canvas" last, after a separator |
| Name dialog (S1c-S1e) | default name selected without the extension; a clash and a "/" are refused in plain words, Create disabled; creating opens the canvas in the Viewer |
| "New canvas" | Nextcloud's own dialog creates the file and it opens in the Viewer |
| Click a canvas (S4a, S4b) | spinner, then OpenCanvas in the Viewer; an edit lands in the Nextcloud file |
| Row "…" (S6b) -> full page (S5a, S5e) | tab "Q1 launch plan - OpenCanvas - Nextcloud", "Files" back to the folder; phone layout moves Share into "…" |
| Full page "Share" (S5c, S8a) | opens the Files sidebar on Sharing, with "What this means in a canvas" |
| Unknown id (S5d) | "This canvas isn't available", tab "Canvas not found - OpenCanvas - Nextcloud" |
| 101 MB file (S13f) | "too large … this one is 101 MB", Download |
| OpenCanvas unreachable (S4g) | "Can't reach OpenCanvas", Try again |
| Not set up (S4h, S4i, S12a) | users: calm message; admins: "Open admin settings"; admin page: "Not connected yet" |
| Admin page (S12h, S12i, S12b) | an address without a scheme is refused before saving; Save, toast, check runs: 4 steps OK |
| Check failures (S12f, S12c) | WOPI base not on the allow-list: step 4 fails with the `wopi_allowlist` line; internal address dead: step 1 fails, the rest skipped |
| End all sessions (S12g) | asks first |
| "Can comment" (S8b) | with the admin switch on, the checkbox is in a view-only share's advanced settings and saves `opencanvas`/`comment` = true |
| Edit link (S7b, S7c) | name prompt, then the guest edits; the name is remembered on reload |
| View-only link (S7d) | no prompt, read only |
| Password link (S7a) | Nextcloud's password page, then the canvas. Before this change the app read an old session key (`public_link_authenticated_token`) and refused every unlocked link; Nextcloud 31 stores `public_link_authenticated_frontend` |
| Links turned off (S7f) | "This canvas can't be opened from a link … Ask alice to share it" |

```sh
npm run build
THEMES=light,dark PLAYWRIGHT=<e2e/node_modules/playwright> NC=http://localhost:8090 \
  NC_PASS_ADMIN=… NC_PASS_ALICE=… NC_PASS_BOB=… OC_PUBLIC=http://localhost:8480 \
  OC_INTERNAL=http://host.docker.internal:8480 node opencanvas/tests/browser/nextcloud-ui.e2e.mjs
```

Unit tests: `php tests/run-without-phpunit.php` 40 passed (adds launch errors, the public-link
password check and the connection-check report); `npm test` 51 passed (names, error screens,
postMessage bridge, admin validation, guest names, file icon).

**Search (SRCH-05), 2026-11-26.** No Nextcloud container was available for this change, so
the Nextcloud glue (the migration, `IndexCanvasListener`, `SearchIndexService`,
`CanvasSearchProvider`, the `occ` command) is checked with `php -l` only. The framework-free
part is unit-tested: `php tests/run-without-phpunit.php` 46 passed (adds `SearchTextTest`:
reading `search.json` from a real zip, older and foreign files skipped, every-word matching with
the block, heading trail, accents and case, the title-only result, 5,000-line and 2 MB limits,
snippets); `bridge.test.js` covers `#block=` → `Action_ScrollToBlock`.

Manual test, with the containers and OpenCanvas 0.3 running as under **Verified**:

1. `occ app:enable opencanvas` (or `occ upgrade` from 0.1.0): `oc_opencanvas_search` exists.
2. As alice, create a canvas, type "Quarterly SSO rollout" under a heading "Release 4.2", wait
   for "Saved". In Nextcloud's database, `oc_opencanvas_search` has one row for the file id.
3. Header search "sso rollout": **Canvases** lists it with "Quarterly SSO rollout · Release 4.2";
   clicking opens the full page and the block flashes.
4. As bob (no share): the same search shows nothing. Share it read-only with bob: it shows.
   Remove the share: it is gone at once.
5. Delete the file: its row is gone. `occ opencanvas:search-index alice` on an old canvas after
   one save: "Indexed 1 canvases".

## Not yet tested

| What | Why |
|---|---|
| Talk (S9-S11: file card, link card, open beside the call, new canvas in a conversation) | Not built. Talk was not installed in the test container. |
| Proof rejected (S13d/e), access removed / deleted / conflict while open (S4e, S4f, S4l), session ending (S4j/k) | The Nextcloud side is unit-tested; these states were not driven in this run |
| Template picker with `.ocanvas` templates (S3) | Stock Nextcloud; without templates it skips the picker (S3c moot), as checked in Nextcloud 31's code |
| Group shares, folder shares, federated shares; MySQL/PostgreSQL Nextcloud; Nextcloud 30, 32, 36 | Not run |
| Members list from share recipients, @mention notifications | Not built: OpenCanvas WOPI mode has neither (gap G1 in DESIGN.md) |

## Limits

- **Viewer header.** Nextcloud's Viewer "…" menu can't take app entries, so "Open in full page" is
  in the Files row menu only; "View only"/"Download off" badges are in OpenCanvas's own bar.
- **File icon.** Nextcloud only resolves file-type icons from `core/img/filetypes`. The app shows
  its icon in the browser (Files, Viewer, public pages) without writing into core; places Nextcloud
  renders on the server (emails, activity) show the generic document icon.
- **Full page Share.** It opens the Files sidebar in Files (not beside the full-page canvas).

- **Mentions.** The @mention list is the people who have opened the canvas, not everyone it is
  shared with, and mentions send no Nextcloud notifications (OpenCanvas WOPI mode; DESIGN.md G1).
- **Sessions.** They last at most 10 h, then the canvas relaunches.
- **Images.** Pictures are stored inside the `.ocanvas`: 10 MB per image, 50 MB per file, files
  up to 100 MB.
- **Comment role.** Read-only shares get view, not comment, unless an admin turns on the comment
  role (DESIGN.md §5).
- **Versions (VH-01c).** Each autosave is a version; Nextcloud's expiry thins them out. The app
  advertises `OpenCanvas_SupportsVersions` and answers `GET {WOPISrc}/versions` and
  `{WOPISrc}/versions/{v}/contents` over `files_versions` (editors only), so the OpenCanvas history
  panel lists, previews, compares and restores them. A named or restore save (`X-COOL-WOPI-IsAutosave:
  false` + `X-OpenCanvas-Commit-Message`) sets the version's Nextcloud **label** and our metadata
  `opencanvas_kind` / `opencanvas_restored_from` (Nextcloud 29+, `IMetadataVersionBackend`; older
  servers keep the name only in the file's manifest). Authors are Nextcloud's own `author` metadata
  (the save runs as the editor). In-file history is off for this host by default (`[host.versions]
  file = false`, docs/05 §2).
- **Do labelled versions survive expiry?** Read from Nextcloud 31 `apps/files_versions/lib/Storage.php`
  (2026-11-24): labelled versions are skipped by the max-age expiry (`expireOlderThanMaxForUser`)
  and by the quota expiry loop in `expire()`, but **not** by its low-space fallback (oldest
  versions deleted until the quota fits, no label check), nor when a version has no database row.
  So named versions are kept in normal operation and can still go when a user runs out of space.
  Not yet confirmed in a running Nextcloud (the real-host pass for VH-01c is pending).
- **Locks.** None. An outside change to an open file produces a conflict copy.
