# 08 — Architecture Decision Register

Status values: **Proposed** (awaiting approval) · **Accepted** · **Superseded**.
The owner signed off the design documents and every remaining Proposed entry on 2026-11-24.

| ID | Decision | Status |
|---|---|---|
| ADR-001 | Host owns identity, ACL and storage; OpenCanvas owns editing, collaboration, preview, export and commits | Accepted (owner sign-off, 2026-11-24) |
| ADR-002 | CRDT = Yjs on client, yrs on server (y-protocols wire format) | Accepted (owner sign-off, 2026-11-24) |
| ADR-003 | Server in Rust (tokio + axum), single binary | Accepted (owner sign-off, 2026-11-24) |
| ADR-004 | DB via sqlx: SQLite default, MySQL 8 / MariaDB 10.6+ when `DATABASE_URL` set; DB holds transient state only | Accepted (owner sign-off, 2026-11-24) |
| ADR-005 | Two handshakes: signed JWT launch and WOPI-compatible; WS uses a short single-room ticket | Accepted (owner sign-off, 2026-11-24) |
| ADR-006 | Cluster: one owner node per room via Redis lease; non-owners relay over an internal HMAC-signed WebSocket | Accepted (implemented CLU-01, chaos-tested CLU-02) |
| ADR-007 | Editor: Tiptap/ProseMirror + y-prosemirror | Accepted (owner sign-off, 2026-11-24) |
| ADR-008 | Board: native block, custom SVG/Canvas2D renderer on Y.Map shapes | Accepted (owner sign-off, 2026-11-24) |
| ADR-009 | Native format `.ocanvas` zip (document.json + ydoc.bin + manifest) | Accepted (owner sign-off, 2026-11-24) |
| ADR-010 | Exports rendered in Rust (MD/HTML/DOCX, boards via `resvg` with embedded Geist); PDF via optional Gotenberg sidecar (`OC_PDF_RENDERER`), 501 + browser print fallback without it | Accepted |
| ADR-012 | Autosave only, no manual save or version messages in the UI; version history is the host's | Accepted (user decision 2026-11-21) |
| ADR-013 | Database block: typed fields + table/board/calendar/gallery views over one row set, stored as a Y.Map in the canvas Doc; CSV import/export | Accepted (owner sign-off, 2026-11-24) |
| ADR-014 | Template gallery: built-in templates are `.ocanvas` files shipped with the server; hosts may add team templates via a `templates` callback | Accepted (owner sign-off, 2026-11-24) |
| ADR-015 | Durable saves through `commit_outbox` with idempotency keys; startup sweeper resumes pending saves | Accepted |
| ADR-016 | Conflict policy per host: `copy` (save mine as a copy via `POST /files/{id}/copies`) or `reload` (close 1012, clients reload host version) | Accepted |
| ADR-017 | Callback tokens encrypted at rest with AES-256-GCM under `OC_KEK`; server refuses to start without it unless `OC_DEV=1` | Accepted |
| ADR-018 | Exported files are self-contained: boards embed as data: SVG in Markdown, never as links carrying a session ticket | Accepted |
| ADR-019 | Editor bundle: Tiptap extensions imported individually (no StarterKit), plugin-only late loading after first paint (never node/mark specs), terser; `check-budget.mjs` fails the build over 300 KB gz initial JS | Accepted |
| ADR-020 | Render fonts: embedded Geist + OFL subsets of Noto Sans Symbols 2 / Math (≤ 300 KB) + system fonts + `OC_FONT_DIRS`, Noto-first fallback, one warning per missing script; new direct deps `fontdb`, `ttf-parser`, `unicode-script` (already in the tree via resvg); image ships `fonts-noto-core` + `fonts-noto-cjk` | Accepted |
| ADR-021 | WOPI mode is a save-target variant behind `HostClient` (rooms unchanged); `WOPISrc` is the file id and must match the host's `wopi_allowlist`; assets inlined into the `.ocanvas` as `assets/<id>` | Accepted |
| ADR-022 | Security hardening (docs/18): one header middleware (SPA CSP `script-src 'self'`, handler CSPs kept + `frame-ancestors` appended, `nosniff`, `no-referrer`); callback signature gains `v2` (method + path bound, `v1` kept); signed callbacks never follow redirects; `OC_METRICS_TOKEN`; room cap 550 peers, 8 awareness ids/connection, slow readers dropped; `zip` 2 → 9; host ids `[A-Za-z0-9._-]` | Accepted (security audit 2026-11-21) |
| ADR-023 | Editor UX pass (docs/19): optional `image.width` (percent 20-100) and `image.align` (left/right; absent = centred) attrs; comment messages may carry `mentions` (user ids); postMessage gains `UI_Block_Link` (canvas → host) and `Action_ScrollToBlock` (host → canvas) | Accepted |
| ADR-024 | Board/database data-format additions from the blocks UX pass (docs/15 §4): shape `fill` tones on rect/ellipse/diamond, `size` on shapes, arrow `text` labels, `group`, awareness `board.sel`; database view prefs `sorts`, `filters`, `widths`, `group`, `date`, `cover`. All optional and additive (old clients ignore them); web and Rust board exporters draw them identically with a fixed wrap rule (0.56 em per UTF-16 unit) | Accepted (2026-11-21) |
| ADR-025 | Blocks open items (docs/15 §4, docs/20): board arrow `via` (manual waypoints, drawn identically by the web and Rust exporters; `pts` keeps the resolved path); database field `description` (shared field map, in `document.json`, footnote line under the table in web and server Markdown, not in CSV); view prefs `fields` (per-view order) and `hidden`, typed `filters` rules `{f, op, v, v2}` (legacy `filter` mirrors the first value-list rule only); `BlockEnv.undoManager` (optional; blocks join the editor's Y.UndoManager instead of a private one). All optional and additive | Accepted (2026-11-21) |
| ADR-026 | Users and identity (docs/21 revision 2, 2026-11-22): the mention list is the canvas's members (token `members[]` ≤ 500, optional signed `GET /files/{fileId}/members` cached 60 s per room, else the saved `people` map; callback > token > saved); the same list and real names for every viewer; one user object `id, name, detail?, avatar?, color?`, never e-mail; chips show the member's current name or the snapshot + "No longer has access"; revocation via the role API or `POST /v1/files/:id/members/invalidate` takes effect at once; `GET /v1/members`. Revision 1 (per-viewer relations, hidden/external, nicknames, `coviewers`, `participants`, `showEmail`, `/users`, `/users/resolve`) removed | Accepted (revision 2, 2026-11-22) |
| ADR-027 | Editor/server open items (docs/19 UX-02, FILE-01, LAY-01): host callback `POST /mentions` + `notify_outbox` table; control `ping` heartbeat; `textColor` mark and `dateMention` node; `fileAttachment.display/height`, `columns.widths`, `column.title`; `GET /v1/assets/fetch` preview route; `UI_BlockLink` and launch `block`; `BlockEnv.undoManager` used; new dependency `pdfjs-dist` (lazy) | Accepted (2026-11-21) |
| ADR-030 | Redis-only cluster storage: `REDIS_URL` without `DATABASE_URL` keeps snapshots, WAL, authoritative epochs (`INCR`), commit and mention outboxes, sessions, used launch `jti` (`SET NX EX`) and assets in Redis behind the same `Store`; with SQL, a Redis wipe restores epochs from `room_epochs` instead of fencing every room; `oc:instance` detects wipes | Accepted (2026-11-22) |
| ADR-029 | Memory durability (`OC_DURABILITY=memory`, the default without Redis): rooms live in memory and their state is dumped to the DB every `OC_DB_SYNC_MS` (2 s) and before saves, drain and close; `wal` keeps ADR-028; SQLite write turn; idle eviction `OC_ROOM_IDLE_MS` (60 s) | Accepted (2026-11-22) |
| ADR-031 | AI is a server-side plug-in capability: a `ModelProvider` abstraction with two protocols: `anthropic` (Claude Platform) and `openai-compatible` (OpenAI, vLLM, Ollama, llama.cpp, LM Studio); browser → OpenCanvas server → model server only; per-profile `tools` capability gates agent mode configured in server config/env (`[ai.providers]`, keys in env or sealed with `OC_KEK`), enabled per host in `hosts.toml` (`[host.ai]`, flags, quotas); browsers never see keys; document content is sent to the configured provider and the docs say so; BYO-in-browser and host AI callbacks rejected (owner decision 2026-11-22) (docs/24 §4, §8) | Accepted (owner, 2026-11-22) |
| ADR-032 | OpenCanvas MCP server at `/mcp/{hostId}`: MCP 2026-07-28 stateless streamable HTTP (2025-11-25 negotiated), tools over one Rust canvas tool layer shared with REST patch and the agent runtime; OAuth 2.1 resource server only (RFC 9728 PRM per host, audience-bound host-issued tokens ≤ 15 min, scopes `canvas:read/comment/write/write:direct`, no token passthrough); effective permission = min(scope, host role via launch grant or new `POST /access` callback) (docs/24 §5, §7) | Accepted (owner, 2026-11-22) |
| ADR-033 | AI edits as a visible collaborator: server-stamped agent identity and awareness, origin `ai:<runId>`, agent in `X-OpenCanvas-Authors`, server-side per-run undo, `rev`/`ifMatch` optimistic writes with minimal Y.Text diffs (no locks), and a new `suggestions` Y root (direct vs suggest modes; `comment` role may write `comments` and `suggestions`) (docs/24 §6) | Accepted (owner, 2026-11-22) |
| ADR-034 | Agent runtime inside the server: plan → act → review loop as a task on the room owner node, tools filtered by the invoking user's role, grant re-checked before each write, limits (steps, wall clock, tokens, writes, runs per user, concurrent runs per room, host monthly quota), cancel via `ai-cancel`, no network/file/code tools; new control messages `ai-run`, `ai-cancel`, `ai-undo`, `ai-step`, `ai-plan`, `ai-done` (docs/24 §10) | Accepted (owner, 2026-11-22) |
| ADR-035 | AI safety and audit: canvas content treated as untrusted data; no outbound channel for the agent; agent-inserted links and images inert until a person acts; confirmation for bulk deletes; no prompts, outputs or tool arguments in logs; audit events to the host through `POST /ai/events` via the notification outbox (docs/24 §9) | Accepted (owner, 2026-11-22) |
| ADR-036 | Session renewal (docs/23 PERM-07): `GET /v1/sessions/:ticket` returns `exp` (seconds); `POST /v1/launch` with `Accept: application/json` answers `{"ticket"}` instead of the 303, so the editor moves to the ticket for the host's `Action_RefreshToken` token and reconnects without a reload | Accepted (owner prototype Main.dc.html, 2026-11-23) |
| ADR-037 | Relicense to Apache-2.0: canonical LICENSE, attribution through NOTICE (Apache §4(d)), SPDX identifier and copyright in every source file (checked in CI by `scripts/check-spdx.sh`); supersedes the earlier BUSL-1.1 licensing (owner decision 2026-11-23) | Accepted |
| ADR-038 | Integration through standardized APIs and SDKs only: OpenCanvas must not depend on specific CasualOffice products; hosts use launch tokens, callbacks, WOPI, REST, postMessage, the SDK and MCP (owner, 2026-11-23; docs/09) | Accepted |
| ADR-039 | (Moved to v0.3 by the owner, 2026-11-24) Portable live blocks are host files embedded by reference (Loop model) and opened as their own rooms; read-only `blockRef` projections; derived grants from the host `POST /access`; snapshot policy; depth 1 (docs/27 §2) | Accepted (2026-11-23) |
| ADR-040 | Block SDK: one generic `extBlock` node and an `ext` root; JSON Schema manifests validated server-side by MOD-01; declarative export templates; no third-party code on the server; sandboxed iframe renderers on a separate origin (docs/27 §3) | Accepted (2026-11-23) |
| ADR-041 | Headless API v1: `/api/v1`, OpenAPI 3.1, RFC 9457 errors, `Idempotency-Key`, signed cursors, `RateLimit` headers, host key or host-minted user tokens, one operation layer shared with MCP (docs/27 §4) | Accepted (2026-11-23) |
| ADR-042 | `.ocanvas` stays format version 1 through v0.2: additive nodes, roots and manifest fields only; a 0.1.x round trip is a release gate (docs/27 §3.3, §5) | Accepted (2026-11-23) |
| ADR-044 | Per-host embed origins: optional `frame_ancestors`; such hosts launch to `/app/?h=<host id>` and only that page carries them (MX-01) | Accepted (owner, 2026-11-24) |
| ADR-045 | Diagram schema: boards stay blocks in a document (per-board budget 25 % of `max_doc_bytes`); additive shape fields `kind` (namespaced, refines the legacy `type`), `kindVersion`, `props` (a per-field map: concurrent edits of different properties merge), `ports`, binding `port` (with `anchor` always kept); declarative shape registry with `core:unknown` fallback; unknown fields kept by every reader and writer; both exporters draw an unknown type's box as a rect; diagram mode is per board; incremental board projection (docs/29) | Accepted (owner, 2026-11-24; condition: `props` merges per field) |
| ADR-046 | Board renderer: keep SVG + React; no Canvas2D/WebGL rewrite without a browser profile showing the renderer, not projection or React reconciliation, is the bottleneck; next steps are culling through the spatial index and a scene layer separate from React chrome (docs/29 §2) | Accepted (owner, 2026-11-24) |
| ADR-047 | Connector routing: straight/elbow stay the baseline and the fallback; obstacle-aware orthogonal routing is a deterministic client-side projection of stored intent (`route: "elbow"` + optional `routing: "avoid"`), never a new source of truth; `pts` stays the compatibility snapshot; invalidation through `EdgeIndex` + `SpatialIndex`; worker only if measured; layout is a separate, explicit, lazy step (Dagre first; ELK only after an EPL-2.0 review). Dependency added (DGM-14.6): `@dagrejs/dagre` 1.1.4, MIT, in `@opencanvas/board`, dynamic import in the diagram chunk | Accepted (owner, 2026-11-24) |
| ADR-048 | Skip the start screen: optional launch-token claim `"start": "page"` opens a new canvas straight into the page without the template picker; it travels as `&start=page` after the ticket in the app fragment (other values ignored). The editor also tells the host a session closed (`Error {code: "SESSION_CLOSED"}`) so host chrome can offer Reopen (MM-02) | Accepted (owner approved via prototype MM S2f / MX S5–S7b, 2026-11-24) |
| ADR-049 | Temporary-canvas wording per host: `[host.flags] temporary_wording`, "meeting" (default, Jitsi) or "room" (Matrix); the session carries `wording`; room wording adds "Start a new canvas" on the ended screen, which posts `UI_StartNew` to the host (MX-02) | Accepted (owner approved via prototype MM S2f / MX S5–S7b, 2026-11-24) |
| ADR-050 | UI units: type, spacing, control/icon sizes, radii, chrome widths and the token scales in rem (16 px = 1 rem); the root keeps the reader's default font size; media queries and the JS compact breakpoint in em; px kept for ≤ 2 px values, borders/outlines/shadows/transforms, board geometry, export renderers and inline geometry; `tools/px-to-rem.mjs` (idempotent codemod) and `tools/check-px.mjs` (CI guard) (SCALE-01) | Accepted (owner, 2026-11-24) |
| ADR-051 | Version history lives with the host: optional JWT callbacks and WOPI extensions (or a host version-page link); named versions are saves with a commit message; restore is a live-room edit; OpenCanvas stores no versions (VH-01, docs/30) | Accepted (owner, 2026-11-24) |
| ADR-052 | Version diff is structural and computed on the server in `oc-model` over `document.json` (blocks, text, databases, boards); one implementation for UI, API, MCP and webhooks (VH-02, docs/30) | Accepted (owner, 2026-11-24) |
| ADR-053 | Diagram import parsers (DGM-15): `oc-model` gains `roxmltree` 0.21, `flate2` 1 and `percent-encoding` 2 as direct dependencies (all three already in Cargo.lock through resvg/usvg and reqwest; no new crate, no new version). draw.io and Excalidraw are converted on the server only, through FC-10 | Proposed (needs owner sign-off) |
| ADR-054 | Headless API v1 boundary details (HAPI-01/02): `/api/v1` behind `[host.flags] api_v1`; RFC 9457 types `urn:opencanvas:problem:<code>`; 0.1 host routes kept as aliases with `Deprecation` (RFC 9745) and `Link: rel="successor-version"`; user tokens host-minted (no exchange, no token store), `iss` → one host (`[host.api] issuer`), `aud` = `{[host.api] audience or OC_PUBLIC_URL}/api/v1`, ≤ 15 min; one `authz::Principal` check shared with MCP; `canvas:admin` for tokens only with `[host.api] token_admin` (docs/27 §4.4) | Proposed (2026-11-24) |
| ADR-055 | In-file bounded history: besides host versions (ADR-051), a host may keep a bounded history inside the `.ocanvas` (`history/index.json` + `history/<id>.deflate`, additive to format 1): each kept version is the compressed reverse structural diff (newer → older, over `document.json`) plus kind, name, authors and time, never a full copy; Yjs GC stays on. Bounds `[host.versions] file_max_kb` (1024) and `file_max_versions` (50): the oldest automatic versions go first, named ones last. `[host.versions] file` (default on for JWT hosts, off for WOPI hosts; never for temporary canvases) turns it off where deleted text must not travel with the file; `prefer_host` picks the list shown first when both exist (docs/30 §13) | Accepted (owner, 2026-11-24, by message) |
| ADR-011 | Design-first UI gate: every UI is approved as an Artifact prototype before implementation | Accepted (user requirement) |

---

### ADR-001 — Responsibility split
**Context.** The brief: "parent application manages ACL and authentication;
we are responsible for editing, collab, preview, download, commits", "no
persistence — the file is the work". Collabora Online and Microsoft Loop both
prove the editor-as-service / file-in-host model.
**Decision.** As stated. The service never stores canonical documents.
**Consequences.** + Trivial compliance story for hosts; + horizontally
scalable; − we need a WAL for un-committed edits (transient) and a commit
protocol with conflict handling.

### ADR-002 — Yjs / yrs
**Context.** Need conflict-free rich text + tree + board maps; server must
merge without per-block logic.
**Options.** Yjs, Automerge, Loro, OT, Fluid.
**Decision.** Yjs/yrs — most mature ProseMirror binding, awareness protocol,
Rust port with wire compatibility.
**Consequences.** + stock y-websocket clients interoperate; − tombstones
grow (mitigated by GC + snapshot compaction); revisit Loro in P3.

### ADR-003 — Rust server
**Context.** Sibling services (OpenCalc, OpenSign) are Rust; "lightweight".
**Decision.** Rust + tokio + axum. **Alternative** Node + Hocuspocus rejected
for footprint (RSS ~10×) and to share tooling with siblings.
**Consequences.** − Some exporters must be written in Rust (mitigated by
sharing serialisers via WASM later).

### ADR-004 — SQLite default, MySQL/MariaDB optional
**Decision.** sqlx `Any` driver; dialect-specific migration folders with an
identical logical schema; epoch-ms BIGINTs; no vendor JSON functions.
**Consequences.** SQLite = single node only (enforced at startup if
`REDIS_URL` is set with SQLite → refuse to start).

### ADR-005 — Handshakes
**Decision.** JWT launch (primary) + WOPI (compat). Launch token exchanged for
a 60 s single-room WS ticket; the WS connection stays valid until the launch
token `exp`, then requires refresh.

### ADR-021 — WOPI-compatible mode
**Decision.** A host with `mode = "wopi"` (or `"both"`) launches with
`POST /v1/launch?WOPISrc=` + form `access_token`/`access_token_ttl`. OpenCanvas is the WOPI
client: CheckFileInfo maps role/user/perms, GetFile loads, PutFile (with
`X-COOL-WOPI-Timestamp` = `LastModifiedTime`) saves, `409`/`COOLStatusCode 1010` is a conflict
and policy `copy` uses PUT_RELATIVE. The normalized `WOPISrc` is the file id, so the room, outbox
and conflict code are untouched: `HostClient` picks a `SaveTarget` (`Callbacks` | `Wopi(url)`)
per call. The access token is stored like a callback token (sealed under `OC_KEK`) and never
logged (reqwest errors are stripped of URLs, no redirects are followed). `WOPISrc` must match a
`wopi_allowlist` entry by exact scheme, host and port (+ optional path prefix) before anything is
called (SSRF). WOPI has no asset API, so uploads are kept per room in `room_assets` (transient,
swept when the room is gone) and inlined into the saved zip as `assets/<id>` + `assets/index.json`;
they are read back on load. Markdown files are saved back as Markdown. No WOPI locks (Collabora
style timestamps instead), no proof keys yet.

### ADR-006 — Room ownership
**Decision.** Exactly one in-memory authoritative Doc per room cluster-wide.
Redis `SET NX PX` lease, 5 s renew, 15 s expiry; LB consistent-hash on room id
minimises relays. **Rejected:** every node holds a Doc and syncs via pub/sub
(N× memory, N× WAL writes).

**Relay transport (CLU-01): internal WebSocket, not Redis pub/sub.** A non-owner opens one
WebSocket per client connection to the owner's `OC_CLUSTER_ADVERTISE` URL
(`/v1/internal/relay/:room`), authenticated by HMAC-SHA256 over time, room and the
forwarded grant with `OC_CLUSTER_SECRET` (±30 s). Reasons: (1) per-connection ordering and
backpressure come from TCP for free, where pub/sub would need sequence numbers and a
reorder buffer; (2) pub/sub is fire-and-forget: a subscriber that blips loses frames silently,
while a broken socket is visible to both sides and becomes a client reconnect + Yjs resync;
(3) no per-connection channel bookkeeping in Redis and no frame traffic through it, so Redis
only carries leases; (4) the owner sees a relayed connection exactly like a local one (same
actor join, same role filter). Host-API room calls are forwarded the same way over signed HTTP.
Cost: nodes must reach each other directly (one more port on the internal network).

**Failover.** Lease value `<node>@<url>#<nonce>`; renew/release/steal are compare-and-set Lua
scripts. A node that cannot reach the owner probes its `/healthz`; when that fails it replaces
the dead owner's exact lease value (no 15 s wait). Under a partition (owner alive but
unreachable) this can briefly give two owners; the old one steps down at its next renewal
(≤ 5 s) and the WAL primary key `(room_id, seq)` rejects its colliding appends. Outbox rows
are claimed with `claimed_by` / `claim_until` (migration 0004) so the sweeper never double-saves.

