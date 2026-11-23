<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas for Nextcloud: design (NC-01)

**Status:** draft, 2026-11-24. Owner request: "Let users create .ocanvas files, open
collaborative canvases from Files, and share them in Nextcloud Talk. Nextcloud already has a
collaborative whiteboard application, so OpenCanvas needs to differentiate itself through the
combined document, database and whiteboard experience."

The rules still hold. Nextcloud owns sign-in, ACL and files. OpenCanvas never persists
documents (ADR-001). No UI ships before its prototype is approved (ADR-011; see
[UI-SCREENS.md](UI-SCREENS.md)).

## 1. Research summary (sources)

Repos were read on their default branch on 2026-11-24. Their `main` branches now target
Nextcloud 36; NC 30–32 behaviour is on the `stable3x` branches and should be checked there.

**Nextcloud Office (richdocuments) as a WOPI host**
- **Routes.** `GET/POST wopi/files/{fileId}` and `GET/POST wopi/files/{fileId}/contents`.
  The whole controller is `#[RestrictToWopiServer]`.
  https://github.com/nextcloud/richdocuments/blob/main/lib/Controller/WopiController.php
- **WOPISrc and file id.** WOPISrc always contains `index.php`, so one document has one URL.
  The file id is `{fileid}_{instanceid}[_{version}]`.
  https://github.com/nextcloud/richdocuments/blob/main/src/helpers/url.js,
  https://github.com/nextcloud/richdocuments/blob/main/lib/Helper.php
- **Tokens.** Random 32-character tokens are stored in the table `richdocuments_wopi`, together
  with the owner, editor, canwrite, share, guest name and expiry. The default TTL is 10 h, and a
  cleanup job removes old rows. https://github.com/nextcloud/richdocuments/blob/main/lib/TokenManager.php,
  https://github.com/nextcloud/richdocuments/blob/main/lib/Db/WopiMapper.php
- **Permissions.** `UserCanWrite` requires an updatable mount (plus the group edit restriction)
  and no foreign files_lock. Public links use `share perms & PERMISSION_UPDATE`.
  `hideDownload` and the share attribute `permissions.download = false` hide export.
  `UserCanNotWriteRelative` is set for public links, hidden download and secure view.
- **Saving.** PutFile checks `X-COOL-WOPI-Timestamp` against the mtime and answers
  `409 {"COOLStatusCode":1010}` on a mismatch. It writes as the editor (user scope) and returns
  `LastModifiedTime`. Versions come from files_versions reacting to the write.
- **PutRelativeFile.** It creates the copy with `newFile` and answers `{Name, Url}`.
- **Locks.** LOCK and UNLOCK go through `OCP\Files\Lock\ILockManager`, and only when a lock
  provider (files_lock) exists.
- **Discovery and proof keys.** Discovery is cached for 1 h, in the distributed cache and in
  appdata. Proof keys are built from `modulus`/`exponent`. The accepted combinations are
  proof/current, proofOld/current and proof/old, with a 20-minute window. A valid proof (or an
  IP `wopi_allowlist` match) marks the server as trusted.
  https://github.com/nextcloud/richdocuments/blob/main/lib/Service/ProofKeyService.php,
  https://github.com/nextcloud/richdocuments/blob/main/lib/Middleware/WOPIMiddleware.php
- **New-file entries.** `RegisterTemplateCreatorEvent` registers a `TemplateFileCreator` for
  each "New …" entry. https://github.com/nextcloud/richdocuments/blob/main/lib/Listener/RegisterTemplateFileCreatorListener.php
- **Microsoft proof-key spec.**
  https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/scenarios/proofkeys

**Nextcloud Whiteboard**
- **Architecture.** Excalidraw plus a separate Node socket.io server, which elects one browser
  to save the board. It trusts a shared HS256 secret (`jwt_secret_key`, 15-minute JWT), and the
  browser PUTs the JSON to `/apps/whiteboard/{fileId}`.
- **File type.** `.whiteboard` is `application/vnd.excalidraw+json`. The type is in server core's
  `mimetypemapping.dist.json`, so the app needs no repair step.
- **"New whiteboard".** Registered as a `TemplateFileCreator`.
- Sources: https://github.com/nextcloud/whiteboard/blob/main/README.md,
  https://github.com/nextcloud/whiteboard/blob/main/lib/Service/JWTService.php,
  https://github.com/nextcloud/whiteboard/blob/main/lib/Listener/RegisterTemplateCreatorListener.php

