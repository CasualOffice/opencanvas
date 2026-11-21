# 04 — Technical Design (LLD)

**Status:** draft v0.1, 2026-11-21. Companion to
[03-HLD-ARCHITECTURE.md](03-HLD-ARCHITECTURE.md).

## 1. Repository layout

```
canvas/
├── Cargo.toml                    # Rust workspace
├── crates/
│   ├── oc-model/                 # block schema, .ocanvas (de)serialiser, validation
│   ├── oc-collab/                # room actor, yrs doc, role filter, awareness, WAL
│   ├── oc-host/                  # host connector: JWT verify, WOPI client, callbacks
│   ├── oc-store/                 # sqlx Any, migrations, repositories
│   ├── oc-render/                # preview HTML, MD/HTML/DOCX/PDF/SVG exporters
│   ├── oc-unfurl/                # SSRF-safe link preview / oEmbed
│   └── oc-server/                # axum binary: routes, config, ops, cluster bus
├── migrations/{sqlite,mysql}/    # same logical schema, dialect-specific DDL
├── web/                          # pnpm workspace
│   ├── packages/core/            # schema, Yjs layout helpers, md/html serialisers
│   ├── packages/editor/          # Tiptap editor + extensions
│   ├── packages/board/           # board block
│   ├── packages/preview/         # read-only renderer
│   └── packages/embed/           # host SDK (<open-canvas>, postMessage)
├── examples/sample-host/         # reference host (Node/Express) — JWT + callbacks
├── deploy/                       # Dockerfile, compose, helm (P2)
└── docs/
```

Dependency DAG (no cycles): `oc-model ← oc-collab, oc-render, oc-host ← oc-server`;
`oc-store` depends only on `oc-model` types.

## 2. Document model

### 2.1 Logical block tree
A canvas is an ordered tree of **blocks**. Every block has a stable ID
(`b_` + 21-char nanoid) that survives moves — required for comments,
deep-links, REST patches and (P3) portable live blocks.

```ts
type Block = {
  id: string;               // stable
  type: BlockType;
  attrs: Record<string, Json>;
  content?: Inline[];        // text-bearing blocks
  children?: Block[];        // containers: columns, toggle, table rows, callout
};

type BlockType =
  | "paragraph" | "heading" | "quote" | "callout" | "divider" | "code"
  | "bulletList" | "orderedList" | "taskList" | "listItem" | "taskItem" | "toggle"
  | "table" | "tableRow" | "tableCell" | "tableHeader"
  | "image" | "file" | "linkCard" | "embed"
  | "board" | "columns" | "column"
  | "unknown";              // preserved verbatim, rendered as placeholder

type Inline =
  | { type: "text"; text: string; marks?: Mark[] }
  | { type: "mention"; attrs: { kind: "user" | "date"; id: string; label: string } }
  | { type: "emoji"; attrs: { name: string } }
  | { type: "hardBreak" };

type Mark = { type: "bold"|"italic"|"underline"|"strike"|"code"|"highlight"
                   |"textColor"|"link"|"comment"; attrs?: Json };
```

Key attrs:
| Block | attrs |
|---|---|
| heading | `level: 1..3` |
| callout | `icon`, `tone: info|warn|success|danger` |
| code | `language` |
| taskItem | `checked`, `assignee?` (host user id), `due?` (ISO date) |
| table | `colWidths: number[]`, `headerRow: bool`, `headerCol: bool` |
| image | `assetId`, `src` (host URL or signed proxy), `alt`, `caption`, `width`, `align`, `w`, `h` |
| file | `assetId`, `name`, `size`, `mime` |
| linkCard | `url`, `title`, `description`, `image`, `siteName`, `fetchedAt` |
| embed | `provider`, `url`, `embedUrl`, `aspect`, `height` |
| board | `boardId` (key into `boards` map), `height`, `viewport` |
| columns | `widths: number[]` (2–3) |

### 2.2 Yjs document layout
One `Y.Doc` per canvas:

```
Y.Doc
├── "content"   : Y.XmlFragment   ← ProseMirror tree via y-prosemirror
├── "boards"    : Y.Map<boardId, Y.Map>
│      └── boardId → { "shapes": Y.Map<shapeId, Y.Map>,
│                      "order":  Y.Array<shapeId>,     // z-order
│                      "meta":   Y.Map }               // background, grid
├── "databases" : Y.Map<dbId, Y.Map>                   // ADR-013
│      └── { "fields": Y.Array<Y.Map{id,name,type,options}>,
│            "rows":   Y.Map<rowId, Y.Map<fieldId, value>>,  // per-cell LWW
│            "order":  Y.Array<rowId>,
│            "views":  Y.Array<Y.Map{type,filter,sort,groupBy}> }
├── "comments"  : Y.Map<threadId, Y.Map>               // P2
│      └── { anchor, resolved, messages: Y.Array<Y.Map> }
├── "assets"    : Y.Map<assetId, Y.Map>                // host asset refs, mime, size
└── "meta"      : Y.Map  { title, icon, cover, schemaVersion, createdBy }
```

Board shape (Y.Map fields): `id, type (pen|rect|ellipse|diamond|line|arrow|
text|sticky|image|frame), x, y, w, h, rot, stroke, fill, strokeWidth, opacity,
points (Y.Array<number> for pen, compressed), text (Y.Text for text/sticky),
start/end bindings (connectors: {shapeId, anchor}), locked, groupId`.
Per-field LWW maps mean two users moving and recolouring the same shape both
win; pen strokes are append-only.

Why separate roots: role filtering by subtree (commenters may only write
`comments`), and the board can grow to thousands of shapes without bloating
the ProseMirror tree.

### 2.3 `.ocanvas` file format (ADR-009)
A zip (stored/deflate), the **only** thing the host stores:

```
manifest.json      { "format":"ocanvas", "version":1, "schemaVersion":1,
                     "createdWith":"opencanvas/0.1.0", "title":"…",
                     "commit": { "id":"01J…", "message":"…", "authors":[…],
                                 "at":"2026-11-21T…Z" } }
document.json      the logical block tree (§2.1) + boards + comments + meta —
                   human/tool readable, the source of truth for importers
ydoc.bin           Yjs state (encodeStateAsUpdateV2) — fast, lossless reload
                   of CRDT identity, so a reopened file keeps merge history
preview.html       optional static render (hosts can show it without us)
thumbnail.png      optional 640×360 thumbnail
```

Load rule: if `ydoc.bin` exists and its `schemaVersion` matches → use it;
else build the Doc from `document.json`. Unknown block types and unknown attrs
are kept verbatim (`unknown` node with raw JSON) — no silent loss.

Also accepted as input: `.md`, `.html`, `.txt` (converted on load; first
commit writes `.ocanvas` unless the host requested `saveAs=md`, in which case
lossy content is listed in a compatibility report sent with the commit).

## 3. Collaboration protocol (WebSocket)

Endpoint: `wss://{server}/collab/{roomId}?ticket={sessionTicket}`.
`roomId` = `hostId:fileId` hashed (sha256 → base32, 26 chars).

Binary frames, y-protocols compatible so stock `y-websocket` clients work:

| Byte 0 (msg type) | Payload | Direction |
|---|---|---|
| 0 `sync` | sub-type 0 step1 (state vector) / 1 step2 (diff) / 2 update | both |
| 1 `awareness` | awareness update (clientID, clock, JSON state) | both |
| 3 `auth` | permission-denied reason / role changed | s→c |
| 100 `oc-control` | JSON: `saved`, `saving`, `conflict`, `role`, `kick`, `commit-request`, `error` | both |

Server per-frame rules:
1. Frame size ≤ 1 MB (configurable); rate ≤ 60 frames/s/connection (token bucket).
2. `sync update` from `view` role → dropped + `auth` frame.
   From `comment` role → applied to a scratch doc, diffed; accepted only if
   it touches `comments` root exclusively, otherwise rejected.
