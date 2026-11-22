# 27 — v0.2 design plan: portable live blocks, block SDK, headless API

**Status:** Proposed, 2026-11-23. Owner review pending. ADRs 039–042 (Proposed) in
[docs/08](08-ADR-REGISTER.md); tracker rows in [docs/10](10-EXECUTION-TRACKER.md) §P3.
**Scope:** the three P0 features of v0.2 in [docs/09](09-ROADMAP.md#feature-priorities).
**Not in scope:** offline-first editing, version history, search, webhooks and automation (v0.3);
partial sync (v0.4); a plugin marketplace (v0.5). No UI is designed here (ADR-011): §6 lists the
prototypes that must be approved first.

Constraints every design below keeps:

- **The host owns auth, ACL and files; OpenCanvas never persists documents** (ADR-001). Rooms
  keep transient state only (WAL, snapshots, outboxes).
- **One Yjs document per canvas, one room per file** (docs/04 §2.2, docs/03 §5). The wire stays
  stock y-websocket (COL-01).
- **One canvas tool layer** in Rust is shared by the host REST patch API, the MCP tools and the
  agent runtime (ADR-032, ADR-033). New APIs extend it; they do not fork it.
- **Standard APIs and SDKs only, no dependency on a specific CasualOffice product** (ADR-038).
  Everything here is usable by any host through tokens, callbacks, REST, WebSocket,
  postMessage, the `<open-canvas>` SDK or MCP.
- **`.ocanvas` stays format version 1** and readable by 0.1.x: additions are additive and
  unknown content is preserved (MOD-02).

Sizes in §8: **S** ≤ 2 days, **M** ≤ 1 week, **L** ≤ 3 weeks, for one engineer.

---

## 1. Research

Sources are listed in §10 with their dates; the bracketed numbers point there. Accessed
2026-11-23 unless a date is given.

### 1.1 Live, portable blocks

| Product | Model | What we take |
|---|---|---|
| **Notion synced blocks** [1][2] | One block is the *original*; copies in other pages mirror it, and an edit in any copy updates all of them. Viewing needs access to the original's page and editing needs edit access to it. A copy can be unsynced alone; with more than 10 copies, "Unsync all" or deleting the original removes every copy without undo. In the API, `synced_from` is null on the original and `{type:"block_id", block_id}` on a copy, children exist only on the original, and the API cannot update synced content. | Reference, not copy. Permissions come from the source, not the embedding page. Deleting a reference must never delete the source. |
| **Microsoft Loop / Fluid Framework** [3][4][5] | A Loop component is a `.loop` **file** in the creator's OneDrive, embedded live in Teams, Outlook, OneNote and Whiteboard, using the storage's permissions and version history; moving the file breaks its embeds. A Fluid container is the unit of sharing and the permission boundary; the service orders all operations into one sequence. Fluid Framework 2 has been production-ready since 2024-06-26 and added SharedTree. | The live unit is a **file** owned by the storage provider, with its own ACL, opened as its own collaborative container. That fits ADR-001 exactly. Embeds should reference a stable file id, not a path. |
| **Coda Packs** [6] | Live *data* rather than live blocks: Pack code may reach the network only through the `Fetcher`, https only, to domains declared with `addNetworkDomain()`; authentication is a fixed set of types added by the platform, not by Pack code. (Execution limits of about 60 s are reported in the community, unverified.) | Third-party code gets network access only to declared origins, enforced by the platform. |
| **Craft** [7] | The Craft API exposes blocks over REST (`GET/POST/PUT/DELETE /blocks`, `PUT /blocks/move`), JSON or `text/markdown`, positioned by sibling; links to blocks use `block://blockId`, and targets outside the token's scope come back as `invalid:out_of_scope`; limits 50 requests / 10 s per IP and 100 / 60 s per space, with `Retry-After`. (In-app block references not checked.) | Block-addressed links that degrade to an explicit "out of scope" marker rather than leaking content. |
| **Anytype** [8][9] | any-sync syncs spaces as encrypted DAGs of signed changes merged as CRDTs, local-first and end-to-end encrypted; a consensus node validates ACL changes. API v2 (pre-release) treats "objects as editable JSON documents". | Embed objects by identity; offline is a property of the sync layer, which we defer to v0.3. |

### 1.2 Block extension models

| Framework | Contract | What we take |
|---|---|---|
| **ProseMirror** [10] / **Tiptap** [11] | A node is a `NodeSpec` in a schema fixed when the editor starts: content expression, `group`, `attrs` (an attr with no default is required), `parseDOM`/`toDOM`; `createChecked` and `Node.check` validate, plain creation does not. Tiptap wraps it as `Node.create({name, group, content, inline, atom, addAttributes, parseHTML, renderHTML, addNodeView})`. Collaborators share one schema: y-prosemirror maps the shared XML tree onto the local schema. | Third-party blocks must not need their own ProseMirror node type, or a client without the extension cannot represent the shared document. |
| **Editor.js** [12] | A block tool gets `{data, api, config, readOnly, block}` and implements `render()`, `save()` (returns JSON) and `validate(data)` (false drops the block); static `toolbox`, `sanitize` (per-field rules), `conversionConfig`, `pasteConfig`, `isReadOnlySupported`. Tools run in the page, unsandboxed. | Data-first blocks with save/validate/sanitize hooks are easy to write and to validate on a server. |
| **Lexical** [13] | Custom nodes (`ElementNode`, `TextNode`, `DecoratorNode`, whose `decorate()` returns a React element) declare `getType`, `clone`, `importJSON`, `exportJSON`, `updateFromJSON`; from v0.33 `$config` generates them, and a JSON schema is experimental. | An explicit import/export pair per node is what makes migrations possible; we add the version field ourselves. |
| **BlockNote** [14] | `createReactBlockSpec({type, propSchema, content: "inline" \| "plain" \| "none"}, {render, toExternalHTML, parse})`; props have defaults and optional allowed values; blocks are registered with `BlockNoteSchema.create({blockSpecs})`. | A small declarative config (type, typed props, content kind) plus render and export functions is the right size for block authors. |

### 1.3 Headless document APIs

| API | Versioning | Writes and concurrency | Paging and limits | What we take |
|---|---|---|---|---|
| **Notion API** [15] | Required `Notion-Version` date header | Append block children (≤ 100 per call, two levels, `position` start/end/after_block); cannot move blocks; no precondition token | `start_cursor`, `page_size` ≤ 100 in; `has_more`, `next_cursor` out (pages may be short); about 3 requests/s average, `429` + `Retry-After`; ≤ 1,000 blocks and 500 KB per request | Date-pinned versions, opaque cursors, documented payload and rate limits. |
| **Google Docs API** [16] | Path `v1` | `documents.batchUpdate`: all requests validated, then applied atomically, replies in order; `writeControl.requiredRevisionId` rejects (400) if not latest; `targetRevisionId` merges over collaborators' changes for a recent revision only; `writeMode` EDIT or SUGGEST | — | Atomic batches; an explicit revision precondition and a merge mode; suggestion writes (we have them, ADR-033). |
| **Confluence REST v2** [17] | Path `v2` | — | Cursor through `limit`; next page in `Link: <…>; rel="next"` and `_links.next`; no `Link` means no more | Cursor links in headers as well as the body. |
| **Yjs** [18][19] / **Loro** [20] | Binary updates | Yjs updates are commutative, associative and idempotent; `encodeStateVector` + `encodeStateAsUpdate(doc, sv)` send only what is missing; y-protocols SyncStep1/SyncStep2/Update; awareness is not authenticated | — | A CRDT-native client can sync directly, and replays are harmless; a JSON client needs a server-side projection. Loro (Eg-walker, movable tree and list, shallow snapshots) is an alternative engine; we stay on Yjs/yrs for v0.2 (ADR-009 and the wire contract). |

Cross-cutting standards: the `Idempotency-Key` header draft [21] (409 while the first request
runs, 422 for a reused key with a different payload) and Stripe's practice [22] (keys ≤ 255
characters, kept at least 24 h, POST only); Problem Details, RFC 9457 [23]; the `RateLimit` /
`RateLimit-Policy` header fields draft [24]; OpenAPI 3.1 [25].

