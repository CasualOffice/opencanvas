# 30 — Version history and visual diff (VH-01, VH-02)

**Status:** Accepted by the owner 2026-11-24 (ADR-051, ADR-052; screens approved). Amended the same
day by the owner: two sources of versions, host and in-file (§13, ADR-055).
**Scope:** [docs/27](27-ROADMAP-v0.2.md) §0 asks for "its own short design (where versions live,
given the host owns files) and a prototype before UI work". Tracker rows VH-01 and VH-02 in
[docs/10](10-EXECUTION-TRACKER.md).

Constraints this design keeps:

- **The host owns auth, ACL and files; OpenCanvas never persists documents** (ADR-001, AGENTS.md
  rule 5). The DB holds only transient room state (snapshot, WAL tail, sessions, outbox).
- **`.ocanvas` stays format version 1** (ADR-042): additions are additive.
- **No manual save** (ADR-012). Naming a version is not a save button: it labels the state that
  autosave is already writing.
- **Restoring never rewrites history.** A restore is a new edit; the version before it and the
  version it restores both stay in the host's history.

## 1. What exists today

Read from `crates/oc-server` and the docs, 2026-11-24:

| Fact | Where |
|---|---|
| Every save is a **complete** `.ocanvas` (manifest, `document.json`, `ydoc.bin` = full Yjs v1 state). A version needs nothing else to be opened. | `oc_model::ocanvas`, docs/15 §4 |
| Autosave commits 2 s after the last edit or 10 s after the first unsaved one, when the last client leaves and on SIGTERM. A save of a busy canvas is a host write every 2–10 s. | docs/15 §7 |
| JWT saves send `X-OpenCanvas-Autosave: 1` always and `X-OpenCanvas-Authors`. `X-OpenCanvas-Commit-Message` is documented in docs/05 §5 but **never sent**, and the `commitMessage` token perm has no UI. | `host_client.rs` `put_file` |
| WOPI saves send `X-COOL-WOPI-IsAutosave: true` always, so Nextcloud cannot tell a named version from an autosave (gap G3). | `wopi.rs`, integrations/nextcloud/DESIGN.md G3 |
| Nextcloud keeps every PutFile as a version under the editor's name, thinned by its own expiry; restore works as for any file. There is no old-version viewing in OpenCanvas. | integrations/nextcloud/README.md |
| Ephemeral hosts have no load, no save and nothing kept after the room closes. | docs/05 §8a, ADR-043 |
| The manifest carries `commit {id, authors, at}`. | docs/15 §4 |
| `room_snapshots` keeps **one** row per room (the latest compaction), not a history. | `store.rs` |
| Yjs GC is on (default), so deleted content is dropped from the room's state. Yjs/y-prosemirror snapshots (`Y.snapshot`, `ySyncPlugin` `snapshot`/`prevSnapshot`) need `gc: false` to show old states. | yrs defaults |
| Templates already replace content as **one server edit** that the person who applied it can undo from a toast. | `routes/templates.rs`, `room::undo_template` |

So the host already holds a complete copy of the canvas for every save. The question is only how
OpenCanvas lists, opens, names and restores those copies.

## 2. Where do versions live?

### Option (a): host-stored versions through optional callbacks

Each saved `.ocanvas` is a version. The host lists them and returns one by id. OpenCanvas reads
them on demand, keeps nothing, and labels named versions through the save it already makes.

- **JWT hosts** implement two optional callbacks: list versions and get one version. A named
  version is the existing `PUT /files/{id}` with `X-OpenCanvas-Autosave: 0` and the (already
  documented) `X-OpenCanvas-Commit-Message`.
- **WOPI hosts** map these to their native versioning. WOPI has no standard "list versions" call
  for clients, so: hosts we ship (the Nextcloud app) implement two OpenCanvas WOPI extensions;
  other WOPI hosts get a link to their own version UI through the standard CheckFileInfo field
  `FileVersionUrl`.
- **Ephemeral hosts** have no history.