### ADR-007 — Tiptap
**Decision.** Tiptap (MIT) for extension ergonomics; ProseMirror underneath.
**Rejected:** Lexical (weaker Yjs story), Slate (no stable collab binding),
BlockNote (good, but less control over schema; may borrow UX).

### ADR-008 — Board
**Decision.** Own renderer. **Rejected:** tldraw (licence watermark/terms),
Excalidraw (MIT but separate scene model and heavy bundle; would need a
second sync model). Use small MIT libs: perfect-freehand, rbush.

### ADR-009 — `.ocanvas`
**Decision.** Zip with JSON for openness and Yjs state for lossless CRDT
reload. **Consequences.** Hosts can index `document.json` for search
without us.

### ADR-010 — Exports
**Decision.** MD/HTML/DOCX/SVG/PNG from Rust; PDF through optional headless
Chromium sidecar (`OC_PDF_RENDERER`), fallback = print-styled HTML.

### ADR-011 — Design-first UI gate
**Decision.** Before any UI code, a clickable prototype is published as an
Artifact and explicitly approved. Approval recorded in the tracker (UI-xx rows).

### ADR-022 — Security hardening (audit 2026-11-21)
**Context.** The repository went public; docs/18 records an OWASP/ASVS L2 audit.
**Decision.** (1) A single response middleware owns baseline headers: the SPA and API get a
CSP with `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`; a handler that sets its own
CSP (room assets, exports) keeps it and only gets `frame-ancestors` appended. (2) Host callbacks
carry `X-OpenCanvas-Signature: t=…,v1=…,v2=…`; `v2` = HMAC(secret, `t.METHOD.path?query.body`).
`v1` is unchanged, so existing hosts keep working; hosts should verify `v2`. (3) The signed callback
client never follows redirects. (4) `OC_METRICS_TOKEN` protects `/metrics`. (5) Room and
connection caps from docs/07 §3 are enforced. (6) `zip` moves to 9.x (RustSec advisories against 2.x).
**Consequences.** + defence in depth against stored XSS in the SPA and exports; + replay of a
captured GET signature on another path is detectable by hosts that check `v2`; − a host whose
`GET /files/{id}` answered with a redirect must now serve the bytes itself (asset fetches were
already redirect-free).

