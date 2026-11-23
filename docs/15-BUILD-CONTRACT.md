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
examples/wopi-host         Node reference WOPI host (CheckFileInfo/GetFile/PutFile/PutRelative)
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
     "host": {"id":"acme","name":"Acme"},
     "perms": {"export":true,"download":true,"comment":true,"print":true,"history":true,"restore":true,"commitMessage":true},
     "history": "full", "historySource": "host", "historyHostName": "Acme",
     "isNew": true,
     "ai": {"enabled":true,"modes":["edit","comment","answer"],"mcp":false},
     "import": {"formats":["md","html","csv"]},
     "wsUrl": "ws://localhost:8080/v1/collab" }
   ```
   *(VH-01a)*: `history` `full` | `link` | `none`, `historySource` `host` | `file` (the list shown
   first), `historyHostName`, and in link mode `historyUrl` + `historyPostMessage` (docs/05 §5a).
   `perms.history`, `perms.restore`, `perms.commitMessage` are effective (the role included).
   `ai` (AI-02): `enabled` when `[host.ai] enabled = true` and the role is not `view`; `modes` are
   the run modes the server accepts for the role (`edit`: `edit`, `comment`, `answer`; `comment`:
   `answer`, `comment`; `view`: none); `mcp` mirrors `[host.ai] mcp`. The editor shows the
   assistant from this; `?ai=1` only turns it on when `ai` is absent (demo, dev).
   `isNew` is true when the host returned 404 / an empty file. The SPA then shows
   the template gallery.
   *(docs/21 revision 2)*: `user` is `{id, name, color, avatar, detail?}`, never an e-mail. A `GET`
   lifts a role-API revoke for that viewer (a fresh token means access). `401 {"error":{"code":"TICKET_INVALID"}}` when unknown or expired.
   (Implementation: `isNew` = the room's doc has no `content` and empty `meta`/`databases`/`boards`,
   so a second user joining after a template was picked gets `false`.)
   Launch failures answer `401 {"error":{"code":"TOKEN_INVALID"|"TOKEN_REUSED",…}}`; `jti` is
   single-use per host (table `launch_jti`). The algorithm is pinned by the host entry
   (`jwt_alg` = `HS256` with `jwt_secret`, or `RS256`/`EdDSA` with `jwt_public_key` PEM or
   `jwt_jwks_url`; JWKS is cached 10 min, the token's `kid` must match a key whose type fits
   `jwt_alg`, an unknown `kid` refetches at most every 30 s), `aud` must be
   `opencanvas`, `iss` the host id, `exp` at most 10 h ahead, `nbf` honoured, 30 s leeway.
   **WOPI launch** (docs/05 §6, added 2026-11-21): `POST /v1/launch?WOPISrc=<urlencoded>` with form
   `access_token` (+ `access_token_ttl`, ms since the epoch) for a host with `mode = "wopi" | "both"`
   whose `wopi_allowlist` admits the URL (else `403 WOPISRC_NOT_ALLOWED`); CheckFileInfo decides
   role, user and perms (`401 TOKEN_INVALID` when it answers 4xx). Same `303`. The ticket lives
   until `access_token_ttl` (10 h when absent). `GET /hosting/discovery` (XML) and
   `GET /hosting/capabilities` (JSON). A JWT for a `mode = "wopi"` host is refused.
   **Open at a block** (UX-02): a `block` form field (or `?block=` query) on either launch adds
   `&block=<id>` to the fragment (`/app/#t=<ticket>&block=<id>`) when it matches
   `[A-Za-z0-9_-]{1,64}`; the editor scrolls to that block and flashes it.
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
`{"t":"conflict","policy":"copy","fileId":"doc_9001","url":"…"}` (room stays read-only; joiners
get it as the save state),
`{"t":"conflict","policy":"reload"}` (followed by `closed` and close code 1012: the client must
drop its local Y.Doc and reconnect, the room now holds the host's version),
`{"t":"role","role":"view"}` (also sent mid-session when the host changes the role),
`{"t":"closed","reason":"…"}` (`access revoked` → close 1008; `closed by the host` → close 1000),
`{"t":"ping"}` (heartbeat every `OC_HEARTBEAT_MS`, default 10 s, on every connection; clients
treat 15 s without any frame as a lost connection, docs/06 §5; added 2026-11-21, UX-02),
`{"t":"reconnect"}` (always followed by close **1012**: the client keeps its Y.Doc and
reconnects; sent on graceful drain and, in cluster mode, when the room moved to another node).
(Changed 2026-11-21 by the server hardening: `conflict` carries `policy`.)
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
  (`{"id","name","color","avatar","detail"?}`), so nobody can spoof another person's name or colour.
  *(docs/21 revision 2)* Every recipient gets the same states: real names for everyone with access.
  Entries over 2 KB, or for a client id owned by another connection, are dropped.
- An update that would push the encoded doc over `OC_MAX_DOC_MB` (20) is refused with an auth
  frame `document size limit reached`; while a conflict is being handled every write is refused.
- Frames over `OC_MAX_FRAME_KB` (1024) close the socket with code 1009. More than 60 non-awareness
  frames/s (burst 120) closes it with **4429** `"rate limit"` (not 1008, which only means access
  revoked / session expired). Awareness frames (type 1) have their own bucket of 120/s (burst 240);
  excess awareness frames are dropped silently, never fatal. Clients should still batch (y-websocket
  awareness throttling, 50 ms update windows).
  (Changed 2026-11-21: was 1008 with awareness counted against the same bucket; fast typing tripped it.) When the ticket expires the server sends
  `{"t":"closed","reason":"session expired"}` and closes with 1008; on shutdown (SIGTERM drain)
  it commits dirty rooms, then sends `{"t":"reconnect"}` and closes with 1012.
  (Changed 2026-11-21 by CLU-01: was `{"t":"closed","reason":"server shutting down"}`.)
- Cluster mode (ADR-006): the socket may land on any node. A node that does not own the room
  relays it to the owner over an internal WebSocket; the protocol above is unchanged, roles
  are enforced by the owner. If the owner dies the client gets `reconnect` + 1012 (or a
  dropped socket) and reconnects with the same ticket.
- Room ids are `r_` + 26 lowercase base32 chars of sha256(`<hostId>:<fileId>`).

### 3.1 AI control messages (AI-02, ADR-034; docs/24 §10)

Client → server (type 100 JSON); answers go only to the sending connection:

| Message | Who | Effect |
|---|---|---|
| `{"t":"ai-run","runId","prompt","selection"?,"selectionBlockIds"?,"mode"?,"confirm"?}` | `edit`: modes `edit` (default), `comment`, `answer`; `comment`: `answer` (default) and `comment` only; `view`: refused | Starts a run on the room owner node. `runId` is chosen by the client, `[A-Za-z0-9_-]{1,64}`, unique per room. `selectionBlockIds` (optional; one per selection line, or one for the whole selection) only places injection flags. `confirm` (boolean; default `true` in mode `edit`, ignored otherwise): the run stops after `ai-plan` and calls no tool (so writes nothing) until `ai-approve` |
| `{"t":"ai-approve","runId"}` | the user who started the run | Lets a run waiting on its plan act ("Nothing changes until you run it"). Ignored for any other run, user or state. Without it the wait ends after 10 minutes: outcome `cancelled`, `reason: "plan_timeout"`; the run's time limit starts on approval |
| `{"t":"ai-cancel","runId"}` | the user who started the run | Aborts the model call or the wait for approval; the current tool call finishes; outcome `cancelled` |
| `{"t":"ai-undo","runId"}` | the user who started the run | Reverts every change made with origin `ai:<runId>` (once; in memory, lost if the room moves) |

Server → client:

| Message | When |
|---|---|
| `{"t":"ai-plan","runId","plan":[{"n","text","kind"}],"awaitingApproval","flags"}` | After the plan call (modes `comment` and `edit`). `plan` is the steps in order, `n` from 1, `kind` one of `create`, `update`, `suggest`, `read` (a server-side classification of the step text; the panel marks `suggest` steps). `awaitingApproval: true` when the run waits for `ai-approve`. `flags` (always present, often empty): prompt-injection flags on the selection, see below |
| `{"t":"ai-step","runId","step","tool","ok","error"?,"flags"?}` | After each tool call; `error` is a code (`not_allowed`, `forbidden`, `bad_input`, `not_found`, `stale`, `confirmation_required`, `internal`). `flags` when a read tool returned instruction-like content |
| `{"t":"ai-done","runId","outcome","summary"?,"reason"?,"steps","writes","undoable","usage":{"input","output"},"flags"?}` | `outcome`: `done`, `cancelled` (`reason: "plan_timeout"` when approval never came), `limit` (`reason`: `steps`, `time`, `tokens`, `writes`, `quota`), `error`, `refused` (with `reason`), `undone` |

**Prompt-injection flags** (docs/24 §9.1 T1). The server scans the content a run reads (the
selection before the plan, then every read tool's result) with a deterministic heuristic for
text addressed to the assistant: "ignore previous/your instructions", "disregard the above",
"you are now", "send/email/post/forward this … to …", a line starting with a speaker label
(`assistant:`, `AI,`, `Claude:`, `system:`), and system-prompt markers (`system prompt`,
`<|im_start|>`, `[INST]`, `<<SYS>>`, a stray `</canvas_data>`). Each hit is
`{"blockId": string|null, "kind": "instruction_in_content", "excerpt"}` (the matched line, at
most 120 characters; `blockId` null for a whole-page read or an unplaced selection line), at
most 20 per message. `ai-done.flags` is every flag of the run. Detection **never blocks the run
and never changes what the model gets**: the content is still sent as data inside
`<canvas_data>` and tool results, and the system prompt still says it is never an instruction.
The panel shows one note on the plan or answer card when flags exist. The excerpt goes only to
the requesting connection; it is never logged or sent in audit events.

Other people see the agent only as an awareness entry (`user.id = "ai:<runId>"`, `name =
"Assistant"`, `agent: true`, `cursor.blockId` at the last touched block) and its edits. A run is
cancelled when its user's last connection leaves. Audit events go to the host as
`POST {callback_base}/ai/events` through the notification outbox, signed like every callback:
`{runId, fileId, userId, agent, event, counts, at}` with `event` one of `run.started`,
`tool.called`, `run.finished`, `run.cancelled`, `run.undone`. No prompts, outputs or tool
arguments are sent or logged.

## 4. Y.Doc layout (shared by server export and web)

| root | type | contents |
|---|---|---|
| `content` | XmlFragment | Tiptap/ProseMirror document (`Collaboration` extension, `field: "content"`) |
| `meta` | Map | `title` string, `icon` lucide name, `tone` Tone, `template` id |
| `databases` | Map<dbId, Y.Map> | per database: `name`, `icon`, `tone`, `fields` Y.Array<Y.Map{id,name,type,options(JSON array)}>, `order` Y.Array<rowId>, `rows` Y.Map<rowId, Y.Map<fieldId,value>>, `notes` Y.Map<rowId,string>, `view` string, `views` Y.Map (per-view prefs JSON) |
| `boards` | Map<boardId, Y.Map> | `shapes` Y.Map<shapeId, Y.Map>, `order` Y.Array<shapeId>; *(DGM-14, optional)* `name` string, the board's own name shown in diagram mode (additive: older clients ignore it, every reader keeps it, the exporters don't draw it) |
| `comments` | Map<threadId, Y.Map> | `quote`, `resolved`, `messages` Y.Array<Y.Map{user,name,color,text,at,mentions?,labels?}>; *(docs/21)* `labels` = `{userId: "@label as inserted"}`, so the text shows the member's current name in place of the inserted label |
| `people` | Map<userId, object> | *(docs/21, optional)* who opened the file: `{id, name, detail?, avatar?, lastSeen}` (ms), never an e-mail. Written by the server on join (never makes the room dirty; `lastSeen` refreshed at most hourly). The member list when the host gives neither token `members` nor the members callback; otherwise only fills a missing `detail`/`avatar` |

Tiptap node types (names are part of the file format, so don't rename them):
`paragraph, heading(level 1-3), bulletList, orderedList, listItem, taskList, taskItem(checked),
blockquote, codeBlock(language), horizontalRule, image(src,alt,caption), callout(tone,icon),
toggle(open) > toggleSummary + toggleContent, database(dbId), board(boardId),
bookmark(url,title,description,site), embed(provider,url,title), fileAttachment(name,size,url,mime),
columns > column, table/tableRow/tableHeader/tableCell, mention(id,label) inline,
commentMark(threadId) mark, dateMention(date) inline, textColor(color) mark`.

*(UX-02 / FILE-01 / LAY-01, ADR-027; all optional and additive, older clients keep them)*:
- `textColor(color)` mark: `color` ∈ `gray red amber green blue purple pink` (the tone tokens'
  `--<tone>-fg`, AA in light and dark). Anything else is ignored on parse and in exports.
  HTML `<span data-color="blue">`; exports: HTML inline `color` (light palette), DOCX run colour,
  Markdown plain text.
- `dateMention(date)` inline atom: `date` = `YYYY-MM-DD`. Shown as a chip ("Today", "Tomorrow",
  "Nov 24"); inserted with `@today`, `@tomorrow`, "Pick a date…" in the @ menu or `/date`.
  HTML `<span data-type="dateMention" data-date>` (parses `<time datetime>` too); exports:
  Markdown `2026-12-04`, HTML `<time datetime="2026-12-04">Dec 4, 2026</time>`, DOCX `Dec 4, 2026`.
- `fileAttachment` gains `display` (`card` | `preview`; absent = `preview` for PDFs, `card`
  otherwise) and `height` (inline preview height in CSS px, 240-1600; absent = 70 % of the
  viewport, at most 900). Exports never embed a viewer: HTML
  `<p class="oc-file" data-display><a>name</a> <span class="oc-file-meta">PDF · 2 KB</span></p>`,
  Markdown `[name](url) (PDF, 2 KB)`, DOCX a link.
- `columns` gains `widths` ("25,75": whole percents, one per column; absent = equal; 2-4
  columns; the editor snaps boundaries to quarters). `column` gains `title` (a label line above
  its blocks; absent = none). HTML exports the grid and a bold title line; Markdown a bold line.

**Block ids.** Any block node may carry an optional string attribute `blockId` (convention
`b_` + 26 lowercase base32 chars, e.g. `b_01jd…`). It is how the host patch API (§6) addresses
blocks; ids are unique within a document. Blocks the patch API inserts always get one (the
caller's `attrs.blockId` is kept, else one is generated). The editor must declare `blockId` as a
global attribute on block nodes (Tiptap `addGlobalAttributes`, default `null`, not rendered) and
keep it when a node is edited; a split keeps it on the first half only and pasting/duplicating
clears it. Without that, y-prosemirror drops the attribute the first time a user edits the block.
(Added 2026-11-21 by the server API build.)
*(VH-00, 2026-11-24)*: an **editable** editor gives every block in `BLOCK_ID_TYPES` that has none
an id: local edits in the same transaction (a split's second half, a new block), and documents
loaded or changed from Yjs (older files, blocks an 0.1.x client inserts) in a follow-up
transaction outside the undo history. A later copy of an id already used gets a fresh one (the
first in document order keeps it); a paste drops only the ids still in the document, so cut and
paste or a drag that moves a block keeps its id. Read-only editors and an empty, not yet loaded
fragment are never written. Two editors that assign ids to the same block at once converge on
one (a Yjs attribute is last-writer-wins). 0.1.x clients already declare the attribute, so they
keep the ids. Shared fixture `crates/oc-model/tests/fixtures/blockids.ydoc.bin` (web
`blockId.test.ts`, Rust `tests/roundtrip.rs`: Yjs → `document.json` → `.ocanvas`).

**Board shape keys** (`boards/<id>/shapes/<shapeId>` Y.Map; all optional except `type`; source of
truth `web/packages/board/src/model.ts`). `type`: `sticky rect ellipse diamond text arrow pen swatch
image`. Geometry `x y w h` (numbers; `text` anchors at its first baseline), `pts` `[[x,y],…]` for
`arrow`/`pen`. Paint order is `order` (back to front; z-order buttons rewrite it), then any shape
missing from `order` by id.

| key | on | meaning |
|---|---|---|
| `fill` | sticky | `y p b g` (default `y`) |
| `fill` | swatch | `accent amber green pink purple red blue` |
| `fill` | rect, ellipse, diamond | *(UX pass)* tone `gray blue green amber red purple pink`: fill `--<tone>-bg`, outline `--<tone>-fg`; unset or unknown = plain (`--app` fill) |
| `stroke` | pen, rect, ellipse, diamond | `"accent"` draws the outline/stroke in the accent colour (a tone `fill` wins for the outline) |
| `text` | sticky, rect, ellipse, diamond, text | the shape's text; `\n` breaks lines |
| `text` | arrow | *(UX pass)* connector label, trimmed, drawn in a pill at the path's midpoint |
| `size` | text | font size (default 18; UI offers 14 18 24 32) |
| `size` | rect, ellipse, diamond | *(UX pass)* text size (default 14, ellipse 15; UI offers 13 14 16 20), line height `round(size×1.3)` (ellipse `×1.27`) |
| `label` | rect | small uppercase corner label (frames) |
| `dashed` | rect | dashed frame, never filled |
| `group` | any | *(UX pass)* shapes with the same group id select and move together; no visual |
| `start`, `end` | arrow | `{shapeId, anchor}`, anchor `top right bottom left center` |
| `route` | arrow | `"elbow"` orthogonal route, `"straight"`/unset a line |
| `via` | arrow | *(open items, ADR-025)* manual waypoints `[[x,y],…]`, in order. The path runs end → waypoints → end; a `center`-bound end aims at the nearest waypoint (straight: outline toward it; elbow: the side facing it). Elbow with waypoints: each leg is an L (one corner), the first leaves along the start side's axis (else the leg's longer axis), each next leg leaves at a right angle to how the previous arrived, the last enters along the end side's axis (two corners at the leg's midpoint when an L can't). Entries that aren't arrays of ≥ 2 read as missing; non-numbers read as 0. Writers keep `pts` = the resolved path. Moving a connector with both bound shapes moves its waypoints too |
| `src`, `alt` | image | URL or `data:` URL; alt text |
| `kind` | any box | *(diagrams, ADR-045)* namespaced shape kind `<namespace>:<name>` (lowercase, e.g. `uml:class`) refining `type`; `type` stays the kind's legacy base, which is what 0.1.x clients and the exporters draw |
| `kindVersion` | with `kind` | *(ADR-045)* schema version of the kind's `props` (positive integer) |
| `props` | with `kind` | *(ADR-045)* kind-specific properties: a nested Y.Map under the shape, one key per property (values plain JSON), so concurrent edits of different properties merge; read as an object. Writers merge per field (`updateShape` with `props`: `undefined` removes one). A plain-object `props` (0.1.x copies) reads the same and is converted to the map on the next edit; `document.json` import creates the map |
| `ports` | any box | *(ADR-045)* named connection points `[{id, side?, x?, y?, kind?}]` added to the five legacy anchors; `x`/`y` are fractions of the box (0..1), `side` `top right bottom left`; ids must not be a legacy anchor name |
| `start.port`, `end.port` | arrow | *(ADR-045)* the port an end is bound to. `anchor` is always written next to it (the side the port degrades to) and is where 0.1.x clients and both exporters draw the end until the renderers learn ports |

Diagram fields *(ADR-045, accepted 2026-11-24; DGM-03/04/08/16)*: every key above is optional and additive. Readers
keep keys they do not know; writers set only the keys they change (never rewrite a shape's map),
and keep every field of a binding they re-point (copy/paste). A shape whose `type` is not one of
the nine above is kept; both exporters draw it as a `rect` (with its `text`, `label`, `fill`) when it
has a box (`w > 0`, `h > 0`, no `pts`) and draw nothing otherwise (shared fixture
`crates/oc-model/tests/fixtures/board-diagram.{json,web.svg}`); the editor canvas does not draw it yet
(placeholder UI awaits a prototype, ADR-011).

Text wrapping *(UX pass)*: sticky, rect, ellipse and diamond text wraps greedily at whitespace to
`w − 28` (sticky, 14 px), `max(20, w − 16)` (rect), `max(20, w × 0.72)` (ellipse), `max(20, w × 0.6)`
(diamond); connector labels to 180 px at 12.5 px. Every UTF-16 unit counts `size × 0.56` px; longer
words are cut. A sticky's stored `h` grows on commit to `ceil(30 + (lines − 1) × 20 + 22)` and never
shrinks; exports apply the same rule. The web and Rust exporters implement this identically (shared
fixture `crates/oc-model/tests/fixtures/board.{json,web.svg}`).

Board awareness *(UX pass)*: `board` `{x, y, sel}`; `sel` lists the peer's selected shape ids, and
`board` may carry only `sel` while the pointer is outside the board.

**Database view prefs** (`databases/<id>/views` Y.Map, JSON per view name `table board calendar
gallery`; source `web/packages/database/src/types.ts` `ViewPrefs`): `q` search; `cal` calendar month
`YYYY-MM`; `filter` `{f, vals[]}` / `sort` `{f, dir: 1|-1}` (single rule, kept for older clients).
*(UX pass)*: `sorts` `[{f, dir}]` applied in order, wins over `sort` (writers keep `sort` = first);
`filters` `[{f, vals}]` ANDed, wins over `filter` (writers keep `filter` = first); `widths`
`{fieldId: px}` table column widths; `group` field id the board view groups by (status/select);
`date` field id the calendar places rows on; `cover` gallery cover: `"none"`, `"color"` (default) or
a URL field id.
*(Open items, ADR-025)*: `fields` field ids in this view's order (unknown ids ignored, fields missing
from it follow in the shared order; column moves write this, never the shared `fields` array);
`hidden` field ids hidden in this view (the title field is always shown). `filters` rules may be
typed: `{f, op, v?, v2?}` with `op` per field type — text/title/url `contains is empty` (case-insensitive,
on the cell's text); number/progress `eq ne lt le gt ge between empty` (`v`, `v2` numbers; `ne` also
matches empty cells; `between` is inclusive in either order); date `is before after` (`v` `YYYY-MM-DD`),
`next past` (`v` days, inclusive of today), `empty`. Status/select/tags/person/checkbox rules keep
`vals` (any of; checkbox `"true"`/`"false"`). Unfinished rules (no value yet, or an `op` the field type
doesn't take) are kept but filter nothing. `filter` mirrors the first `vals` rule only.

**Database field keys** (`fields` Y.Array of Y.Map): `id`, `name`, `type`, `options` (as above) and
*(ADR-025)* `description` — optional plain-text note (may be multi-line, absent when blank). Shown as a
header tooltip and in the row peek; exported in `document.json` (as stored) and as a footnote line
`*Field*: text` under the table in Markdown (web "Copy as Markdown" and the server export), not in CSV.

Field types for databases: `title text status select tags person date number checkbox url progress`.
Option objects: `{ "v": "In progress", "c": "blue" }`. Date values: `YYYY-MM-DD`. Person values: user id.

`.ocanvas` as written by the server: `manifest.json` (`format`, `version` 1, `schemaVersion` 1,
`createdWith`, `title` from `meta.title`, `commit {id, authors, at}`), `document.json` and `ydoc.bin`.
`ydoc.bin` is a Yjs **v1** update (`Y.encodeStateAsUpdate(doc)`); readers also accept v2.
`document.json` is `{type:"doc", content:[…], meta, databases, boards, comments, people?}` (`people` only
when non-empty) where `content`
nodes are `{type, attrs?, content?}` and text is `{type:"text", text, marks?:[{type, attrs?}]}`
(y-prosemirror `mark--hash` keys are reduced to `mark`). If `ydoc.bin` is missing the doc is built
from `document.json` (content and meta exactly; nested maps best-effort).

### 4.1 Validation (MOD-01)

`oc_model::validate(&Doc)` / `validate_json(&document.json)` / `validate_blocks(prefix, &[node])`
return `Report {errors, warnings}`; each issue has a JSON-pointer path (`/content/3/content/0`,
`blocks/1/attrs/level` for patch input) and a message. **Errors** refuse the input: `read_ocanvas`
fails with `Error::Invalid("<path>: <message>")`, and `apply_patch` (REST patch, md/html import,
MCP writes) answers 400 `PATCH_INVALID` naming the op and node. **Warnings** never refuse; the
content is kept as is and counted in `oc_schema_warnings_total`.

| rule | error | warning |
|---|---|---|
| node shape | not an object, no string `type`, `attrs` not an object, `content` not an array | unknown node type (its children are still checked) |
| attributes | wrong value type or range: `heading.level` 1-3, `orderedList.start` integer, `checked`/`open` booleans, `image.align` `left right`, `image.width` number, `fileAttachment.size` ≥ 0, `height` 240-1600, `display` `card preview`, `columns.widths` whole percents, cell `colspan`/`rowspan` ≥ 1, `colwidth` array, `dateMention.date` `YYYY-MM-DD`, ids (`dbId boardId mention.id threadId`) non-empty strings, other attributes strings. `null` always means the default | unknown attribute; `callout.tone` / `textColor.color` outside the tones |
| content | `paragraph heading toggleSummary`: inline only; `codeBlock`: unmarked text; `bulletList orderedList`: `listItem+`; `taskList`: `taskItem+`; `listItem taskItem blockquote toggleContent column tableCell tableHeader`: one or more blocks; `callout`: `paragraph+`; `toggle`: `toggleSummary toggleContent`; `columns`: `column+`; `table`: `tableRow+`; `tableRow`: cells+; atoms (`horizontalRule image database board bookmark embed fileAttachment mention dateMention hardBreak`) no content; parts (`listItem column tableRow …`) and inline nodes inside a block-only parent | `columns` with other than 2-4 columns or a `widths` count that doesn't match; inline content (bare text) at the document's top level, which server tools have always written |
| text and marks | empty `text`, `content` on text, `marks` not an array, mark without `type`, wrong mark attr type (`link.href` string, `commentMark.threadId` id) | unknown mark |
| ids | `blockId` not a non-empty string | duplicate `blockId`; `database`/`board` block whose id is not in `databases`/`boards` |
| databases | entry/fields/rows not the right JSON type, field without an id, duplicate field id, option without string `v`, `order` not strings, `notes`/`views` not objects | unknown field type; `order` entry missing from `rows` |
| boards | `shapes` not an object, shape without string `type`, `x y w h size` not numbers, `pts` not `[x, y]` pairs, `start`/`end` without `shapeId`, string keys not strings | unknown shape type, bad `via` entries, `order` entry missing from `shapes` |
| document | not an object, `type` other than `doc`, `meta databases boards comments people` not objects, `meta.title icon tone template` not strings, thread `messages` not an array | — |

A patch's blocks are checked on their own (each root may be any known node, so a `listItem`
can replace a `listItem`); they are not checked against where they are inserted.

## 5. Host callbacks (JWT mode). The server calls the host.

Base `callback_base` from the host registry. Headers on every call:
`Authorization: Bearer <callbackToken from JWT>`,
`X-OpenCanvas-Signature: t=<unix>,v1=<hex HMAC-SHA256(jwt_secret, "<t>.<body>")>,v2=<hex HMAC-SHA256(jwt_secret, "<t>.<METHOD>.<path?query>.<body>")>`.
(`v2` added 2026-11-21 by the security audit, ADR-022: it binds the method and path; hosts should
verify `v2` and may fall back to `v1`. Callbacks never follow redirects.)

| Call | Notes |
|---|---|
| `GET /files/{fileId}` | 200 bytes (`.ocanvas` zip, or `text/markdown`), `ETag`; 404 = new file |
| `PUT /files/{fileId}` | body `.ocanvas`; `If-Match`, `Idempotency-Key`, `X-OpenCanvas-Autosave: 1`, `X-OpenCanvas-Authors: <json ids>`; 200 `{"version":"…"}`, 409 conflict |
| `POST /files/{fileId}/assets` | multipart `file` → 201 `{"assetId","url","mime","size"}` |
| `GET /files/{fileId}/members?q=&limit=` *(optional, docs/21)* | signed GET with the asking viewer's `callbackToken`; `[user…]` or `{"members":[…]}` (≤ 500; `id`, `name`, `detail?`, `avatar?`, `color?`; any `email` ignored); cached 60 s per (room, q); 404/405/410/501 or a failure = no callback (token and saved map apply). The cache is dropped by `POST /v1/files/:id/role` with `none`, `DELETE /v1/files/:id/session` and `POST /v1/files/:id/members/invalidate` |
| `POST /files/{fileId}/copies` | conflict policy `copy`: body `.ocanvas`, `Idempotency-Key`; 200/201 `{"fileId","url"}` |
| `POST /mentions` *(optional)* | JSON `{fileId, blockId?, threadId?, mentioned:[userId], by, excerpt}`, `Idempotency-Key`; any 2xx; 404/405/410/501 = not implemented. Queued in `notify_outbox` first, retried with backoff (8 attempts). Never in WOPI mode (docs/05 §5) |

The HMAC key is the host's `callback_secret` if set, else `jwt_secret`. `If-Match` is the quoted
version from the last load/save (`ETag` of `GET`, else the JWT `file.version`). The PUT carries
`Content-Type: application/vnd.opencanvas+zip`; 412 is treated like 409. For uploads the multipart
body is forwarded byte for byte and the signature covers those bytes.
`OC_CALLBACK_BASE_OVERRIDE`, when set, replaces every host's `callback_base` (dev/compose only;
logged as a warning).

## 6. Server REST used by the SPA

`GET /v1/sessions/:ticket` · `POST /v1/assets?ticket=` (multipart, proxied to host; WOPI mode:
stored with the room, `201 {"assetId","url":"/v1/assets/<id>","mime","size"}`, ≤ 10 MB each, ≤ 50 MB
per file) · `GET /v1/assets/:id?ticket=` (WOPI mode only, else 404) ·
`GET /v1/members?ticket=&q=` → `{"members":[{id,name,color,detail?,avatar?}]}` (docs/21 revision 2:
the same list for every viewer; merged by id, members callback > token `members` > the saved `people`
map, which counts only when the host gave neither; the viewer is always in; people revoked by the
role API are left out; never e-mail) · `GET /v1/export/:fmt?ticket=` with `fmt` = `md|html|ocanvas|json|docx|pdf` (all but `ocanvas`
render mention labels and person cells with members' current names; non-members keep the stored label, docs/21) ·
`GET /v1/export/board/:boardId.svg|png?ticket=` ·
`POST /v1/import?format=md|html|csv&ticket=[&blockId=][&name=]` (raw body ≤ 5 MiB; edit role; format
must be in `[host.flags] import_formats` and `OC_IMPORT` not `off`, else `403 IMPORT_OFF`; CSV ≤ 10,000
rows and ≤ 200 columns, else `413 IMPORT_TOO_LARGE`) → `{"format","blockIds",…}`, one transaction
through the room; the session response's `import.formats` lists what the editor may offer (empty for
non-editors or when off) · `GET /healthz` · `GET /readyz` · `GET /metrics`.

Host → server (docs/05 §7), headers `X-OpenCanvas-Host: <id>` + `X-OpenCanvas-Key: <api_key>`
(`api_key` in the host entry; 401 `API_KEY_INVALID` otherwise):
`POST /v1/files/:fileId/role {"userId","role":"view|comment|edit|none"}` → `{"connections","sessions"}`;
`DELETE /v1/files/:fileId/session` → final save, close all, drop tickets → `{"closed","sessions"}`;
`POST /v1/files/:fileId/patch` → `{"applied","blockIds","live"}` (+ `version` when no room was live);
`POST /v1/files/:fileId/commit` → `200 {"live","saved","version"}` / `202 {"queued":true}` / `409 CONFLICT`;
`POST /v1/files/:fileId/import?format=&author=` → like the session import, plus `live` (+ `version` when no room was live);
`POST /v1/convert?from=md|html|ocanvas&to=ocanvas|md|html|json|docx|pdf` (raw body in, file out).
Optional `X-OpenCanvas-Callback-Token`: the bearer used for callbacks made for that request (loading /
saving a file with no live room, fetching images); without it the bearer is empty and the host
authenticates the call by the HMAC signature. Details in docs/04 §6 and docs/05 §7.

DOCX (`export/docx`, `convert to=docx`): minimal WordprocessingML written with `zip` (no new crate).
Headings, marks, links (http/https/mailto only), bullet/numbered/task lists, quotes, code, tables,
callouts (shaded paragraphs), databases (caption + table), boards (a PNG rendered at 2×, shown at 1×,
caption "Whiteboard", alt text = the board's texts; a text note only if rendering fails),
bookmarks/embeds/files (links). Images that were not fetched (see *Images in exports*) become links.

Boards (`oc_model::board`, changed 2026-11-21): `to_svg(doc, boardId)` is a port of the web
`exportBoardSvg` (light palette, fitted to content + 32 px, stickies, rect/frame, ellipse, diamond,
swatch, text, pen, arrows incl. bound ends and elbow routes, images as `<image href>`); a parity test
compares it byte for byte with the web output. `to_png(svg, scale)` renders with `resvg` and the
embedded Geist Regular/SemiBold (OFL), no system fonts; only inline `data:` images are drawn (remote
URLs and file paths are never read); ≤ 16384 px a side, ≤ 64 Mpx. Exports: HTML inlines the board
SVG (`<figure class="board">`); Markdown keeps the note and, for ticketed exports, adds
`[Whiteboard (SVG)](<OC_PUBLIC_URL>/v1/export/board/<id>.svg?ticket=<ticket>)` (the link carries the
session ticket and stops working when it expires); `GET /v1/export/board/:boardId.svg` (image URLs
kept) / `.png` (allowed images inlined) need `perms.export`; unknown board 404 `BOARD_NOT_FOUND`.

PDF (ADR-010): `OC_PDF_RENDERER=gotenberg:<url>` → the print HTML is posted to Gotenberg's
`/forms/chromium/convert/html` (A4, 0.6" margins, backgrounds) and the PDF is streamed back
(`502 PDF_RENDERER_FAILED` if it fails). The print HTML is self-contained: allowed images and board
images inlined as `data:` URLs, other images are links, CSP `default-src 'none'; img-src data:` so the
renderer fetches nothing. Unset → `501 {"error":{"code":"PDF_RENDERER_NOT_CONFIGURED"}}` (the editor
uses its print stylesheet instead).

Images in exports (DOCX, board PNG, PDF): fetched only from allowed origins — the host's
`callback_base` origin (relative `/…` resolves there; signed + callback token), the original
`callback_base` origin while `OC_CALLBACK_BASE_OVERRIDE` is active (fetched through the override,
signed), and the host's `asset_origins = ["https://cdn…"]` (plain GET, no signature or token).
No redirects, ≤ 10 MB, `Content-Type: image/*` required, ≤ 50 per export; anything else is skipped.

`perms.print` (added 2026-11-21 with WOPI mode; JWT `perms.print`, WOPI `DisablePrint`, default
true) is additionally required for `pdf`.
`ocanvas` export needs `perms.download`, the others `perms.export` (403 otherwise); unknown formats
answer 404 `FORMAT_UNSUPPORTED`. Exports carry `Content-Disposition: attachment; filename="<file name>.<ext>"`.
`POST /v1/assets` needs the `edit` role and `multipart/form-data` (≤ 25 MB); the host's status and
body are passed through. Every response carries `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff` and a CSP ending in `frame-ancestors 'self' <all hosts'
allowed_origins>`: by default `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none';
form-action 'self'; img-src 'self' https: http: data: blob:; …`; exports (`/v1/export/*`, `/v1/convert`)
are served with `sandbox; default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'`,
room assets with `default-src 'none'; sandbox`. (Changed 2026-11-21 by the security audit, ADR-022.)
`GET /metrics` needs `Authorization: Bearer <OC_METRICS_TOKEN>` when that variable is set.
`GET /v1/members` refuses `q` over 200 bytes (`400 QUERY_TOO_LONG`). A room holds at most 550
connections (the next is closed with 1013 `room full`); a socket that stops reading is closed.

`GET /v1/assets/fetch?ticket=&url=` (FILE-01): an attachment's bytes served from this origin,
for previews (pdf.js and text previews can't read the host's origin). Same rules as export image
fetching: the URL must be on the host's `callback_base` origin (fetched signed) or an
`asset_origins` entry (plain GET), exact origin, no userinfo, never following redirects
(`403 ASSET_ORIGIN_NOT_ALLOWED`, `502 ASSET_UNAVAILABLE`, `404 ASSET_NOT_FOUND`). Streamed, at most
50 MB (`413 ASSET_TOO_LARGE`). Any role may preview (`perms.download` only hides the editor's
Download action; downloads keep the original URL). Answers with the real `Content-Type`,
`Content-Disposition: inline`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox; default-src 'none'`. Room-served WOPI assets
(`/v1/assets/:id`) are already same-origin and are used as they are.

## 7. Autosave

No manual save anywhere (ADR-012). A room saves when it is dirty and:
- 2 s have passed since the last update (`OC_AUTOSAVE_DEBOUNCE_MS`), or
- 10 s have passed since the first unsaved update (`OC_AUTOSAVE_MAX_MS`), or
- the last client leaves, or the process gets SIGTERM.

Saves are serialized per room. Each commit (`.ocanvas` bytes, idempotency key, base version,
sealed callback token) is written to `commit_outbox` as `pending` **before** the PUT; retries
resend the same row. 200 marks it `done` (payload dropped), 409 `conflict`, a newer commit marks
older pending rows `superseded`. A failure is retried with backoff (1 s, 2 s, 5 s, 10 s, …) and
sends `save_error`. At startup (and every 60 s) a sweeper reopens every room with a pending row
(from WAL, or from the outbox payload when there is no WAL) so the save continues after a restart.

A 409 stops autosave and applies the host's `[host.flags] on_conflict` (default `copy`):
`copy` → `POST /files/{id}/copies` with the room's state, then `conflict` with `fileId`/`url`;
the room is read-only and closes as soon as the last client leaves. `reload` → `GET` the
host's file, replace the room's state with it, send `conflict` + `closed`, close every socket.

Every accepted update is appended to `room_updates` before fan-out. A room writes the updates
that queued while its previous append ran as one batch (one row and `seq` per update, one
epoch-guarded statement, all or nothing), then fans them out in order; on SQLite one writer task
commits the batches of many rooms in one transaction (group commit, docs/22 §9.3). Every 500
updates or 30 s the
WAL is compacted into `room_snapshots`. A room that was dirty when the process died is rebuilt
from snapshot + WAL on the next join instead of reloading from the host. A clean room with no
clients for `OC_ROOM_TTL_SECS` (600) closes and its rows are purged.

WOPI mode (docs/05 §6): the same outbox and autosave; `HostClient` sends the save to the WOPI host
(PutFile with `X-COOL-WOPI-Timestamp` = the tracked `LastModifiedTime`; `409` + `COOLStatusCode`
1010 = conflict; policy `copy` = PUT_RELATIVE). The `saved` control's `version` is the host's
`LastModifiedTime`. Assets of a WOPI room live in `room_assets` (migration 0003) and are inlined as
`assets/<id>` + `assets/index.json` on every save; rows of rooms that are gone and have no pending
commit are swept by the 60 s sweeper (10 min grace).

## 8. Secrets and limits

`OC_KEK` (base64 of 32 bytes) seals the host callback token (in WOPI mode: the access token) in `sessions.grant_json` and
`commit_outbox.token` with AES-256-GCM (`enc:v1:<base64(nonce‖ct)>`, bound to the row id). The
server refuses to start without it unless `OC_DEV=1` (then tokens are stored in clear, with a
warning). `OC_MAX_DOC_MB` (20) caps the encoded document; 60 frames/s (burst 120) per socket.

Convergence fuzz: `cargo test -p oc-server --test fuzz` runs `OC_FUZZ_ITERS` (200) random rooms;
`OC_FUZZ_ITERS=10000 cargo test --release -p oc-server --test fuzz -- --nocapture` for the long
run, `OC_FUZZ_SEED=<n> OC_FUZZ_ITERS=1` to replay a failing seed.

## 9. Ports in dev

Server `:8080`, sample host `:4000`, Vite dev `:5173` (proxying `/v1` to `:8080`, ws included).