| For | Against |
|---|---|
| Fits ADR-001 exactly: the host stores every byte, ACLs it and applies its own retention, quotas, legal hold and backup. | Each host has to implement two calls (they are optional; without them the UI shows a plain message or a link). |
| Zero growth of the `.ocanvas`. | Listing costs a host round trip (cached 30 s). |
| Nextcloud already keeps the versions; named versions map to Nextcloud's version labels. | Retention differs by host (Nextcloud thins autosaves). We show what the host has. |
| Deleted content stays where the host's retention says, not in every downloaded copy. | |

### Option (b): versions inside the `.ocanvas`

The file carries compressed Yjs states of earlier versions (for example `versions/<id>.bin` plus
an index), so the host stores them as part of the file.

| For | Against |
|---|---|
| Works on any host with no new callback. | **Size.** A version is a full state (with GC on, an incremental update cannot rebuild an old state). A 2 MB canvas with 20 named versions carries about 40 MB raw, 10–15 MB deflated: most of the 20 MB `max_doc_bytes`. One diagram board may use 25 % (5 MB, ADR-045); 4 versions of a full board alone fill the document. |
| History travels with a download. | **Quadratic host storage.** The host keeps every save as its own version, and each now carries all earlier embedded versions. |
| | **Privacy.** Text someone deleted stays in every copy anyone downloads, exports or shares. Hosts lose the ability to purge it. |
| | Every save (every 2–10 s while editing) rewrites the whole history; slower saves, more conflict-copy bytes. |
| | Retention, quotas and legal hold move from the host to us: against ADR-001. |
| | Turning off GC to make deltas possible grows the live room's state without bound. |

### Option (c): hybrid

Host-stored history (a), plus something small in the file. Two variants:

- **c1 — named snapshots in the file, autosaves at the host.** Keeps most of (b)'s size and
  privacy problems for named versions, and makes restore depend on where a version came from. Rejected.
- **c2 — the version's own label inside its own bytes.** Each saved file says what it is in its
  manifest: `commit.kind` (`auto`, `named`, `restore`), `commit.message` (the name) and
  `commit.restoredFrom`. Nothing earlier is embedded, so there is no growth; a host that keeps old
  bytes but cannot store a label (generic WOPI, a JWT host without version metadata) still has the
  name, and OpenCanvas reads it when it opens that version.

### Recommendation

**(a) with the c2 manifest labels.** Versions live with the host; OpenCanvas stores none. Each
saved file describes itself (kind, name, authors, restored-from) in its manifest, additively.
This is the only option that keeps ADR-001 and rule 5 without exception, costs no document
budget, and reuses what Nextcloud already does. (b) is rejected for size, quadratic storage and
privacy; c1 for the same reasons at smaller scale. A third idea, keeping versions in the
OpenCanvas DB (`room_snapshots` history), is rejected by rule 5.

## 3. Per host mode

| | JWT, callbacks implemented | JWT, no version callbacks | WOPI: Nextcloud app | WOPI: other hosts | Ephemeral |
|---|---|---|---|---|---|
| History panel | Full | Message, or a link when `[host.flags] history_url` is set | Full | Link from CheckFileInfo `FileVersionUrl`, else message | Message only |
| List versions | `GET /files/{id}/versions` | — | `GET {WOPISrc}/versions` (extension) over `files_versions` | — | — |
| Open a version | `GET /files/{id}/versions/{v}` | — | `GET {WOPISrc}/versions/{v}/contents` | — | — |
| Name a version | `PUT` with `X-OpenCanvas-Autosave: 0` + `X-OpenCanvas-Commit-Message` | Same headers are sent; the host may ignore them. The name is also in the file's manifest | PutFile with `X-COOL-WOPI-IsAutosave: false` + `X-OpenCanvas-Commit-Message`; the app sets the Nextcloud version label (closes G3) | Same PutFile headers; the name is in the manifest | Not offered |
| Automatic versions | Every save, flagged `X-OpenCanvas-Autosave: 1`; the host collapses or prunes | Same | Every PutFile; Nextcloud's expiry thins them | Host's rule | None |
| Restore | In the room (§5) | Not offered in OpenCanvas; the host's own restore causes a conflict copy if the canvas is open | In the room (§5). Restoring from Nextcloud's Versions tab while the canvas is open still produces a conflict copy (§10 decision 7) | Host's own UI | — |
| Retention | Host | Host | Nextcloud expiry; labelled versions are kept by it (to verify on NC 30–32) | Host | Destroyed with the room |
| Diff | Yes | — | Yes | — | — |
| Who edited | `authors` from the list response, else the version's manifest | — | The app stores authors as version metadata | — | — |