### ADR-023 — Editor UX pass: image layout, comment mentions, block links

**Context.** The PRD (§5.1) lists image width and alignment and mentions in comments; the UX
audit (docs/19) found block links copied plain text.
**Decision.** (1) `image` gains two optional attrs, `width` (whole percent of the text column,
20-100, absent = full) and `align` (`left` | `right`, absent = centred), rendered as
`data-width` / `data-align`. Older clients keep and round-trip them (unknown attrs survive in the
Y.Doc); exports may ignore them. (2) A comment message map may carry `mentions`: an array of
user ids found as `@Name` in its text, for the server's `onMention` callback. (3) "Copy link to
block" gives the block a `blockId` if it has none and posts `UI_Block_Link {blockId, fileId}`;
the host builds its own URL and brings a reader back with `Action_ScrollToBlock {blockId}` (or a
`block=` launch fragment).
**Consequences.** + layout and mentions round-trip in the file; − server exports do not yet apply
image width/alignment; − `onMention` delivery is a server follow-up.

### ADR-026 — Users and identity for integrators

**Context.** Every host had to build user search before mentions worked, two people with the same
name looked identical, and stored mention labels went stale. Viewers don't share one directory:
Priya's contacts aren't Ravi's.
**Decision.** As [docs/21](21-USERS-AND-IDENTITY.md): the id is the identity; zero required user
endpoints (tier 0 = launch tokens and a `people` map kept in the file); optional `participants`,
search and resolve, all per viewer; the host returns `relation` and may return a viewer-specific
name; the server rewrites presence per recipient so `hidden`/`external` names never reach a
client that mustn't see them; the editor tells same-named people apart (second line, grouped
picker rows, "Name · detail" labels, initials with subscripts, hover cards) and renders stored
mentions through the viewer's resolve. Additive file-format changes: `people` root, comment
`labels`.
**Consequences.** + mentions work with no host user API; + renames and departures show up; +
per-viewer privacy for presence, chips and exports. − the Y.Doc is shared by everyone in the room,
so the `people` map and mention labels are data in every client (never rendered when resolve
answers; strict hosts use `coviewers = "none"`); − one resolve call per viewer when someone new
arrives; − `contacts` without a resolve callback cannot distinguish contacts and lists everyone.