3. Applied updates are appended to WAL (`room_updates`) **before** fan-out ack.
4. Awareness payload ≤ 2 KB; server stamps `user` fields from the grant so a
   client cannot impersonate another user's name/colour.

Client control messages (JSON over type 100):
```json
{ "t":"commit", "message":"Sprint notes final" }
{ "t":"follow", "user":"u_123" }
```
Server control messages:
```json
{ "t":"saving" }
{ "t":"saved", "commitId":"01J…", "hostVersion":"42", "at":"…" }
{ "t":"conflict", "policy":"copy", "newFileUrl":"…" }
{ "t":"role", "role":"view" }        // host revoked edit via REST
{ "t":"error", "code":"HOST_UNAVAILABLE", "retryInMs":5000 }
```

## 4. Room engine

One tokio task (actor) per live room; mailbox of `Join | Leave | Frame |
Commit | Patch | Tick | Shutdown`.

```
struct Room {
  id, host_id, file_id,
  doc: yrs::Doc,
  awareness: Awareness,
  peers: HashMap<ConnId, Peer{ grant, tx, rate }>,
  host_version: Option<String>,       // from last load/commit
  dirty_since: Option<Instant>,
  contributors: HashSet<UserId>,      // since last commit
  wal_seq: u64, snapshot_seq: u64,
}
```
- Compaction: every 500 updates or 30 s → `encode_state_as_update_v2` →
  upsert `room_snapshots`, delete `room_updates <= seq`.
- Commit scheduling: `Tick` every 1 s checks autosave/idle rules.
- Server-side patches (REST markdown/JSON) are converted to a Yjs transaction
  on the server Doc with origin `api:{client}` and broadcast like any update.

## 5. Database schema (portable subset)

```sql
CREATE TABLE hosts (
  id            VARCHAR(64) PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  mode          VARCHAR(16)  NOT NULL,           -- 'jwt' | 'wopi' | 'both'
  jwt_alg       VARCHAR(16),                     -- HS256 | RS256 | EdDSA
  jwt_secret    TEXT,                            -- encrypted at rest (AES-GCM, KEK from env)
  jwt_jwks_url  TEXT,
  callback_base TEXT,                            -- https://host/api/opencanvas
  allowed_origins TEXT NOT NULL,                 -- JSON array, frame-ancestors
  config_json   TEXT NOT NULL,                   -- flags, embed allow-list, limits
  created_at    BIGINT NOT NULL
);

CREATE TABLE sessions (
  id          VARCHAR(32) PRIMARY KEY,           -- ticket id (ULID)
  room_id     VARCHAR(32) NOT NULL,
  host_id     VARCHAR(64) NOT NULL,
  file_id     VARCHAR(255) NOT NULL,
  user_id     VARCHAR(255) NOT NULL,
  role        VARCHAR(8)  NOT NULL,              -- view|comment|edit
  grant_json  TEXT NOT NULL,                     -- perms, display, host token (encrypted)
  expires_at  BIGINT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX ix_sessions_room ON sessions(room_id);
CREATE INDEX ix_sessions_exp  ON sessions(expires_at);

CREATE TABLE rooms (
  id            VARCHAR(32) PRIMARY KEY,
  host_id       VARCHAR(64) NOT NULL,
  file_id       VARCHAR(255) NOT NULL,
  host_version  VARCHAR(255),
  owner_node    VARCHAR(64),
  dirty         SMALLINT NOT NULL DEFAULT 0,
  last_commit_at BIGINT,
  last_active_at BIGINT NOT NULL,
  UNIQUE (host_id, file_id)
);

CREATE TABLE room_snapshots (
  room_id   VARCHAR(32) PRIMARY KEY,
  seq       BIGINT NOT NULL,
  state     LONGBLOB NOT NULL,                   -- BLOB on SQLite
  updated_at BIGINT NOT NULL
);

CREATE TABLE room_updates (
  room_id   VARCHAR(32) NOT NULL,
  seq       BIGINT NOT NULL,
  data      MEDIUMBLOB NOT NULL,
  origin    VARCHAR(255),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, seq)
);

CREATE TABLE commit_outbox (
  id          VARCHAR(32) PRIMARY KEY,           -- commit_id ULID (idempotency key)
  room_id     VARCHAR(32) NOT NULL,
  payload     LONGBLOB NOT NULL,                 -- .ocanvas bytes
  message     TEXT,
  authors     TEXT NOT NULL,                     -- JSON
  attempts    INT NOT NULL DEFAULT 0,
  next_try_at BIGINT NOT NULL,
  status      VARCHAR(16) NOT NULL,              -- pending|done|failed|conflict
  last_error  TEXT
);

CREATE TABLE unfurl_cache (
  url_hash  CHAR(64) PRIMARY KEY,
  data      TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
```
SQLite: WAL mode, `busy_timeout=5000`, `synchronous=NORMAL`. MySQL/MariaDB:
InnoDB, `utf8mb4`, `ROW_FORMAT=DYNAMIC`. Timestamps are epoch ms `BIGINT` to
stay dialect-neutral.