**Support detection.** The session answer gains `history: "full" | "link" | "none"` and, for
`link`, `historyUrl`. JWT: `full` when `[host.flags] history = true` (explicit, no probing at
launch; a 404/405/501 from the list call later downgrades the session to `none`). WOPI:
`full` when CheckFileInfo has `OpenCanvas_SupportsVersions: true`; `link` when it has
`FileVersionUrl` (http(s) only, opened in a new tab, or posted to the host page as
`UI_FileVersions` when `FileVersionPostMessage` is true); else `none`. Ephemeral: `none`.

### 3.1 New JWT callbacks (optional)

| Call | Request | Response |
|---|---|---|
| **List versions** `GET /files/{fileId}/versions?cursor=&limit=` | signed like every callback, with the `callbackToken` of whoever opened history; `limit` ≤ 100 | `{"versions":[{"version":"18","at":"2026-11-24T10:14:03Z","authors":["u_123"],"name":"Before the board review","kind":"named","size":182344}], "next":"<opaque>"}`, newest first. `kind` `auto` \| `named` \| `restore`; `name` absent for automatic versions. `404`/`405`/`501` = not implemented. Must list only what this user may see |
| **Get version** `GET /files/{fileId}/versions/{version}` | signed | the `.ocanvas` bytes of that version (≤ 100 MB, checked like a load). `404`/`410` = gone (expired) |

The **save** gains no new call: a named save is `PUT /files/{fileId}` with `X-OpenCanvas-Autosave: 0`,
`X-OpenCanvas-Commit-Message: <name, percent-encoded UTF-8, ≤ 120 chars>`, and on a restore
`X-OpenCanvas-Restored-From: <version>`. Hosts that ignore them still get a correct file.

### 3.2 WOPI extensions (Nextcloud app; any WOPI host may implement them)

- CheckFileInfo: `OpenCanvas_SupportsVersions: true`.
- `GET {WOPISrc}/versions?access_token=` → the JSON of §3.1.
- `GET {WOPISrc}/versions/{v}/contents?access_token=` → bytes.
- Both carry proof keys like every WOPI call, and the app checks access live.
- PutFile: `X-COOL-WOPI-IsAutosave: false` and `X-OpenCanvas-Commit-Message` on a named save.

## 4. Named and automatic versions

- **Automatic.** Every save is one, as today. The panel groups them by day and folds a run of
  automatic versions with no gap over 30 minutes into one row, "Edited by Lea, Jonas · 10:02 –
  10:47", which expands to the individual times. Showing all 300 autosaves of a morning is noise.
- **Named.** "Name this version" (edit role and the `commitMessage` perm) commits the current
  state at once with the name. If nothing changed since the last save, the save still goes out:
  the host gets a version with the label (decision 3). A name is 1–120 characters. Renaming an
  existing version needs a host call we do not define in v0.2 (decision 4).
- **Restore versions** are named automatically, "Restored from 'Board review ready'" or "Restored
  from Nov 21, 10:14".
- **Checkpoint hint.** So hosts that keep every write can prune safely, a save also carries
  `X-OpenCanvas-Checkpoint: 1` when it is the last save of a room (last person left) or the first
  save after 30 minutes of editing (decision 5). Named saves are always checkpoints.

**Retention** is the host's. OpenCanvas never deletes a version and never asks the host to. A
version the host has expired answers `404`/`410` and leaves the list on the next refresh.

## 5. Restore

Restore is **an edit in the live room**, never a host-side rewrite and never a replacement of the
room's Y.Doc:

1. **Save first.** If the room is dirty, the server commits now (`kind: auto`, checkpoint). The
   state before the restore is therefore always a version. Nothing is lost.
2. **Load the old version** from the host, read and validate it (`read_ocanvas`, MOD-01; over
   `max_doc_bytes` → refused with a plain message).
