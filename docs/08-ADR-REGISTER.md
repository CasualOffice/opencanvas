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
| ADR-056 | Webhooks (WH-01): the HAPI-05 events POSTed to `[host.webhooks] url` (same origin as the host's `callback_base`: the SSRF rule), signed with `X-OpenCanvas-Signature` v2 and the host secret (or `[host.webhooks] secret`), event id as `Idempotency-Key`; a durable `webhook_outbox` (metadata only, rule 5) on SQLite/MySQL/MariaDB written by the room's owner, claimed per row so one node delivers; backoff 10 s → 12 h with `Retry-After`, give-up after `max_attempts` (12) | Accepted (owner, 2026-11-25) |
| ADR-057 | Icons people add (DGM-17): a server-written document root `icons` `{id → {name, keywords, format, data (cleaned file, base64), width, height, bytes, by, byName, at}}` (exception to ADR-045 §1: a new root, so a document is self-contained and exports never fetch); client updates that touch it are refused, like `comments` for the comment role; `POST /v1/icons` (editors, 20 a minute) cleans the file (`oc_model::icon_clean`: roxmltree pre-scan without DTDs, usvg normalisation, allow-list, 256 KB in / 64 KB cleaned, 2,000 elements, depth 16; PNG by magic bytes, ≤ 256 KB and 1024 px, re-encoded) and writes it through the room; 200 icons and 1 MB per document; every reader checks a stored icon again; the editor and both exporters draw it as `<image href="data:…">`, never inline markup | Accepted (owner approved the design via the prototype, 2026-11-24) |
| ADR-058 | Block packages (BSDK-01): `block.json` checked at install with a compiled JSON Schema 2020-12 **subset** (`oc_model::ext::schema`; any other keyword, a remote `$ref` or another `$schema` refuses the package) instead of the `jsonschema` crate (about 15 new crates); new direct dependency `regex` 1 (MIT OR Apache-2.0; its dependencies already in Cargo.lock) for `pattern`, and `semver` 1 (already in Cargo.lock); packages that fail (manifest, integrity sha384) are refused one by one and listed on `/healthz`; `[host.blocks] enabled = ["type@req"]` is the per-host switch (no `block_sdk` flag); `OC_BLOCKS_ORIGIN` must differ from the editor's origin | Accepted (owner, 2026-11-25) |
| ADR-059 | SDK blocks in documents (BSDK-02): every package's block is `extBlock > block*` (inline content in one paragraph child); data in the `ext` root, one Y.Map key per field; writes carry `data` beside the node and get `fallback` re-derived from the templates; exports draw template, else sanitised fallback, else a placeholder; connections declare `caps=ext`, and an update from a connection without it that removes an `extBlock` (what y-prosemirror in a 0.1.x editor does) is refused and closed with 4426 | Accepted (owner, 2026-11-25) |
| ADR-060 | Block versions (BSDK-05): `v` is the package's SemVer major; `migrations` may be declarative steps (`set default remove move copy map scale` over `{attrs, data}`) run by the server and the editor, or a script for the sandbox; older data is validated, exported and written back migrated; data newer than the installed package is kept read-only (fallback, "Updated by a newer version"), and server writes to it are refused | Accepted (owner, 2026-11-25) |
| ADR-061 | Editor profiles (EDP-01): `[host.editor]` picks a profile (`notebook meeting project diagramming document full`, default `full`) or an explicit list of stable block ids (`core.*`, SDK types), plus `features` (`comments version_history ai diagramming templates import`) that win over the older `[host.flags]`/`[host.ai]` switches; the session carries `editor`; profiles only hide blocks from insertion surfaces, never from loading, rendering, editing, paste or round trips; features with a server surface are enforced there (history routes, AI and MCP, import, team templates, comment writes); unknown values refuse start-up | Accepted (owner, 2026-11-25) |
| ADR-062 | Insert menu model (INS-01): one insert engine and one catalogue (block, variants, aliases, intent phrases, a "why" line) behind the "/" menu, the phone sheet and the gallery; five categories (Content, Data & planning, Visual & diagrams, Layout, Extensions); six blocks carry variants (inline: Heading, List, Callout, Columns; second step: Database view, Diagram type); offers filtered by the EDP-01 profile (`blockAllowed`), 8 or fewer blocks a flat list; local keyword intent matching only; Recent and remembered variants in `localStorage` only (24 entries); `[host.editor] intents`/`chips` the only new host keys; SDK blocks by `discovery.category`, `discovery.keywords` as intents (no new manifest field) | Accepted (owner, 2026-11-25; prototype approved) |
| ADR-063 | Offline cache on the person's device (OFF-01/02, docs/34 §3): off unless `[host.offline] enabled` and the launch token's `perms.offline`, then opt-in per canvas per device (or the host's `auto_recent`); Yjs updates in IndexedDB (y-indexeddb scheme) encrypted under a per-host-and-user device key kept for crypto-shredding; a server-signed offline grant (ES256 JWS: host, user, file, role ≤ `max_role`, `exp` ≤ `grant_days` (7, max 30), `gen`) used only locally, never as a server credential; locked after expiry; no document content on the server (one `offline_generation` metadata row per host and user) | Accepted (owner, 2026-11-26) |
| ADR-064 | Offline reconnect and merge (OFF-04/05/07, docs/34 §3.3, §3.6): every reconnect is a fresh host launch (token refresh), never the grant; role view → pending changes held (download or discard), access gone → local copy and pending changes deleted; queued uploads first, then pending updates in frames ≤ 1 MB within the rate limit, each re-checked by the role filter and MOD-01; a checkpoint save before merges over 10 min or 200 transactions; a merge summary only for edits in deleted blocks and both-sides cell changes; `oc-pending:` asset scheme; host-wide revoke by generation (`POST /api/v1/offline/revoke`); logout through `OpenCanvas.clearOffline()` or the `/v1/offline/clear` iframe (key first, then data); JWT hosts only in v0.3 | Accepted (owner, 2026-11-26) |
| ADR-065 | Cross-canvas search: the host indexes (SRCH-02/03, docs/34 §4.3). Every save carries `search.json` (plain-text projection with block ids; comments only with `[host.search] comments`; no in-file history; ≤ 2 MB) inside the `.ocanvas` (additive to format 1); stateless `POST /api/v1/extract`; optional host callback `GET /search` (ACL-filtered by the host) behind the editor's "Search all canvases", `GET /api/v1/search` and MCP `canvas_search`; OpenCanvas keeps no index. Rejected: an OpenCanvas index (ADR-001), open-rooms-only search, a candidate-file callback, text in webhook payloads (outbox at rest) | Accepted (owner, 2026-11-26) |
| ADR-066 | Find and replace in a canvas (SRCH-01, docs/34 §4.2): client-side over the live Y.Doc (text, database cells, board text; comments find-only as an option; SDK blocks by fallback text; readable live blocks labelled); match case, whole word, regex with a 50 ms budget; replace for editors only, replace all as one transaction and one undo step; matches in a live block replaced in its own room with edit there; server role filter unchanged | Accepted (owner, 2026-11-26) |
| ADR-067 | Automation rules (AUTO-01..03, AUTO-05, docs/34 §5.2–5.5): stored in a new `automations` document root (additive; disabled and ownerless on copy); run by the room's owner node as the collaborator "Automation" on behalf of the rule owner, whose role is re-checked through `/access` at each run (paused below edit); creating rules needs `perms.automate` (default false); saving a rule makes the saver its owner ("Run it as me" on a paused rule); writes through the canvas tool layer (role filter, MOD-01), one transaction per run; loop guard (never itself, chain depth 3); time triggers via a metadata-only `automation_schedule` table with claimed rows; run log `automation_runs` (ids, results, codes, counts; 30 days); events `automation.ran`/`automation.failed` | Accepted (owner, 2026-11-26) |
| ADR-068 | Automation outbound calls and limits (AUTO-04, docs/34 §5.6–5.7): `http.post` signed like webhooks (v2, `Idempotency-Key` = run id), 10 s, no redirects, 3 tries (now, 1 min, 10 min); destination = the host's callback origin or an operator `[host.automation] allow_origins` entry, checked at save and before every call; only the fields a rule names are sent; `notify` only through the host's `POST /mentions`; limits 25 rules per canvas, 60 runs/min per rule, 1,000 runs/day per canvas, 50 changes per run, schedules ≥ 15 min; auto-pause after 10 consecutive failures | Accepted (owner, 2026-11-26) |
| ADR-069 | Live blocks in v0.3, deltas to ADR-039 (LIVE-03, LIVE-07, docs/34 §2): an always-visible header; insert through the host's picker (`UI_PickLiveBlock` → `Action_InsertLiveBlock`) and paste-as (live / reference / link); unlink to a plain copy; `live.embedded`/`live.removed` events for the host's usage index (OpenCanvas keeps none); server-written presence `from {fileId, title}`, omitted for viewers who cannot read that title (its "· in <canvas>" caret label dropped by the owner, 2026-11-26); cached offline only with its own offline grant | Accepted (owner, 2026-11-26) |
| ADR-070 | Live block host contract details (LIVE-01, docs/27 §2.2 left open): `[host.flags] live_blocks` (default off) and `[host.live] {snapshot, link, max_open}` checked at start-up (unknown keys refuse it; the flag needs JWT callbacks, host storage and `callback_base`); `perms.live` defaults to false; derived sessions come from `POST /v1/live/session {ticket, fileId}` only for a file the parent canvas embeds, never from a derived session (depth 1), with role = the host's `/access` answer, perms ∩ the parent's (never `live`), expiry = the parent's; `/access` may answer `name` and `callbackToken` for the live file, else the parent's bearer is used; without `/access`, files in the token's `live` claim open read-only whatever role it names; "Make live" asks the host's `POST /files` only after the checks pass, writes the live file with an internal tool step (one edit, `meta.kind = "live"`), commits it, then replaces the blocks with one `liveBlock`; SDK blocks are not moved (their data would need moving) | Accepted (owner, 2026-11-26) |
| ADR-071 | Live block room rules (LIVE-02): connections declare `caps=live`; an update from one without it that lowers the number of `liveBlock`/`blockRef` nodes is refused and closed with 4426 (as ADR-059, so a 0.2 editor loses nothing); adding a reference needs `[host.flags] live_blocks` and `perms.live` (the server's own writes only the flag); every write path (clients, REST patch, API, MCP, tools) refuses a document that newly breaks the depth rule, the 50-reference limit or the snapshot policy; at most `[host.live] max_open` (≤ 8) live rooms per parent session are connected, counted per node (`429 LIVE_LIMIT` before the upgrade); presence `from {fileId, title}` is written by the server from the parent grant and sent only to viewers whose own session comes from that same canvas (the conservative reading of ADR-069's "viewer can read the title"); the room emits `live.embedded` / `live.removed` for each reference an applied change adds or removes | Accepted (owner, 2026-11-26) |
| ADR-072 | Live block projections, snapshots, exports and render (LIVE-04/05/06): `GET /v1/live/projection` answers the read-only view of a live file or one block with an ETag (304 on `If-None-Match`, so refresh is cheap polling); `POST /v1/live/refresh` (edit role) writes the title (not under `none`) and, only under `content`, `snapshot = {markdown}` ≤ 64 KB with `snapshotAt`, through the room; rendered exports (Markdown, HTML, DOCX, PDF, `render`) resolve each reference for the exporting person into a caption "Live block: <title>" (linked with `[host.live] link`) plus the content, or "(no access)", or the stored snapshot; the `.ocanvas` and JSON exports keep references; `GET /api/v1/files/{id}/render?format=html` is the export renderer's sanitised HTML with the export CSP; API operations `makeLive`, `listReferences`, `renderFile` | Accepted (owner, 2026-11-26) |
| ADR-073 | Live block editor contract details (LIVE-03/07, ADR-069 left open): the session answer carries `live {enabled, make, insert, snapshot, maxOpen, link}`; the host picker acknowledges with `Action_LiveBlockPicker {state}` within 2 s (else the insert entry hides for the session) and answers `Action_InsertLiveBlock {fileId, title?}`; the first-edit hint asks `UI_LiveBlockUsage` and counts places only when the host answers `Action_LiveBlockUsage {fileId, places}` within 1.5 s; `/access` answering 410 (or `gone: true`) means deleted or moved (`404 LIVE_GONE`, prototype 5e), distinct from no access; "Who can see this" is `GET /v1/live/audience` (a count, never names, off above 200 members or on any host failure); block links carry the editor's clipboard marker (`data-oc-file`, `data-oc-block`, `data-oc-live`) or match `[host.live] link` (+ `#block=<id>` / `#live`); unlink copies what the person can read now (the connected room, else a projection without databases or boards) in one undoable step; the live chrome, rooms and dialogs load lazily | Accepted (owner, 2026-11-26) |
| ADR-074 | Offline wire details (OFF-03..07, under ADR-063/064): reconnect asks the host with `Token_Expiring {inSeconds: 0, reason: "reconnect"}` and the host answers `Action_RefreshToken {token}` or `{access: "none"}`; replay answers the room's first SyncStep1 with an empty step 2 and sends the unsent log as update frames ≤ 900 KB at 20/s; `{"t":"offline_merge"}` → `offline_checkpoint` (named save "Before <name>'s offline changes", once per connection, writers only) and `offline_arrived` to the others; a root service worker `/sw.js` caches only the editor build (`/app/shell.json`) and turns an unreachable `offline=1` launch into `/app/#offline=1&h&u&f`; `/v1/offline/files` lists the device's copies for `OpenCanvas.offlineFiles()` | Proposed |
| ADR-075 | SDK blocks in live blocks (PSDK-01..08, docs/34 §2.4; amends ADR-070's last clause): Make live moves each `extBlock`'s `ext[dataId]` verbatim (no migration, every ADR-060 state) into the live file in its first document, and deletes it from the canvas in the same one-edit transaction (kept when another `extBlock` there names the same `dataId`), with a catch-up copy of fields edited meanwhile; Undo restores blocks and data in one step; unlink copies content and data from the room or projection with fresh `dataId`s in one undo step; block projections carry only their blocks' `ext`; references are read-only; the live file's ACL governs the data; sandbox permissions = manifest ∩ `[host.blocks.permissions]` of the canvas session's host ∩ the live room's host; ADR-060 states apply per viewer and data migrates only on a write; writes aimed at a moved `dataId` answer 404 `BLOCK_MOVED {liveFileId}`; `caps=liveext`: without it, an update that removes an `extBlock` in a live room or adds a data-less `extBlock` anywhere is refused with 4426; Make live on SDK blocks is offered only when the session says `live.sdk` | Accepted (owner, 2026-11-26; newer or missing packages move as stored) |
| ADR-076 | Partial document sync (PSYNC-01..04, docs/36 §2): databases, boards and diagrams keep their content in Yjs subdocuments (`guid = <fileId>/block/<blockId>`), the main document keeps text, outline and a header per heavy block; sync frames carry a document id on one socket; a client asks for a subdocument when its block nears the viewport and the server checks the role per request, same file only; the room loads subdocuments lazily and evicts unheld ones, WAL per document id; saves flatten to `.ocanvas` format v1; `caps=subdoc`, older editors closed with 4426 on split rooms; offline copies load every subdocument; the launch carries the main document as one compressed snapshot. Confirmed by the PSYNC-01 spike (docs/36 §2.5): on the 50 MB fixture, first screen 228 ms and room 5 MB against 6.1 s and 734 MB today; the first-screen projection painted in 182 ms but left the caret at 6.3 s and the room at 734 MB, so it was not chosen. The split keeps Yjs item ids so the save is a merge of the parts | Accepted (owner, 2026-11-26; 0.3 editors are closed with 4426; spike 2026-11-26 chose subdocuments) |
| ADR-077 | Room fan-out and presence at scale (PERF-12/13, docs/36 §4.2): clients send awareness at most every 100 ms (latest wins); the room sends one merged awareness frame per peer per tick with the latest state per client; a tick's updates are merged and encoded once and shared by every peer; after apply the tick goes to fan-out shards (cores − 1), each owning a fixed subset of sockets so per-peer order holds; slow peers leave by the existing back-pressure rule; above 200 peers cursors outside the reader's visible blocks are sent at 1 Hz; relayed peers get the tick once per node; `MAX_PEERS` stays 550 until X10K, R1K, SOAK and the RLB-A1..A3 drills pass (docs/36 §4.2) | Accepted (owner, 2026-11-26; default cap stays 550, 1,000 as a configured maximum) |
| ADR-078 | Formula engine, relations and rollups (DB4-01..06, docs/36 §6.1): one typed engine (`oc-formula`, Rust, native in the server and WASM in the editor, loaded lazily) with errors as values (`#TYPE #REF #CYCLE #DIV/0 #LIMIT`), only expressions stored and values computed through a dependency graph, limits (4 KB, depth 64, step budget per cell), `now()` never triggers automation; relation fields hold row ids, same canvas `{dbId, rowIds}` (optionally two-way) or across canvases only through a live block `{fileId, dbId, rowIds}` read under the live file's ACL ("No access" otherwise), one-way; rollups aggregate related rows, across canvases from the live projection on refresh; MOD-01 validates on every write path | Accepted (owner, 2026-11-26) |
| ADR-079 | Benchmark program and performance budgets in CI (BENCH-01..05, LAZY-01, docs/36 §3): `scripts/bench/` runs scenario files (`bench/scenarios/*.toml`: rooms, peers, load mix, fixture, duration, faults, pass rules; docs/22 A–E, R, K, T kept) locally and in CI; every result is JSON with commit, hardware, store and load mix, and is refused for publication without them; pull requests gate the initial JS (300 → 260 → 240 → 220 KB gzip, `check-budget.mjs --forbid` for advanced modules in the initial graph), heap per fixture (Chromium, after GC, +5% fails) and first screen, plus quick server runs; a nightly job fails at p99 > 20% or RSS > 10% worse than the median of the last seven runs; full X10K, R1K and STORM run weekly on a reference machine and publish to the site's Benchmarks page with hardware and mix; budgets change only in a reviewed commit that says why | Accepted (owner, 2026-11-26; reference runs on the owner's Mac until a machine is chosen, results marked local) |
| ADR-080 | Spreadsheet block on opencalc's engine (SHEET-01.., prototype `v04-approved/spreadsheet.html`): the block computes with CasualOffice/opencalc's Rust crates (`casual-calc-sdk` without text shaping and rasterising: model, formula, eval, transaction, xlsx/ods import and export), pinned to a git revision, native in the server and WASM in the editor behind our own JSON bridge (as `oc-formula`), loaded only when a spreadsheet block comes within a screen; opencalc's editor (`<opencalc-sheet>`) and its OT collaboration are not used. Yjs stays the source of truth and the engine is a per-client cache: per sheet `rows`/`cols` are `Y.Array`s of stable ids and cells a `Y.Map` keyed `rowId:colId` holding the input (formulas with references stored as row/column ids, shown and fed to the engine as A1) and a style key; values are computed, never stored. The block is a partial-sync part (ADR-076) and lives in `.ocanvas` as Yjs like every block; exports, `search.json` and the API show values from the native engine. `oc-formula` does not delegate to opencalc (different language, typed records, relations and rollups); functions both have are cross-checked on shared vectors | Accepted (owner, 2026-11-27: engine yes, our grid) |
| ADR-081 | Link index across canvases (LINK-01..05, docs/38 §2): a `canvasLink` inline node `{fileId, blockId?, rowId?, label}` (`[[` picker, pasted host URLs matching `[host.links] url_patterns`; fallback a `link` mark) with block, heading and row targets; the server keeps `link_edges` (ids and kind only: `link`, `embed`, `relation`; no titles or text; migration 0014) replaced per file at each save the host acknowledged; backlinks read through the host's ACL at read time (`POST /access/batch`, else `/access`), hidden sources dropped without a count; titles from the host, excerpts made at read time and kept 5 min in memory only; unlinked mentions through the host's `GET /search`; `[host.flags] links` off by default; Redis-only storage refused | Accepted (owner, 2026-11-28) (2026-11-28) |
| ADR-082 | Graph API (GRAPH-01..03, docs/38 §3): `GET /api/v1/graph` local (`root`, depth 1–3, ≤ 500 nodes) and full (≤ 2,000 most-connected readable canvases, `truncated`) from `link_edges`; every node access-checked before it is expanded, so hidden canvases neither appear nor connect others; optional host callback `GET /files/readable`; block nodes optional; 30 s per-reader cache; 10 requests/min (2 full); MCP `canvas_graph`; view in a lazy chunk with a list fallback | Accepted (owner, 2026-11-28) (2026-11-28) |
| ADR-083 | Plugin packaging, signing and distribution (PLUG-01..06, docs/38 §4): one `.ocplugin` zip with `plugin.json` (id, SemVer, `engines`, `contributes`, `permissions`, per-file sha384) that may contribute blocks, views, commands, importers, exporters, actions and providers; block packages are plugins (`OC_BLOCKS_DIR` kept); publisher Ed25519 signature plus marketplace countersignature; a signed `index.json` with version and 7-day expiry (rollback and freeze refused) carrying revocations fetched hourly; private registries in the same format and signed offline bundles; operator (`[plugins]` registries, `server_code`, ceilings), host admin (`perms.plugins: "admin"` or `/api/v1/plugins`) and person (request) roles; per-host policy; auto-update only when permissions do not change | Accepted (owner, 2026-11-28) (2026-11-28) |
| ADR-084 | SDK extension points and the server runtime (EXT-01..08, docs/38 §5): database views and commands run in the block origin's sandbox (ADR-040) with a checked bridge; importers, exporters, automation actions and integration providers run as WebAssembly components on wasmtime (world `opencanvas:plugin@0.5.0`; fuel, 256 MB, 10 s / 60 s, fresh instance per call, bounded pool; host imports `log`, `http-fetch` to declared and allowed origins, `connection-token`, `clock`, `random`; no filesystem, sockets or environment); outputs are data applied through the tool layer (role filter, MOD-01); provider connections per person or organisation encrypted under `OC_KEK`; amends ADR-040: server code is off unless `[plugins] server_code = true` | Accepted (owner, 2026-11-28) (2026-11-28) |
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
   *(DGM-14 S2, 2026-11-24, agreed by the owner via the coordinator)* A descriptor may carry a
   `look` (`path`: SVG path data in a 100 × 100 box, only path letters, digits, spaces, commas,
   dots and minus signs; `w`/`h`: default size; `tone`: a tone name; `text`: default text), a
   `library` id and search `keywords`. Still data only: `registerShape` rejects anything else, and
   descriptors and looks are frozen. The editor draws the path stretched to the shape; the
   exporters and 0.1.x clients keep drawing the base type.
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
**Note (DGM-19, 2026-11-24, profiled first).** Zoomed out on a 10k board the cost was DOM size
(55k elements), then raster: a trace of the first level-of-detail cut (grouped paths in the board
SVG) showed four raster threads busy for most of each pan, script ~1.7 ms per event. Decision: still
SVG, no `<canvas>`. Below 40 % zoom on boards over 300 shapes the shapes draw as one `<path>` per
style group in a separate `<svg>` under the board SVG, moved by a CSS transform (`will-change`) so
the compositor pans it without re-raster; hit-testing by position through `SceneIndex`. Pixel-identical
at 40 % and above (test). 10k fit-view pan 134.6 → 23.6 ms latency p50 (harness floor), 16.7 ms
frames, no long tasks (docs/29 §6.6).

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
**Note (DGM-12b, 2026-11-24).** Point 3 is built in every exporter: Rust SVG, PNG, PDF and preview
(`board::stored_route`), the web SVG/PNG exporter (`connectors.ts` `exportResolvedArrows`) and the
draw.io export (bends only for a current route; otherwise a plain orthogonal edge draw.io routes
itself; Mermaid has no geometry). "Still match" = `pts` starts and ends exactly where the plain
elbow would (ports or anchors of the bound shapes, after sticky growth) and every leg is
axis-aligned. Shared fixture `board-avoid.json` (points and SVG byte-equal in both). The Rust router
port and the route worker stay deferred: neither is needed while `pts` is current, and no
measurement asks for the worker yet.

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

### ADR-056 — Webhooks: signed deliveries of change events from a durable outbox (Accepted by the owner 2026-11-25)
**Context.** Hosts want to react to canvas activity (index a saved file, notify on a comment)
without holding an event stream open. HAPI-05 defined the events (ids, user ids, versions,
counts; never content). Webhooks must survive restarts and failovers, never deliver one event
from two nodes, never carry document content into a database (ADR-001, rule 5), and must not
let a hosts file turn the server into a proxy into the network it runs in (SSRF).

**Design (short).**
1. *Config.* `[host.webhooks] url, events, secret?, max_attempts?`. `events` lists HAPI-05 types
   (`edited`, `commented`, `mentioned`, `member.joined`, `member.left`, `session.closed`,
   `restored`, `saved`) or `"*"`; `secret` accepts `env:`/`file:` like every secret. Checked at
   startup: an unknown type, a non-http(s) URL or a URL off the callback origin stops the server.
2. *Source.* The room actor publishes each event once, on the node that owns the room (HAPI-05).
   That node's hub hands it to a writer task, which inserts a `webhook_outbox` row when the
   host subscribes to the type. Other nodes receive events over the bus for their streams only,
   never for webhooks. The row id is the event id (`ev_<ulid>`), so a repeated insert is a no-op.
3. *Store.* `webhook_outbox (id, host_id, room_id, file_id, event_type, payload, attempts,
   next_try_at, status, last_status, created_at, done_at)` on SQLite, MySQL and MariaDB
   (migration `0009`). `payload` is the event JSON: ids and counts only. Finished rows are kept
   7 days for inspection, then purged with sessions. Redis-only storage (ADR-030) has no outbox
   in v0.2: webhooks are refused there at startup with a clear message.
4. *Delivery.* Every node runs the worker: pick due `pending` rows, claim each with a conditional
   update of `next_try_at` (the notify-outbox pattern: exactly one claimant), POST, record.
   `POST <url>` with the event JSON, `Content-Type: application/json`, `X-OpenCanvas-Event`,
   `X-OpenCanvas-Event-Id`, `Idempotency-Key: <event id>`, `X-OpenCanvas-Delivery-Attempt`, and
   `X-OpenCanvas-Signature: t=…,v1=…,v2=…`: v2 = HMAC-SHA256(secret, `<t>.POST.<path?query>.<body>`)
   exactly as on callbacks (docs/05 §5), secret = `[host.webhooks] secret` or the host's
   `callback_secret`/`jwt_secret`. 10 s timeout, redirects never followed.
5. *Retries.* `2xx` = done. Network errors, timeouts, `408`, `425`, `429` and `5xx` retry after
   10 s, 30 s, 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, 4 h, 8 h, 12 h (a longer `Retry-After`, up
   to 12 h, wins); after `max_attempts` (default 12, at most 20) the row is `failed` (give-up).
   Other `3xx`/`4xx` are `rejected` at once (a receiver that refuses will refuse again). The
   schedule runs on `crate::clock::Clock`, so tests pin time instead of sleeping.
6. *Ordering and duplicates.* At-least-once: a receiver deduplicates by `Idempotency-Key`.
   Order is not guaranteed across retries; `at` and the ULID order events of one file.
7. *Metrics.* `oc_webhook_deliveries_total{host,result}` (`ok`, `retry`, `rejected`, `gave_up`,
   `refused`) and `oc_webhook_delivery_seconds{host}`, on the OPS-01 dashboard.

**Decision (SSRF): restrict the URL to the origin of the host's `callback_base`** (scheme, host
and port; with `OC_CALLBACK_BASE_OVERRIDE`, the configured origin is accepted and delivery goes
through the override, like callbacks). Checked when the hosts file loads and again before every
delivery (a row whose host config changed is `refused`, never sent). Why this and not the unfurl
fetcher's private-range blocking: (a) hosts usually run next to OpenCanvas on a private network,
where private-range blocking would refuse the legitimate receiver and push operators to
allow-list whole private ranges; (b) the callback origin is already trusted with signed
callbacks carrying callback tokens, so webhooks add no new destination; (c) an origin check is
decided from configuration alone, with no DNS lookup to race (no rebinding window); (d) no
redirects, so the check cannot be bypassed by a `Location`.

**Consequences.** + No new destination and no new secret to manage by default; + restart- and
failover-safe, one delivery per event; + no document content at rest. − A receiver on another
domain needs a relay on the host's own origin (or a later opt-in allow-list); − events between
an owner's crash and its outbox insert are lost (the stream's `resync` covers readers; webhooks
are at-least-once from the outbox on); − no webhooks with Redis-only storage in v0.2.