## 6. REST API (server)

All JSON; errors `{ "error": { "code": "…", "message": "…" } }`.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/launch` (form: `token`, `mode`) | launch JWT or WOPI token | returns editor HTML; sets ticket |
| `GET  /v1/sessions/{ticket}` | ticket | grant + room info for the SPA |
| `GET  /v1/preview` `?token=` | JWT/WOPI | read-only HTML |
| `GET  /v1/export/{fmt}` `?ticket=` | ticket + `export` perm (`download` for ocanvas) | md/html/json/docx/pdf/ocanvas |
| `GET  /v1/export/board/{boardId}.{svg,png}` `?ticket=` | ticket + `export` perm | one board, fitted to content |
| `POST /v1/assets` (multipart) | ticket, edit | proxies upload to host asset callback |
| `GET  /v1/assets/{id}` | ticket | proxies/redirects to host asset URL |
| `GET  /v1/unfurl?url=` | ticket | link preview |
| `POST /v1/files/{fileId}/patch` | host API key | markdown/JSON block patch into live room or file |
| `POST /v1/files/{fileId}/commit` | host API key | force commit now |
| `POST /v1/files/{fileId}/role` | host API key | change/revoke a user's role live |
| `DELETE /v1/files/{fileId}/session` | host API key | close room (commit then kick) |
| `POST /v1/convert` | host API key | stateless convert (md→ocanvas, ocanvas→pdf…) |
| `GET /healthz` `/readyz` `/metrics` | none / internal | ops |

Patch body:
```json
{ "ops": [
  { "op": "append",  "markdown": "- [ ] Follow up with design" },
  { "op": "insertAfter", "blockId": "b_x1", "blocks": [ { "type":"callout", … } ] },
  { "op": "replace", "blockId": "b_x2", "markdown": "## New heading" },
  { "op": "delete",  "blockId": "b_x3" } ],
  "author": { "id": "bot-1", "name": "Standup bot" } }
