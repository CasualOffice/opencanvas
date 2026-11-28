# Changelog

All notable changes to OpenCanvas are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Day-by-day detail and the evidence for
each change are in the integration log of [the tracker](docs/10-EXECUTION-TRACKER.md).

## [Unreleased]

### Changed

- Partial sync: a canvas reopened at the version it was saved at opens from the room's kept
  split instead of reading and cutting the file again (the 50 MB benchmark canvas: 1.3 s to its
  first screen on a reopen), and the session no longer waits for a large file to be read
  (`isNew` can be `null`; the room says it on the socket). PSYNC-BUG-2.
- Partial sync: spreadsheets load as their own parts, as databases and boards do, so a canvas
  with large spreadsheets opens faster. Charts of a spreadsheet follow its part. Reload any
  editor tab left open across the upgrade (PSYNC-05).

### Fixed

- Partial sync: the one-client-id-per-document rule now refuses only items at clocks another
  document was given. An editor that loaded a database during server work had its sync reply
  refused (PSYNC-BUG-4).

## [0.4.0] - 2026-11-28

Spreadsheets, advanced databases (formulas, relations, rollups, Timeline and Workload) and linked
charts; partial sync on by default; performance and reliability. Release notes:
[docs/37](docs/37-RELEASE-v0.4.0.md).

### Upgrading to 0.4

- **Partial sync is on by default** (`[host.flags] partial_sync`, ADR-076, docs/05 §2c-bis):
  databases and boards load as subdocuments. Editors before 0.4 are closed with 4426 on such
  rooms ("reopen the canvas" loads the current editor). Deploy the 0.4 editor with the 0.4 server,
  or set `partial_sync = false` for hosts that embed an older editor or a client without
  `caps=subdoc`. Files, the API, MCP, exports and `search.json` are unchanged. Migration 0012 (WAL
  per document id) runs at start-up.

### Changed

- Large canvases open faster in the editor (PSYNC-A1): block ids for a document without them (an
  import, a generated file) are assigned 200 blocks at a time in idle time, not in one
  transaction with a step per block (Tiptap compared its changed ranges in quadratic time; on the
  50 MB benchmark canvas that was most of the load), and the browser lays out only the text
  blocks near the screen (`content-visibility`).

- Partial sync is complete and on by default: rooms on the Redis WAL and on Redis-only storage
  split too (a stream per part, part snapshots in Redis), a part's edits reach the WAL as they
  happen under memory durability, Find searches every database and board (it loads the parts
  while there is a query), a room opens a large canvas by cutting the stored state as it is (no
  whole document in memory), and a main-document edit that reaches the room during a whole view
  no longer deletes parts' items (found by the new partial sync fuzz test).

### Added

- **Timeline and Workload views for databases** (DB5-01): a Gantt chart over start and end dates (or
  a duration) with day to quarter zoom, dependencies from a "Blocked by" relation created on demand,
  a toast that shifts dependents when a task moves past them, the critical path, milestones, a No
  dates tray, drag to move, resize and link, a bar menu and full keyboard use; a Workload view of
  people against weeks; on phones the Timeline is a list by week.
- The public demo (`#demo`, "Sprint 42 planning") now shows the v0.4 blocks: a launch budget
  spreadsheet with formulas and formats, a chart linked to it, and the backlog with Start,
  Estimate and Blocked by for its Timeline and Workload views.

- Spreadsheet blocks on the server (SHEET-03, ADR-080): Markdown, HTML, Word, `.ocanvas`
  (`document.json`, `search.json`), `GET …/blocks/{blockId}` and MCP `canvas_read` show a
  spreadsheet as tables of the values the grid displays, computed with opencalc's engine;
  `POST /v1/import?format=xlsx|ods` turns a workbook into a Spreadsheet block (host
  `import_formats`), and `GET /v1/export/sheet/<sheetId>.xlsx` exports one. The `sheets` root
  stays in the main document under partial sync for now.

- **Spreadsheet block** (SHEET-04, ADR-080, prototype v04 frames 1-5): "Spreadsheet" in the insert
  and / menus (`core.spreadsheet`). A virtualized grid with column letters, row numbers, a name box
  and a formula bar; Excel keyboard (typing replaces, F2 edits, Enter/Tab move, Ctrl+arrows, Shift
  extends, Ctrl+A, Home/End, PageUp/PageDown, Delete); formulas computed by the opencalc engine in
  WASM, loaded with the first sheet; sheet tabs (add, rename, delete); insert, delete, resize and
  freeze rows and columns from the header menus; fill handle, copy and paste with Excel and Google
  Sheets, number formats, bold, italic, colours, alignment, filters and full screen
  (Ctrl+Shift+E). Edits sync live through Yjs; other people's selections show in their colour.