**Revision 2 (2026-11-22).** The owner simplified the model: the mention list is the people with
access to this canvas, the same for everyone with access, with real names and the `detail`
second line. Removed: `relation` (contact/member/external/hidden), "Someone", per-viewer
nicknames, per-recipient awareness rewriting (the grant-based `user` stamp stays),
`[host.directory] coviewers`, token `participants`, `perms.showEmail`, `user.email` and every
e-mail field, `GET /users`, `POST /users/resolve` and their SPA endpoints. Added: token
`members[]` (≤ 500), the optional signed callback `GET {callback_base}/files/{fileId}/members?q=&limit=`
(cached 60 s per room), `GET /v1/members?ticket=&q=` (callback > token > saved `people` map, the
last only without a host source), and authoritative revocation: the role API with `none`
invalidates the cache, leaves the person out even where an older token or the saved map names
them, and tells the room to refetch (control `{"t":"members"}`); `POST /v1/files/:id/members/invalidate`
does the same for other changes. A mentioned id that is no longer a member shows its snapshot
label with "No longer has access". − In a cluster the revoke set and the cache are per node and kept in step over Redis
pub/sub (`oc:members`, signed; 2026-11-22), so a revoke reaches every node within a second;
a node that was unsubscribed when it was published can serve a stale answer for up to 60 s; − with no host source, everyone
who ever opened the canvas stays listed until the host revokes them.

### ADR-027 — Editor and server open items: mentions, heartbeat, inline marks, file previews, columns

**Context.** docs/19 left open: comment mentions not reaching the host, ~30 s before a silent
network drop shows, no text colour or date mentions, block links in hosts, board undo outside the
canvas stack; the product asked for file previews and a better columns block.
**Decision.** (1) A new optional host callback `POST {callback_base}/mentions` (JSON, signed, with
`Idempotency-Key`). The room finds new mention items (comment messages with `mentions`, inline
`mention` nodes) in accepted updates, attributes them to the sending grant, and queues one call
per message / block in a new transient table `notify_outbox` (id = hash of room + item, so a
message is queued once; payload cleared when done; rows swept after a day). A sweeper retries
failures with backoff. Text mentions count per person, so mention nodes re-created by a split
or a move are not news. WOPI hosts are skipped. (2) Control `{"t":"ping"}` every 10 s
(`OC_HEARTBEAT_MS`); clients treat 15 s of silence as a lost connection. (3) Schema: `textColor`
mark (palette names only), `dateMention` inline node, `fileAttachment.display/height`,
`columns.widths`, `column.title`, all optional. Rust and web exporters render them (no embedded
viewers in exports). (4) `GET /v1/assets/fetch` serves allowed attachment bytes same-origin for
previews (≤ 50 MB, inline, sandboxed, `nosniff`). (5) `pdfjs-dist` 4.10 renders PDFs; it and its
worker load only when a PDF is shown (same-origin worker, `isEvalSupported: false`), so the
initial JS stays under budget. (6) postMessage `UI_BlockLink {fileId, blockId}` (the earlier
`UI_Block_Link` is still posted) and a launch `block` parameter.
**Consequences.** + hosts can notify people without polling documents; + offline shows within
20 s; + richer inline content and file handling round-trip in `.ocanvas` and export sensibly;
− the DB holds short excerpts until a notification is delivered (transient, like the commit
outbox); − a new third-party dependency (pdf.js, Apache-2.0) in a lazy chunk; − hosts must check
access before notifying the ids they get.

### ADR-028 — Batched WAL, outbound tick, and the hot WAL in Redis

**Context.** docs/22 §8–§9: with everyone typing, a room applied one update, waited for its own
WAL append, then took the next (S1: 954 → 577 of ≈ 2,750 updates/s), and 1,000 small rooms
queued on SQLite's single writer lock (S2: 90 % of SQLite time in the busy handler). A room of
550 also sent each update to 549 peers as its own frame (≈ 1.5 M frames/s).
**Decision.** (1) **Batch per room.** Updates are applied to the Y.Doc as they arrive and queued;
the queue is written as one batch (one row and `seq` per update, one epoch-guarded statement or
script, all or nothing), and only then fanned out. Anything that reads the doc's state (sync
step 1, joins, exports, patches, saves, commits) writes the queue first. (2) **Outbound tick.**
A room writes its batch and sends **one** update frame (the batch merged with
`merge_updates_v1`, shared by every peer) plus one presence frame at most every 40 ms, armed by
the first queued item. A batch is merged only when every update in it integrated in order (no
pending structs); otherwise its updates go out one by one, as before (merging updates with
gaps lost structs in `tests/fuzz.rs`). The sender gets the merged frame too when the batch has
several senders; Yjs ignores structs it already has. (3) **SQLite group commit.** One writer
task commits the batches of every room queued while the previous commit ran, in one
transaction (`OC_WAL_GROUP_COMMIT=0` turns it off; `OC_WAL_GROUP_WINDOW_MS` ≤ 5 adds a wait).
A fenced room in the group writes nothing; any other error retries each room alone.
(4) **Hot WAL in Redis** when `OC_WAL_REDIS_URL` (default `REDIS_URL`) is set: one stream per
room (`oc:wal:{room}`, entry id `<seq>-0`), appended per batch by a Lua script that refuses a
stale epoch (`oc:epoch:{room}`, raised to the DB epoch whenever an actor claims the room, before
it reads the WAL) or a non-increasing `seq`, before adding anything. The database gets a
snapshot every `OC_DB_SYNC_MS` (5 s) or `OC_DB_SYNC_UPDATES` (500) updates and on close/drain,
under the DB epoch guard; only after that commit is the stream trimmed (`XTRIM MINID seq+1`).
Load = DB snapshot + DB rows + stream entries after them. A room row is marked dirty **before**
its first append, so a restart never purges a stream that holds acknowledged edits.
**Durability contract.** Acknowledged (fanned out) means durable in the WAL store: the database
without Redis; Redis with it. With Redis AOF `appendfsync always` a Redis crash loses nothing
acknowledged; with `everysec` it can lose about the last second; without AOF, everything since
the last DB sync (≤ 5 s). Recommended: `appendonly yes` + `appendfsync always`, or `everysec`
with a replica and `WAIT`-free failover accepted as ≤ 1 s loss. The server logs a warning at
start-up when `appendonly` is `no` or `appendfsync` is not `always`.
**Consequences.** + a 550 room keeps up at p95 ≈ 50–70 ms (docs/22 §9.3); + peers get ≤ 25
update frames/s; + DB write load drops to one snapshot per room per 5 s with Redis; − Redis
becomes part of the durability path (and its persistence settings matter); − edit latency has a
floor of the tick (≤ 40 ms) plus one append; − a snapshot every 5 s re-encodes the whole doc
(cost grows with the doc).

### ADR-029 — Memory durability: a single server in memory, periodic dump to the database