### ADR-057 — Icons people add: a server-written `icons` root and `POST /v1/icons` (Accepted, 2026-11-24, DGM-17)
**Context.** The owner's policy (2026-11-24, approved prototype `docs/prototypes/icons-approved/`)
ships only generic icons; product logos are added by people themselves. An uploaded SVG is
untrusted markup (scripts, event handlers, `foreignObject`, external references, entity bombs), and
a document must stay self-contained: exports and the preview never fetch anything.
**Decision.**
1. *Root.* Added icons live in a new document root `icons` (exception to ADR-045 §1, decision 1 of
   the prototype), `{id → {name, keywords, format: svg|png, data, width, height, bytes, by, byName,
   at}}`, `data` the cleaned file in base64. Only the server writes it: the room refuses any client
   update that changes the root (`room::filter::touches_root`; a deep observer on a scratch copy,
   run only when the document has the root or the update names it), like `comments` for the comment
   role. Server writes go through the room as one transaction with origin `icons`
   (`Cmd::Icons`, forwarded to the owner in a cluster).
2. *API.* `POST /v1/icons?ticket=[&dryRun=1][&name=&keywords=][&replace=<id>]` with the file as
   the body (editors only, 20 uploads a minute per person) and `POST /v1/icons/:id?ticket=` with
   `{"name","keywords"}` or `{"remove": true}`. A dry run answers with the cleaning report and a
   preview and stores nothing.