**App structure (NC 30–32)**
- **info.xml.** https://docs.nextcloud.com/server/latest/developer_manual/app_development/info.html
- **Bootstrap.** `IBootstrap` with `IRegistrationContext`. There is no `registerDirectEditor`;
  direct editors listen to `RegisterDirectEditorEvent`.
  https://docs.nextcloud.com/server/latest/developer_manual/app_development/bootstrap.html,
  https://github.com/nextcloud/server/blob/stable31/lib/public/AppFramework/Bootstrap/IRegistrationContext.php
- **Custom mimetype.** Use a repair step that merges `config/mimetypemapping.json` and
  `config/mimetypealiases.json`, then calls `IMimeTypeLoader::updateFilecache`. This is the
  draw.io pattern, and it uses `\OC::$configDir`.
  https://github.com/jgraph/drawio-nextcloud/blob/main/lib/Migration/RegisterMimeType.php
- **Files actions and New menu.** `@nextcloud/files` provides `registerFileAction` and
  `addNewFileMenuEntry`. On NC 30–32 that is v3, where actions are `new FileAction({...})`.
  https://github.com/nextcloud-libraries/nextcloud-files
- **Viewer.** `OCA.Viewer.registerHandler({id, mimes, component})`, loaded on the `LoadViewer`
  event. Nextcloud 36 folds Viewer into server and drops `LoadViewer`.
  https://github.com/nextcloud/viewer/blob/stable31/README.md

**Talk (spreed)**
- **Share a file into a chat.** Create a share with `shareType=10` (`IShare::TYPE_ROOM`) through
  the files_sharing OCS API. The file then appears in the chat as a file rich object.
  https://github.com/nextcloud/spreed/blob/main/docs/chat.md
- **Rich objects.** `POST /ocs/v2.php/apps/spreed/api/v1/chat/{token}/share` takes an
  `objectType`, `objectId` and `metaData`, with types from `OCP\RichObjectStrings\Definitions`.
- **File conversations.** `GET /ocs/v2.php/apps/spreed/api/v1/file/{fileId}` returns the room
  token of a file's own conversation. The file must be shared, and the conversations feature must
  be on. Talk shows this chat as the `chat` tab of the Files sidebar.
  https://github.com/nextcloud/spreed/blob/main/lib/Controller/FilesIntegrationController.php,
  https://github.com/nextcloud/spreed/blob/main/src/integrations/filesSidebar/mainFilesSidebarLoader.js
- **Public front-end hooks.** `OCA.Talk.registerMessageAction` and
  `OCA.Talk.registerParticipantSearchAction`. https://github.com/nextcloud/spreed/blob/main/src/init.js
- **Reference providers (Smart Picker).** `IReferenceProvider` / `ADiscoverableReferenceProvider`.
  https://docs.nextcloud.com/server/latest/developer_manual/digging_deeper/reference.html
- **Not confirmed in code.** How chat sits beside a Collabora document. It appears to be Talk's
  Files-sidebar chat tab inside the Viewer; richdocuments has no Talk-specific UI code.

## 2. Decision: A, the Nextcloud app is a WOPI host

We considered two paths:

- **(A) WOPI host.** The app implements CheckFileInfo, GetFile, PutFile and PUT_RELATIVE, the
  same way richdocuments does for Collabora. OpenCanvas's WOPI client mode already exists.
- **(B) JWT host.** The app signs JWTs and implements the docs/05 §5 callbacks.

**Recommended: A.** The reasons, point by point:

| Concern | A: WOPI | B: JWT |
|---|---|---|
| Who can call the file endpoints | Only OpenCanvas: every call carries an RSA proof checked against OpenCanvas's published key. No shared secret sits in Nextcloud. | HMAC with a secret shared by both sides. Leaking it from either side lets anyone mint launch tokens. |
| Server changes needed for the core flow | None. Verified against a real OpenCanvas binary (README). | None, but more endpoints to build: load, save, copies, assets, members, refresh. |
| Conflict copies | PUT_RELATIVE: the copy sits next to the original with the editor's rights. | `POST /files/{id}/copies`: the app builds the same thing itself. |
| Images and files in a canvas | Inlined into the `.ocanvas` (`assets/`). The file is self-contained, so download, versions, restore, federation and sync clients all carry the images. | The host stores assets separately (appdata) and must ACL every asset GET. A downloaded or restored file loses or orphans them. |
| Versions | Each PutFile is a normal write, so files_versions keeps history and restore works as for any file. | Same. |
| Locking | None (OpenCanvas uses timestamps, like Collabora). An outside change gives 409, then a conflict copy. | Same (If-Match / 409). |
| Permissions | CheckFileInfo is re-read live on every call, so a revoked share stops at the next call. | Role is fixed in the JWT until it expires. The live access callback is optional. |
| Public links and guests | The token carries the share token; permissions come from the share on every call. Same pattern as Collabora. | Same, built by hand. |
| Members and @mentions from share recipients | **Not in WOPI mode today** (docs/05 §6: the member list is "who opened it", and no mention calls are made). | Available (`members` claim or callback, `POST /mentions`). |
| Token refresh after 10 h | Relaunch (`Action_RefreshToken` is a fresh launch). | `POST /tokens/refresh`. |
| Admin familiarity | Same mental model as Nextcloud Office: URL, discovery, allow-list. | Whiteboard-style shared secret. |