3. **Apply the reverse diff** (§6) as one transaction with origin `restore:<id>:<user>`: only
   blocks, rows, cells, fields and shapes that differ are touched. Edits others make at the same
   time to parts the restore does not touch survive; edits to touched parts are in the version of
   step 1.
   - Restored: `content`, `meta`, `databases` (rows, fields, view settings), `boards`.
   - Kept as they are now: `comments` (threads are conversation, not content: no thread is
     deleted by a restore; a thread whose quoted text is gone shows as it does today when text is
     deleted) and `people`.
   - Assets: JWT asset URLs are the host's (it keeps them as long as any version references them,
     as today for undo). WOPI versions carry their assets inline; the restore copies the old
     version's `assets/` into `room_assets` (50 MB limit applies).
4. **Commit at once** as a restore version (`kind: restore`, `restoredFrom`).
5. **Tell everyone.** Clients get a control message `{"t":"restored","by":userId,"from":version,"at":…}`.
   Others see a toast, "Lea restored the version from Nov 21, 10:14". The person who restored
   gets **Undo** for 30 s (same mechanism as templates: undo is refused once others have edited
   restored parts).

**Permissions.** Restore needs the `edit` role and the new token perm `restore` (default `true`
for editors; WOPI: `UserCanWrite`, and `OpenCanvas_DisableRestore` to turn it off). The server
checks it on the request, like every frame (rule 6).

## 6. Visual diff (VH-02)

### 6.1 How it is computed

**Server-side, structurally, in `oc-model`** (ADR-052). Not with Yjs snapshots: GC is on, so a
Yjs snapshot cannot rebuild deleted content, and turning GC off grows every room for ever.

1. Load both versions (`read_ocanvas`) and project each to the `document.json` shape (content
   tree, `meta`, `databases`, `boards`; `comments` and `people` are not diffed).
2. **Blocks.** Flatten the tree to blocks with their paths (list items, toggles, columns and table
   rows recurse). Match by `blockId` first. For blocks without ids (older content; the web part of
   block ids is still to do, docs/15 §4), run Myers over block signatures (type + normalised text
   hash) and then pair the remaining same-type blocks in each gap by word similarity (≥ 0.5) as
   *changed*. Matched blocks outside the longest increasing subsequence of positions are *moved*.
3. **Inline text.** For a changed block, a word-level Myers diff with semantic clean-up (as
   diff-match-patch does), giving `[[op, text], …]` runs; mark-only changes are *formatting*.
4. **Databases** (by `dbId`). Fields by id: added, removed, renamed, type or options changed.
   Rows by `rowId`: added, removed. Cells per (row, field): old → new value. Row notes as text.
   Order changes and view settings are one summary line each.
5. **Boards** (by `boardId`). Shapes by id: added, removed; **moved** when `x`/`y` changed by more
   than 2 px with the same size; resized; text changed (inline diff); style changed (`fill`,
   `stroke`, `kind`, `props`); connector re-bound (`start`/`end` shape or port).
6. **Meta**: title, icon.

Output, `GET /v1/history/diff?ticket=&from=<v>&to=<v|current>`:

```json
{"summary":{"added":4,"removed":1,"changed":6,"moved":2},
 "blocks":[{"op":"changed","path":"/content/5","blockId":"b_01jd…","text":[["eq","Admins can sign in with "],["del","SAML"],["ins","SSO"],["eq"," …"]]},
           {"op":"added","path":"/content/9","blockId":"b_01je…"}],
 "databases":[{"dbId":"db_1","rows":[{"op":"added","rowId":"r_9"}],"cells":[{"rowId":"r_2","fieldId":"status","old":"In progress","new":"In review"}]}],
 "boards":[{"boardId":"bd_1","shapes":[{"op":"moved","shapeId":"s_4","from":[120,80],"to":[340,80]}]}],
 "truncated":false}
```

At most 2,000 entries (then `truncated`), 5 s of CPU per diff. Results and decoded versions are
cached **in memory only** (LRU, 64 MB per node, 5 minutes) keyed by (room, from, to); nothing is
written to the DB (rule 5).

**As built (VH-02a, `oc_model::diff`).** `diff_json(old, new, &Limits)` / `diff_docs`. The answer
always has `summary`, `meta`, `blocks`, `databases`, `boards`, `truncated`:

- `meta`: `[{field: "title"|"icon", old, new}]`.
- `blocks`, in the newer version's order: `added` `{path, blockId?, type}`; `changed` and `moved`
  `{path, blockId?, type, changes, …}` where `changes` ⊆ `text` (with `text` runs), `formatting`,
  `attrs` (`{key: {old, new}}`; a container's attribute is keyed `taskItem.checked`,
  `callout.tone`), `type`, `context` (the container chain changed); `moved` adds `from` (the old
  path). `removed` `{path (old), blockId?, type, node (the old block), context?, after: {path,
  blockId?} | null}` sits right after the block it followed (null: at the top). Leaf blocks only:
  paragraphs, headings, code, toggle summaries and atoms; lists, toggles, callouts, columns and
  tables recurse.
- `databases`: `{dbId, op: added|removed|changed, name, meta?, fields?, rows?, cells?, notes?,
  order?, views?}`; fields `{op, fieldId, name, changes?: renamed|type|options|description, old?,
  new?}`, rows `{op: added|removed, rowId, title}`, cells `{rowId, fieldId, field, old, new}`,
  notes `{rowId, text}`. Changed parts in the new order, then removed, then added.
- `boards`: `{boardId, op, shapes, order?}`; shapes `{op: changed|moved|removed|added, shapeId,
  type, changes?: moved|resized|text|style|rebound, from?, to?, text?, style?: [keys],
  rebound?: {start|end: {old, new}}, shape? (removed: the old shape)}`. A bound connector's path
  follows its shapes and is not itself a change.
- Over the time limit the diff fails (`DiffError::TimedOut`); the server answers
  `422 DIFF_TOO_LARGE`.

Shared fixtures: `crates/oc-model/tests/fixtures/diff/{text,legacy,database,board}.json`
(`{old, new, expected}`), read by `tests/diff.rs` and by the web renderer's tests.

**Why the server, not the client.** The callback and WOPI tokens are server-side only, so the
bytes come through the server anyway; one Rust implementation serves the editor, the headless API
(`/api/v1/files/{id}/versions/diff`, HAPI), MCP ("what changed since Monday?") and webhooks; a
phone does not download and decode two 20 MB documents.

### 6.2 How it is shown (client)

The client opens the newer side (a version, or the current canvas) **read-only** in a second
editor bound to a throwaway Y.Doc loaded from `GET /v1/history/{v}?ticket=` (the version's Yjs
state). Diff entries become decorations keyed by `blockId`/path: added text and blocks green
underline/bar, removed text red strikethrough, removed blocks as widgets at their old position,
changed cells amber, board shapes outlined (added green, changed amber, removed as a red dashed
ghost, moved as a faint ghost at the old place with an arrow). A **Show changes** toggle turns
the decorations off; Previous / Next change steps through them. Compare any two versions by
choosing a base in the panel.

## 7. Permissions

| Action | Who | How it is set |
|---|---|---|
| See history, preview, diff | `edit` by default; `comment` and `view` only with the new perm `history: true` (decision 1) | token `perms.history`; WOPI `OpenCanvas_UserCanSeeHistory` |
| Name a version | `edit` and `perms.commitMessage` (existing) | token; WOPI: `UserCanWrite` |
| Restore | `edit` and `perms.restore` (default true) | token; WOPI: `UserCanWrite`, `OpenCanvas_DisableRestore` |
| Copy text out of an old version | anyone who may see history, unless `download`/`export` is off | existing perms |

The host's list call runs with the requesting user's token, so a host can hide versions per user.

## 8. Wire and API additions (all additive)

- **Manifest** (`.ocanvas`): `commit.kind`, `commit.message`, `commit.restoredFrom`. Readers that
  do not know them ignore them (ADR-042).
- **Session answer**: `history`, `historyUrl`; grant perms `history`, `restore`.
- **SPA REST**: `GET /v1/history?ticket=&cursor=`; `GET /v1/history/{v}?ticket=` (Yjs state, not
  stored); `GET /v1/history/diff?ticket=&from=&to=`; `POST /v1/history/name?ticket=` `{name}`;
  `POST /v1/history/{v}/restore?ticket=` → `{restoreId}`; `POST /v1/history/restore/undo?ticket=&restoreId=`.