3. *Cleaning* (`oc_model::icon_clean`). PNG by magic bytes, ≤ 256 KB and 1024 px, decoded and
   encoded again. SVG ≤ 256 KB: a `roxmltree` pre-scan (DTDs refused, so no entity expansion;
   ≤ 2,000 elements; depth ≤ 16) counts what will be removed, by name; `usvg` normalises it with
   every external reference resolving to nothing (inline PNG/JPEG only, text to outlines); the
   output must pass an allow-list (drawing elements, no `on*`, no `style`, references inside the
   file or inline rasters only) and be ≤ 64 KB.
4. *Limits.* 200 icons and 1 MB of icon data per document (`oc_model::doc_icons`).
5. *Drawing.* The editor and both exporters draw an added icon as `<image href="data:…">`, never
   inline markup; `oc-model` checks a stored icon against the allow-list again before drawing it.
   A missing or failing icon draws the empty frame (editor) or the base rect with its label
   (exports, 0.1.x clients).
**Consequences.** + Self-contained documents; logos never reach a browser uncleaned; + one
cleaner for every path. − Documents with icons pay a scratch-copy check per client update (O(doc
size)); a cheaper check by update structure is a follow-up. − Undo of adding or removing an icon
is not offered (only the server writes the root); shapes keep working either way.