- Spreadsheet block (SHEET-07): merge cells, borders, wrap text, find and replace (Ctrl+F / Ctrl+H
  with Excel's wildcards), a warning before deleting rows or columns that formulas use, Ctrl-drag
  on the fill handle, moving, hiding and unhiding rows and columns, and tab colours and order.
  The matcher, border placements and merge rule are ported from OpenCalc.
- Spreadsheet import keeps formatting (SHEET-08): `.xlsx` and `.ods` files keep bold, italic,
  strikethrough, text and fill colours, alignment, number formats (currency, percent, number,
  scientific, date, decimals), column widths and row heights, and `.xlsx` export writes them.
  "Import" in the editor takes Excel and OpenDocument files. Team templates copy their
  spreadsheets, and the block validator knows the `spreadsheet` node. A 100,000-row sheet
  opens on the server in about half a second (indexed id lookups, one recalculation on open).
- Spreadsheet block on phones, view only and offline (SHEET-06, frames 9-10): a double tap edits
  in the formula bar with a row of insert keys, an action bar (copy, paste, fill, clear, Aa) and
  round handles to extend the selection; viewers select, copy, filter for themselves and see sums
  with nothing to edit; a change from someone else that turns formulas into `#REF!` is named in a
  toast with Show.
- **Linked chart block** (SHEET-06, frame 4h, `core.chart`, node `chart`): "Chart" in the insert
  and / menus, "Chart from selection" in the spreadsheet toolbar and cell menu, and "Chart" in a
  database's menu. Column, line, area, pie, donut and scatter charts of a sheet range (the computed
  values; the range follows inserted rows) or of a database grouped by a field with count, sum,
  average, min or max. It redraws when the data changes, for everyone; a title (automatic, "Total by
  Category"), legend and axis labels are set in its side panel; a data table is always there for
  screen readers and shown with the table button; light and dark themes. Plain SVG, loaded on
  demand (not in the editor's initial JS). Markdown, HTML and Word exports write the charted
  values as a table.
- **Database ⇄ spreadsheet** (SHEET-06, frame 8a): "Open as spreadsheet…" on a database either
  views it live (fields as typed columns, edits written back to the records, free columns on the
  right for formulas) or converts a copy into a new Spreadsheet block; "Convert to database" in the
  spreadsheet's cell menu turns the selected range into a database (types detected as for CSV).

- Nextcloud Talk (TALK-01): post a canvas to a conversation as a card (posting never grants
  access; the dialog offers to share the file with the conversation), open it beside the chat or
  call, in a sidebar tab on narrow windows, full screen, or full screen with a call tile on a
  phone. A temporary meeting canvas per call: participants read only once the call ends, the
  moderator saves it to the Talk folder (posted back) or discards it, and it is discarded after 10
  minutes without an answer. Guests are read only unless the moderator allows editing and never
  save or download. Moderator tools: guests can edit, lock canvas, Follow me, save to Files.
- Editor host messages for "Follow me": `Action_FollowView {on}` and `UI_ViewBlock {blockId}`,
  and `Action_ScrollToBlock {follow: true}` scrolls without the flash (docs/05 §4).
- Board tool bar for narrow boards, 200% zoom and large text (UX4-01): tools and the zoom pill in one
  bottom row, so they never overlap; tools that do not fit move into "More" (Pan first), measured
  on the board's own width, and the zoom pill becomes one "100%" button last. Keyboard: one Tab
  stop for the tools and one for zoom, arrow keys inside. "Tools on the left" in More puts the
  tools in a rail (a personal setting, off by default). The tool order is now Select, Sticky note,
  Pen, Text, Rectangle, Arrow, Ellipse, Diamond, Pan.
- Backup and restore (RLB-03, docs/13): a runbook for SQLite, MySQL/MariaDB and Redis,
  `scripts/restore-drill.sh`, and a restore epoch. Start once with `OC_RESTORED=1` after a
  restore. Devices revoked after the backup stay revoked (every offline copy is dropped once),
  and schedule slots due before the restore are skipped instead of running twice. Migration
  0013 adds the `restore_epoch` table.
- Crash drills (RLB-01, docs/13 "Crash drills"): `scripts/crash-drill.sh` kills the server
  with `kill -9` during edits, during in-flight saves and during migrations, on SQLite and
  MySQL/MariaDB, and checks that no acknowledged edit is lost. A reduced drill runs nightly.
- Formula engine (DB4-01/02, ADR-078): `crates/oc-formula`, one typed engine native in the server and
  WASM in the editor (lazy). Spreadsheet-like syntax `prop("Price") * prop("Qty")`, function names in
  any case stored upper case, errors as values (`#TYPE`, `#REF`, `#DIV/0`, `#CYCLE`, `#LIMIT`),
  limits of 4 KB, depth 64 and a step budget. Exports, `search.json`, `queryRows` and MCP `db_query`
  carry computed values (DB4-10). `[host.flags] formulas` turns on adding the new field types.
- Formula, relation and rollup fields in databases (DB4-03/04/06): formula editor with autocomplete and
  errors as you type, error cells with their reason, sums that skip errors; relations two-way on one
  canvas with a row picker; rollups (count, sum, percent checked, earliest, latest) with a dash when
  nothing relates; links to a deleted database kept for 30 days.
- Editing a cell in a large database re-reads only that row (DB100K: 100,000 rows x 30 fields keep
  16.7 ms frames while editing; each edit cost about half a second before).
- Large tables and boards (DB4-07/08): from 1,000 rows the table and board are virtualized, with a
  sticky header, frozen title column, Go to row (Ctrl+G), sorting in a worker, Select all N and bulk
  edit undone as one step, and a card list with long-press selection on phones.
- Partial-sync placeholders (PSYNC-03) to the prototype: sized from the block header, "Loading" after
  400 ms, retry with a countdown, "Not on this device" offline.
- Fixed: a new formula field's editor stayed on "Loading formulas…" when the database had no formula
  field yet.
- Fixed: the editor's CSP blocked the formula engine's WebAssembly; `script-src` now adds
  `'wasm-unsafe-eval'` (compiling WebAssembly only; `eval` and inline script stay blocked).
- Fixed: on phones a long press on a row selected it and the release deselected it; a new field
  turned into a formula kept the name "Text"; avatar initials now meet 4.5:1 on light colours.

- Benchmarks page on the site (BENCH-05): every result in `bench/results/` with its hardware, store and
  load mix beside the numbers; `local` runs marked as such. `/metrics` adds `oc_alloc_allocated_bytes`
  and `oc_alloc_resident_bytes`. The server raises its soft open-file limit to the hard limit at start
  (PERF-11).

- Flaky-test policy (RLB-04, docs/13 "Flaky tests"): a tracker row and a root-cause fix for every
  flake, no timeout raises, a dated quarantine list that must be empty at release. A reliability
  nightly runs the Rust tests five times (`scripts/repeat-tests.sh`) and the browser suite with
  `--repeat-each=3`; CI runs new or changed specs five times.
- Benchmark results after PERF-11/12: X10K short passes (p99 ≤ 64 ms per bucket, was 11.3 s);
  R1K short at `OC_MAX_PEERS=1000` (scenario now sets it) passes latency (p99 ≤ 81 ms) and fails
  its RSS drift rule (docs/36 §4.1).
- Partial sync in the editor (PSYNC-03/04, ADR-076; still behind `[host.flags] partial_sync`,
  off by default): the editor sends `caps=subdoc`, loads each database and board as its own
  document when it comes within a screen of the viewport (the block's skeleton until then),
  releases it two minutes after it leaves, undoes across the text and every block in one stack,
  and an offline copy keeps and replays every part. Find, automation, block duplication and
  diagram import reach block data through one accessor. A split room saves the same
  `document.json` and `search.json` as a whole one. Rooms under memory durability (the default)
  split too.

- Partial sync, server groundwork (PSYNC-02, ADR-076; nothing changes for users yet, the room
  does not split documents): `oc_model::parts` splits a canvas into a main document and one part
  per database and board **keeping every Yjs item id**, and flattens the parts back to the format v1
  update byte for byte (property tests; checked on the 50 MB fixture, where the main document
  holds 6.7 MB against 737 MB for the whole). The WAL keeps rows per document id (migration 0012:
  `room_updates.doc_id`, `room_part_snapshots`).
- Partial sync in the room (PSYNC-02, ADR-076), behind `[host.flags] partial_sync` (**off by
  default**; leave it off until the 0.4 editor ships): databases and boards become subdocuments on
  the room socket (message type 101, docs/15 §3.2), loaded when a connection asks, the role checked
  per request, evicted when unheld; the API, MCP, history, templates, AI tools, automation and saves
  work on a whole view flattened with the original item ids, so saves stay `.ocanvas` format v1.
  Editors without `caps=subdoc` are closed with 4426 on a split room. Room memory on the 50 MB fixture with 20 viewers (caps=subdoc, first page, no edits; release build, Apple M4, local; one process per figure, test-process RSS): split room opened from its WAL 220 MB (a high-water mark: opening walks every part once, one at a time, to index its ids) against 4,401 MB for the same room whole (2,382 MB in a second run), 5-9%, under the 30% bar (tests/partial_sync.rs room_memory_on_the_fixture).

### Fixed

- After a restart with a slow host, rooms reopen and save at full speed (RLB-01c): a room no
  longer holds one of the `OC_ROOM_LOADS` slots while the host answers its file request.
- Spreadsheet safety (SEC-62..64): `.xlsx` imports are read with server limits (64 MiB inflated,
  200,000 cells, no recalculation, 250,000 rows and columns in all) off the async workers, two at
  a time; a Spreadsheet block whose formulas take longer than 2 s to compute shows its inputs in
  saves, exports and reads instead of stalling them; "Who can see this" tells nothing to someone
  who cannot open the live file.
- Dependency audit (DEP-01): `jsonwebtoken` 12 and `p256` 0.14 remove rsa 0.9 (RUSTSEC-2023-0071) and
  crypto-bigint 0.5 (RUSTSEC-2026-0387), which the offline-grant signing key went through (SEC-61);
  `resvg` 0.50 removes the unmaintained rustybuzz and ttf-parser (font fallback checks glyphs with
  `skrifa`). An empty HS256 host secret is now refused as no key.

- Overload never answers 500: while rooms recover after a restart (more than
  `OC_ROOM_LOAD_QUEUE`, default 32, waiting to load) or when no database connection is free,
  launches, session lookups and WebSocket upgrades answer 503 with a `Retry-After` of 1-5 s.
  The browser launch shows "Reconnecting…" and posts again; the editor waits out
  `Retry-After` for up to 60 s instead of showing an error (RLB-01b).
- A launch that failed after its token was recorded (database timeout, server killed
  mid-launch) spent the token, so every retry was refused as a replay. The token is now spent
  last (SEC-59).
- Partial sync (off by default): one client id writing both the main document and a block's
  document made the whole view drop the block's content (SEC-54); block edits now count
  against the document size limit (SEC-55).
- A release refused to start on a database a newer release had migrated, so a downgrade needed
  a manual database step; migrations it does not know are now ignored (they are additive;
  RLB-08, docs/13 "Upgrades and downgrades").
- After a restart on MySQL/MariaDB, launches failed with 500 for about 20 s while every room
  reopened at once (connection pool exhausted). Rooms now load at most 8 at a time
  (`OC_ROOM_LOADS`), and the pool is 32 connections (`OC_DB_MAX_CONNECTIONS`; RLB-01b).
- MySQL/MariaDB: a server killed in the middle of a migration never started again ("migration
  N is partially applied"); the next start now finishes the migration (RLB-01).
- A date or recurring automation skipped its run when the canvas was opened after the slot's
  time and before the next sweep (the room moved the due slot to the next day; RLB-04).
- Memory stayed resident after rooms closed (alloc_release, PERF-11): the grouped snapshot writer
  committed up to 8 MB per transaction (now 1 MB), and save builds left their freed blocks in
  idle blocking threads' caches (now flushed).

- The editor's files are now served gzip-compressed to browsers that accept it: the build writes
  a `.gz` next to each text asset and the server sends it. The initial JS went over the wire as
  955 KB instead of its 294 KB gzip budget (BENCH-03).
- Load generator: a client refused by a full room retried every 0.5 s and counted as a drop;
  it now backs off and is counted as refused.
- Automation in a cluster (AUTO-CL): rule operations (API, editor, MCP) sent to a node that does
  not hold the canvas answered 503; they now run on the owner. A scheduled rule whose canvas was
  open on another node could be put off for five minutes at a time; the node holding the canvas
  now runs it. A run cut off by a node that stopped is logged as failed (`INTERRUPTED`) after an
  hour instead of staying "running".
- Nextcloud app: unified search hits no longer end in ".ocanvas" (NC-03).

### Tests

- `tests/automation_cluster.rs`: three nodes on Redis and MySQL/MariaDB (schedule once, also
  when a node dies; row changes once; loop guard, daily limit and auto-pause cluster-wide; no
  duplicate runs). CI job `automation-cluster` (MySQL 8.4, MariaDB 10.11).
- Offline (OFF-08): a canvas kept offline whose copy had expired lost its unsent changes on
  reconnect. The locked copy was never read into the document, so the replay sent nothing and
  then dropped the changes as sent. It is now read before anything is sent or held.
- Offline (OFF-08): a canvas locked by expiry while open kept its content in the page, hidden.
  The locked view (5c) now renders the title only, and drops the "You can view this canvas"
  banner while locked or paused.
- Offline merge summary (OFF-08): text you edited offline in a block someone else moved was lost
  without a word, because a move deletes the block and inserts a copy with the same id. The
  summary now compares blocks by their Yjs item, offers the text back ("You edited a block that
  was moved"), and no longer counts deleting a block as editing it.
- Offline uploads (OFF-08): an image added offline shows the prototype's caption, "Waiting to
  upload · size · kept on this device" (others see "Uploading from the device it was added on").

### Added

- Browser benchmark (BENCH-03): `e2e/perf/first-screen.bench.ts` measures first screen, heap
  after GC, DOM size, script bytes and long frames on the S, M, L and 50 MB fixtures through the
  real server (Chromium, 4× CPU throttle, 40 Mbit/s, 40 ms RTT); budgets per fixture in
  `bench/budgets.toml`, checked nightly by `scripts/bench/check-browser.mjs`.
- `OC_MAX_PEERS`: the room cap per server, default 550, at most 1,000 (R1K; PERF-11). Profile of
  the X10K latency miss in docs/36 §4.1.
- Benchmark program, first part (BENCH-01, BENCH-04, ADR-079): `scripts/bench/run <scenario>`
  with scenario files in `bench/scenarios/` that state their load mix (X10K, R1K, STORM, SOAK, and
  the docs/22 scenarios run unchanged), `oc-bench scenario` (idle, presence-only and typing peers,
  latency per bucket, `kill -9` and restart mid-run with reconnect timing, source addresses),
  JSON results with hardware, load average and mix in `bench/results/`, seeded fixtures
  (`oc-bench fixture s|m|l|50mb`), `bench/budgets.toml`, the initial-JS and `--forbid` gate in
  `scripts/prepush.sh` and CI, and a nightly benchmark workflow.
- OFF-08 tests: a three-client simulated day offline in vitest (text, database cells, board
  objects, block deletes and moves, comments; the real replay frames, cut connections, the
  pending log and the merge summary; seeds 1, 7, 42 and `OC_FUZZ_SEED`, a long run behind
  `OC_FUZZ_LONG=1`), and Playwright `zf-offline-2` (expiry by the browser clock, queued upload end
  to end, the 5 MB pause).
- `integrations/nextcloud/test/e2e.sh`: a real Nextcloud 31 in Docker with the app, driven
  through Files, sharing, unified search and delete (NC-03); CI job `nextcloud-e2e`, nightly and
  on demand.

## [0.3.0] - 2026-11-26

Release and upgrade notes: [docs/35](docs/35-RELEASE-v0.3.0.md). Every new feature is off until the host turns it on.

### Added

- The automations panel (AUTO-06): "Automations" in the canvas menu, when the host turns
  automation on. Rules read as sentences ("When Status changes to Done in Backlog, then move the
  row to Archive"), switch on and off in place, and say when they ran or run next. Suggestions
  built from the canvas, a rule editor with a grouped trigger picker, conditions, up to five
  actions and a test run that changes nothing, and a run history with failed and stopped
  filters. Paused rules say why and offer "Run it as me". Viewers see the rules read-only. On
  phones the panel is a full-screen page.
- Find and replace in a canvas (SRCH-01, ADR-066, [approved prototype](docs/prototypes/v03-approved/search.html)):
  ⌘F opens a find bar over text, databases and boards; case, whole word and regular expressions
  (50 ms budget); Replace all is one undo step; view-only people can find but not replace. Matches
  inside live blocks are found (in the block's own text when it is connected) and labelled;
  Replace all changes this canvas, then asks separately "Replace in “<live block>” too?" for each
  live block you can edit, and applies it in that block's own room as one undo step (SRCH-06).
  View-only live blocks are never changed.
- Search all canvases (SRCH-04): results from the host's own search (`GET /search` callback),
  grouped by canvas, with deep links to the block; hidden when the host has no search callback.
- Automation, server side (AUTO-01..05, AUTO-07, ADR-067, ADR-068; off unless
  `[host.automation]`): rules stored in the canvas (`automations` root) run by the server as
  "Automation" on behalf of their owner, re-checked with the host's `/access` at every run.
  Triggers: row added, field changed, checklist item checked, comment or mention added, a date
  reached and schedules (every 15 minutes or more, in the canvas time zone, even with the canvas
  closed). Actions: set a field, move a row, check or add checklist items, comment, notify through
  the host's `POST /mentions`, and call a URL signed like webhooks on allowed origins only. Loop
  guard (never itself, 3 deep), limits, auto-pause after 10 failures, a metadata-only run log
  (30 days), `automation.ran`/`automation.failed` events, `perms.automate`, migration 0010, the
  API (`/api/v1/files/{id}/automations…`) and MCP tools.
- Offline copies, server side (OFF-01, OFF-07, ADR-063/064): `[host.offline]` (off by default;
  checked at start-up; JWT hosts only), the launch token's `perms.offline` and `offlineReason`,
  an ES256 offline grant in the session answer that the editor keeps with its copy and uses only on
  the device, a revocation generation per host and person (migration 0011; Redis `oc:offgen:`)
  raised by `POST /api/v1/offline/revoke`, and the `GET /v1/offline/clear` sign-out page. The server
  stores one number per host and person, never content.
- Offline-first editing in the editor (OFF-02..07, ADR-063/064/073, the approved prototype): a person
  keeps a canvas on their device ("Available offline on this device"), encrypted in IndexedDB under a
  per-person device key; it opens and edits without a network (a service worker caches the editor
  code, never content) and locks when its 7-day grant runs out. The save pill shows where changes are
  (on this device, or this tab only). Reconnecting is a fresh launch through the host; unsent changes
  go in frames under the frame and rate limits, long sessions get a "Before <name>'s offline changes"
  version first and collaborators a toast. A merge summary appears only for edits inside a deleted
  block (restore as a new block) and both-sides cell changes (use mine). View only on reconnect holds
  the changes (download or discard); no access deletes the copy. Images added offline wait as
  `oc-pending:` and upload first. Hosts clear the device at sign-out with `OpenCanvas.clearOffline()`
  or the `/v1/offline/clear` iframe and list copies with `OpenCanvas.offlineFiles()`.

- Live blocks in the editor (LIVE-03, LIVE-07, [approved prototype](docs/prototypes/v03-approved/live-blocks.html),
  ADR-073): an always-visible header (Live mark, title, the people in it, Open source, options),
  editing in place with presence, a one-time hint on the first
  edit, view only, and every failure state (connecting, not up to date, no access with or without
  the title, deleted or moved, access removed, limits). The header says where the source lives
  ("from Leadership weekly › Q1") when the host's `/access` answers the new optional `path` (≤ 200
  characters, shown as text), else the host's name. Inside a live block, "/" offers the same
  categorised insert menu, filtered by the host profile, without live blocks (depth rule) and
  without what acts on the embedding canvas (assistant, import, uploads, SDK blocks). "Make live…" in the block menu, "Live
  block" in the insert menu through the host's own picker (`UI_PickLiveBlock` →
  `Action_InsertLiveBlock`), and paste a block link as a live block, a reference or a link.
  References refresh on their own and flash once. "Convert to a copy" and "Who can see this"
  (`GET /v1/live/audience`). A host answers `/access` with 410 for a deleted live file. Phones get
  a compact header and an options sheet. The live block code loads only when a canvas shows one.

- `<open-canvas view="block">` (LIVE-06): one live block with compact chrome for chats and side
  panels; its height follows the content (`UI_Resize`, `oc:resize`). The SDK gains
  `insertLiveBlock()`, `livePicker()`, `liveBlockUsage()` and the `oc:pick-live-block`,
  `oc:live-block-open` and `oc:live-block-usage` events.

- Search across canvases, server side (SRCH-02/03/05, ADR-065): every saved `.ocanvas` carries
  `search.json`, a plain-text projection with block ids and heading trails for the host to index
  (comments only with `[host.search] comments = true`; never in-file history; at most 2 MB).
  `POST /api/v1/extract` answers it statelessly for a `.ocanvas` or Markdown body. Hosts may
  implement `GET /search` (`[host.search] callback = true`); `GET /api/v1/search` and the MCP tool
  `canvas_search` proxy it for user tokens only, 10 a minute per user, dropping files the host's
  `/access` refuses. OpenCanvas keeps no index and caches no result. The sample host indexes
  `search.json` and serves the callback and a search page.

- Nextcloud app (SRCH-05): canvases appear in Nextcloud's unified search. Every write of an
  `.ocanvas` indexes its `search.json` into the app's `oc_opencanvas_search` table (Nextcloud's
  index, not OpenCanvas's), results are only files the person can open in Nextcloud, and each one
  opens the canvas at the matching block. `occ opencanvas:search-index` indexes existing files.

- Portable live blocks, server side (v0.3, behind `[host.flags] live_blocks`, off by default):
  the host contract (LIVE-01, docs/05 §2c, ADR-070): `[host.live]` checked at start-up, the
  `POST /files` callback, `/access` required (with optional `name` and `callbackToken`), the
  token's `perms.live` and `live` claims, derived sessions for embedded live files
  (`POST /v1/live/session`) and "Make live" (`POST /v1/live/make`).

- Live block rooms (LIVE-02, docs/15 §3 and §4.4, ADR-071): the `liveBlock` and `blockRef` nodes in
  the editor schema (no node view yet), `caps=live` and the 4426 guard so a 0.2 editor deletes no
  live block, the depth rule, at most 50 references, the snapshot policy and `perms.live` on every
  write path, at most 8 live rooms per session, presence `from` and the `live.embedded` /
  `live.removed` events (ADR-069).

- Live block projections, snapshots, exports and render (LIVE-04/05/06, ADR-072): `GET
  /v1/live/projection` with ETags, `POST /v1/live/refresh` under the snapshot policy, exports that
  inline only what the exporting person can read, and API operations `makeLive`, `listReferences`
  and `renderFile` (`GET /api/v1/files/{id}/render`) in the OpenAPI document, both clients and the
  conformance suite.

### Changed

- Trademarks (LEGAL-01): the Nextcloud and Mattermost docs pages, the Nextcloud app's description
  and planned App Store text, and NOTICE now say that Nextcloud and Mattermost are trademarks of
  their owners and that OpenCanvas is not affiliated with or endorsed by either. The Mattermost
  plugin's text uses "Mattermost" only as an adjective ("Files are stored on your Mattermost
  server", "open it in the Mattermost web or desktop app", "Sign in to your Mattermost account
  first"). The approved Nextcloud prototype no longer draws the Nextcloud logo.

## [0.2.1] - 2026-11-26

### Added

- The categorised insert menu (INS-01, [approved prototype](docs/prototypes/insert-menu-approved/)):
  "/" opens Quick insert, Recent, goal chips and five categories (Content, Data & planning,
  Visual & diagrams, Layout, Extensions) with flyouts on desktop and drill-in on phones.
  Heading, List, Callout and Columns pick their variant inline (Tab); Database and Diagram have
  a second step with previews (Board, Calendar and Gallery views; Flowchart, UML, ERD, network,
  mind map, org chart, wireframe). `/h2`, `/todo`, `/board`, `/kanban`, `/uml` and the old ids
  land on the variant; intent search ("track tasks", "plan a sprint") shows why each result
  fits; no results offers "Did you mean". Recent stays in the browser. The gallery takes the same
  categories with variant chips. `[host.editor] intents` and `chips` turn off or replace the
  goal chips (docs/05 §2b). Profiles with 8 or fewer blocks get a flat list.

### Fixed

- Gallery: Enter inserts the focused card, not the first one.
- A newly inserted SDK block takes focus when its frame is ready only while it is still selected.
- "Browse all blocks" shows only in the full workspace profile.

## [0.2.0] - 2026-11-25

- The headless API (`/api/v1`) is on by default; `[host.flags] api_v1 = false` turns it off per host.

The release notes and the scope lock are in [docs/32](docs/32-RELEASE-v0.2.0.md); read the
upgrade notes in it first. The block SDK runtime (BSDK-03/04), host editor profiles (EDP-01) and
block discovery metadata land before the tag.

### Added

- Editor profiles (`[host.editor]`, docs/05 §2b): `notebook`, `meeting`, `project`,
  `diagramming`, `document` or `full` (default), or an explicit list of stable block ids
  (`core.*`), decide which blocks the / menu, "+" and phone insert sheets, Turn into and markdown
  shortcuts offer; intent keywords ("track tasks", "draw architecture", "schedule") find blocks.
  `[host.editor.features]` switches comments, version history, AI, diagramming, templates and
  import, enforced on the server where they have routes, and win over the older `[host.flags]`.
  Profiles only hide: every existing block still opens and edits. The session carries `editor`.
  The Jitsi sample uses `meeting`, the Matrix sample `notebook`.

- **Headless API is the supported contract.** `/api/v1` with OpenAPI 3.1, RFC 9457 errors,
  scoped user tokens shared with MCP, `Idempotency-Key`, signed cursors, rate limits, the events
  stream and the sync token. Most of it shipped in 0.1.2 behind `[host.flags] api_v1`.
- **Webhooks** for the events-stream events (WH-01): `[host.webhooks]`, signed deliveries
  (`X-OpenCanvas-Signature` v2, `Idempotency-Key` = event id) from a durable outbox (migration
  `0009_webhook_outbox`), retries with backoff, each sent once per cluster, same origin as
  `callback_base` only.
- **Clients:** TypeScript `@opencanvas/client` and Rust `opencanvas-client`, generated from the
  OpenAPI document, with retries, idempotency keys, paging, events resume and webhook
  verification. They share a conformance suite (HAPI-06, HAPI-07).
- MCP canvas tools are adapters over the API operations, with one scope check, limiter and
  idempotency store, and a parity contract test (HAPI-08). New operation: `POST /api/v1/files/{id}/boards`.
- **Block SDK (data side):**
  - `block.json` manifests installed by the operator (`OC_BLOCKS_DIR`, sha384 integrity,
    `OC_BLOCKS_ORIGIN`) and enabled per host with `[host.blocks]`;
  - JSON Schema validation of attrs and data on every write path;
  - one generic `extBlock` node and an `ext` root;
  - declarative export templates and fallbacks;
  - data versions with declarative migrations (BSDK-01, -02, -05).
- API reference on the website (`/api/`): guides for authentication, errors, pagination,
  idempotency, rate limits, events, webhooks and the SDKs, and one page per resource generated
  from the OpenAPI document, with samples in curl, TypeScript, Rust and Python.
- `tools/check-openapi.py`: every API operation is documented with examples and its error codes.
- Acceptance rows for v0.2 in docs/23, and the v0.2 security audit in docs/18 §6.

### Changed

- The 0.1 host routes (`/v1/files/{id}/patch|commit|role|import|session`, `/v1/convert`) answer
  with `Deprecation` and `Link: rel="successor-version"`. They are removed in v0.3.
- An editor older than 0.2 that would delete an SDK block is closed with 4426 ("editor out of
  date: reopen the canvas").
- Nodes that start together on an empty database wait for each other's migrations, instead of
  one failing (SEC-47).
- A webhook sweep claims at most 40 deliveries, and the next sweep starts at once (SEC-48).

### Security

- SEC-46: room updates over the WebSocket are checked against installed SDK block schemas, as API
  and MCP writes are. A broken block could otherwise make the file unopenable.
- SEC-49: draw.io and Excalidraw label cleaning is linear; it was quadratic on raw-text tags.
- SEC-50: icon SVGs are counted with `<use>` references expanded, and refused past 2,000 drawn
  elements.
- SEC-51: a restore's undo cannot be reached with a crafted `restoreId` by a user whose id is a
  suffix of the restorer's.
- SEC-52: `opencanvas_client::verify_webhook` no longer overflows on an extreme header timestamp.
- SEC-53: a host that answers 404 to the version-list call is asked again after 5 minutes.

## [0.1.2] - 2026-11-24

See the [release and upgrade notes](docs/31-RELEASE-v0.1.2.md).

### Added

- Nextcloud WOPI app, Mattermost channel canvases, and Element / Matrix room widgets.
- Diagram mode with searchable shape libraries, ports, obstacle-aware connectors, auto-layout,
  draw.io and Excalidraw import, and draw.io and Mermaid export.
- Version history with named versions, preview and comparison, restore and temporary undo
  where supported by the host.
- Headless API under `/api/v1` with OpenAPI 3.1, scoped tokens, and idempotency keys on file writes.
- API events stream (SSE and WebSocket) with resume, and a headless sync token.
- Server-rendered previews, host team templates, and a Grafana dashboard with alert rules.

### Changed

- Large boards use incremental projection and draw less detail when zoomed out.
- Editor controls and icons scale with the reader's text size.
- Hosts can set per-host frame ancestors and temporary-canvas wording.

### Fixed

- Concurrent edits preserve separate diagram properties during mixed-version collaboration.
- A Jitsi role change takes precedence over launch tokens issued before the change.

## [0.1.1] - 2026-11-23

Jitsi Meet integration and temporary canvases. No upgrade steps: existing hosts behave as before.

### Added

- **Jitsi Meet** (`integrations/jitsi/`, JIT-02): `mod_opencanvas.lua` gives every meeting a
  shared canvas in Jitsi's Shared document slot, like Etherpad. One Prosody plugin plus `.env`
  lines, no Docker image or compose changes. Per-person launch tokens, a fresh token on reload,
  the meeting end closes the canvas. Tested end to end against a stock docker-jitsi-meet
  (stable-11509-1) with two browsers; guide in `integrations/jitsi/README.md`.
- **Temporary canvases** (`storage = "ephemeral"`, ADR-043, JIT-01) for hosts with no file
  storage: no load or save callbacks; everything is deleted when the room closes (idle grace or
  `DELETE /v1/files/{id}/session`). A server restart or deploy keeps the canvas for the reconnect.
- `template` for temporary canvases: a built-in template id (`meeting`, `standup`, `retro`, …)
  or an `.ocanvas`/Markdown file, applied once by the server. Unset: blank.
- Editor: a temporary canvas says "Not saved · temporary", opens without the template picker,
  shows no host name, and its ended screen says it was deleted.

### Fixed

- The block handle (+ and drag grip) disappeared when the pointer crossed the gap between the
  text and the handle, so it could not be clicked or dragged.
- Plugin: tokens signed with Jitsi's `luajwtjitsi` did not verify (non-standard signature
  encoding); the plugin now signs with Prosody's own HMAC. Jitsi appends its Etherpad options
  with `?`, which broke the token; the launch URL now ends in `&ep=`.

### Changed

- The template button in the top bar of an open canvas is gone; new canvases still start from
  the template picker (or blank, for a temporary canvas).

## [0.1.0] - 2026-11-23

The first final release: v0.1.0-alpha.1 plus the alpha.2
security fixes and the three release blockers (scope: [docs/26](docs/26-RELEASE-v0.1.0-SCOPE.md)).
Support is best effort with no SLA. Release notes, upgrade notes and known limitations:
[docs/28](docs/28-RELEASE-v0.1.0.md).

### Upgrade notes

- **WOPI hosts require proof keys.** With any WOPI host configured, the server refuses to start
  without `OC_WOPI_PROOF_KEY` (PEM, or sealed with `opencanvas seal-proof-key`); on Helm set
  `wopi.proofKeySecret`. Rotate with `OC_WOPI_PROOF_KEY_OLD` (Helm `wopi.oldKey: true`).
- **MCP needs `OC_PUBLIC_URL`** or `[host.ai] mcp_audience`; without either, MCP answers `404`.
- **MCP tokens must name their files** (`files` claim) unless the host has the `/access`
  callback or sets `[host.ai] mcp_all_files = true`.
- **WOPI sessions are capped at 10 h** after the launch.
- **Invalid documents and writes are refused:** an `.ocanvas` that breaks the block schema is
  refused when read (`/v1/convert`: 400 `INPUT_INVALID`), and a REST patch, import or MCP write
  that breaks it answers 400 `PATCH_INVALID`. Unknown blocks and attributes are still kept.

### Added

- **WOPI proof keys (WOPI-13):** every WOPI call is signed (`X-WOPI-TimeStamp`, `X-WOPI-Proof`,
  `X-WOPI-ProofOld`, SHA256withRSA); `/hosting/discovery` publishes the current and old keys;
  `opencanvas seal-proof-key`; the reference WOPI host verifies proofs; Helm
  `wopi.proofKeySecret`.
- **Block schema validation (MOD-01)** in `oc-model` on `.ocanvas` read, REST patch, import and
  MCP writes, with JSON-pointer paths; unknown nodes are warnings, kept and counted in
  `oc_schema_warnings_total`.
- **Template load test (FC-07):** all 40 built-in templates validate and round-trip through
  `.ocanvas`.
- **Release artefacts:** `.github/workflows/release.yml` builds a multi-architecture image
  `ghcr.io/casualoffice/opencanvas` (linux/amd64, linux/arm64) pinned to the tag, standalone
  Linux binaries (x86_64, aarch64) with the editor bundle, checksums and build provenance.
- The v0.2 plan ([docs/27](docs/27-ROADMAP-v0.2.md)) and the release roadmap (ADR-038).

### Changed

- Licence: the Apache License 2.0 (ADR-037), with NOTICE and SPDX headers.

### Fixed

- Memory was not returned after idle rooms closed (jemalloc purge refused and the error
  ignored): RSS with 0 rooms after eviction fell from 856 MB to 174 MB (docs/22 §9.7).

### Security

- **MCP audience (SEC-33):** the MCP token audience comes from `[host.ai] mcp_audience` or
  `OC_PUBLIC_URL`, never from the request's `Host` header. Without either, MCP is off (`404`) and
  the server logs one start-up warning.
- **MCP file scope (SEC-34):** when the host has no `/access` callback, an MCP token must name
  its files in a `files` claim; a token without one is refused (`FILES_REQUIRED`). The broad
  behaviour (one token's role on every file) needs `[host.ai] mcp_all_files = true`.
- **WOPI session cap (SEC-35):** a WOPI session ends at `access_token_ttl` or 10 h after the
  launch, whichever is first, like a JWT session.
- **WOPI caller authenticity (SEC-44):** WOPI hosts can verify that calls come from OpenCanvas
  (proof keys, above). Signing uses `rsa` 0.10.

## [0.1.0-alpha.1] - 2026-11-23

**Licence:** relicensed from BUSL-1.1 to the Apache License 2.0 before this first release, with
attribution through NOTICE and an SPDX header in every source file (ADR-036).

Embeddable collaborative workspace canvas. The first alpha, for evaluation; there is no production
SLA. Release notes, known limitations, backup and recovery:
[docs/25](docs/25-RELEASE-v0.1.0-alpha.1.md).

### Added

- **Editor:** rich text blocks (headings, lists, checklists, toggles, quotes, callouts, code with
  syntax highlighting, simple tables, images, files, link cards, sandboxed embeds, columns), slash
  menu, block menu, selection toolbar, and side-panel and phone layouts.
- **Databases:** typed fields; table, board, calendar and gallery views; filter, sort and search;
  row detail; spreadsheet keyboard, ranges and clipboard; CSV import and export.
- **Whiteboards:** pen, sticky notes, shapes, text, bound and elbow connectors with waypoints,
  frames, images, multi-select, groups, alignment, snapping, minimap, SVG and PNG export.
- **Templates:** 40 templates in 9 categories, plus blank canvas, database, whiteboard and import.
- **Collaboration:** live co-editing over Yjs, cursors, avatars, follow mode, comments with
  mentions, a shared undo stack, and view, comment and edit roles enforced on the server.
- **Host integration:** HS256, RS256, EdDSA and JWKS launch tokens; signed callbacks; the live
  role API; host members and revocation; the `<open-canvas>` embed SDK and postMessage API;
  access expiry warning and quiet renewal (ADR-036).
- **WOPI client mode:** discovery, CheckFileInfo, GetFile, PutFile, PUT_RELATIVE conflict copies,
  assets and mentions, and a reference WOPI host.
- **Saving:** autosave only, through a durable outbox; host 409 conflicts save a copy or reload.
- **Import and export:** `.ocanvas`, Markdown, HTML, CSV, DOCX, PDF (Gotenberg sidecar, with a
  print fallback) and board SVG/PNG; server-side Markdown, HTML and CSV import, off by default.
- **Storage and deployment:** SQLite by default; MySQL 8.4 and MariaDB 11.4 with `DATABASE_URL`;
  cluster mode with Redis leases and relay, and a Redis-only cluster (ADR-030); Docker image and
  Helm chart.
- **Durability:** `memory` mode by default without Redis (ADR-029), `wal` mode with batched WAL
  and group commit, and a hot WAL in Redis (ADR-028); fencing epochs against stale room owners.
- **AI assistant and MCP endpoint (experimental, disabled by default):** server-side model
  providers (Claude Platform, OpenAI-compatible servers), plan → approve → act → review → undo
  runs, suggestions, limits, quotas and audit; MCP at `POST /mcp/{hostId}` with host-issued
  tokens (ADR-031 to ADR-035).
- **Operations:** `/healthz`, `/readyz`, Prometheus `/metrics` including `oc_wal_append_seconds`,
  graceful drain with HTTP 503 for new WebSocket upgrades, `scripts/bench.sh` capacity and chaos
  benchmarks, and `scripts/audit.sh` supply-chain checks.
- Documentation: PRD, architecture, technical design, integration guide, build contract,
  security and limits, capacity and sizing (docs/22), acceptance matrix (docs/23), and AI and MCP
  (docs/24); the public website.

### Changed

- jemalloc is the default allocator; memory is purged when a room closes (docs/22 §9.6, §9.7).
- Idle rooms are saved and dropped after `OC_ROOM_IDLE_MS` (60 s).
- Outbound updates are merged into one frame per room every 40 ms; socket write batches are capped.

### Fixed

- A `.ocanvas` file whose `ydoc.bin` is a v2 Yjs update loaded as an empty canvas (docs/23 FC-03b).
- Saves kept using a revoked editor's token after a role change (docs/23 PERM-05).
- A frozen node could keep writing rooms another node had claimed; a failed WAL append was still
  fanned out; MariaDB deadlocks were not retried; a draining node accepted and then closed
  WebSocket upgrades (docs/22 §8 weaknesses 3, 4, 5, 7).
- The host's `export_formats` flag was not enforced (docs/23 EX-09).
- Memory was not returned after idle rooms closed: the jemalloc purge call was refused and the
  error ignored; RSS with 0 rooms fell from 856 MB to 174 MB in the S2 run (docs/22 §9.7).

### Security

- Callback and outbox tokens sealed at rest with AES-256-GCM under `OC_KEK`; the server refuses
  to start without `OC_KEK` outside development.
- HTML export is sanitised and served with a sandbox CSP; imported HTML drops scripts, event
  handlers and `javascript:` links.

[Unreleased]: https://github.com/CasualOffice/opencanvas/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/CasualOffice/opencanvas/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/CasualOffice/opencanvas/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/CasualOffice/opencanvas/compare/v0.1.2...v0.2.0
[0.1.0]: https://github.com/CasualOffice/opencanvas/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/CasualOffice/opencanvas/releases/tag/v0.1.0-alpha.1
