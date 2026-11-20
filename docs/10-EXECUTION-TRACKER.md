# 10 — Execution tracker

Every unit of work has a row here, created when it starts and updated as its
status moves. **No untracked work.**

Status: `Todo` · `In progress` · `Review` (awaiting user approval) · `Done` · `Blocked`.

## P0 — Foundation

| ID | Item | Status | Notes |
|---|---|---|---|
| DOC-01 | Research: Slack Canvas, Zoom Canvas, MS Loop, Collabora integration, CRDT options | Done | [01](01-RESEARCH-COMPETITIVE-ANALYSIS.md) |
| DOC-02 | PRD | Review | [02](02-PRD.md) — open questions §10 |
| DOC-03 | HLD architecture | Review | [03](03-HLD-ARCHITECTURE.md) |
| DOC-04 | Technical design (LLD) | Review | [04](04-TECHNICAL-DESIGN.md) |
| DOC-05 | Integration guide / host contract | Review | [05](05-INTEGRATION-GUIDE.md) |
| DOC-06 | Collaboration & presence design | Review | [06](06-COLLABORATION-AND-PRESENCE.md) |
| DOC-07 | Security & limits | Review | [07](07-SECURITY-AND-LIMITS.md) |
| DOC-08 | ADR register | Review | [08](08-ADR-REGISTER.md) — all Proposed |
| DOC-09 | README, AGENTS, CLAUDE, SKILLS | Done | repo root |
| UI-01 | Clickable UI prototype (editor, slash menu, table, image, link card, embed, board, presence/cursors, save/commit, preview mode, narrow panel) on Artifact | Done (rejected) | [Artifact](https://claude.ai/artifact/74HWMXbcLhqRzBCFmcqSqY) published 2026-11-21. Feedback: no save button, not premium, emojis instead of icons, needs templates + databases + mobile polish.
| UI-02 | Rebuilt prototype: autosave only, Lucide icons, Geist type, 40-template gallery, database block (table/board/calendar/gallery, CSV), board, presence, comments, phone + side-panel layouts | Done | [Artifact v2](https://claude.ai/artifact/74HWMXbcLhqRzBCFmcqSqY), 2026-11-21; 33 scripted interaction checks pass in headless Chrome. **Approved by user 2026-11-21** |
| SCAF-01 | Cargo + pnpm workspaces, CI matrix (SQLite/MySQL/MariaDB) | In progress | build contract: [15](15-BUILD-CONTRACT.md) |

## P1 — MVP

| ID | Item | Status | Notes |
|---|---|---|---|
| MOD-01 | `oc-model`: block schema + validation | Todo | |
| MOD-02 | `.ocanvas` reader/writer, unknown-block preservation, zip limits | Todo | |
| MOD-03 | Markdown/HTML import & export | Todo | |
| STO-01 | Migrations (sqlite + mysql dialects), repositories | Review | `migrations/{sqlite,mysql}/0001_init.sql` + `0002_outbox.sql` (outbox recreated with host/file/seq/base_version/sealed token). `oc-server/src/store.rs` (sqlx Any, SQLite WAL pragmas). `hosts`/`unfurl_cache` not created (TOML registry; P2). `scripts/e2e-db.sh` PASS on SQLite, MariaDB 11.4, MySQL 8.4 (2026-11-21, hardening). |
| HOST-01 | JWT verify (HS256/RS256/EdDSA), jti cache | Review | `jwt.rs`: alg pinned by host, iss/aud/exp/nbf, ≤10 h, single-use jti. RS256 + EdDSA with PEM and with `jwt_jwks_url` (10 min cache, `kid` match, key type must fit the pinned alg). Tests incl. alg=none, HS512, HS256-with-RSA-public-key against RS256/EdDSA hosts, unknown/missing kid, JWKS cache hit. Fixtures in `tests/keys/`. |
| HOST-02 | Callback client (load/save/assets/users), HMAC signing, retries | Review | `host_client.rs`; signature checked against an openssl vector and against `examples/sample-host` live (load, PUT v1→v3, users). Save backoff 1/2/5/10 s lives in the room actor. `OC_CALLBACK_BASE_OVERRIDE` supported. |
| HOST-03 | `examples/sample-host` | Review | Callbacks incl. `POST /files/:id/copies` ("<name> (copy)", same ACL); "Save access" calls the role API for each changed user (`OC_API_KEY`, `OC_SERVER_INTERNAL`). |
| COL-01 | Room actor, yrs doc, y-protocols sync + awareness | Review | `room/actor.rs`, yrs 0.28 `sync` encoding (stock y-websocket wire). Awareness `user` stamped from grant. Auth frame is type 2 (docs/15 §3 corrected). Tests: convergence, awareness spoofing, full WS round trip. |
| COL-02 | WAL + snapshot compaction + recovery | Review | WAL append before fan-out; compaction every 500 updates / 30 s; dirty rooms rebuilt from snapshot+WAL. Test kills the actor mid-edit and recovers without touching the host. |
| COL-03 | Role filter (view/comment/edit) with failing-first tests | Review | `room/filter.rs` scratch-doc apply + changed root inspection. Seen failing: removing the filter fails `view_role_cannot_write` and `comment_role_cannot_change_content`; an always-reject filter fails `comment_role_can_write_comments`. |
| COL-04 | Convergence fuzz harness (10k iters in CI) | Review | `tests/fuzz.rs`: per iteration a fresh room, 2–5 editors, random text/paragraph/map/array ops, both directions buffered and flushed/delivered in shuffled order; barrier via the room mailbox (no sleeps). `OC_FUZZ_ITERS` (200 default, 0.7 s); 10 000 iterations pass in 31.8 s (release). Seen failing: found that delete-only updates arriving before their target were parked in yrs `pending_ds`, not relayed and not WAL-logged — fixed in `actor.rs`. CI wiring still to do. |
| CMT-01 | Commit engine: autosave/idle/manual/last-leave, outbox, 409 policy | Review | Durable `commit_outbox` (pending → done/conflict/superseded) written before every PUT; retries resend the row; startup sweeper resumes pending rows after a restart (test restarts on the same DB). 409 policy per host `on_conflict` = copy (POST copies, read-only, `conflict{policy,fileId,url}`) or reload (fetch host version, reset room, close 1012). |
| SEC-01 | Secrets at rest + limits | Review | `crypto.rs`: AES-256-GCM under `OC_KEK` for `sessions.grant_json` callback token and `commit_outbox.token` (AAD = row id); start refused without `OC_KEK` unless `OC_DEV=1` (compose sets it; e2e uses a random KEK and asserts the refusal). Doc hard cap `OC_MAX_DOC_MB` refuses updates with an auth frame; 60/s burst 120 frame limit → 1008 now tested. |
| SRV-01 | axum routes, launch, tickets, WS upgrade, ops endpoints | Review | Launch POST/GET → 303 `/app/#t=`, sessions (isNew), WS with 1009/1008 limits and 60 s connect window, export md/html/json/ocanvas, assets/users proxy, healthz/readyz/metrics, SPA at `/app/` with CSP frame-ancestors. `deploy/Dockerfile` builds and serves. Smoke client: `cargo run -p oc-server --example smoke`. |
| WEB-01 | Editor core: text, lists, headings, quote, callout, code, divider | Review | `web/packages/editor`: Tiptap v3 + Yjs (`content` field), custom nodes per docs/15 §4 (callout, toggle, columns, bookmark, embed, fileAttachment, database, board, mention, commentMark), slash menu, markdown rules (incl. `>>` toggle), hover gutter + block menu with undo toast, selection toolbar. `#demo` review mode. Verified in headless Chrome (desktop + 390 px). |
| WEB-02 | Tables | Review | TableKit (resizable), slash "Simple table"; template tables. |
| WEB-03 | Images/files via asset proxy | Review | Image (caption, drop/replace) and file blocks upload via `POST /v1/assets?ticket=`; not yet exercised against the sample host. |
| WEB-04 | Links, link cards, embeds (allow-list) | Review | Paste-a-URL menu (link / preview / embed); embeds: YouTube (nocookie), Vimeo, Loom, Figma, Maps in sandboxed iframes, click-to-load. Link-card titles are the hostname until UNF-01. |
| WEB-05 | Presence: avatars, cursors, selections, follow | Review | CollaborationCaret labels, block peer bars, avatar stack with typing dot / viewer eye, follow mode. Live run: a client that joins later is not shown to clients already in the room (awareness from late joiners not delivered); needs a server-side look. |
| WEB-06 | Autosave status + popover (no Save button) | Review | Control channel (type 100) drives Saving/Saved/Retrying/Offline/Reconnecting; banners for view/comment/offline/save-failing/role-changed, modals for conflict/closed. Verified live: sample host received v2 after edits. |
| DB-01 | Database block model in Yjs + table view | In progress | |
| DB-02 | Board, calendar, gallery views; row peek | In progress | |
| DB-03 | CSV import/export with type detection | Todo | |
| TPL-02 | Template gallery + 40 built-in `.ocanvas` templates | Review | 40 templates ported from UI-02 with skeleton thumbnails, categories, search, chips (compact), preview modal, blank starts + Import (md/html/csv). Shown for `isNew` edit sessions (verified live). |
| SDK-01 | `@opencanvas/embed` web component + postMessage | Review | `public/sdk/embed.js` (served at `/app/sdk/embed.js`): `<open-canvas server token theme>` form-POSTs the token, maps postMessage to `oc:*` events, `commit/setReadOnly/refresh/export/setTheme`. Not yet tested in a host page. |
| RND-01 | Preview SSR + `@opencanvas/preview` | Todo | |
| UNF-01 | SSRF-safe unfurl | Todo | |
| E2E-01 | Playwright two-browser suite | Todo | |

## P2 — Board & scale

| ID | Item | Status |
|---|---|---|
| BRD-01 | Board block: shapes, pen, text, sticky, select/transform | Todo |
| BRD-02 | Connectors, frames, images on board, PNG/SVG export | Todo |
| LAY-01 | Columns layout | Todo |
| CMN-01 | Comments (anchors, threads, commenter role filter) | Todo |
| WOPI-01 | WOPI client mode + discovery | Todo |
| CLU-01 | Redis leases + relay; MySQL/MariaDB cluster compose | Todo |
| CLU-02 | Chaos test: kill owner mid-edit | Todo |
| EXP-01 | PDF (Chromium sidecar) + DOCX export | Todo |
| API-01 | Role / patch / commit / close REST | In progress | Done: `POST /v1/files/:id/role` (live role switch, `none` disconnects, tickets updated) and `DELETE /v1/files/:id/session` (final save, close, drop tickets), host `api_key` via `X-OpenCanvas-Key`. Todo: patch, commit, convert. |
| TPL-01 | Host-supplied team templates callback | Todo |
| OPS-01 | Helm chart, dashboards | Todo |

## Block packages status (database / board session, 2026-11-21)

| ID | Item | Status | Notes |
|---|---|---|---|
| DB-01 | Database block model in Yjs + table view | Done | `web/packages/database`: contract §4 layout; cell editors, header menu, filter/sort/search chips (shared via `views`), footer totals; viewers keep view/prefs local |
| DB-02 | Board, calendar, gallery views; row peek | Done | Kanban: pointer drag (mouse, touch long-press 250 ms, auto-scroll), reorder within a column via `order` (`moveRow`), keyboard (Space/arrows/Escape) with live announcements; calendar month shared via `views.calendar.cal`; presets map sample people onto real users (`createDatabase(doc, preset, users)`); gallery, peek |
| DB-03 | CSV import/export with type detection | Done | `parseCsv` (quotes, CRLF, TSV, BOM), type detection incl. tags/progress/person, `CsvImportDialog`, download export, import→export round-trip tested |
| BRD-01 | Board block: shapes, pen, text, sticky, select/transform | Done | `web/packages/board`: 9 tools, move/resize, swatch, inline text edit, zoom/pinch, full screen, compact cover, awareness pointers, per-view undo |
| BRD-02 | Connectors, frames, images on board, PNG/SVG export | Review | Bound connectors (`start`/`end` `{shapeId, anchor}`, 5 anchors, snap while dragging an end, follow on move/resize, unbind when dragged away or moved by body), straight/elbow toggle; images by drop/paste/menu via optional `env.upload` (data URL ≤ 2 MB fallback); `exportBoardSvg`/`exportBoardPng` (fit to content, light palette) + Export in the board menu. Checked in Chrome via a temp harness. |

## Integration log

| Date | Item | Result |
|---|---|---|
| 2026-11-21 | Merged server, database/board, editor branches into main | cargo test (30) + vitest (131) + typecheck + editor build green |
| 2026-11-21 | Two-browser live test via sample host (Priya edit, Sam view) | Template applied; content, cursors, avatars both ways; DB checkbox live to viewer; autosaves v1–v3 landed in host |
| 2026-11-21 | Fix: viewers' empty sync step 2 was answered with "permission denied" | `filter::adds_nothing`; non-writes from view/comment are ignored silently |
| 2026-11-21 | Fix: `{"t":"save"}` control (Retry now) was ignored | skips backoff, saves on next tick |
| 2026-11-21 | Fix: MySQL 8.4 could not connect (caching_sha2 needs RSA or TLS) | sqlx `mysql-rsa` + rustls features |
| 2026-11-21 | `scripts/e2e-db.sh` on SQLite, MariaDB 11.4, MySQL 8.4 | PASS on all three |
| 2026-11-21 | Merged board/database finishing (connectors, board images, SVG/PNG export, touch kanban, shared calendar, real people in presets) | board 42 + database 138 pass; one board test failed once under parallel load and did not reproduce in 9 reruns, watch in CI |
| 2026-11-21 | Server hardening branch `server-hardening`: outbox, 409 policy, doc cap, JWKS, OC_KEK, fuzz, role API | cargo test (49) + clippy -D warnings green; e2e-db PASS on SQLite, MariaDB 11.4, MySQL 8.4; fuzz 10k OK |
| 2026-11-21 | Fix: out-of-order delete-only updates were neither relayed nor logged (found by the fuzz) | room treats yrs `pending_ds` as a change |