### ADR-058 — Block packages: schema subset, integrity and per-host enablement (Accepted by the owner 2026-11-25)
**Context.** ADR-040 fixed the block contract: JSON Schema 2020-12 manifests validated by MOD-01,
packages installed by the operator with an SRI hash. A validator was needed in `oc-model`. The
`jsonschema` crate (MIT) implements all of 2020-12 but brings about 15 crates (fancy-regex,
fraction, referencing, uuid-simd, email_address, ahash, …) and remote-reference features to keep
switched off.
**Decision.** (1) `oc_model::ext::schema` compiles a defined subset (docs/15 §4.2) and refuses any
other keyword, a `$schema` other than 2020-12 and any non-local `$ref` when the package is
installed; nothing is ever fetched. (2) `pattern` uses `regex` 1 (MIT OR Apache-2.0,
rust-lang; linear time, size-limited); `regex`'s own dependencies and `semver` 1 (MIT OR
Apache-2.0) were already in Cargo.lock. (3) Each package is checked on its own; a bad one is
refused, logged and listed on `/healthz`, and the server starts. (4) `[host.blocks] enabled` (a
list of `type@SemVer requirement`) is the per-host switch the design's `block_sdk` flag would
have been. (5) `OC_BLOCKS_ORIGIN` must be a different origin from `OC_PUBLIC_URL`.
**Consequences.** + one small, audited validator, the same on every write path; + a bad package
cannot stop a server; − authors cannot use `unevaluatedProperties`, `$dynamicRef`,
`dependentSchemas` or format assertions.
**Note (BSDK-03, 2026-11-25).** The manifest gains optional `publisher` (1-80 characters),
`keywords` (≤ 10 words) and `preview` (a `.png` inside the package, ≤ 512 KB, PNG signature
checked; decision 7), and `[host.blocks]` gains `[host.blocks.permissions."<type>"]` (`network`,
`members`) that narrows the manifest's permissions per host (decision 9; a host can only take
away). The editor runs the same schema subset for the bridge's write checks
(`web/packages/editor/src/ext/schema.ts`, shared cases), and the server checks room updates too.
**Note (owner decision, 2026-11-25).** Optional `discovery {label, category, keywords, profiles,
complexity}` before the v0.2 contract freezes: `category` ∈ `content`, `data-planning`, `visual`,
`layout`, `extensions` (default `extensions`); `profiles` ⊆ `notebook`, `meeting`, `project`,
`diagramming`, `document`, `full` (default `["full"]`); `complexity` `basic` | `advanced` (default
`basic`); unknown categories or profiles refuse the package; `discovery.keywords` merge with
`keywords`. The session lists `discovery` with defaults applied; editor menus filter through
`blockVisibleInMenus(entry, profile)` for host editor profiles.