**Main cost of A:** members and mentions (§7, gap G1). We still recommend A because the file
model (self-contained `.ocanvas`, versions, proof-key trust) is the part that is expensive to
change later. The member list can be added to WOPI mode with a small, additive server change,
or by switching the host to `mode = "both"` once G1 is done. That keeps one room per file
either way, since the room id is the WOPISrc.

## 3. Endpoints (built)

- **WOPISrc.** `{nextcloud}/index.php/apps/opencanvas/wopi/files/{fileId}`. It always includes
  `index.php`, so pretty URLs cannot change the room id. Admins can override the base (proxies,
  internal addresses). OpenCanvas's `wopi_allowlist` gets `{nextcloud}/index.php/apps/opencanvas/wopi`.
  The file id is the plain numeric Nextcloud file id: the host name already makes it unique, and
  the version suffix richdocuments uses is not needed (there is no old-version viewing in v1).

| Route | What |
|---|---|
| `GET wopi/files/{id}` | CheckFileInfo. Fields: BaseFileName, Size, Version (etag), LastModifiedTime, OwnerId, UserId, UserFriendlyName, UserExtraInfo.avatar, PostMessageOrigin, SupportsLocks=false, SupportsUpdate, and the §5 flags. |
| `GET wopi/files/{id}/contents` | GetFile, at most 100 MB. |
| `POST wopi/files/{id}/contents` | PutFile. Answers 401 when this token may not write (OpenCanvas then tries the next editor's token, PERM-05), 409 `{"COOLStatusCode":1010}` on a timestamp mismatch, and 423 when the file is locked. Writes as the editor (`setVolatileActiveUser`), so versions and activity name them. |
| `POST wopi/files/{id}` | Only `X-WOPI-Override: PUT_RELATIVE`; anything else gets 501. The UTF-7 name is decoded and given the original's extension, path separators are stripped, and `getNonExistingName` avoids clashes. Answers `{Name, Url, HostEditUrl}`. |
| `POST api/v1/token/{id}` | Signed-in user: answers `{action, access_token, access_token_ttl}` for the iframe form POST. |
| `POST api/v1/share/{shareToken}/token/{id}` | Guest on a public link. A password-protected link must have been unlocked first. |
| `GET open/{id}` | Full-page editor (placeholder). |
| `POST api/v1/create` | `{dir, name, kind: blank|database|whiteboard}`. Creates the starter `.ocanvas`. |
| `GET/POST settings/admin`, `POST settings/check`, `POST settings/rotate-secret` | Admin only. |

**Request checks**, in order: proof (refreshing discovery once on a miss), then the token, then
live Nextcloud access. The proof URL is rebuilt from the configured WOPI base, not from request
headers, so a TLS-terminating proxy cannot break it.

**Tokens** are stateless: `oc1.<claims>.<HMAC-SHA256>`, signed with a 64-character app secret
stored as a sensitive app config value.
- Claims: file id, either the user id or the share token (+ guest id + guest name), a maximum
  role, and the expiry (at most 10 h, OpenCanvas's cap).
- No DB table and no cleanup job. Every character is URL-unreserved, so the token signed in the
  proof is byte-identical to the one in the query.
- Revocation works because access is re-checked live. Rotating the secret ends every session.
- richdocuments keeps a token table because Collabora needs server-side state, such as template
  sources and remote shares. We need none of that.

## 4. `.ocanvas` file type and icon

- **MIME.** `application/vnd.opencanvas+zip`, the type OpenCanvas's discovery advertises.
- **Registration.** A repair step on install and post-migration merges `{"ocanvas": [mime]}` into
  `config/mimetypemapping.json` and an alias into `config/mimetypealiases.json`, then retags
  existing files with `updateFilecache`. It runs again on every upgrade, and uninstall removes
  our entries.
- **Icon.** The alias points at the core `x-office-document` icon until our icon is approved
  (UI-SCREENS S2). The approved SVG then ships in the app, and the admin runs
  `occ maintenance:mimetype:update-js` (README). The draw.io app also copies its icon into
  `core/img/filetypes`; we would rather not write into core.
- **Upstream option.** Ask Nextcloud to add `ocanvas` to `mimetypemapping.dist.json`, as was done
  for `.whiteboard`. That removes the repair step.

## 5. Permissions mapping

`PermissionMapper::map` is a pure function with unit tests.

| Nextcloud | OpenCanvas |
|---|---|
| No READ | No access (404) |
| UPDATE (owner, editable share, editable public link) | `edit` |
| Read-only share | `view` |
| Read-only share with share attribute `opencanvas`/`comment` = true **and** the admin switch on | `comment` (off by default, see below) |
| "Allow download" off (`permissions.download = false`) or public link "Hide download" | `DisableExport`, `DisablePrint`, `HideExportOption`. Editing is unaffected. |
| No CREATE in the parent folder, or a guest | `UserCanNotWriteRelative` (no conflict copy, so the host should use `on_conflict = "reload"`) |
| Token's `maxRole` | Upper bound (lets a "view only" launch exist later) |

**Why `comment` is off by default.** Nextcloud has no comment permission, so a read-only
recipient cannot write the file. OpenCanvas saves with an editor's token first and falls back to
a commenter's (PERM-05). If only commenters are connected, the PutFile is refused (401) and the
comments wait in OpenCanvas's outbox until an editor's session saves. The UI for setting the
share attribute is not designed either (UI-SCREENS S8). Gap G5.

**Live changes (built, verified in Nextcloud 31).** A downgraded or removed share always takes
effect at the next WOPI call. To make it immediate, `RoleSyncService` calls OpenCanvas's role API,
`POST /v1/files/{WOPISrc}/role` (docs/05 §7, needs `opencanvas_api_key`), with each affected
person's new live role. The role is computed again from all their shares, so losing one share
while still holding another does not lock them out.

It is triggered by two things:
- `ShareDeletedEvent`
- the legacy `OCP\Share` `post_update_permissions` hook. Nextcloud 30–32 have no typed "share
  updated" event.

Scope:
- Handled: user and group shares (groups capped at 500 members).
- Not handled yet: folder shares, Talk room shares and link shares.

The real-Nextcloud browser test showed an open editor still editable 10 s after a downgrade or a
revoke without this, and switched (read-only / closed) with it.

## 6. Creating, opening, Talk

- **New canvas (Files + menu).** A server-side `TemplateFileCreator` ("New canvas", `.ocanvas`)
  creates an empty file. OpenCanvas opens an empty body as a new canvas on its own start screen:
  blank, database, board, the 40+ built-in templates, and import. The Nextcloud entry therefore
  does not duplicate the template gallery.
- **New database / New whiteboard.** These are front-end `addNewFileMenuEntry` entries that
  call `api/v1/create`. That endpoint writes a zip whose `document.json` holds one empty
  database or board block. Both starters were verified to open, save and keep their block in a
  real OpenCanvas.
- **From template.** Users' own `.ocanvas` files in their Nextcloud Templates folder work through
  the standard template picker, which copies the file. A built-in template picker is the
  in-canvas one.
- **Open from Files.** Two placeholder routes: a Viewer handler (an iframe inside the Viewer
  modal, which keeps the Files sidebar and its Talk chat tab available) and a default file action
  that goes full screen at `/apps/opencanvas/open/{id}`. Both form-POST `access_token` and
  `access_token_ttl` to `{opencanvas}/v1/launch?WOPISrc=…`.
- **Talk: post a canvas into a conversation.** Talk's built-in "Share from Files" (a room share,
  type 10) already posts the file. Clicking it in Talk opens the Viewer, and our handler opens the
  canvas. Room members get read or edit through the room share's permissions. No Talk-specific
  code is needed for this.
- **Talk: open beside the call.** Two options:
  - (a) Talk's per-file conversation (`/api/v1/file/{fileId}`), shown as the Files sidebar chat
    tab next to the Viewer. The canvas stays open while the file's call runs in the sidebar.
  - (b) From a conversation, a message action (`OCA.Talk.registerMessageAction`, "Open canvas
    beside the call") on messages that carry an `.ocanvas` file. It opens our view in a split
    with the call.

  Option (a) works with stock Talk; (b) needs our front end and its prototype. Both are listed
  in UI-SCREENS. A "New canvas in this conversation" entry would create the file in the user's
  Talk attachments folder and room-share it (designed, not built).
- **Rich object.** For a link-only card (a canvas Talk users cannot open as a file), use
  `chat/{token}/share` with objectType `file`. A dedicated card through a reference provider
  (`IReferenceProvider` for `/apps/opencanvas/open/{id}` links) gives the Smart Picker and link
  previews. Designed, not built.

## 7. Members and mentions

- **Today in WOPI mode.** The @-list is "everyone who opened this canvas" plus the saved
  `people` map. No mention notifications are sent.
- **Target.** The members are the share recipients: the owner, user shares, group members,
  Talk room participants (room shares), and circle/team members, capped at 500 and without
  e-mail. Mentions become Nextcloud notifications (`INotificationManager`) with a link to
  `/apps/opencanvas/open/{id}#block=…`. Before notifying, the app checks that each mentioned
  person can see the file.
- **Needs G1.** The app side is designed only.

## 8. Admin settings (backend built, page is a placeholder)

| Setting | Notes |
|---|---|
| OpenCanvas URL (public) | What browsers load. Added to CSP `frame-src` and `form-action` on our pages. |
| OpenCanvas internal URL | Optional. Where Nextcloud fetches discovery. |
| WOPI base | Shown read-only by default, plus an override. This is what OpenCanvas's `wopi_allowlist` needs. |
| Public links on/off | Guests on link shares. |
| Comment role on/off | §5 |
| Connection check | Discovery reachable, `.ocanvas` action present, proof key published |
| Rotate token secret | Ends open sessions |

- The token secret is generated automatically and never shown.
- An IP allow-list for the WOPI routes (richdocuments' `wopi_allowlist`) is optional defence in
  depth. Proof keys are mandatory here, so it is not built.

## 9. Gaps in OpenCanvas (server unchanged in this work)

| # | Gap | Suggested change |
|---|---|---|
| G1 | WOPI mode has no member list or mention notifications | Either call the docs/05 §5 `members`/`mentions` callbacks for WOPI hosts that set `callback_base` (signed like JWT-mode callbacks, keyed by the WOPISrc file id), or read a CheckFileInfo extension `OpenCanvas_MembersUrl`/`OpenCanvas_MentionsUrl` that is proof-signed like other WOPI calls. |
| G2 | No way to start an empty WOPI file as a database or board | Not needed: the app writes `document.json` starters. A `start=` launch hint would let "New database" create an empty file instead. |
| G3 | PutFile has no named-version signal (`X-COOL-WOPI-IsAutosave` is always `true`) | Send `X-COOL-WOPI-IsAutosave: false` and `X-OpenCanvas-Commit-Message` on explicit "Save version", so the app can label a Nextcloud version. |
| G4 | Token refresh is a full relaunch | Acceptable (10 h). An `Action_RefreshToken` flow for WOPI hosts would avoid the reload. |
| G5 | Comment-only sessions cannot save without an editor | Product decision. Either accept, or let the host write commenter saves as the file owner (safe only because proofs show OpenCanvas enforced the role). |
| G6 | Nextcloud 36 removes `LoadViewer` | Front-end work in the app (listen to `HttpBeforeTemplateRenderedEvent`), not a server gap. |

## 10. Why OpenCanvas, not Whiteboard (app store text; factual)

> Nextcloud Whiteboard is a freehand whiteboard. OpenCanvas is a document that holds rich text,
> databases (table, board, calendar and gallery views over typed fields) and whiteboards in the
> same file, edited together in real time. Start from more than 40 built-in templates (meeting
> notes, trackers, roadmaps, retros, mind maps, flowcharts) or import Markdown, HTML and CSV.
> Export to PDF, Word, Markdown, HTML or images. Images live inside the `.ocanvas` file, so
> versions, downloads and sync clients keep everything. Nextcloud stays in charge of files,
> sharing and permissions; OpenCanvas stores no documents.

Check every claim against the release notes before publishing. Export formats depend on the
OpenCanvas host's `export_formats`. PDF needs the PDF renderer.
