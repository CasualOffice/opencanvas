# 08 — Architecture Decision Register

Status values: **Proposed** (awaiting approval) · **Accepted** · **Superseded**.
All entries below are **Proposed** until the user approves the PRD/HLD.

| ID | Decision | Status |
|---|---|---|
| ADR-001 | Host owns identity, ACL and storage; OpenCanvas owns editing, collaboration, preview, export and commits | Proposed |
| ADR-002 | CRDT = Yjs on client, yrs on server (y-protocols wire format) | Proposed |
| ADR-003 | Server in Rust (tokio + axum), single binary | Proposed |
| ADR-004 | DB via sqlx: SQLite default, MySQL 8 / MariaDB 10.6+ when `DATABASE_URL` set; DB holds transient state only | Proposed |
| ADR-005 | Two handshakes: signed JWT launch and WOPI-compatible; WS uses a short single-room ticket | Proposed |
| ADR-006 | Cluster: one owner node per room via Redis lease; non-owners relay over an internal HMAC-signed WebSocket | Accepted (implemented CLU-01, chaos-tested CLU-02) |
| ADR-007 | Editor: Tiptap/ProseMirror + y-prosemirror | Proposed |
| ADR-008 | Board: native block, custom SVG/Canvas2D renderer on Y.Map shapes | Proposed |
| ADR-009 | Native format `.ocanvas` zip (document.json + ydoc.bin + manifest) | Proposed |
| ADR-010 | Exports rendered in Rust (MD/HTML/DOCX, boards via `resvg` with embedded Geist); PDF via optional Gotenberg sidecar (`OC_PDF_RENDERER`), 501 + browser print fallback without it | Accepted |
| ADR-012 | Autosave only, no manual save or version messages in the UI; version history is the host's | Accepted (user decision 2026-11-21) |
| ADR-013 | Database block: typed fields + table/board/calendar/gallery views over one row set, stored as a Y.Map in the canvas Doc; CSV import/export | Proposed |
| ADR-014 | Template gallery: built-in templates are `.ocanvas` files shipped with the server; hosts may add team templates via a `templates` callback | Proposed |
| ADR-015 | Durable saves through `commit_outbox` with idempotency keys; startup sweeper resumes pending saves | Accepted |
| ADR-016 | Conflict policy per host: `copy` (save mine as a copy via `POST /files/{id}/copies`) or `reload` (close 1012, clients reload host version) | Accepted |
| ADR-017 | Callback tokens encrypted at rest with AES-256-GCM under `OC_KEK`; server refuses to start without it unless `OC_DEV=1` | Accepted |
| ADR-018 | Exported files are self-contained: boards embed as data: SVG in Markdown, never as links carrying a session ticket | Accepted |
| ADR-019 | Editor bundle: Tiptap extensions imported individually (no StarterKit), plugin-only late loading after first paint (never node/mark specs), terser; `check-budget.mjs` fails the build over 300 KB gz initial JS | Accepted |
| ADR-020 | Render fonts: embedded Geist + OFL subsets of Noto Sans Symbols 2 / Math (≤ 300 KB) + system fonts + `OC_FONT_DIRS`, Noto-first fallback, one warning per missing script; new direct deps `fontdb`, `ttf-parser`, `unicode-script` (already in the tree via resvg); image ships `fonts-noto-core` + `fonts-noto-cjk` | Accepted |
| ADR-021 | WOPI mode is a save-target variant behind `HostClient` (rooms unchanged); `WOPISrc` is the file id and must match the host's `wopi_allowlist`; assets inlined into the `.ocanvas` as `assets/<id>` | Accepted |
| ADR-022 | Security hardening (docs/18): one header middleware (SPA CSP `script-src 'self'`, handler CSPs kept + `frame-ancestors` appended, `nosniff`, `no-referrer`); callback signature gains `v2` (method + path bound, `v1` kept); signed callbacks never follow redirects; `OC_METRICS_TOKEN`; room cap 550 peers, 8 awareness ids/connection, slow readers dropped; `zip` 2 → 9; host ids `[A-Za-z0-9._-]` | Accepted (security audit 2026-11-21) |
| ADR-023 | Editor UX pass (docs/19): optional `image.width` (percent 20-100) and `image.align` (left/right; absent = centred) attrs; comment messages may carry `mentions` (user ids); postMessage gains `UI_Block_Link` (canvas → host) and `Action_ScrollToBlock` (host → canvas) | Accepted |
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
