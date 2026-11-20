# 15 — Build contract for P1 (server ↔ web ↔ host)

**Status:** binding for the P1 build, 2026-11-21. If a builder needs to change
anything here, they update this file and say so in their report.

## 1. Repository layout

```
Cargo.toml                 Rust workspace
crates/oc-model            .ocanvas zip read/write, Yjs doc helpers, markdown/html export
crates/oc-server           axum binary `opencanvas`: config, host connector, store, rooms, autosave, routes
migrations/sqlite|mysql    identical logical schema (docs/04 §5)
web/packages/ui            design tokens (tokens.css) + shared TS types (BlockEnv, OcUser, Role)
web/packages/editor        Vite + React app: shell, Tiptap editor, gallery, comments, mobile bar
web/packages/database      React database block (table / board / calendar / gallery, CSV)
web/packages/board         React whiteboard block
examples/sample-host       Node reference host (JWT signing + callbacks + file store)
```

The server serves the built editor (`web/packages/editor/dist`) at `/app/`.
`OC_WEB_DIR` overrides the path.

## 2. Launch flow

1. Host page form-POSTs `token=<JWT>` to `POST /v1/launch`.
2. Server verifies the JWT (docs/05 §3, HS256 via the host's `jwt_secret`), creates
   a session row, and answers `303 See Other` → `/app/#t=<ticket>`.
   (The ticket goes in the fragment so it never appears in server logs or Referer headers.)
   `GET /v1/launch?token=` does the same, for hosts that use a plain iframe `src`.
3. The SPA reads `#t`, calls `GET /v1/sessions/<ticket>` → `200`:
   ```json
   { "ticket":"01J…", "room":"r_7k…", "role":"edit",
     "user": {"id":"u_123","name":"Asha Rao","color":"#7a45f0","avatar":null},
     "file": {"id":"doc_8812","name":"Sprint 42 notes"},
     "host": {"id":"Acme","name":"Acme"},
     "perms": {"export":true,"download":true,"comment":true},
     "isNew": true,
     "wsUrl": "ws://localhost:8080/v1/collab" }
   ```
   `isNew` is true when the host returned 404 / an empty file. The SPA then shows
   the template gallery. `401 {"error":{"code":"TICKET_INVALID"}}` when unknown or expired.
   (Implementation: `isNew` = the room's doc has no `content` and empty `meta`/`databases`/`boards`,
   so a second user joining after a template was picked gets `false`.)
   Launch failures answer `401 {"error":{"code":"TOKEN_INVALID"|"TOKEN_REUSED",…}}`; `jti` is
   single-use per host (table `launch_jti`). The algorithm is pinned by the host entry
   (`jwt_alg` = `HS256` with `jwt_secret`, or `RS256`/`EdDSA` with `jwt_public_key` PEM), `aud` must be
   `opencanvas`, `iss` the host id, `exp` at most 10 h ahead, `nbf` honoured, 30 s leeway.
4. Tickets live for the launch token's `exp`. The WS must connect within 60 s of the
   first `GET /v1/sessions`, though reconnects with the same ticket are allowed until `exp`.

## 3. Collaboration WebSocket

`GET /v1/collab/<room>?ticket=<ticket>`, upgraded to a WebSocket. This is compatible with
the stock `y-websocket` `WebsocketProvider(wsUrl, room, doc, { params: { ticket } })`.

Binary frames, y-protocols encoding (lib0 varuint message type first):

| type | meaning |
|---|---|
| 0 | sync: 0 = step1, 1 = step2, 2 = update |
| 1 | awareness update |
| 2 | auth: the server sends `[2, 0 (permission denied), varString reason]` when a write is rejected |
| 3 | query awareness (client → server; the server answers with all awareness states) |
| 100 | OpenCanvas control: varString JSON, both directions |

(Changed 2026-11-21 by the server build: auth is type **2** and query-awareness is 3, as in
y-protocols / y-websocket and yrs. The earlier draft said 3 for auth.)

Server → client control JSON:
`{"t":"saving"}`, `{"t":"saved","at":<epoch ms>,"version":"18"}`,
`{"t":"save_error","retryInMs":10000,"message":"…"}`,
`{"t":"conflict"}`, `{"t":"role","role":"view"}`, `{"t":"closed","reason":"…"}`.
On connect the server sends sync step1 and the current awareness states. When the client's
step1 arrives the server answers with step2, then `{"t":"role",…}` and the current save state
(`saved` with the last known host version, or `saving`). Client → server control messages are
accepted and ignored for now.

Server rules:
- `view` role: sync step2 and update messages are dropped, and an auth frame is sent once.
- `comment` role: an update is accepted only if it touches nothing but the `comments` root
  (applied to a scratch copy of the doc first; updates that create other roots or cannot fully
  integrate are refused). The auth frame is sent once per connection.
- Awareness: the server rewrites the `user` field from the grant before fan-out
  (`{"id","name","color","avatar"}`), so nobody can spoof another person's name or colour.
  Entries over 2 KB, or for a client id owned by another connection, are dropped.
- Frames over `OC_MAX_FRAME_KB` (1024) close the socket with code 1009. More than 60 frames/s
  (burst 120) closes it with 1008. When the ticket expires the server sends
  `{"t":"closed","reason":"session expired"}` and closes with 1008; on shutdown it sends
  `{"t":"closed","reason":"server shutting down"}` and closes with 1012.
- Room ids are `r_` + 26 lowercase base32 chars of sha256(`<hostId>:<fileId>`).

## 4. Y.Doc layout (shared by server export and web)

| root | type | contents |
|---|---|---|
| `content` | XmlFragment | Tiptap/ProseMirror document (`Collaboration` extension, `field: "content"`) |
| `meta` | Map | `title` string, `icon` lucide name, `tone` Tone, `template` id |
| `databases` | Map<dbId, Y.Map> | per database: `name`, `icon`, `tone`, `fields` Y.Array<Y.Map{id,name,type,options(JSON array)}>, `order` Y.Array<rowId>, `rows` Y.Map<rowId, Y.Map<fieldId,value>>, `notes` Y.Map<rowId,string>, `view` string, `views` Y.Map (per-view prefs JSON) |
| `boards` | Map<boardId, Y.Map> | `shapes` Y.Map<shapeId, Y.Map>, `order` Y.Array<shapeId> |
| `comments` | Map<threadId, Y.Map> | `quote`, `resolved`, `messages` Y.Array<Y.Map{user,text,at}> |

Tiptap node types (names are part of the file format, so don't rename them):
`paragraph, heading(level 1-3), bulletList, orderedList, listItem, taskList, taskItem(checked),
blockquote, codeBlock(language), horizontalRule, image(src,alt,caption), callout(tone,icon),
toggle(open) > toggleSummary + toggleContent, database(dbId), board(boardId),
bookmark(url,title,description,site), embed(provider,url,title), fileAttachment(name,size,url,mime),
columns > column, table/tableRow/tableHeader/tableCell, mention(id,label) inline,
commentMark(threadId) mark`.

Field types for databases: `title text status select tags person date number checkbox url progress`.
Option objects: `{ "v": "In progress", "c": "blue" }`. Date values: `YYYY-MM-DD`. Person values: user id.

`.ocanvas` as written by the server: `manifest.json` (`format`, `version` 1, `schemaVersion` 1,
`createdWith`, `title` from `meta.title`, `commit {id, authors, at}`), `document.json` and `ydoc.bin`.
`ydoc.bin` is a Yjs **v1** update (`Y.encodeStateAsUpdate(doc)`); readers also accept v2.
`document.json` is `{type:"doc", content:[…], meta, databases, boards, comments}` where `content`
nodes are `{type, attrs?, content?}` and text is `{type:"text", text, marks?:[{type, attrs?}]}`
(y-prosemirror `mark--hash` keys are reduced to `mark`). If `ydoc.bin` is missing the doc is built
from `document.json` (content and meta exactly; nested maps best-effort).

## 5. Host callbacks (JWT mode). The server calls the host.

Base `callback_base` from the host registry. Headers on every call:
`Authorization: Bearer <callbackToken from JWT>`,
`X-OpenCanvas-Signature: t=<unix>,v1=<hex HMAC-SHA256(jwt_secret, "<t>.<body>")>`.

| Call | Notes |
|---|---|
| `GET /files/{fileId}` | 200 bytes (`.ocanvas` zip, or `text/markdown`), `ETag`; 404 = new file |
| `PUT /files/{fileId}` | body `.ocanvas`; `If-Match`, `Idempotency-Key`, `X-OpenCanvas-Autosave: 1`, `X-OpenCanvas-Authors: <json ids>`; 200 `{"version":"…"}`, 409 conflict |
| `POST /files/{fileId}/assets` | multipart `file` → 201 `{"assetId","url","mime","size"}` |
| `GET /users?q=&fileId=` | `[{"id","name","avatar"}]` |

The HMAC key is the host's `callback_secret` if set, else `jwt_secret`. `If-Match` is the quoted
version from the last load/save (`ETag` of `GET`, else the JWT `file.version`). The PUT carries
`Content-Type: application/vnd.opencanvas+zip`; 412 is treated like 409. For uploads the multipart
body is forwarded byte for byte and the signature covers those bytes.
`OC_CALLBACK_BASE_OVERRIDE`, when set, replaces every host's `callback_base` (dev/compose only;
logged as a warning).

## 6. Server REST used by the SPA

`GET /v1/sessions/:ticket` · `POST /v1/assets?ticket=` (multipart, proxied to host) ·
`GET /v1/users?ticket=&q=` (proxied) · `GET /v1/export/:fmt?ticket=` with `fmt` = `md|html|ocanvas|json` ·
`GET /healthz` · `GET /readyz` · `GET /metrics`.

`ocanvas` export needs `perms.download`, the others `perms.export` (403 otherwise); unknown formats
answer 404 `FORMAT_UNSUPPORTED`. Exports carry `Content-Disposition: attachment; filename="<file name>.<ext>"`.
`POST /v1/assets` needs the `edit` role and `multipart/form-data` (≤ 25 MB); the host's status and
body are passed through. Every response carries `Content-Security-Policy: frame-ancestors 'self'
<all hosts' allowed_origins>` and `Referrer-Policy: no-referrer`.

## 7. Autosave

No manual save anywhere (ADR-012). A room saves when it is dirty and:
- 2 s have passed since the last update (`OC_AUTOSAVE_DEBOUNCE_MS`), or
- 10 s have passed since the first unsaved update (`OC_AUTOSAVE_MAX_MS`), or
- the last client leaves, or the process gets SIGTERM.

Saves are serialized per room. A failure is retried with backoff (1 s, 2 s, 5 s, 10 s, …) and
sends `save_error`. A 409 sends `conflict` and stops autosave for that room until it reloads.

Every accepted update is appended to `room_updates` before fan-out; every 500 updates or 30 s the
WAL is compacted into `room_snapshots`. A room that was dirty when the process died is rebuilt
from snapshot + WAL on the next join instead of reloading from the host. A clean room with no
clients for `OC_ROOM_TTL_SECS` (600) closes and its rows are purged.

## 8. Ports in dev

Server `:8080`, sample host `:4000`, Vite dev `:5173` (proxying `/v1` to `:8080`, ws included).