**Context.** docs/22 §9.3: with the batched WAL a single SQLite server still missed the 700 ms
p95 at 1,000 rooms × 5 (p95 1.2–1.6 s): every acknowledged keystroke became a database row, and
WAL batches, snapshots, outbox writes and room marks all queued on SQLite's single writer. The
owner's direction (2026-11-22): a single server keeps rooms in memory and dumps them to the
database for restart safety; the strict WAL stays available as an option.
**Decision.** `OC_DURABILITY = memory | wal`.
(1) **`memory`** (the default when no Redis WAL is configured): no per-update write. An update
is applied to the in-memory Y.Doc and fanned out on the next outbound tick (≤ 40 ms) without
waiting for the database. While the room has changes, its encoded state is dumped
(epoch-fenced, into `room_snapshots`) every `OC_DB_SYNC_MS` (default 2,000 ms) in the
background: the actor encodes, a task writes, and a late dump never replaces a newer one. The
state is also dumped synchronously before each host save, on drain/SIGTERM and on close. The
room row is marked dirty before the first edit after a save, so a restart loads the dump.
Outbox, mention outbox and `jti` writes are unchanged.
(2) **`wal`**: ADR-028 unchanged. An edit is fanned out only after its WAL batch commits.
(3) **With a Redis WAL** (`OC_WAL_REDIS_URL`/`REDIS_URL`): unchanged (hot WAL in Redis plus a
periodic DB sync). `OC_DURABILITY` is ignored.
(4) On SQLite every write transaction waits for an in-process write turn (FIFO) instead of
SQLite's busy handler, which sleeps and retries.
(5) **Idle eviction**: a room with no peers and nothing unsaved for `OC_ROOM_IDLE_MS` (default
60 s; the older `OC_ROOM_TTL_SECS` is still read) is saved, its rows are purged and its actor
and Y.Doc are dropped. (This existed with a 10-minute default; the default is now 60 s.)
**Durability contract (memory mode).** An acknowledged edit is in server memory and in the
editors' browsers. If the server process dies (kill -9, OOM, power loss), it restarts from the
last dump, at most `OC_DB_SYNC_MS` old. Every client that is still open resends what the server
lacks through Yjs sync step 1/2 when it reconnects, so nothing is lost while some client that
holds the edit comes back. Edits made in the last `OC_DB_SYNC_MS` before the crash by clients
that never come back are **lost**. A clean shutdown (SIGTERM) loses nothing: rooms dump and
save before exit. Operators who need every acknowledged edit on disk set `OC_DURABILITY=wal`
or configure a Redis WAL.
**Consequences.** + no database write on the edit path (docs/22 §9.4); + database load is one
state dump per busy room per 2 s; − a crash can lose up to `OC_DB_SYNC_MS` of edits from
clients that do not return; − each dump re-encodes the whole doc, so its cost grows with the
document.

### ADR-030 — Redis-only cluster storage; SQL optional in a cluster

**Context.** A cluster needed MySQL/MariaDB for snapshots, epochs, outboxes, sessions and used
launch tokens, plus Redis for leases and the hot WAL (ADR-006, ADR-028): two stateful services
to run. The chaos runs (docs/22 §11.1) also showed that a Redis restart without AOF dropped every
mirrored fencing epoch, so every room of the cluster was fenced and every client reconnected.
Owner decision (2026-11-22): a single server uses SQLite, or MySQL as its dump target; a
cluster uses Redis only; SQL is optional in a cluster and used when `DATABASE_URL` is set.
**Decision.** (1) **`REDIS_URL` set and `DATABASE_URL` unset → Redis-only storage.** Every piece
of server state lives in the WAL Redis (`OC_WAL_REDIS_URL`, default `REDIS_URL`), behind the
same `Store` interface: each method dispatches to `redis_store::RedisStore` first, so the SQLite
and MySQL/MariaDB code paths are unchanged. Mapping: `room_snapshots` → hash `oc:snap:{room}`
(the periodic sync target, every `OC_DB_SYNC_MS` = 5 s or 500 updates, and on close/drain);
`room_updates` → the existing stream `oc:wal:{room}`; `room_epochs` → `oc:epoch:{room}`, now
authoritative: a claim is `INCR`, or the clock in ms when the key is missing, so an epoch is
never handed out twice; `commit_outbox` → a hash per row plus zsets per room and of pending rows
(row id = idempotency key, a second insert with the same id is refused; supersede-older-pending,
`claimed_by`/`claim_until` claim lease, attempts, finish: the SQL semantics); `notify_outbox` →
hash per row plus a due zset (insert once per id, claim by `next_try_at`, finished rows kept a
day); `sessions` → hash per ticket expiring an hour after the ticket plus a per-room zset;
`launch_jti` → `SET NX EX`; `rooms`, `room_assets` → hashes and sets. Each guarded write
(outbox insert, snapshot + trim, closing purge, WAL append) is one Lua script that compares the
writer's epoch with `oc:epoch:{room}` first; a stale writer changes nothing. Sealing with
`OC_KEK` is unchanged. Scripts touch keys of one room that are not all declared, so the Redis is
a standalone server or a Sentinel-managed primary, not Redis Cluster.
(2) **Redis wiped with SQL configured.** An append that finds no epoch key (`NOEPOCH`, distinct
from a stale epoch) reads the room's epoch from `room_epochs` (the authoritative one), restores
the mirror (it only ever raises) and retries once: the room's current owner keeps writing, a
writer whose epoch is not the database's latest is still refused, and the next claim is
`room_epochs` + 1 as always. A wipe no longer fences every room of the cluster.
(3) **Wipe detection.** The first node sets `oc:instance` (`SET NX`, a ULID); every node checks
it every 2 s. Gone or changed → Redis lost its data: logged at ERROR. In Redis-only mode the
message says it plainly: snapshots, WAL, epochs, pending commits, sessions and used launch
tokens are gone; rooms are fenced at their next write (no epoch key), close with 1012 and
rebuild from the host's last saved file plus what reconnecting clients resend; open sessions
must relaunch.
(4) **Durability guidance.** Start-up warns when Redis has `appendonly no` (Redis-only: every
piece of state is lost on a restart) or `appendfsync` is not `always`. Recommended:
`appendonly yes` + `appendfsync always`, or `everysec` with a replica (docs/13).
**Durability contract (Redis-only).** Acknowledged means in Redis (as ADR-028). With
`appendfsync always` a Redis crash loses nothing acknowledged; with `everysec`, about the last
second; with AOF off, a Redis restart loses **everything** Redis held: edits since each room's
host save survive only in clients that come back, commits the host has not acknowledged are
lost, sessions must relaunch, and a used launch token could be replayed until it expires.
**Consequences.** + a cluster needs only Redis; + SQL remains available in a cluster (and a wipe
there no longer reconnects every client); + one store contract checked by conformance tests on
SQLite, MySQL/MariaDB and Redis (`tests/storage_conformance.rs`); − Redis memory holds every
room's snapshot (≈ the encoded doc per open or recently closed room) besides the WAL tail;
− Redis persistence decides durability for all state, not only the last seconds of edits;
− not compatible with Redis Cluster (one primary).

### ADR-037 — Relicense to Apache-2.0 with NOTICE attribution (Accepted, 2026-11-23)
**Context.** OpenCanvas was published under the Business Source License 1.1 (source-available, MPL-2.0
after four years). The owner chose a permissive open-source licence for the first release.
**Decision.** Apache License 2.0, canonical text in LICENSE. Attribution through NOTICE, which
redistributions must keep (§4(d)), and a two-line SPDX header (`SPDX-License-Identifier: Apache-2.0`,
`Copyright 2026 CasualOffice`) in every source file, checked by `scripts/check-spdx.sh` in CI and
`scripts/audit.sh`. Bundled fonts stay under the SIL OFL 1.1. **Supersedes** the earlier BUSL-1.1
licence decision.

### ADR-031 — AI as a server-side capability with a provider abstraction (Accepted, 2026-11-22)
**Context.** Hosts want AI writing, Q&A, database autofill and an agentic assistant. The owner
decided (2026-11-22) that AI is a plug-in capability of the OpenCanvas server, configured from
the backend, not bring-your-own in the browser and not a host inference callback. Research:
docs/24 §2.
**Decision.** A `ModelProvider` trait with streaming content-block messages and tool calls;
kinds `anthropic` (Claude Platform) and `openai-compatible` (OpenAI, vLLM, Ollama, llama.cpp `llama-server`, LM Studio); `bedrock`/`vertex`/`foundry` later if asked. Profiles declare `tools` and `context_tokens`; agent mode needs `tools = true`. Profiles in `[ai.providers]`
of the server config with keys from env or sealed with `OC_KEK` (ADR-017); `[ai] enabled` is off by
default. Per host: `[host.ai]` picks the profile, models, features, default write mode and limits;
launch token `perms.ai` and optional `ai.budget`. `GET /v1/ai/info` discloses provider kind,
region and models to the host. Reference profile: `claude-opus-5-5` for the agent,
`claude-sonnet-5-5` for inline features.
**Consequences.** + one behaviour in every deployment; + keys never leave the server; − the
operator becomes the provider's customer and a data processor for prompts: **document content
is sent to the configured provider**, which docs/05, docs/07 and the operator guide must state;
− a new outbound dependency with its own failure modes (`/readyz` reports it).