### ADR-059 — SDK blocks in documents and older editors (Accepted by the owner 2026-11-25)
**Context.** ADR-040/042 assumed that 0.1.x keeps an unknown node. The `.ocanvas` reader does
(MOD-02), but the 0.1.x **editor** binds the document with y-prosemirror against its own schema,
and y-prosemirror deletes any element its schema lacks (`deleteYType`), for every peer. Seen with
the v0.1.1 schema in `web/packages/editor/src/ext/compat.test.ts`.
**Decision.** (1) One node, `extBlock {type, v, attrs, dataId, fallback} > block*`; a package with
inline content keeps it in one paragraph child. (2) Data in the `ext` root: `ext[dataId]` is a
Y.Map with one plain-JSON value per field. (3) API, MCP and REST patch writes may carry `data`
beside the node; the server writes it to `ext`, checks both against the schemas and re-derives
`fallback` from the templates. (4) Exports: template, else the fallback sanitised by a Markdown
round trip, else `Block: <name>`; HTML, DOCX, PDF and previews draw that Markdown. (5) The editor
sends `caps=ext`; an update from a connection without it that lowers the number of `extBlock`s is
refused and the socket closed with 4426 (a 0.1.x editor treats 44xx as final).
**Consequences.** + no SDK block is lost to an editor older than 0.2 sharing the room; − such an
editor's session ends when it meets an SDK block (the person reopens with the current editor);
− headless CRDT clients must send `caps=ext` to delete SDK blocks; − one scratch-copy check per
update from such connections in rooms with SDK blocks.

### ADR-060 — Block versions and declarative migrations (Accepted by the owner 2026-11-25)
**Context.** docs/27 §3.3 runs `migrations.js` in the sandbox. The sandbox (BSDK-03) is not built
yet, and the server must never run third-party code (ADR-040), so neither could migrate or
validate older data.
**Decision.** `v` is the package's SemVer major. `migrations` is either a script (sandbox) or
declarative steps per version (`set default remove move copy map scale` over `{attrs, data}` with
JSON pointers), run identically by `oc_model::ext::migrate` and the editor's `migrate.ts` (shared
cases). Older data is validated, exported and written back at the installed version; script
migrations leave older data as it is (a warning). Data newer than the installed package is never
rewritten: validation warns, exports use its fallback, the editor shows "Updated by a newer
version" read-only, and server writes or replaces of it are refused.
**Consequences.** + older documents open with newer packages on every path, without code; + the
server can check migrated data against the new schema; − complex migrations still need the
script form and a client with the package.