- **Collab control**: `restored`.
- **Headless API, MCP, webhooks** (v0.2 HAPI, WH-01): the same four operations; events
  `version.named` and `version.restored`.
- **Host config**: `[host.flags] history = true` (JWT callbacks present), `history_url` (a link
  with `{fileId}`).

## 9. Prototype

`vh-protos/index.html` (scratchpad, not published; for owner approval). Frames:

| Id | Frame |
|---|---|
| 1a | Editor with the menu open on "Version history" |
| 1b | History panel: today and yesterday, named versions, folded automatic sessions, who edited |
| 1c | Automatic session expanded |
| 2a | Name this version (popover) |
| 2b | Named: toast and the new row |
| 3a | Preview an old version, read-only, changes off |
| 4a | Diff, text: blocks added, removed, changed, inline words |
| 4b | Diff, database: rows added and removed, cells changed |
| 4c | Diff, board: shapes added, moved, removed, changed |
| 4d | Compare any two versions (base picker) |
| 5a | Restore confirm |
| 5b | After restore: toast with Undo, the new "Restored from" row |
| 6a | Restore while others are editing: confirm names them |
| 6b | What the others see |
| 7a | View-only user with history allowed: no Restore, no Name |
| 7b | View-only user without history: the menu item is absent; nothing to show |
| 8a | Host without history (JWT): plain message |
| 8b | WOPI host with its own version page: link (Nextcloud-style "Versions") |
| 8c | Temporary canvas: no history |
| 9a–9d | Phone: list, preview with changes, change list, restore sheet |

## 10. Decisions for the owner

1. **Who sees history by default**: editors only (recommended; viewers could otherwise read
   content someone deliberately deleted), or everyone who can open the canvas.
2. **Fold automatic versions** into sessions with a 30-minute gap (recommended), or list every save.
3. **Naming with no changes** still sends a save so the host gets a labelled version (recommended),
   or label the latest host version through a new optional rename call.
4. **Renaming and deleting named versions**: out of v0.2 (recommended), or a `PATCH`/`DELETE`
   version callback now.
5. **Checkpoint hint** (`X-OpenCanvas-Checkpoint`) for hosts that keep every write: yes (recommended).
6. **Temporary canvases**: no history (recommended), or in-room checkpoints destroyed with the room.
7. **Nextcloud's own restore** while a canvas is open: keep today's conflict copy (v0.2), or let the
   app call a new `POST /v1/files/{id}/reload` so the open room reloads the restored file.
8. **Restoring comments**: keep current threads, never delete (recommended), or restore the
   threads as they were.
9. **Undo after restore** for 30 s by the person who restored (recommended), or no undo (the
   "Before restore" version is the safety net).

## 11. ADR text (Accepted by the owner 2026-11-24; in the register)

**ADR-051 — Version history lives with the host.** *Accepted by the owner 2026-11-24.* OpenCanvas stores no
versions. Every saved `.ocanvas` is a complete version, kept by the host. Hosts expose history
through optional calls: JWT `GET /files/{id}/versions` and `GET /files/{id}/versions/{v}`; WOPI
extensions `GET {WOPISrc}/versions` and `{WOPISrc}/versions/{v}/contents` advertised by
`OpenCanvas_SupportsVersions` (the Nextcloud app maps them to `files_versions`), or a link through
CheckFileInfo `FileVersionUrl`; ephemeral canvases have none. A named version is a save with
`X-OpenCanvas-Autosave: 0` and `X-OpenCanvas-Commit-Message` (WOPI: `X-COOL-WOPI-IsAutosave:
false`). Each saved file describes itself in its manifest (`commit.kind`, `commit.message`,
`commit.restoredFrom`), additively. Restore is a server edit in the live room, preceded by a save
and followed by a restore save, so it never rewrites or loses history. Retention is the host's.
Decoded versions are cached in memory only. *Rejected:* versions inside the `.ocanvas` (size
against the 20 MB limit and the 25 % board budget, quadratic host storage, deleted content
travelling with every copy); named snapshots in the file with autosaves at the host (the same at
smaller scale); versions in the OpenCanvas DB (rule 5).