### ADR-032 — OpenCanvas MCP server; host-issued tokens (Accepted, 2026-11-22)
**Context.** Remote MCP servers with OAuth are now standard for document products (docs/24 §2.13).
The host owns identity and ACL (ADR-001), so OpenCanvas must not become an identity provider.
**Decision.** `/mcp/{hostId}` implements MCP 2026-07-28 (stateless, POST-only streamable HTTP,
`Origin` checked) and negotiates 2025-11-25. Tools: `canvas_read`, `canvas_find`, `canvas_search`
(host search, phase 3), `canvas_patch`, `db_describe`, `db_query`, `db_upsert_rows`, `db_create`,
`db_add_field`, `board_read`, `board_add_shapes`, `comment_add`, `comment_list`, `members_list`,
`suggestions_list`; resources `canvas://{hostId}/{fileId}`; no sampling or roots. OpenCanvas is a
resource server only: PRM per host naming the host's authorization server, tokens verified by
issuer, JWKS, `aud` = the host's MCP URI, scope, `exp` ≤ 15 min; host-minted tokens (Flow B) use
the launch-token keys. Effective permission = min(scope, host role); role from the launch grant or
the new signed `POST /access` callback (cached 60 s, dropped by the role API). Tokens are never
forwarded; callbacks keep HMAC `v2`.
**Consequences.** + any MCP client can work on canvases under host control; + stateless fits the
cluster; − hosts that want external clients need an OAuth/OIDC authorization server (open
question, docs/24 §12).

### ADR-033 — AI edits as a visible, undoable collaborator; suggestions root (Accepted, 2026-11-22)
**Decision.** Agent identity `agent:<runId>` on behalf of a user, stamped by the server in
awareness; origin `ai:<runId>` on one Yjs transaction per tool call; agent named in
`X-OpenCanvas-Authors`; per-run yrs `UndoManager` on the server (in memory, lost with the node);
`rev` per block and `ifMatch` on writes (`STALE_BLOCK` on mismatch); text rewrites as minimal
Y.Text diffs; new `suggestions` root (ops against `blockId` + `rev`, accepted by an `edit` user).
Role filter: `comment` may write `comments` and `suggestions` only.
**Consequences.** + people see, follow and undo the agent; + no locks; − file format gains a
root (old clients ignore it; unknown roots already round-trip).

### ADR-034 — Agent runtime inside the server (Accepted, 2026-11-22)
**Decision.** The in-editor assistant loop (plan → act → review) runs as a tokio task on the
room's owner node, writing only through the room actor's mailbox. Tools are the MCP tools filtered
by the invoking user's role; no network, file system or code execution. Limits default to 25
steps, 300 s, 400 k tokens, 500 changed blocks, 60 runs per user per hour, 3 concurrent runs per
room and a per-host monthly token quota. `ai-cancel` aborts the provider stream after the current
transaction. Runs end with their room or grant; a room move cancels the run.
**Consequences.** + one place for limits, cancel and presence; − model latency and streaming
connections now live in the server process (bounded by the concurrency limits).

### ADR-035 — AI safety and audit (Accepted, 2026-11-22)
**Decision.** Canvas content is data inside delimited blocks, labelled untrusted; the agent has
no outbound channel; agent-inserted links and images outside `asset_origins` are inert and badged,
and not unfurled until a person clicks; deletes over 5 blocks, 50 rows or a whole database or
board need confirmation (elicitation over MCP); prompts, outputs and tool arguments are never
logged; audit events (`run.started`, `tool.called`, `run.finished`, `suggestion.accepted|rejected`,
`run.undone`; counts only) go to the host's `POST /ai/events` through the notification outbox
(ADR-027).
**Consequences.** + limits what a successful injection can do rather than relying on detection;
+ the host keeps the audit trail; − hosts must implement a callback to see AI activity.

### ADR-039 — Portable live blocks as referenced host files (Accepted, 2026-11-23)
**Context.** v0.2 P0 (docs/09). Notion synced blocks reference one original; Loop components are
files in the user's storage embedded live everywhere (docs/27 §1.1). OpenCanvas never persists
documents (ADR-001).
**Decision.** A `liveBlock` node references a separate host file (`meta.kind = "live"`), opened
as its own room; the host creates it (optional `POST /files`) and its ACL decides access through
a derived grant from `POST /access` (never wider than the parent grant). `blockRef` is a
read-only server projection of a block in another canvas. Snapshots in the embedding file follow
`[host.live] snapshot` (default `title`). Live files cannot contain references (depth 1).
**Consequences.** + full CRDT co-editing and presence with no new storage; + host ACL stays the
only authority; − one room connection per visible live block (≤ 8); − hosts must implement
`/access`; − snapshots trade export quality against leakage (owner question, docs/27 §9).

### ADR-040 — Block SDK contract and sandbox (Accepted, 2026-11-23)
**Context.** Hosts need their own blocks without forking. A per-block ProseMirror node would
break clients without the extension (docs/27 §1.2).
**Decision.** Every third-party block is an `extBlock {type, v, attrs, dataId, fallback}` node,
with collaborative state in a new `ext` root. A manifest declares JSON Schema for `attrs` and
`data`, export templates, requested permissions and migrations; MOD-01 validates writes on every
path. Renderers run in `sandbox="allow-scripts"` iframes on a separate block origin with a
hash-pinned CSP and a typed postMessage bridge. Packages are installed by the operator
(integrity-checked) and enabled per host. No third-party code runs on the server.
**Consequences.** + every reader keeps working (fallbacks); + validation is the same for editor,
API and MCP; − iframe cost per instance; − no server-side integrations in v0.2.

### ADR-041 — Stable headless API v1 (Accepted, 2026-11-23)
**Context.** Programs need a supported API; today there is a host-key patch API and MCP.
**Decision.** `/api/v1` described by OpenAPI 3.1; host key or host-minted user tokens (as
ADR-032) with effective permission = min(scope, role); atomic `blocks:batch` with `ifMatch` and
`If-Match`; `Idempotency-Key` (24 h, all store backends); signed cursors built on Yjs relative
positions; `RateLimit` headers and one limiter shared with MCP; RFC 9457 errors; events over
WebSocket/SSE; TypeScript and Rust clients. MCP tools become adapters over the same operations.
The 0.1 host routes stay as aliases.
**Consequences.** + one contract for programs and agents; − a new store table and more surface
to audit and keep compatible.

### ADR-054 — Headless API v1 boundary details (Proposed, 2026-11-24)
**Context.** ADR-041 fixed the API's shape; HAPI-01/02 had to pin the details a host codes
against: the gate, the error type URIs, how the 0.1 routes announce their successor, and how a
user token names its host and audience without OpenCanvas issuing tokens (ADR-001).
**Decision.** `/api/v1` answers per host when `[host.flags] api_v1 = true`. Problem `type` is
`urn:opencanvas:problem:<code>` (stable, not a URL to fetch). The 0.1 host routes stay, with
their answers, plus `Deprecation: @1795478400` and a successor `Link`. User tokens are minted by
the host with its launch-token keys; `iss` selects exactly one host (`[host.api] issuer`, default
the host id); `aud` = `{[host.api] audience or OC_PUBLIC_URL}/api/v1`, never from the request;
`exp` ≤ 15 min. One `Principal` check serves the API and MCP. `canvas:admin` counts for tokens
only with `[host.api] token_admin = true`.
**Consequences.** + no token store or exchange endpoint; + MCP and the API cannot drift apart;
− hosts sharing one external issuer must set distinct `[host.api] issuer` values; − a public base
URL is required for user tokens.

### ADR-042 — `.ocanvas` forward compatibility in v0.2 (Accepted, 2026-11-23)
**Decision.** Format version 1 and `schemaVersion` unchanged; v0.2 adds only nodes (`liveBlock`,
`blockRef`, `extBlock`), the `ext` root, `meta.kind` and `manifest.requires.blocks`, all of
which 0.1.x preserves as unknown content. A test that opens and saves a v0.2 file with 0.1.x and
finds no loss is a v0.2 release gate.
**Consequences.** + no migration for hosts; − 0.1.x shows placeholders for the new blocks.