```

Patch rules (implemented 2026-11-21):
- `markdown` or `blocks` (Tiptap JSON block nodes), exactly one per op; `author.id` required.
- `insertAfter` / `replace` / `delete` address a block by its `blockId` attribute (docs/15 §4), at
  any depth; `append` adds to the end of the document. New top-level blocks get a `blockId`
  (returned in `blockIds`, in order) unless the caller set one.
- All ops run on a scratch copy first, so a failing op changes nothing: `404 BLOCK_NOT_FOUND`,
  `400 PATCH_INVALID`, `413 DOC_TOO_LARGE` (over `OC_MAX_DOC_MB`), `409 CONFLICT` (room in a save
  conflict). At most 500 ops.
- Live room: one Yjs transaction with origin `api:<author.id>`, WAL-logged and broadcast like a
  client update; the author is added to `X-OpenCanvas-Authors`; autosave as usual →
  `200 {"applied","blockIds","live":true}`.
- No live room: the room opens (loads the file from the host), applies, saves at once →
  `200 {…,"live":false,"version":"…"}` or `202 {…,"queued":true}` when the PUT failed (outbox).

Commit: `200 {"live":true,"saved":true,"version"}` after the host acknowledged;
`{"saved":false}` when already clean; `202 {"queued":true,"message"}` when the PUT failed and
waits in the outbox; `409 CONFLICT`. A file with no live room and no pending outbox row answers
`200 {"live":false,"saved":false,"version":null}`; a pending row is resumed and committed.

Convert: `POST /v1/convert?from=md|html|ocanvas&to=ocanvas|md|html|json|docx`, body = the input
file, answer = the output file. `400 FORMAT_UNSUPPORTED` / `400 INPUT_INVALID`. HTML input is read
by a small forgiving parser (scripts/styles dropped, `javascript:` links dropped).

## 7. Configuration

| Env | Default | Meaning |
|---|---|---|
| `OC_BIND` | `0.0.0.0:8080` | listen addr |
| `OC_PUBLIC_URL` | — | external base URL (required in prod) |
| `DATABASE_URL` | `sqlite://./data/opencanvas.db?mode=rwc` | `mysql://user:pw@h/db` for MySQL/MariaDB |
| `REDIS_URL` | unset | enables cluster mode |
| `OC_NODE_ID` | hostname | cluster node id |
| `OC_KEK` | — | 32-byte base64 key-encryption key for host secrets |
| `OC_HOSTS_FILE` | `./opencanvas.hosts.toml` | static host registry (alternative to DB) |
| `OC_AUTOSAVE_SECS` | 60 | autosave commit interval when dirty |
| `OC_COMMIT_IDLE_SECS` | 30 | commit after idle |
| `OC_ROOM_TTL_SECS` | 600 | purge after last leave + committed |
| `OC_MAX_DOC_MB` | 20 | hard CRDT size cap |
| `OC_MAX_FRAME_KB` | 1024 | WS frame cap |
| `OC_PDF_RENDERER` | unset | `gotenberg:http://gotenberg:3000`; unset → PDF export answers 501 (ADR-010) |
| `OC_LOG` | `info` | log level, JSON |

## 8. Front-end design

- **Editor:** Tiptap 2 (ProseMirror) + `@tiptap/extension-collaboration`
  (`y-prosemirror`) + `collaboration-cursor`. Custom node views for image,
  file, linkCard, embed, board, columns, callout, toggle. Slash menu, block
  drag handle, floating format toolbar, table menu.
- **Board:** React-free vanilla TS renderer (SVG for ≤ 2 000 shapes,
  Canvas2D layer for pen strokes); spatial index (RBush) for hit-testing;
  pointer events with coalesced points; perfect-freehand-style stroke
  smoothing (MIT). Pointers via awareness `{board, x, y}`.
- **Undo:** `Y.UndoManager` scoped to local origin, shared across content and
  boards with tracked origins.
- **Offline buffer:** `y-indexeddb` optional (disabled by default because the
  host owns persistence; enabled for flaky networks via host flag).
- **Preview package:** renders `document.json` to DOM with zero Yjs, used for
  preview mode and SSR parity tests.
- **Bundle budget:** core+editor ≤ 300 KB gz, board lazy-loaded ≤ 60 KB gz,
  preview ≤ 60 KB gz.

## 9. Testing strategy

| Layer | Tests |
|---|---|
| Model | round-trip `document.json ↔ Y.Doc ↔ .ocanvas` property tests; unknown-block preservation |
| Collab | convergence fuzz (N clients, random ops, random delivery order, disconnects) — 10 000 iterations in CI |
| Role filter | view/comment write attempts rejected (fails without filter) |
| Host | contract tests against sample host + WOPI conformance subset |
| DB | every migration on SQLite, MySQL 8, MariaDB 10.11 in CI |
| Cluster | 3-node compose: kill owner mid-edit, assert no acked update lost |
| E2E | Playwright: two browsers type, draw, comment, commit; preview/export |
| Perf | k6/WS soak: 2 000 conns/node, 50 editors/room, p95 latency gate |
| Security | SSRF suite for unfurl, XSS corpus for paste/import, JWT negative tests |