### ADR-063 — Offline cache on the person's device (Accepted by the owner 2026-11-26)
**Context.** v0.3 adds offline-first editing (docs/34 §3). ADR-001 forbids the server from
persisting documents; the host owns files and decides who may hold a copy.
**Decision.** Offline copies live only on the person's device, in IndexedDB, and only when the
host enables `[host.offline]`, the launch token carries `perms.offline`, and the person keeps the
canvas offline (or the host sets `auto_recent`). Data is encrypted under a device key per host
and user so that deleting the key destroys every copy at once. A server-signed offline grant with
a short expiry tells the editor locally whether and how a copy may open; it is never accepted by
the server. The server stores one generation number per host and user, nothing else.
**Alternatives.** Server-side offline queue (rejected: stores content); always-on browser cache
(rejected: shared computers, host policy); a service-worker-only cache without grants (rejected:
no expiry or revocation).
**Consequences.** + no new server storage of content; + host policy per launch; − storage
partitioning and Safari eviction mean a copy can disappear; − the device key does not protect
against someone who controls the browser profile (the OS lock does).

### ADR-064 — Offline reconnect, merge and revocation (Accepted by the owner 2026-11-26)
**Context.** Offline edits must merge without loss and without bypassing permissions that changed
while the person was away.
**Decision.** Reconnect is a fresh host launch; the server's role decides before any pending update
is sent. Pending updates are sent in chunks within the frame and rate limits and re-checked like
typing. Large merges are preceded by a checkpoint save. The editor shows a merge summary only for
edits lost with a deleted block and for both-sides cell changes. Revocation: lower role holds the
changes for download or discard; no access deletes the copy; a host-wide revoke raises the
generation number. Logout clears through the SDK or a clear iframe on the host's site.
**Consequences.** + the host's current ACL always wins; + history can undo a bad merge; − WOPI hosts
(no refresh callback) get session resilience only in v0.3.

### ADR-065 — Cross-canvas search: the host indexes (Accepted by the owner 2026-11-26)
**Context.** Cross-canvas search spans files the host owns under the host's ACL; OpenCanvas may not
keep their content (ADR-001).
**Decision.** Every save includes `search.json` in the `.ocanvas`; `POST /api/v1/extract` produces it
statelessly; the host indexes it in its own engine and may answer an optional `GET /search`
callback that the editor, the API and MCP use.
**Alternatives kept.** (A) an OpenCanvas index: stores content, duplicates ACL, stale on permission
changes. (B) open rooms only: incomplete; maybe later as a freshness overlay. (C) a candidate-file
callback with server-side scanning: many file loads per query. (D) text in `saved` webhooks:
payloads are stored in the outbox.
**Consequences.** + no index or content in OpenCanvas; + the host's ACL and engine; + JWT and WOPI
alike; − results are as fresh as the last save; − hosts must do the indexing (sample host and
Nextcloud app show how).

### ADR-066 — Find and replace in a canvas (Accepted by the owner 2026-11-26)
**Decision.** Client-side over the live document; replace for editors only and as one transaction;
live blocks replaced in their own rooms. The server needs no new code beyond the role filter.
**Consequences.** + instant and current; + no server load; − regex across very large canvases is
bounded by a time budget and a 10,000-match display cap.