### ADR-043 — Ephemeral storage for hosts without file storage (Accepted, owner decision 2026-11-23)
**Context.** ADR-001: the host owns files and we never persist documents. A meeting integration
(Jitsi Meet) has no file storage at all.
**Decision.** Opt-in `storage = "ephemeral"` per host. No load or save callback, no
`callback_base` required. Canvases are temporary: the room is destroyed (every row and key)
when it closes after the idle grace or on `DELETE /v1/files/{id}/session`; a drain (restart,
deploy) keeps it for the reconnect (revised 2026-11-23 after the Jitsi test). A `template` is a
built-in template id or a file, applied once by the server. Uploads
live with the room. Users keep work by exporting during the meeting. ADR-001 stands for every
other host; this is the only exception, and it keeps nothing beyond the room's life.
**Consequences.** + meeting hosts integrate with a JWT secret only; − work not exported is gone
when the meeting ends, and a node crash during the meeting recovers from the WAL only until the
room closes.

### ADR-044 — Per-host embed origins (`frame_ancestors`) (Accepted by the owner 2026-11-24, MX-01)
**Context.** The editor's CSP `frame-ancestors` was one list for the whole server (every host's
`allowed_origins`). A Matrix widget nests the editor inside the bridge page inside any Matrix
client, and `frame-ancestors` checks every ancestor, so each client origin would have had to be
allowed for every host on the server. The editor URL carries the session only in the fragment,
which the server never sees, so it cannot tell which host a page belongs to.
**Decision.** Optional host setting `frame_ancestors = [origins]`. Launches for such a host
redirect to `/app/?h=<host id>#t=<ticket>` and that page gets the server-wide list plus the
host's own. Everything else, and hosts without the setting, are unchanged (`/app/#t=…`). The
`h` parameter selects a policy and grants nothing: the editor has no cookies or ambient
credentials, its session is the ticket.
**Consequences.** + nested embeds (Matrix widgets) work without widening every host's framing;
− anyone can load `/app/?h=<that host>` under that host's ancestors, which exposes an editor
with no session; a session still needs a ticket.

### ADR-045 — Diagram schema, shape registry and compatibility (Accepted by the owner 2026-11-24, with per-field `props`)
**Context.** Structured diagramming (owner design, 2026-11-24; docs/29) needs shape kinds beyond the
nine board types, named ports and semantic edges. Boards are blocks inside a document (one Yjs doc,
`max_doc_bytes`), rendered by the web editor and, server side, by `oc-model` (`board.rs` for SVG/PNG,
`export.rs`, `preview.rs`). 0.1.x clients are deployed and will share rooms with newer ones.
**Decision.**
1. *Additive fields only* (docs/15 §4): `kind` (`<namespace>:<name>`, lowercase), `kindVersion`,
   `props` (a nested Y.Map under the shape, one key per property, each value plain JSON; owner
   condition at sign-off), `ports` (`[{id, side?, x?, y?, kind?}]`, fractions of the box), and `port`
   inside a `start`/`end` binding. `type` stays one of the nine legacy types: the kind's *base*,
   which 0.1.x clients and the exporters draw. No new Y roots, no format version change (ADR-042).
2. *Bindings keep `anchor`.* A port binding is `{shapeId, anchor, port}`; `anchor` is the side the
   port degrades to and is where every renderer draws the end until the web and Rust resolvers learn
   ports together (Phase 2, parity fixture). Reason, found by the mixed-version test: v0.1.1's paste
   rebuilds bindings as `{shapeId, anchor}`, so a 0.1.1 user who copies a diagram drops `port`; with
   `anchor` kept the copy still connects to the same side.
3. *Registry.* Declarative descriptors only (no functions, frozen): `core:<type>` for the legacy
   types, stencil kinds on a box base type. Lookup: registered kind → the base type's descriptor
   (plugin missing: raw fields kept, `missing` reported) → `core:unknown`, a bindable box with the
   five legacy ports, for a `type` this client doesn't know. Documents never carry code.
4. *Unknown-field preservation.* Readers keep every key; writers set only the keys they change
   (Y.Map key level, never a whole-shape rewrite) and keep every field of a binding they re-point.
   Nested Y types written by another client survive edits; copies write them as plain JSON, which
   readers accept. Tested against the v0.1.1 mutation paths (`compat.test.ts`) and the `.ocanvas`
   round trip, `ydoc.bin` and `document.json`-only (`oc-model/tests/diagram.rs`).
5. *Server rendering.* A kind renders as its base type (byte-identical output). An unknown `type`
   with a box and no points renders as a `rect` with its text, label and fill in both exporters
   (shared fixture `board-diagram.{json,web.svg}`); otherwise nothing. The editor canvas does not draw
   unknown types yet; its placeholder is UI and waits for a prototype (ADR-011).
6. *Orphan edges.* An end bound to a missing node keeps its binding (undo or a late sync may restore
   the node) and draws from its stored `pts` end, as today.
7. *Size.* A board is a block, not a file. Budget: one board up to 25 % of `max_doc_bytes` (5 MB at
   20 MB), measured to hold 10,000 nodes + 15,000 edges with short labels (4.44 MB). Enforcement
   (a warning near the budget) is Phase 2 UI.
8. *Diagram mode is per board* (a board opening full screen as a diagram), not an editor-wide mode.
   It is per person and never stored in the document. *(DGM-14, 2026-11-24, with the prototype
   approval, 1d)* The one document field it adds is the board's optional name, `boards/<id>.name`
   (a plain string beside `shapes` and `order`; additive, same rules as §1 and §4; kept by import,
   validation and `.ocanvas` round trips, not drawn by the exporters: `oc-model/tests/diagram.rs`
   `a_board_name_survives_import_validation_and_ocanvas_round_trips`).
9. *Projection.* The editor projects a board incrementally (`BoardProjection`): only shapes a
   transaction touched are re-read; output equal to `readShapes`.
**Consequences.** + Every 0.1.x client and export keeps working and keeps new data; + no migration;
− 0.1.x clients show kinds as plain base shapes and port bindings at the nearest side; − a paste in
0.1.x drops `port` (kept `anchor`); + concurrent edits of different properties of one shape both
survive (`props` merges per field; one property is last-writer-wins); − a 0.1.x copy writes `props`
as one plain object, which every reader accepts and the next per-field edit converts to the map (two
clients converting the same plain `props` at once keep one conversion).

### ADR-046 — Board renderer: keep SVG, profile first (Accepted by the owner 2026-11-24)
**Context.** The design proposes profiling SVG against Canvas2D before any renderer change. Phase 0
measured (docs/29 §2): before DGM-05 a remote move at 5,000 nodes cost ~81 ms of React work in jsdom,
mostly re-projection and re-resolving every connector; after it, ~21 ms, the rest being React walking
the full shape list (culling off in jsdom). The projection now costs 0.01-0.07 ms per edit at 1k-10k.
**Decision.** Keep the SVG renderer with React and memoised shape views (ADR-008). Next steps, in
order, each measured in a browser (Playwright trace, fixed machine, DGM-10): viewport culling through
`SpatialIndex`; a scene layer separate from the React chrome so a move re-renders only its shapes;
cached text metrics. Canvas2D or WebGL only when a trace shows paint or DOM size, not projection or
reconciliation, keeps 1,000 nodes / 1,500 edges from 60 fps pan and drag. Exports stay in Rust and
on the web SVG exporter, unaffected by the screen renderer.
**Consequences.** + No rewrite risk, accessibility (SVG + DOM) kept; − large boards depend on culling
and a scene split landing in Phase 2/4.

### ADR-047 — Connector routing and layout (Accepted by the owner 2026-11-24)
**Context.** Connectors store intent (bindings, `route`, `via`); `pts` is a resolved snapshot kept for
readers that ignore bindings. Web and Rust resolve bound connectors identically today. Obstacle
avoidance is the main Phase 2 routing feature; layout (ELK/Dagre) is Phase 3.
**Decision.**
1. Straight and elbow routing stay the baseline, the fallback and what 0.1.x clients draw.
2. Obstacle-aware routing is stored as `route: "elbow"` plus an optional `routing: "avoid"` (the
   base-plus-refinement pattern of ADR-045), so older clients and the Rust exporter draw a plain
   elbow. The route is a deterministic function of the connector, its bound shapes and the obstacle
   boxes (orthogonal visibility graph + A* with a bend penalty and fixed tie-breaking; chosen by
   measured cost). User waypoints (`via`) stay separate from generated bends. Generated points are
   never the source of truth; writers refresh `pts` on commit as `syncBoundArrows` does.
