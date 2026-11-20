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
| STO-01 | Migrations (sqlite + mysql dialects), repositories | Todo | |
| HOST-01 | JWT verify (HS256/RS256/EdDSA), jti cache | Todo | |
| HOST-02 | Callback client (load/save/assets/users), HMAC signing, retries | Todo | |
| HOST-03 | `examples/sample-host` | Todo | |
| COL-01 | Room actor, yrs doc, y-protocols sync + awareness | Todo | |
| COL-02 | WAL + snapshot compaction + recovery | Todo | |
| COL-03 | Role filter (view/comment/edit) with failing-first tests | Todo | |
| COL-04 | Convergence fuzz harness (10k iters in CI) | Todo | |
| CMT-01 | Commit engine: autosave/idle/manual/last-leave, outbox, 409 policy | Todo | |
| SRV-01 | axum routes, launch, tickets, WS upgrade, ops endpoints | Todo | |
| WEB-01 | Editor core: text, lists, headings, quote, callout, code, divider | In progress | |
| WEB-02 | Tables | In progress | |
| WEB-03 | Images/files via asset proxy | In progress | |
| WEB-04 | Links, link cards, embeds (allow-list) | In progress | |
| WEB-05 | Presence: avatars, cursors, selections, follow | In progress | |
| WEB-06 | Autosave status + popover (no Save button) | In progress | |
| DB-01 | Database block model in Yjs + table view | In progress | |
| DB-02 | Board, calendar, gallery views; row peek | In progress | |
| DB-03 | CSV import/export with type detection | Todo | |
| TPL-02 | Template gallery + 40 built-in `.ocanvas` templates | In progress | |
| SDK-01 | `@opencanvas/embed` web component + postMessage | Todo | |
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
| API-01 | Role / patch / commit / close REST | Todo |
| TPL-01 | Host-supplied team templates callback | Todo |
| OPS-01 | Helm chart, dashboards | Todo |

## Block packages status (database / board session, 2026-11-21)

| ID | Item | Status | Notes |
|---|---|---|---|
| DB-01 | Database block model in Yjs + table view | Done | `web/packages/database`: contract §4 layout; cell editors, header menu, filter/sort/search chips (shared via `views`), footer totals; viewers keep view/prefs local |
| DB-02 | Board, calendar, gallery views; row peek | Done | Kanban drag between groups, month grid (agenda when compact), gallery cards, peek side panel / full sheet with notes |
| DB-03 | CSV import/export with type detection | Done | `parseCsv` (quotes, CRLF, TSV, BOM), type detection incl. tags/progress/person, `CsvImportDialog`, download export, import→export round-trip tested |
| BRD-01 | Board block: shapes, pen, text, sticky, select/transform | Done | `web/packages/board`: 9 tools, move/resize, swatch, inline text edit, zoom/pinch, full screen, compact cover, awareness pointers, per-view undo |
| BRD-02 | Connectors, frames, images on board, PNG/SVG export | Todo | Plain arrows only; no bound connectors, images or export yet |