---

## 2. Portable live blocks

### 2.1 Problem and user value

Teams copy the same status table, decision list or task list into several canvases and chat
threads, and the copies drift. A **live block** is written once and shown live in many places:
another canvas, a host's chat message, a ticket, a dashboard. Everyone edits the same thing and
sees the same state, under the access rules the host already has.

### 2.2 Design

Two kinds, both new nodes in `content`:

1. **`liveBlock` (editable, Loop model).** The live unit is **its own host file**: a small
   canvas (`.ocanvas`) that holds the block or blocks (rich text, a database, a board). Any
   canvas or host surface embeds it by file id; the embed opens the live file's **own room**,
   so co-editing is full CRDT editing with presence, exactly as in a normal canvas. Nothing new
   is persisted by OpenCanvas: the host stores the live file like any other, under its own ACL.
2. **`blockRef` (read-only reference, like Craft's `block://` links).** Points at `blockId` in another
   canvas. The server renders a read-only projection of that block (the same projection
   `canvas_read` uses) and refreshes it when the source room changes. No editing through it.

**Transclusion vs reference.** Both are references. Content is never copied into the embedding
canvas's CRDT, so there is one source of truth and no merge between copies. The only copy is an
optional **snapshot** for export and for readers without access (§2.5), governed by host policy.

**Making a block live.** "Make live" on a selection (or on a database or board block) asks the
host to create a file through a new optional callback, `POST /files` `{name, parentFileId,
kind:"ocanvas"}` → `{fileId}`; the host decides folder and ACL (by default, the parent's). The
server writes the selected content into the new file (one transaction, origin `user:<id>`),
saves it through the normal commit path, and replaces the selection with a `liveBlock` node in
one undoable transaction. Without `POST /files` the host can create the file itself and insert
the reference through the API (§4) or postMessage (`Action_InsertLiveBlock`).

**Rooms and sync.** The editor opens a room connection per visible live block, lazily when it
scrolls into view, at most **8 at once** per tab (others show their last projection until
visible). Each connection is a normal room session with its own ticket, so cluster ownership,
WAL, autosave and the role filter all apply unchanged. Multiplexing several rooms on one socket
is a follow-up (open question Q3). Presence inside a live block shows everyone editing that live
file, wherever they are.

**Permissions.** The live file's ACL decides, never the embedding canvas's:

- When a session meets a `liveBlock`, the server asks the host `POST /access {fileId, userId}`
  (exists since AI-01) and mints a **derived grant** for the live file: role = the host's
  answer, `exp` ≤ the parent grant's `exp`, `perms` ∩ the parent's. `/access` is **required** for
  live blocks; a host without it gets `blockRef`-style read-only references only if the launch
  token lists the file in a new `live` claim (`[{fileId, role}]`).
- No access: the node renders "No access" with **no** title or content unless the host policy
  allows a snapshot (§2.5).
- Editing the live content needs `edit` on the live file. Moving or deleting the `liveBlock`
  node needs `edit` on the embedding canvas only; deleting the reference never deletes the file.
- The role API (`POST /v1/files/{id}/role`) and revocation fan-out already reach the live file's
  room, so revoking access to a live file takes effect in every embed at once.

**Depth and cycles.** In v0.2 a live file cannot itself contain `liveBlock` or `blockRef` nodes
(rejected by MOD-01 validation for files marked `meta.kind = "live"`). This removes cycles and
unbounded fan-out. At most 50 references per canvas.

**Host surfaces.** `<open-canvas file="…" view="block">` renders one live file with compact
chrome (no header, no template gallery, height follows content and is reported with
`UI_Resize`). A host that cannot run the web component can render
`GET /api/v1/files/{id}/render?format=html` (read-only, sanitised, the export renderer).

**Offline.** v0.2 has no offline editing (v0.3). A live block that cannot connect shows its last
projection, marked as not current; edits are disabled until it reconnects.

**Export.** Exports resolve each live block **for the exporting user**: content they can read is
inlined with a caption "Live block: <title>" and a link; content they cannot read becomes a
placeholder. `.ocanvas` stores the reference plus the snapshot allowed by policy, never the live
file's CRDT state. Markdown, HTML, DOCX and PDF all use the resolved content.

### 2.3 Data model changes

```ts
// content node (docs/15 §4 gains two names)
liveBlock { blockId, fileId, hostId?, kind: "blocks" | "database" | "board",
            title, snapshot?: Json /* ≤ 64 KB, §2.5 */, snapshotAt?: string }
blockRef  { blockId, fileId, refBlockId, title, snapshot?: Json, snapshotAt?: string }
// meta of a live file
meta.kind = "live"
```

Host contract additions (docs/05): optional `POST /files` (create); `POST /access` required for
live blocks; launch token claim `perms.live` (may make and embed live blocks) and optional
`live: [{fileId, role}]`. postMessage: `Action_InsertLiveBlock {fileId}`, event
`UI_LiveBlockOpen {fileId}` so the host can navigate to the source.

### 2.4 API sketch

```http
POST /api/v1/files/{fileId}/live            # make live: move blocks into a new live file
{ "blockIds": ["b_…","b_…"], "name": "Q1 OKRs" }
→ 201 { "liveFileId": "f_…", "blockId": "b_…" }

POST /api/v1/files/{fileId}/blocks:batch    # insert a reference (§4)
{ "ops": [ { "op": "insertAfter", "blockId": "b_x",
             "blocks": [ { "type": "liveBlock", "attrs": { "fileId": "f_…" } } ] } ] }

GET  /api/v1/files/{fileId}/references      # live blocks and refs inside this canvas
→ { "items": [ { "blockId", "fileId", "kind", "access": "edit|view|none" } ] }
```

"Where is this live block used" is a host question (it has every file); OpenCanvas reports
`live.embedded` / `live.removed` events to the host's notification callback (ADR-027 outbox) so
the host can keep that index. OpenCanvas keeps none.

### 2.5 Security

- **Leak through snapshots.** A snapshot inside canvas B is readable by anyone who can read B's
  file outside OpenCanvas. Policy `[host.live] snapshot = "none" | "title" | "content"`,
  default **`"title"`**; `"content"` is for hosts whose ACL treats embedding as sharing (Q1).
- **Derived grants** are never wider than the parent grant or the host's `/access` answer, and
  expire with the parent. Each live-room connection is checked like a launch (no ticket reuse
  across files).
- **Fan-out limits:** 8 connected live blocks per tab, 50 references per canvas, `/access`
  answers cached 30 s (as today), and per-user room-open rate limits.
- **No cross-file writes by the server** except "Make live", which is one user action with an
  explicit target file the host created.

### 2.6 Tests and acceptance

- Two browsers, canvases A and B both embed live file L; typing in A's embed appears in B's within
  the p95 target; presence of both shows in L.
- A user with edit on B and view on L cannot change L (server role filter, not the UI);
  revoking L via the role API turns every embed read-only or "No access" within 1 s.
- Snapshot policy `"title"`: B's `.ocanvas` contains no L content (byte search in the zip).
- Export by a user without access to L contains no L content.
- A live file containing a `liveBlock` is refused by validation.
- Cluster: A's room and L's room owned by different nodes; edits converge, chaos kill of L's
  owner loses no acknowledged edit (reuse `scripts/chaos-cluster.sh`).
- 0.1.x reader opens a v0.2 canvas with `liveBlock`: the node is kept (unknown-node preservation)
  and round-trips byte-equal in `document.json`.

---

## 3. Extensible block SDK

### 3.1 Problem and user value

Every host has blocks of its own: an OKR tracker, a ticket card, a CRM record, a chart from an
internal service. Today a new block type needs a change to OpenCanvas itself. The SDK lets a host
or a third party ship a block without forking, while keeping the document safe for every reader
and every other tool (exports, MCP, validation).

### 3.2 Block definition contract

A block package is a directory (or npm package) with a manifest and a browser bundle:

```jsonc
// block.json
{
  "type": "acme.okr",                 // reverse-DNS-ish, lowercase; "oc." is reserved
  "version": "1.2.0",                 // SemVer of the data contract
  "title": "OKR",
  "icon": "target",                   // Lucide name
  "content": "none",                  // "none" | "inline" | "blocks" (editable children)
  "attrs": { "$schema": "https://json-schema.org/draft/2020-12/schema",
             "type": "object", "additionalProperties": false,
             "properties": { "objective": {"type":"string","maxLength":500},
                             "progress":  {"type":"number","minimum":0,"maximum":1} },
             "required": ["objective"] },
  "data": { "kind": "map", "schema": { /* JSON Schema of collaborative fields */ } },
  "export": { "markdown": "**{{objective}}** ({{progress|percent}})",
              "text": "{{objective}}" },
  "permissions": { "network": ["https://okr.acme.example"], "members": "read" },
  "migrations": "migrations.js",       // pure functions vN → vN+1 over attrs/data JSON
  "entry": "block.js",                 // browser bundle, run in the sandbox
  "integrity": "sha384-…"
}
```

- **Schema.** `attrs` (small, last-writer-wins) and optional `data` (collaborative state in a new
  `ext` root: `Y.Map<dataId, Y.Map>` with per-field LWW, like databases) are JSON Schema 2020-12.
- **One generic node.** Third-party blocks do **not** add ProseMirror node types. Every one is
  stored as `extBlock {blockId, type, v, attrs (JSON), dataId?, fallback}` with content `block*`
  when `"content":"blocks"`, `inline*` when `"inline"`. The ProseMirror schema is therefore the
  same in every client, whether or not it has the package installed, which y-prosemirror needs
  (§1.2).
- **Renderer.** `defineBlock({ render(el, ctx), update(attrs, data), destroy() })` in the
  bundle; `ctx` is the bridge in §3.4. Read-only when the user's role is not `edit`.
- **Server validation (plugs into MOD-01).** MOD-01's validator gains an extension registry:
  for an `extBlock` whose `type@version` is installed, `attrs` and `data` are checked against the
  manifest's schemas on `.ocanvas` load, patch, import, API and MCP writes, and room updates
  through the role filter's scratch-doc step (reject the update, as the filter does today).
  Unknown types are kept and not checked, as MOD-02 promises. **No third-party code runs on the
  server.**
- **Export hooks** are declarative: a small logic-less template over `attrs` (Mustache subset
  plus fixed filters) rendered by the Rust exporters for Markdown, text and HTML (escaped). The
  block also keeps `fallback {markdown, text}` up to date in the client; the server re-derives it
  from the template when present and sanitises it otherwise. DOCX and PDF use the HTML. Readers
  without the package (0.1.x, other tools, the host) see the fallback.
- **MCP and API.** `canvas_read` returns `extBlock` with `type`, `attrs` and `fallback`;
  `canvas_patch` and the API can write `attrs` and `data`, validated by the same schema. Agents
  see installed block types through a new `blocks_describe` tool (types, titles, schemas).
- **Permissions** in the manifest are requests; the effective set is manifest ∩ operator config
  ∩ host config. `network` becomes the sandbox CSP `connect-src`; `members:"read"` exposes the
  canvas member list (docs/21 rules, never e-mail).

### 3.3 Distribution and versioning

- **Installed by the operator**, enabled by the host. `OC_BLOCKS_DIR` holds packages; the server
  verifies `integrity` (SRI sha384) at start-up and serves bundles from the block origin (§3.4).
  `[host.blocks] enabled = ["acme.okr@^1"]` enables them per host; the session lists what the
  editor may load. No marketplace and no install from the browser in v0.2 (v0.5).
- **First-party blocks** (database, board, the existing nodes) stay in-process and trusted. One
  sample first-party block moves onto the contract (`oc.progress`) to keep the contract honest.
- **Versioning.** `attrs.v` records the data version. A newer package migrates older data
  forward on first edit (pure functions in `migrations.js`, run in the sandbox, result
  validated by the server schema of the new version). A client with an **older** package than
  the data renders the fallback read-only ("Updated by a newer version"). Breaking changes need a
  new major and a migration; the server refuses a manifest whose major changed without one.
- **`.ocanvas` forward compatibility.** Format version 1, `schemaVersion` unchanged. The
  manifest gains `requires.blocks: [{type, version}]`; `document.json` stores `extBlock` with
  `attrs`, `data` (as JSON) and `fallback`; `ydoc.bin` carries the `ext` root. A 0.1.x reader
  keeps `extBlock` as an unknown node and the `ext` root as an unknown root (both already
  preserved), so nothing is lost; it shows the placeholder. A test opens a v0.2 file in 0.1.x and
  checks the round trip (BSDK-05).

### 3.4 Sandbox

Third-party renderers run in an iframe per block instance:

- `sandbox="allow-scripts"` (never `allow-same-origin`, `allow-top-navigation`,
  `allow-popups-to-escape-sandbox` or `allow-forms`), served from a **separate block origin**
  (`OC_BLOCKS_ORIGIN`, e.g. `blocks.canvas.example`, a different site from the editor), so the
  bundle can reach neither the editor's DOM, its tickets nor its storage.
- CSP on the frame: `default-src 'none'; script-src 'sha384-…'; style-src 'self'
  'unsafe-inline'; img-src data: blob: <asset proxy>; connect-src <manifest ∩ config>;
  frame-ancestors <editor origin>`.
- **Bridge** over `postMessage` with origin checks both ways and a typed RPC: `getAttrs`,
  `setAttrs(patch)`, `data.get/set/observe` (the editor applies changes to the `ext` root on the
  block's behalf; the frame never holds the Y.Doc), `theme` tokens, `resize(height)`,
  `members.list` (if permitted), `assets.upload` (through the asset proxy, if permitted),
  `openLink(url)` (the editor opens it after `safeHref`). Rate limited (e.g. 60 writes/s per
  block); every write is validated by the editor against the schema before it reaches Yjs, and
  again by the server.
- A block that throws, hangs (no heartbeat for 5 s) or exceeds memory is replaced by its
  fallback with a "Block failed to load" state; the rest of the canvas is unaffected.
- Keyboard and focus: the bridge forwards Escape and Tab out of the frame so the editor's
  keyboard model keeps working; accessibility is the block author's duty, checked by axe in the
  sample block's tests.

### 3.5 Tests and acceptance

- A schema-invalid `attrs` write is refused over WebSocket (role filter step), patch API, MCP and
  `.ocanvas` load; seen failing first with validation disabled.
- The sandbox cannot read `document.cookie`, `localStorage` or the editor DOM, cannot open a
  top-level navigation, and cannot `fetch` an origin outside its allow-list (Playwright with a
  hostile sample block).
- Exports of a canvas with `acme.okr` produce the template output in Markdown, HTML, DOCX and PDF.
- A 0.1.x build opens a v0.2 file with an `extBlock` and saves it back without loss.
- Version skew: data at v2, client package at v1 → read-only fallback; package at v3 → migrated
  on first edit, server validates against v3.
- Two editors, one with the package and one without (enabled for only one host): the document
  converges and the second sees the placeholder.

---

## 4. Stable headless API

### 4.1 Problem and user value

Bots, integrations, back-office jobs and other products need to read and write canvases without
running the editor. Today there is a host-key REST patch API (docs/04 §6, docs/05 §7) and an MCP
endpoint for agents, but no stable, versioned, documented API with idempotency, paging and a
client SDK. v0.2 makes that API the supported contract.

### 4.2 Design

**Surface.** `/api/v1/…`, JSON, OpenAPI 3.1 at `/api/v1/openapi.json`. The path major (`v1`)
changes only for breaking changes; within v1 changes are additive. Behaviour changes that cannot
be additive are pinned by an optional date header `OpenCanvas-Version: 2027-02-01` (Notion-style)
so a client can upgrade on its own schedule (Q6). Deprecations carry `Deprecation` and `Sunset`
headers. The 0.1 host routes (`/v1/files/{id}/patch|commit|role|import|session`, `/v1/convert`)
stay as aliases through 0.x.

**Auth, two kinds, one check.**

1. **Host key** (`X-OpenCanvas-Key` + `X-OpenCanvas-Host`): server-to-server, full access to the
   host's files, as today.
2. **User-scoped bearer token**, host-minted exactly like MCP tokens (ADR-032): `iss`, `aud` =
   the host's API URI, `sub` = user, `scope`, `files`, `exp` ≤ 15 min. Effective permission =
   min(scope, host role via `/access` or the token's `role`), re-checked before every write.
   Scopes are the MCP ones (`canvas:read`, `canvas:comment`, `canvas:write`) plus `canvas:admin`
   (role, commit, session close; host key only by default).

**Resources (sketch).**

| Operation | Method and path | MCP tool |
|---|---|---|
| Read a canvas (JSON, Markdown, outline) | `GET /api/v1/files/{fileId}?format=json\|markdown\|outline` | `canvas_read` |
| List blocks | `GET /api/v1/files/{fileId}/blocks?cursor=&limit=` | `canvas_read` (paged) |
| Read one block | `GET /api/v1/files/{fileId}/blocks/{blockId}` | `canvas_read{blockIds}` |
| Find | `GET /api/v1/files/{fileId}/blocks:find?q=&types=` | `canvas_find` |
| Edit blocks (atomic batch) | `POST /api/v1/files/{fileId}/blocks:batch` | `canvas_patch` |
| Databases | `GET …/databases`, `GET …/databases/{dbId}/rows?filter=&sort=&cursor=`, `POST …/rows:upsert`, `POST …/databases`, `POST …/databases/{dbId}/fields` | `db_describe`, `db_query`, `db_upsert_rows`, `db_create`, `db_add_field` |
| Boards | `GET …/boards/{boardId}/shapes`, `POST …/boards/{boardId}/shapes` | `board_read`, `board_add_shapes` |
| Comments | `GET/POST …/comments` | `comment_list`, `comment_add` |
| Members | `GET …/members` | `members_list` |
| Export, import, convert | `GET …/export/{fmt}`, `POST …/import`, `POST /api/v1/convert` | (none) |
| Live blocks | `POST …/live`, `GET …/references` (§2.4) | (none in v0.2) |
| Block types | `GET /api/v1/block-types` | `blocks_describe` |
| Admin | `POST …/commit`, `POST …/role`, `DELETE …/session` | (not over MCP) |

`blocks:batch` takes the existing patch ops (`append`, `insertAfter`, `replace`, `delete`) plus
`editText` (minimal Y.Text diff) and `setAttrs`, each with optional `ifMatch` (the block `rev`),
and a document precondition `If-Match: "<doc rev>"`. All ops apply in one Yjs transaction or
none (scratch doc, as today), origin `api:<sub>`. Answer: `{applied, blockIds, rev}`; a stale
block → `412` with the fresh block (the role of Google Docs' `requiredRevisionId`); no precondition
→ merge (CRDT; `targetRevisionId`-like).

**Idempotency.** Every `POST` accepts `Idempotency-Key` (≤ 255 chars). The server stores
`(host, sub, key) → {request hash, status, response}` for 24 h in the store (new table
`api_idempotency` on SQLite and MySQL/MariaDB; `oc:idem:{host}:{key}` with TTL in Redis-only
mode). A replay returns the stored response with `Idempotency-Replayed: true`; the same key with
a different body → `422 IDEMPOTENCY_KEY_REUSED`; a duplicate that arrives while the first still
runs → `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`, as the draft specifies (the cluster
tool-forward dedupe, which waits instead, keeps its behaviour internally). The SDKs send a key on every write
by default.

**Cursors.** Opaque, base64url, HMAC-signed by the server, never parsed by clients. Block lists
encode a Yjs **relative position** of the last returned block (so a cursor survives concurrent
inserts and deletes: a deleted anchor resumes at its successor) plus the filter. Database rows
encode the row id in `order` plus the filter and sort hash. Responses carry `next_cursor` and
`has_more` in the body and a `Link: <…>; rel="next"` header. `limit` ≤ 100 (rows ≤ 200).
Cursors expire after 1 h (`410 CURSOR_EXPIRED`).

**Rate limits.** Token buckets per host key or token subject (default 10 requests/s, burst 30)
and per file for writes (default 5 batches/s), overridable in `[host.api]`; in a cluster the
counters live in Redis. `RateLimit-Policy` and `RateLimit` headers on every response; `429` with
`Retry-After`. The MCP per-token limit is the same limiter.

**Errors.** RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail` and a
`code` extension carrying the existing codes (`BLOCK_NOT_FOUND`, `STALE_BLOCK`,
`ROLE_FORBIDDEN`, `DOC_TOO_LARGE`, `CONFLICT`, `RATE_LIMITED`, …). The 0.1 aliases keep
`{error:{code,message}}`.

**WebSocket.** Two options for clients that need changes without polling:

1. **Events stream**, `GET /api/v1/files/{fileId}/events` upgraded to WebSocket (and offered as
   SSE): JSON events `block.changed {blockId, rev, by}`, `block.deleted`, `db.row.changed`,
   `comment.added`, `saved {version}`, with a `since` resume token (room sequence); the server
   coalesces per 250 ms. Read scope; the role filter decides what is visible. Webhooks in v0.3
   reuse these event shapes.
2. **CRDT sync** for Yjs-native clients: the existing room WebSocket accepts a headless
   bearer token (no awareness required; a bot awareness entry is stamped like the agent's). The
   Rust SDK can use `yrs` for this mode.

**Relation to MCP.** MCP stays the interface for agents; the API is the interface for programs.
Both call one operation layer: each MCP tool is a thin adapter over an API operation, with the
same input schema (the tool's `inputSchema` is generated from the OpenAPI component), the same
scopes, the same limiter and the same audit. A contract test enumerates the MCP tools and fails
if any lacks a matching operation.

**Clients.**

- **TypeScript** `@opencanvas/client`: types generated from the OpenAPI document
  (`openapi-typescript`), a small hand-written core on `fetch` (Node 20+, Deno, browsers, edge),
  automatic `Idempotency-Key`, retry on `429`/`503` with `Retry-After`, async iterators over
  cursors, typed problem errors, events helper.
- **Rust** `opencanvas-client` crate: `reqwest` + `serde`, models generated from the same
  document (`typify`), the same retry/idempotency/paging behaviour, `Stream` over cursors,
  optional `yrs` feature for CRDT sync. Both are Apache-2.0, versioned with the API.
- A conformance suite (shared JSON fixtures) runs both clients against a real server in CI.

### 4.3 Tests and acceptance

- OpenAPI document validates, and every route in the router is in it (and vice versa).
- Idempotency: the same `blocks:batch` sent twice (also concurrently, also to two cluster nodes)
  applies once; a different body with the same key is refused. Seen failing with the store off.
- Cursor stability: page through 1,000 blocks while another client inserts and deletes; every
  surviving block is returned once.
- Rate limits: headers present; burst over the limit gets `429` with `Retry-After`; MCP and API
  share the bucket.
- Permission: a token with `canvas:read` cannot write; a token whose host role is `view` cannot
  write even with `canvas:write`; a file not in `files` is refused without `/access`.
- MCP parity contract test passes; the 0.1 aliases keep passing their existing tests.
- TS and Rust clients pass the conformance suite on SQLite, MariaDB, MySQL and Redis-only.

---

## 5. Cross-cutting changes

**Data model (all additive, format version 1).**

| Where | Change | Feature |
|---|---|---|
| `content` nodes | `liveBlock`, `blockRef`, `extBlock` | §2, §3 |
| Y roots | `ext: Y.Map<dataId, Y.Map>` | §3 |
| `meta` | `kind: "live"` | §2 |
| `.ocanvas` manifest | `requires.blocks[]` | §3 |
| Store | `api_idempotency` table / Redis keys; no document content | §4 |

**Host contract (docs/05).** Optional `POST /files`; `POST /access` required for live blocks;
token claims `perms.live`, `live[]`; API bearer tokens with `aud` = API URI; `[host.live]`,
`[host.blocks]`, `[host.api]` config; postMessage `Action_InsertLiveBlock`, `UI_LiveBlockOpen`.

**Security summary.** Sandboxed iframes on a separate origin with a hash-pinned CSP; no
third-party code on the server; permission scopes shared by API and MCP; derived grants for live
files never wider than parent ∩ host answer; snapshot policy against leaks; idempotency and rate
limits per subject; docs/07 and docs/18 get a v0.2 audit section before release.

**Feature flags.** `[host.flags] live_blocks`, `block_sdk`, `api_v1` (default off in 0.2.0-alpha,
on by 0.2.0 for the API), as docs/09 P3 requires.

---

## 6. UI that needs prototypes (ADR-011; none designed here)

1. **Make live / insert live block**: selection action, file picker or "new live block", host
   `POST /files` result, undo.
2. **Live block chrome**: source label and link, live badge, presence inside, connecting,
   not-current projection, "No access", read-only, unlink (convert to a local copy), phone layout.
3. **Block reference card** (`blockRef`): read-only projection, refresh state, open source.
4. **Compact block view** for host surfaces (`view="block"`), light and dark, phone width.
5. **SDK block chrome**: third-party badge, loading, crash/fallback, "updated by a newer
   version", read-only, focus ring around the frame.
6. **Slash menu and insert gallery entries** for installed block types (icon, title, search).

No UI for the headless API (it is an API) or for block installation (operator config).

---

## 7. ADRs (Proposed, docs/08)

- **ADR-039** Portable live blocks are host files embedded by reference (Loop model), opened as
  their own rooms; read-only `blockRef`; derived grants via `/access`; snapshot policy; depth 1.
- **ADR-040** Block SDK: one generic `extBlock` node and an `ext` root; JSON Schema manifests
  validated server-side by MOD-01; declarative export templates; no third-party code on the
  server; sandboxed iframe renderers on a separate origin.
- **ADR-041** Headless API v1: `/api/v1`, OpenAPI 3.1, RFC 9457 errors, `Idempotency-Key`,
  signed cursors, `RateLimit` headers, host key or host-minted user tokens, one operation layer
  shared with MCP.
- **ADR-042** `.ocanvas` stays format version 1 for v0.2: additive nodes, roots and manifest
  fields only; 0.1.x round-trip is a release gate.

---

## 8. Delivery breakdown

Rows are in docs/10 §P3 (Todo). Dependency order:

```
MOD-01 (v0.1.0) ─┬─► HAPI-01 ─► HAPI-02 ─► HAPI-03 ─► HAPI-04 ─► HAPI-05 ─► HAPI-06, HAPI-07 ─► HAPI-08
                 ├─► BSDK-01 ─► BSDK-02 ─► BSDK-03* ─► BSDK-04 ─► BSDK-05
                 └─► LIVE-01 ─► LIVE-02 ─► LIVE-03* ─► LIVE-04, LIVE-05, LIVE-06
V2UI-01 (prototypes, starts now) ─► gates every * row's UI
ACC-V2 (docs/23 rows) runs alongside; REL-04 (v0.2 release) last
```

| Row | Item | Size | Depends on |
|---|---|---|---|
| V2UI-01 | Prototypes §6 (1–6) on Artifact, owner approval | M | — |
| HAPI-01 | `/api/v1` router, OpenAPI 3.1 document, RFC 9457 errors, 0.1 aliases | L | MOD-01 |
| HAPI-02 | User-scoped API tokens and scopes shared with MCP (one auth check) | M | HAPI-01 |
| HAPI-03 | `Idempotency-Key` store on SQLite, MySQL/MariaDB and Redis; cluster-safe | M | HAPI-01 |
| HAPI-04 | Signed cursors (relative positions), `RateLimit` headers, shared limiter | M | HAPI-01 |
| HAPI-05 | Events stream (WebSocket and SSE) and headless CRDT sync token | M | HAPI-02 |
| HAPI-06 | TypeScript client `@opencanvas/client` + conformance suite | M | HAPI-04 |
| HAPI-07 | Rust client `opencanvas-client` + conformance suite | M | HAPI-04 |
| HAPI-08 | MCP tools as adapters over API operations; parity contract test | S | HAPI-01 |
| BSDK-01 | Block manifest + JSON Schema registry in MOD-01; `[host.blocks]`; integrity check | M | MOD-01 |
| BSDK-02 | `extBlock` node, `ext` root, declarative export templates, fallbacks | M | BSDK-01 |
| BSDK-03 | Sandboxed iframe runtime, block origin, CSP, bridge RPC | L | BSDK-02, V2UI-01 |
| BSDK-04 | `@opencanvas/block-sdk` package, `oc.progress` and `acme.okr` samples, guide | M | BSDK-03 |
| BSDK-05 | Versioning and migrations; 0.1.x forward-compatibility round-trip test | M | BSDK-02 |
| LIVE-01 | Host contract: `POST /files`, `/access` required, `perms.live`, derived grants | M | MOD-01 |
| LIVE-02 | `liveBlock` node, per-block room sessions (lazy, ≤ 8), depth rule | L | LIVE-01 |
| LIVE-03 | Editor live block chrome and "Make live" (to the approved prototype) | L | LIVE-02, V2UI-01 |
| LIVE-04 | `blockRef` read-only projection and refresh | M | LIVE-02 |
| LIVE-05 | Exports and `.ocanvas` snapshots under `[host.live] snapshot` | M | LIVE-02 |
| LIVE-06 | `view="block"` compact embed and `GET …/render` | M | LIVE-02 |
| ACC-V2 | docs/23 acceptance rows for §2.6, §3.5, §4.3 | S | — |
| REL-04 | v0.2.0 scope lock, audit, release notes | M | all |

Rough total: 3 L + 15 M + 2 S ≈ 25–30 engineer-weeks; three tracks (API, SDK, live) can run in
parallel after MOD-01 and HAPI-01.

---

## 9. Decisions and remaining questions

Decided by the owner on 2026-11-23:

1. **Snapshot policy default: `"title"`.** Someone who cannot open the live file sees only its
   title, never its content; exports carry the title and a link.
2. **Who creates live files: the host, through an optional `POST /files` callback.** The host owns
   files, so "Make live" asks the host to create the file; without the callback the action is hidden.
5. **Who may install blocks: the server operator only,** per host in the hosts file. No upload API.
6. **API versioning: the path major (`/api/v1`).** No date header.
8. **0.1 routes: kept working through v0.2, retired in v0.3** with a deprecation notice in v0.2.

Proceeding with the proposal unless the owner says otherwise:

3. **One socket or many:** per-block room sockets (≤ 8 per page) in v0.2; multiplexing with
   partial sync in v0.4.
4. **Third-party server code:** none in v0.2 (client sandbox and declarative server checks only);
   server-side execution is reconsidered for v0.5.
7. **Default limits:** 10 requests/s per subject and 5 write batches/s per file, configurable per host.
9. **Native surfaces:** web only in v0.2; native clients use the headless API.

---

## 10. Sources

Accessed 2026-11-23 unless a date is given. Facts marked "unverified" in §1 were not confirmed on
the cited page.

1. Notion Help, "Synced blocks", https://www.notion.com/help/synced-blocks
2. Notion API reference, "Block" (`synced_block`), https://developers.notion.com/reference/block
3. Microsoft Learn, "Loop components in Teams" (updated 2026-09-10), https://learn.microsoft.com/en-us/microsoft-365/loop/loop-components-teams
4. Fluid Framework docs, "Containers", https://fluidframework.com/docs/build/containers
5. Microsoft 365 Developer Blog, "Fluid Framework 2 is now production-ready" (2024-06-26), https://devblogs.microsoft.com/microsoft365dev/fluid-framework-2-is-now-production-ready/
6. Coda Packs SDK, "Fetcher", https://coda.io/packs/build/latest/connectors/features/fetcher/
7. Craft Connect API docs, https://connect.craft.do/api-docs/space
8. any-sync repository, https://github.com/anyproto/any-sync
9. Anytype developer portal (API v2 changelog 2025-11-08), https://developers.anytype.io/
10. ProseMirror guide, "Schema", https://prosemirror.net/docs/guide/#schema
11. Tiptap docs, "Create a new node", https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node
12. Editor.js, "Tools API", https://editorjs.io/tools-api/
13. Lexical docs, "Nodes", https://lexical.dev/docs/concepts/nodes
14. BlockNote docs, "Custom blocks", https://www.blocknotejs.org/docs/features/custom-schemas/custom-blocks
15. Notion API: versioning, request limits, pagination, append block children: https://developers.notion.com/reference/versioning, https://developers.notion.com/reference/request-limits, https://developers.notion.com/reference/pagination, https://developers.notion.com/reference/patch-block-children
16. Google Docs API, `documents.batchUpdate`, https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate
17. Atlassian, "Confluence REST API v2 introduction", https://developer.atlassian.com/cloud/confluence/rest/v2/intro/
18. Yjs docs, "Document updates", https://docs.yjs.dev/api/document-updates
19. y-protocols, PROTOCOL.md, https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md
20. Loro repository, https://github.com/loro-dev/loro (1.0 reported October 2024, unverified)
21. IETF draft-ietf-httpapi-idempotency-key-header (rev -09, 2026-11-21), https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
22. Stripe API, "Idempotent requests", https://docs.stripe.com/api/idempotent_requests
23. RFC 9457, "Problem Details for HTTP APIs" (July 2023), https://www.rfc-editor.org/rfc/rfc9457.html
24. IETF draft-ietf-httpapi-ratelimit-headers (rev -12, 2026-11-20), https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
25. OpenAPI Specification 3.1, https://spec.openapis.org/oas/v3.1.0