3. The Rust exporter uses the stored `pts` for an `avoid` connector when its ends still match the
   resolved anchors, else a plain elbow; porting the router to Rust is decided after it exists.
4. Invalidation: only connectors whose bound shapes changed (`EdgeIndex`) or whose cached route box
   meets a changed obstacle (`SpatialIndex`). Throttle during drag, recompute at drag end. A worker
   with cancellation only if the measured main-thread cost at 1k nodes needs it.
5. Layout is an explicit user action, previewed, applied in one transaction. Dagre (MIT) first. ELK
   (EPL-2.0) only after a licence review for an Apache-2.0 distribution, as a lazy worker chunk
   outside the 300 KB initial budget (ADR-019). Phase 1 adds no dependency.
**Consequences.** + Mixed-version rooms draw something sensible; + no new persisted geometry; − the
Rust export of an `avoid` connector may fall back to a plain elbow when `pts` is stale.

### ADR-048 — Skip the start screen with a launch claim (Accepted, owner approved via prototype MM S2f / MX S5–S7b, 2026-11-24)
**Context.** The Mattermost plugin asks for the kind of canvas (blank or meeting notes) in its own
create dialog (MM S3). The editor then showed its template picker on first open, in a 400 px
panel, asking the same question again (MM S2e). The owner approved opening new canvases straight
into the page (S2f).
**Decision.** An optional launch-token claim `"start": "page"`. The server appends `&start=page`
after the ticket in the redirect fragment (`/app/#t=<ticket>&start=page`), like `&block=`; any
other value or type is ignored and the launch is unchanged. The editor skips the template picker
for that open (`showsGallery`); templates stay in the editor. The JSON launch answer (ADR-036)
returns the bare ticket. A claim, not a host flag, because the host decides per launch (a host
can keep the picker for canvases it did not ask about) and no `hosts.toml` change is needed.
Also: when the editor shows a closed session it posts `Error {code: "SESSION_CLOSED", message:
"revoked" | "host" | "other"}`, so a host panel can offer Reopen (MM S2j). Both are additive.
**Consequences.** + no double question; + older servers ignore the claim (the picker shows, as
before); − the option is in the fragment, so a person can edit it; it only hides a picker.

### ADR-049 — Host wording for temporary canvases (Accepted, owner approved via prototype MM S2f / MX S5–S7b, 2026-11-24)
**Context.** ADR-043 temporary canvases were worded for a meeting ("deleted when the meeting
ends", "ended with the meeting"). In a Matrix room that is wrong; the owner approved room wording
(MX S5, S5 tooltip, S6a, S7a, S7b) and "Start a new canvas" on the ended screen.
**Decision.** `[host.flags] temporary_wording = "meeting" | "room"`, default `"meeting"`; any
other value stops the server at start-up. `GET /v1/sessions/:ticket` carries `"wording"`. The
editor takes every temporary-canvas sentence from one table (`lib/wording.ts`). Room wording also
changes the view-only line and the access-removed screen, and adds "Start a new canvas" to the
ended screen; the button posts `UI_StartNew` to the host, which opens a fresh canvas (the Matrix
widget reloads itself). The server's close reason stays "This canvas ended with the meeting".
**Consequences.** + Jitsi and every existing host keep their wording (tested); + room wording
with one line of config; − a host that sets `room` must handle `UI_StartNew` or the button does
nothing.

### ADR-050 — UI units: rem for type and spacing, em for breakpoints (Accepted by the owner 2026-11-24)

**Context.** The owner asked (2026-11-24) that the UI not become unusable when zoom or resolution
changes. Browser zoom and high-DPI screens already scale CSS px; what px ignores is the reader's
default font size (browser setting, OS text size). The editor also set `font-size:14px` on `html`,
which pinned rem to 14 px for everyone. WCAG 2.2 SC 1.4.4 (Resize Text), 1.4.10 (Reflow at 320 CSS
px) and 1.4.12 (Text Spacing) are the yardsticks.

**Decision.**
1. The root keeps the reader's default (`html` has no font-size); the editor's 14 px body text is
   `body{font-size:.875rem}`. Nothing sets font-size on `html` (the guard fails on it).
2. In rem (16 px = 1 rem, at most 4 decimals): font sizes, absolute line heights, letter spacing,
   padding/margin/gap, widths/heights and their min/max (controls, icons boxes, panels, popovers,
   max-widths), positional offsets (top/right/bottom/left/inset), border radii, flex-basis,
   grid tracks, scroll margins, and the token scales in `ui/src/tokens.css` (`--r-s`, `--r`, `--r-l`).
   The wide-block width (`--bw`, 1100 px → 68.75rem) too.
3. Media queries use em (`max-width:40em`), so they move with the reader's font size. The editor's
   compact (phone/side-panel) breakpoint, measured in JS with a ResizeObserver, is 45em of the root
   font size (720 px at 16 px), not a fixed 720 px.
4. Stays px, and why:
   - values of 2 px or less in any property: borders, hairlines, 1–2 px nudges. Scaling a hairline
     with text makes it heavier, not more legible;
   - borders, outlines, `outline-offset` (focus rings), box/text shadows, filters and
     backdrop-filters, transforms, `text-underline-offset`, background position/size,
     multi-value custom properties (the shadow tokens): decoration, not layout; converting the
     focus-ring offset would change rendering for no reading benefit;
   - board/whiteboard document geometry: shape coordinates, stroke widths in board space, zoom math
     (`BoardBlock.tsx`, `connectors.ts`, `projection.ts`, …), and the in-board text editors sized
     with the zoom (marked `// px-ok`). They are document content, scaled by the board zoom;
   - export renderers (`crates/oc-model`): output documents, not UI;
   - image intrinsic sizes and measured values in JS (popover placement from `getBoundingClientRect`,
     database column widths stored in the document);
   - Lucide icon `size={n}` props (SVG attributes) — not converted in SCALE-01; see the follow-ups;
   - the phone safe-area values come from `env(safe-area-inset-*)`, which the OS reports in px;
     a constant mirroring them would be marked `/* px */` (none in the converted CSS today).
   A declaration that must stay px for another reason ends with `/* px */`.
5. Guard: `node tools/check-px.mjs` runs in CI (web job). It fails on any px the codemod would
   convert in the converted CSS, on a font-size on `html`, and on numeric/px `fontSize` or px
   padding/margin/gap strings in inline React styles (`// px-ok` allows a line).

**Consequences.** + At the default 16 px root and 100 % zoom the UI renders pixel-identical (SCALE-01
pixel suite, 28 screens, 3 runs, 0 px). + A reader's larger default font enlarges the chrome and the
text together, and switches to the phone layout sooner. − Icons, board text and database column
widths do not follow the font size yet (follow-ups in docs/19 §Scaling). − Hosts that embed the
editor without an iframe would now inherit their page's root size (the editor is an iframe today).

### ADR-051 — Version history lives with the host (Accepted by the owner 2026-11-24, VH-01)
See [docs/30 §11](30-VERSION-HISTORY.md) for the full text: context, decision, rejected options.

### ADR-052 — Version diff is structural and computed on the server (Accepted by the owner 2026-11-24, VH-02)
See [docs/30 §11](30-VERSION-HISTORY.md).

### ADR-053 — Diagram import parsers (Proposed 2026-11-24, DGM-15)

**Context.** The owner asked for draw.io and Excalidraw import on 2026-11-24, through the FC-10
pipeline (5 MB, SEC-39, dry run, "Undo import"). draw.io files are XML whose pages are often
compressed (base64, raw deflate, URL-encoding); Excalidraw files are JSON. Both are untrusted.
**Decision.** Convert on the server, in `oc-model::diagram_import`, never in the browser (one
converter, one set of limits, the browser bundle unchanged). Add three direct dependencies to
`oc-model`, each already compiled into the server through another crate (Cargo.lock gains only
the three dependency lines of `oc-model`): `roxmltree` 0.21 (used by usvg; DTDs refused by
default, so no entity expansion and no external entities; node limit), `flate2` 1 (raw inflate
read through a size cap) and `percent-encoding` 2. `base64` and `serde_json` were already direct.
**Consequences.** + No new crate or version in the tree; + parser limits are ours to test (depth,
nodes, inflated size, image bytes); − three more direct dependencies to keep current with usvg.