### ADR-067 — Automation rules in the document, run by the server (Accepted by the owner 2026-11-26)
**Context.** People want rules ("when an item is done, move it") without running their own
service; the server may not store documents.
**Decision.** Rules are document data in an `automations` root, so the host stores them with the
file. The room's owner node runs them through the canvas tool layer as "Automation" on behalf of
the rule's owner, re-checking that person's access every run. Time triggers use a metadata-only
schedule table; runs are logged as metadata for 30 days.
**Alternatives.** Rules in an OpenCanvas table (rejected: server state that outlives the file and
escapes the host's copy and ACL model); rules only in the host (rejected: every host would rebuild
the engine); client-side rules (rejected: need an open browser).
**Consequences.** + rules travel with the file and history; + no write path beyond the API's; − time
rules need the server to open closed files with the host key.
**Notes (2026-11-26, AUTO-CL).** *Cluster.* Rules run where the room's tool layer runs, the room's
owner node: the API, editor and MCP rule operations sent to another node are forwarded to the
owner (`RemoteOp::Automation`), and the schedule worker leaves a slot whose room another node
holds to that node (a dead owner's lease expires, then any node takes the room over). Limits,
auto-pause and duplicate suppression read the shared run log, so they hold cluster-wide. A
node that dies after logging a run as `running` is not re-run (its actions may have happened);
the janitor logs it `failed`/`INTERRUPTED` after an hour. Delivery is at most once per slot or
change. Tested on three nodes with Redis and MySQL 8.4 / MariaDB 10.11
(`tests/automation_cluster.rs`). *Redis-only storage stays refused at start-up* for
`[host.automation]`, as for webhooks (ADR-056): the schedule claim is a conditional update, a run
id is a unique insert, and the limits and auto-pause are range and order queries over the run log.
Redis has none of these as one statement; rebuilding them with sorted sets and Lua scripts is a
second implementation to keep in step, and a Redis-only deployment's eviction and persistence
settings belong to the operator, so a run log and schedule there could vanish without notice.
Operators who want automation add `DATABASE_URL` (SQLite for one node, MySQL or MariaDB for a
cluster).

### ADR-068 — Automation outbound calls and limits (Accepted by the owner 2026-11-26)
**Decision.** URL calls follow the webhook rules (signature, origin, no redirects) plus an operator
allow-list, send only the named fields, and run under per-rule, per-canvas and chain limits with
auto-pause. Notifications go through the host's mentions callback only.
**Consequences.** + no new SSRF surface beyond what the operator lists; − calling a third-party
service needs the operator's allow-list or a relay on the host's origin.

### ADR-069 — Live blocks in v0.3 (Accepted by the owner 2026-11-26)
**Decision.** ADR-039 holds; v0.3 adds an always-visible header, the host picker and paste-as flow,
unlink to a copy, usage events for the host, server-written presence origin, and the offline rule
(a live block is cached only with its own grant). See docs/34 §2.
**Amendment (owner, 2026-11-26).** The "· in <canvas>" caret label is dropped. ADR-071 sends
`from` only to viewers whose session comes from that same canvas, so the label could only ever
name the viewer's own canvas. The server still writes `from` (ADR-071 unchanged); the editor
shows the name only.

### ADR-070 — Live block host contract details (Accepted by the owner 2026-11-26)
**Context.** docs/27 §2 and ADR-039 fix the model (live files are host files, derived grants via `/access`) but leave the mechanics open.
**Decision.** See the register row: start-up-checked `[host.flags] live_blocks` and `[host.live]`; `perms.live` off by default; `POST /v1/live/session` mints derived sessions only for files the parent canvas embeds; role from `/access` (optional `name`, `callbackToken`), perms ∩ parent, parent expiry, depth 1; the token's `live` claim opens read-only only; "Make live" checks first, then `POST /files`, an internal one-edit write, a commit and one `liveBlock`.
**Consequences.** + a ticket is never a key to arbitrary files; + hosts that scope bearer tokens per file can do so; − hosts must implement `/access` (and `POST /files` for "Make live"); − SDK blocks cannot be made live yet.

### ADR-071 — Live block room rules (Accepted by the owner 2026-11-26)
**Context.** A 0.2 editor's y-prosemirror deletes nodes its schema lacks (ADR-059); live blocks add rules (depth, limit, snapshot policy) that every writer must follow; ADR-069 adds presence origin and usage events.
**Decision.** See the register row.
**Consequences.** + no live block is lost to an older editor, which must reopen with the current one; + the rules hold for the API and MCP as for typing; − one scratch-copy check per update in documents with references; − the open limit is per node; − people outside the parent canvas see a live block's editors without their origin.

### ADR-072 — Live block projections, snapshots, exports and render (Accepted by the owner 2026-11-26)
**Context.** docs/27 §2.2 and §2.5 ask for read-only projections that refresh, policy-bound snapshots and per-person exports; the mechanics were open.
**Decision.** See the register row.
**Consequences.** + nothing of a live file reaches the embedding file unless the policy is `content`; + exports never show what the exporting person cannot read; − refresh is polling with ETags rather than a push; − each export resolves references with one `/access` call (cached 30 s) and one room load per live file.

### ADR-074 — Offline wire details (Proposed)
**Context.** ADR-063/064 fixed the model; building OFF-03..07 needed a few wire details they left open.
**Decision.** See the register row. The host keeps deciding: a reconnect is always its fresh token or
its "no access"; a host that never answers keeps the running session (re-checked by the server).
**Consequences.** + hosts that already renew tokens (PERM-07) support offline with one extra answer;
+ the replay never trips the frame or rate limits; − a service worker at the server root (it handles
only `/v1/launch` navigations and `/app/` and passes everything else through).

### ADR-075 — SDK blocks in live blocks (Accepted by the owner 2026-11-26)
**Context.** ADR-070 left SDK blocks out of Make live because their data sits in the canvas's `ext`
root, apart from the node. Unlink, references, exports and the package rules (ADR-060) had no
answer for a block whose data lives in another file. The owner asked for the design on 2026-11-26.
**Decision.** See the register row and docs/34 §2.4. Wherever an `extBlock` lives, its data lives
in the same document; a move is a verbatim copy, not a write, so it needs no migration and no
package; everything else (ACL, permissions, versions, exports) follows from the file that now
holds the block, narrowed and never widened by the embedding canvas.
**Consequences.** + SDK blocks become portable like core blocks with no new storage and no
cross-file pointers; + per-field last-writer-wins survives the move; + old editors cannot lose data
(4426); − one more connection capability; − a 0.3.0 editor cannot make SDK blocks live or unlink
them safely (it is refused, not corrupted); − two viewers of one live block may see different
package states when their hosts differ.

### ADR-076 — Partial document sync (Accepted by the owner 2026-11-26)
**Context.** A Yjs document syncs whole; a 50 MB canvas sends and builds 50 MB before the first paint and the room holds all of it. The owner's v0.4 target is a first screen in under 2 s (docs/36 §2).
**Decision.** See the register row. Heavy blocks become subdocuments synced on demand over one socket; the save stays format v1.
**Consequences.** + first paint and memory scale with what is on screen; + no change for hosts or the file format; − a split room needs `caps=subdoc` (0.3 editors are closed with 4426); − undo spans documents; − the server re-checks roles per subdocument request.
**Spike (PSYNC-01, 2026-11-26).** Measured on the seeded 50 MB fixture (Chromium, 4× CPU, 40 Mbit/s, 40 ms; median of 5; local M4). Subdocuments: first screen 228 ms (531 ms with a database on it), 191 KB before it, room 5.0 MB, browser heap 3.4 MB. A first-screen projection: 182 ms and 26 KB to paint, but the caret only at 6.3 s and the room and browser unchanged (734 MB, 385 MB), against 6.1 s, 10.5 MB, 734 MB and 385 MB today. **Chosen: subdocuments.** Condition for PSYNC-02: the split keeps Yjs item ids, so the v1 save is a byte-level merge of the parts and offline copies merge without duplicates (docs/36 §2.5).

### ADR-077 — Room fan-out and presence at scale (Accepted by the owner 2026-11-26)
**Context.** Fan-out is quadratic; at 1,000 peers unthrottled cursors alone would be millions of frames per second (docs/22, docs/36 §4.2).
**Decision.** See the register row.
**Consequences.** + frames per tick scale with peers, not peers × senders; + uses every core while the document keeps one writer; − remote cursors far from the reader move at 1 Hz in very large rooms; − one more stage between apply and send.

### ADR-078 — Formula engine, relations and rollups (Accepted by the owner 2026-11-26)
**Context.** Formulas must give the same value in the editor, exports, the API, MCP and automation; relations across canvases must not widen anyone's access. Secondary in v0.4 (docs/36 §6).
**Decision.** See the register row.
**Consequences.** + one implementation, identical results everywhere; + the document stays small (expressions only); + cross-canvas data follows the live file's ACL; − a WASM chunk; − cross-canvas rollups update on refresh, not per keystroke; − cross-canvas relations are one-way.

### ADR-079 — Benchmark program and performance budgets in CI (Accepted by the owner 2026-11-26)
**Context.** docs/22's numbers come from a hand-run script; nothing stops a regression, browser memory and startup have no budget, and the owner made benchmarks a first-class part of v0.4 (2026-11-26).
**Decision.** See the register row and docs/36 §3.
**Consequences.** + every target is reproducible and every published number states its hardware and load mix; + regressions fail CI instead of reaching people; − a reference machine and a nightly job to run; − budget changes need a reviewed reason.

### ADR-080 — Spreadsheet block on opencalc's engine (Accepted by the owner 2026-11-27)
**Context.** The owner approved a Spreadsheet block (2026-11-26): per-cell Excel formulas (A1, ranges, `$`, `Sheet!A1`), about 120
functions, formatting, several sheets, xlsx/ods in and out, 100,000 rows, other people's selections, comments, phone. The sister
project CasualOffice/opencalc (Apache-2.0, Rust, alpha) is an Excel-compatible engine with an Excel-style editor in WebAssembly. The
owner asked whether to embed it rather than build our own, and whether database formulas should use it.

**What was checked (2026-11-27, opencalc `main` @ 88a2522, local Apple M4).**
- A spike crate on `casual-calc-sdk` (default features off) computed every case the prototype shows: `SUM(A1:A2)`, `$A$1*2`, `IF`,
  `A1/0` → `#DIV/0!`, `XLOOKUP`, `Sheet1!A1 + SUMIF(…)`. `casual-calc-eval` lists 437 built-in functions; every function named in the
  prototype is there.
- WASM size (wasm32, `opt-level = "z"`, LTO, input + recalculation + xlsx open and save linked): **2.09 MB raw, 733 KB gzip,
  530 KB brotli**. Without import: 1.59 MB / 549 KB gzip. opencalc's own editor ships an 8.1 MB binary and 1.6 MB of JavaScript
  (its docs/100).
- opencalc's editor holds one workbook per JavaScript realm: a second element on the page silently edits the first one's workbook
  (its docs/100, a known data-loss defect). Its bindings keep the session in a global; the SDK itself is an ordinary value.
- Its collaboration is server-ordered OT and deliberately not a CRDT (its docs/56), with its own server.

**Decision.**
1. *Engine, not editor.* The block uses opencalc's engine crates and our own grid UI built to the approved prototype (OpenCanvas
   toolbar, Lucide icons, peers' selections, cell comments, phone), reusing the large-table virtualization (DB4-07). Embedding
   `<opencalc-sheet>` would bring an Excel ribbon the prototype does not have, 8.1 MB + 1.6 MB, one workbook per page, and a second
   collaboration system.
2. *Bridge.* A small crate in this repo (`oc-sheet`) depends on the pinned crates and exposes a JSON bridge (no bindgen), like
   `oc-formula`; one WASM instance holds a session per block, keyed by block id, so several spreadsheet blocks share one module and
   one memory.
3. *Yjs mapping.* Per block: `sheets: Y.Array<sheetId>`; per sheet a `Y.Map` with `name`, `rows: Y.Array<rowId>`,
   `cols: Y.Array<colId>`, `cells: Y.Map<"rowId:colId", Y.Map{in, s}>`, plus `widths`, `heights`, `merges`, `freeze`, `cf`,
   `validation`, `filters`, `charts`. `in` is what was typed; in a formula every reference is stored as row and column ids with its
   `$` flags (and the sheet id for `Sheet!A1`), turned into A1 for the formula bar and for the engine from the current order. So
   inserting or deleting rows and columns is one `Y.Array` edit with no formula rewrites, concurrent inserts and edits converge, and a
   reference to a deleted row becomes `#REF!`. Fill and paste shift relative references by rewriting ids before writing. Styles are
   keys into a per-block `styles` map. Values are computed on each client (ADR-078's rule: expressions only), never stored.
   Local edits are written to Yjs; the engine is updated from Yjs observers only (one path for local, remote, undo and offline
   replay). Undo is the block's `Y.UndoManager` in the cross-document stack (PSYNC-03).
4. *Storage and server.* The block is a partial-sync part (ADR-076) and is stored in `.ocanvas` as Yjs like every block; no xlsx
   inside. The server builds a session from the Yjs state with the native engine for exports (values and formats), `search.json`
   (displayed values), `GET` API reads, MCP and xlsx/ods export; xlsx/ods import runs in the server (`/v1/import`) and, for a file
   dropped on the canvas, in the editor's lazy chunk. Limits: cells per block and file size capped (MOD-01), measured first.
5. *Initial JS.* Nothing in the initial graph (`check-budget --forbid`): the block chunk and the WASM load when a spreadsheet block
   comes within a screen (as partial sync loads parts); a skeleton sized from the header until then.
6. *Licence.* Both Apache-2.0, same copyright holder; NOTICE names opencalc; its dependency licences are on our allow-list
   (Apache-2.0, MIT, BSD, ISC, Zlib, Unicode-3.0); same edition (2024) and `zip` 9. Pinned revision; fixes go upstream.
7. *Database formulas stay on `oc-formula`.* Different language (`prop("Field")` over typed records, relations, rollups, a
   checker with positions), 253 KB against 2 MB of WASM, and already identical native and WASM on 563 vectors. Functions both
   engines have (SUM, ROUND, IF, dates, text) get a cross-check test that runs shared vectors through `casual-calc-eval`, so the
   same function gives the same answer in a database and a sheet.

**Consequences.** + Excel semantics, 437 functions and xlsx/ods fidelity without writing them; + one engine in the editor and the
server, as with `oc-formula`; + Yjs keeps offline, partial sync, history and the room unchanged; − 733 KB gzip of WASM on first
use of a sheet; − Yjs metadata per cell (opencalc's reason for OT): 100,000-row sheets must be measured before the cap is set;
− we track an alpha dependency (pinned, behind our bridge); − our own grid UI to build and keep at Excel parity for keyboard and
paste; − formulas stored with ids need a converter both ways (tested by property tests: A1 → ids → A1 is identity).

**Open for the owner.** Confirm engine-not-editor; confirm the per-block cell cap is set after the 100,000-row measurement.

### ADR-081 — Link index across canvases (Accepted (owner, 2026-11-28) 2026-11-28)
**Context.** The owner made backlinks and a knowledge graph part of v0.5 (2026-11-28). Links between
canvases today are host URLs in text marks (ADR-023): OpenCanvas cannot say what links to a canvas.
ADR-065 rejected an OpenCanvas search index because it would hold content and duplicate the host's
ACL. Backlinks need an inverse lookup that no single file contains.
**Decision.** See the register row and docs/38 §2. The index is a table of id pairs written only
from saves the host acknowledged, so it describes what the host stores; it is never an answer on
its own: every read checks the reader's role on every source with the host first, and drops what
the reader cannot open without counting it. Titles, paths and excerpts are fetched at read time.
**Alternatives.** (A) Host-built backlinks from `search.json` (no OpenCanvas state, but every host
would rebuild link parsing and the graph; kept as an option for hosts that refuse the flag).
(B) Excerpts stored with each edge, encrypted (faster panel; text at rest; owner question 1).
(C) An index in Redis for Redis-only clusters (a second implementation of a relational query).
**Consequences.** + backlinks, unlinked mentions and the graph with no content in OpenCanvas;
+ the host's ACL decides every answer; − a new table to migrate and back up (it can be rebuilt by
the backfill call); − read cost grows with the number of sources (`/access/batch`, caches, limits);
− results are as fresh as the last save; − an explicit, narrow extension of ADR-001 (metadata, like
`automation_schedule`).

### ADR-082 — Graph API (Accepted (owner, 2026-11-28) 2026-11-28)
**Context.** A knowledge graph view and agents (MCP) need the neighbourhood of a canvas and an
overview of a workspace without learning anything about canvases the reader cannot open.
**Decision.** See the register row and docs/38 §3. The walk checks access before it expands a node,
so a hidden canvas is neither shown nor used as a bridge; the full graph is a capped, best-effort
view of the most-connected readable canvases unless the host offers `GET /files/readable`.
**Consequences.** + one API for the editor, clients and MCP; + no leak through structure or counts;
− the full graph is approximate (`truncated`) on hosts without `/files/readable`; − access checks
dominate the cost, hence the batch callback, caches and rate limits.

### ADR-083 — Plugin packaging, signing and distribution (Accepted (owner, 2026-11-28) 2026-11-28)
**Context.** Block packages (ADR-058) are copied into a directory by the operator, with an SRI hash
but no signature, registry, update or revocation. v0.5 adds a marketplace and plugins that can run
on the server (ADR-084), so who made a package, whether it was reviewed, and whether it is still
trusted must be checked by the server, not by the operator's care.
**Decision.** See the register row and docs/38 §4. Two signatures (publisher and marketplace) over
a manifest that hashes every file; a small TUF-style signed index (offline root, online timestamp
key, version and expiry) that also carries revocations; the same format for private registries;
policy enforced on the server per host, with three roles: operator, host admin, person.
**Alternatives.** Sigstore keyless signing with a transparency log (no publisher key management,
but needs an online OIDC flow and a log for air-gapped servers; owner question 5). Unsigned
packages with hashes only (today; no answer to a compromised registry or a revoked plugin).
**Consequences.** + tampering, rollback and freeze are refused; + a bad plugin can be switched off
everywhere within an hour; + one format for public, private and offline; − key management for
publishers and the project; − a review service to run; − the index must be refreshed at least
weekly or plugins stop updating (they keep running).

### ADR-084 — SDK extension points and the server runtime (Accepted (owner, 2026-11-28) 2026-11-28)
**Context.** ADR-040 kept third-party code out of the server. Importers, exporters, automation
actions and integration providers need to run where the file and the rule run, without a browser,
and v0.6's automation and app building will build on them. Database views and commands are UI and
can stay in the browser sandbox.
**Decision.** See the register row and docs/38 §5. Server parts are WebAssembly components with no
ambient authority: everything they can do is a host import we write, limited per call; what they
produce is data that goes through the same tool layer as every other write. Browser parts extend
the existing block sandbox and bridge.
**Alternatives.** Remote calls to a publisher's service only (no code on the server, but the
document leaves the operator's network, latency per call, and availability depends on the
publisher; owner question 4). Native dynamic libraries (no isolation; rejected). A JavaScript
engine in the server (larger attack surface than wasmtime and no fuel metering; rejected).
**Consequences.** + plugins work for every host, the API and MCP, not only in the editor; + strict
resource limits and no ambient I/O; + one runtime for v0.6 scripted steps; − a new large dependency
(`wasmtime`) to keep current and audit; − compile time per plugin version (cached); − plugin
authors need a component toolchain (Rust, or others through the SDK).