**ADR-052 — Version diff is structural and computed on the server.** *Accepted by the owner 2026-11-24.*
`oc-model` diffs two decoded versions over the `document.json` projection: blocks matched by
`blockId`, then by a Myers sequence diff of block signatures and similarity pairing; word-level
inline diffs; database fields, rows and cells by id; board shapes by id (added, removed, moved
over 2 px, resized, restyled, text, re-bound). The result is JSON (≤ 2,000 entries, 5 s CPU),
cached in memory, and served to the editor, the headless API, MCP and webhooks. The client
renders the newer side read-only and decorates it. *Rejected:* Yjs / y-prosemirror snapshot
diffs (need `gc: false`, which grows every room without bound); a client-only diff (the client
has no host access, it would ship two whole documents to phones, and the API and MCP would need a
second implementation).

## 12. Work after approval

| Row | Work | Size |
|---|---|---|
| VH-01a | Host contract: callbacks, WOPI extensions, manifest fields, headers, perms; sample host and WOPI reference host implement them | M |
| VH-01b | Server: history proxy, in-memory cache, name, restore (save first, reverse diff, restore save, undo), `restored` control | M |
| VH-01c | Nextcloud app: version list/contents over `files_versions`, labels and authors as version metadata (G3) | S |
| VH-02a | `oc-model` diff (blocks, text, databases, boards) with fixtures shared with the web renderer | M |
| VH-01d / VH-02b | Editor UI after the prototype is approved: panel, preview, diff decorations, restore, phone | L |
| — | Block ids in the web editor (docs/15 §4, still to do) are a prerequisite for stable block matching | S |

## 13. Two sources (amendment, owner decision 2026-11-24; ADR-055)

The owner amended §2 by message on 2026-11-24: history has **two sources**, chosen per host.
Option (b) above was rejected for full copies; this is a bounded store of **diffs** instead.

1. **Host versions** (ADR-051, §3): for hosts such as Nextcloud that keep every save.
2. **In-file history** (ADR-055): a bounded history inside the `.ocanvas`, for real-time hosts
   that want it fast and self-contained.
   - Each kept version is the **reverse structural diff** (newer → older, over the
     `document.json` projection: top-level blocks by a Myers sequence diff, `meta`, `databases`
     and `boards` as object diffs) plus `kind`, name, authors, time. The current document and the
     chain of reverse diffs rebuild any kept version. Never full copies; Yjs GC stays on.
   - Comments and people are not history (as in §5: a restore keeps them).
   - Layout, additive to format 1: `history/index.json` (oldest first) and
     `history/<id>.deflate` (raw deflate, stored). Readers that do not know it ignore it; our
     writers keep it, including the WOPI asset rewrite. OpenCanvas servers older than VH-01 drop
     it when they save (known limitation).
   - What is kept: every checkpoint save (§4: the last save of a room, the first after 30
     minutes, named, restore) becomes a version once a newer save replaces it; ordinary
     autosaves in between are folded into the next one, so 50 versions span sessions, not
     seconds. The state a room loaded is always kept.
   - Bounds: `file_max_kb` (default 1024, compressed) and `file_max_versions` (50). Over either,
     the oldest automatic version goes first (its older neighbour is re-diffed against its newer
     one, so the chain stays whole); named and restore versions are kept until only they remain,
     then the oldest of them.
   - Privacy: reverse diffs carry deleted text, so a host can turn it off (`file = false`).
   - Temporary canvases: none.
3. **Host config** (docs/05 §2):

   ```toml
   [host.versions]
   file = true              # default true for JWT hosts, false for WOPI hosts
   file_max_kb = 1024
   file_max_versions = 50
   prefer_host = true       # with host versions too: the host list is primary, in-file is
                            # "recent changes"; on restore or conflict the host version wins
   ```

4. **Rule 5 still holds.** The history lives in the host's file. The server keeps it in memory
   while a room is open (with the state of the previous save); a room rebuilt from its WAL after a
   crash reads it back from the host's file before its first save.
5. **UI.** The only change from the approved frames is a small source label in the history panel
   footer: "Kept in this file" or "Kept by <host name>" (deviation listed for the owner).
