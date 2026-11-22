# 25 — Release notes: v0.1.0-alpha.1

**Embeddable collaborative workspace canvas.**

**Status:** prepared 2026-11-23 from `main` at `1156d58`. Not tagged and not published.
This is an **alpha** for evaluation. There is **no production SLA**: no uptime, support,
response-time or data-retention commitment of any kind. Read [Known limitations](#known-limitations)
before you run it with real users.

OpenCanvas is open source under the [Apache License 2.0](../LICENSE); keep [NOTICE](../NOTICE) when you redistribute it. Your
application keeps the users, the permissions and the files; OpenCanvas does the editing,
real-time merge (Yjs CRDT), presence, export and autosave back to your storage (ADR-001).

## What's included

Each item lists its evidence: an acceptance ID from [docs/23](23-ACCEPTANCE.md), a tracker row
from [docs/10](10-EXECUTION-TRACKER.md), and the tests that check it. Rust tests are in
`crates/oc-server/tests/` and `crates/oc-model/tests/`; browser tests are in `e2e/specs/`;
unit tests are vitest files under `web/packages/*/src/`.

### Rich text

Text, headings, lists, checklists, toggles, quotes, callouts, code with syntax highlighting,
simple tables, images, files, link cards, sandboxed embeds and columns.

- WEB-01, WEB-02, WEB-03, WEB-07, LAY-01 (Done): e2e `a-template-presence`, `b-live-autosave`,
  `k-ux` (tables), `e-upload`, `g-code-highlight`, `o-columns`.
- Round trip of every block type through `.ocanvas`: docs/23 **FC-01**, **FC-02** PASS
  (`acceptance::fc_round_trip_every_block_and_unknowns`).
- Mobile typing, IME input, formatting and tables on phones: docs/23 **MOB-01** to **MOB-04**,
  **MOB-08** to **MOB-12** PASS (`s-mobile`, `f-phone`, `l-ux-phone`, `t-mobile-blocks.phone`).

### Databases

Typed fields; table, board (kanban), calendar and gallery views; filter, sort and search; row
detail; CSV import and export.

- DB-01 to DB-05 (Done): vitest `database.test.ts`, `render.test.tsx`, `views.test.tsx`,
  `kanban.test.tsx`, `addfield.test.tsx`, `csv.test.ts`, `ux.test.tsx`; live cell edits between
  two people in e2e `b-live-autosave`.
- Database cells and views on a phone: docs/23 **MOB-04** PASS.
- Every database field type and view survives `.ocanvas`: docs/23 **FC-01** PASS.

### Whiteboards

Pen, sticky notes, shapes, text, arrows that stay attached to shapes, frames, images, zoom and
full screen, live pointers, SVG and PNG export.

- BRD-02 to BRD-04 (Done), BRD-01 (Review): vitest `board.test.tsx`, `connectors.test.tsx`,
  `export.test.ts`, `open.test.tsx`, `ux.test.tsx`; e2e `p-inline-drag`, `f-phone`.
- Board touch (tap, pan, pinch, draw, move): docs/23 **MOB-05** PASS.
- SVG and PNG export: docs/23 **EX-05** PASS (`acceptance::ex_board_svg_png`).
- Gap: there is no two-person board convergence browser test yet (BRD-01).

### Templates

40 templates in 9 categories, plus blank canvas, database, whiteboard and import.

- TPL-02 (Done): e2e `a-template-presence` (gallery, search, use a template, a viewer sees it).
- Gap: docs/23 **FC-07** (every built-in template loads on the server side) is **Not run**.

### Collaboration

Live co-editing, cursors with names, avatars, follow mode, comments, and view, comment and edit
roles enforced on the server.

- COL-01 to COL-04 (Done): `rooms::two_clients_converge_through_a_room`,
  `rooms::awareness_user_is_stamped_from_the_grant`, `tests/fuzz.rs` (convergence fuzz; 10,000
  iterations pass in release).
- Roles: docs/23 **PERM-01** to **PERM-06**, **PERM-08**, **PERM-09** PASS (`r-permissions`,
  `c-roles`, `p-people`, `d-conflict`; `rooms.rs`, `hardening.rs`, `cluster.rs`, `conflict_live.rs`).
- Access expiry and renewal (**PERM-07**, ADR-036): built 2026-11-23 and checked by e2e
  `u-access-expiry` (tracker integration log). The docs/23 row still reads FAIL from the
  2026-11-22 run; it has not been re-run in the matrix.
- Comments: CMN-01 (Review). The commenter role is browser-tested (PERM-02); a two-person thread
  browser test is still missing.

### Saving

Autosave only, through a durable outbox; host conflicts (409) save a copy or reload.

- CMT-01 (Done): `hardening.rs` (outbox written before every PUT, pending saves resumed after a
  restart); docs/23 **PERM-05**, **PERM-08** PASS.

### Standalone SQLite deployment

One binary and one SQLite file. SQLite is the default (ADR-004); MySQL 8.4 and MariaDB 11.4 work
when `DATABASE_URL=mysql://…` is set.

- STO-01 (Done): `tests/storage_conformance.rs`; `scripts/e2e-db.sh` on SQLite, MariaDB 11.4
  and MySQL 8.4 (launch, edit over WebSocket, autosave reaches the host, export).
- Crash recovery on SQLite: docs/22 §9.4 and §10 (`scripts/bench.sh R`).
- Image and Helm chart: [docs/13](13-OPERATIONS-AND-DEPLOYMENT.md). The chart (OPS-01, Review)
  is linted and rendered in CI; it has not been installed in a real cluster.

### Host SDK and integration

HS256, RS256, EdDSA and JWKS launch tokens; signed callbacks; live role changes; the
`<open-canvas>` web component; the postMessage API; the WOPI client mode.

- HOST-01 to HOST-03, SDK-01, API-01 (Done): `jwt.rs` unit tests, `host_client.rs` signature
  tests, `tests/host_api.rs`; e2e `q-sdk-embed` (the SDK loaded from a separate host origin).
- WOPI: docs/23 **WOPI-01** to **WOPI-12** and **WOPI-14** PASS (`tests/wopi.rs`,
  `scripts/e2e-wopi.sh`). **WOPI-13** (proof keys) FAIL: see limitations.
- The contract: [docs/05](05-INTEGRATION-GUIDE.md) and [docs/15](15-BUILD-CONTRACT.md).

### Import and export (tested formats only)

| Format | Export | Import | Evidence |
|---|---|---|---|
| `.ocanvas` | yes | yes | **FC-01** to **FC-06**, **EX-06** PASS |
| Markdown | yes | yes (server, off by default) | **FC-08**, **EX-01**, **FC-10** PASS |
| HTML | yes (sanitised) | yes (server, off by default) | **EX-02** PASS; **FC-09** PASS for export, import covered by `tests/import.rs` |
| CSV (databases) | yes | yes (editor; server off by default) | **FC-10** PASS, vitest `csv.test.ts` |
| DOCX | yes | no | **EX-03** PASS |
| PDF | yes, with the optional Gotenberg sidecar; otherwise the browser prints | no | **EX-04** PASS |
| Board SVG / PNG | yes | no | **EX-05** PASS |

Non-ASCII text (CJK, RTL, emoji) survives every export: **EX-07** PASS. Export permissions and the
host's `export_formats` flag: **EX-08**, **EX-09** PASS. Server-side import is off unless a host
lists formats in `[host.flags] import_formats`; `OC_IMPORT=off` turns it off for every host.

### AI assistant and MCP: experimental, disabled by default

An in-editor assistant (plan, approve, act, review, undo) and an MCP endpoint
(`POST /mcp/{hostId}`) for external agents with host-issued tokens. ADR-031 to ADR-035;
[docs/24](24-AI-AND-MCP.md).

- **Experimental.** AI-01, AI-02 and AI-UI are in Review, not Done. Interfaces and behaviour may
  change in any later release.
- **Disabled by default.** AI is on only when `OC_AI_CONFIG` names a file with `[ai] enabled =
  true` and `OC_AI` is not `off`; each host must also set `[host.ai] enabled = true`, and MCP
  needs `[host.ai] mcp = true` (default false; the endpoint answers 404). See docs/13
  "AI server switch".
- **Canvas content is sent to the model server you configure.**
- Evidence: `tests/ai.rs`, `ai_tools.rs`, `ai_e2e.rs`, `mcp.rs`; e2e `t-assistant`,
  `t-assistant.real` (against a mock model).

## Security

The release security gate (docs/18, "Release audit, v0.1.0-alpha.1") re-audited everything added
since the first audit: the assistant and MCP, import, Redis storage and fencing, access renewal, the
SDK's CORS and export enforcement.

- **Fixed, High (SEC-29):** deeply nested HTML or Markdown overflowed the stack and stopped the
  whole server. It was reachable through import and through any host Markdown file opened in a
  room. Nesting is now capped in `oc-model`; tests aborted before the fix and pass after it.
- **Fixed, Medium (SEC-30):** a quadratic scan in the HTML importer.
- **Open, Medium (fix before beta):** the MCP token audience falls back to the `Host` header when
  `OC_PUBLIC_URL` is unset (set `OC_PUBLIC_URL` in production); an MCP token without a `files`
  list applies its role to every file of the host; WOPI session lifetime has no upper cap. AI and
  MCP are off by default.
- **Dependencies:** `cargo audit` reports 0 vulnerabilities (405 crates); `cargo deny` advisories,
  bans, licences and sources pass; `npm audit` reports 0 for `web/` and `e2e/`.
- No Critical or High finding is open.

## Known limitations

### Alpha, with no SLA

This is a pre-release. There are no maintained release branches, no support commitment and no
production SLA. Formats, configuration and APIs can change before 1.0. Most design documents
(docs/02 to docs/08) and several features are still awaiting the owner's review (tracker status
`Review`).

### Memory

All figures are from one Apple M4 laptop ([docs/22](22-CAPACITY-AND-SIZING.md)), with the load
generator on the same machine. They are indicative, not a guarantee.

- **Idle cost:** about 0.20 MB per idle connection; per open room about 5× the encoded document
  for text-heavy canvases and about 14× for database- or board-heavy ones (docs/22 §2 C).
- **Sizing rule:** memory ≈ 50 MB + 0.25 MB per concurrent user + 5–14× the document per open
  room; keep under 60 % of what was measured (docs/22 §4).
- **Under nonstop editing**, a room's in-memory document is about 20× its encoded size, and it
  grows while the room is open (docs/22 §9.4). In the 1,000 rooms × 5, everyone-typing run, RSS
  grew from 843 MB to 1,451 MB over 5 minutes (docs/22 §9.4.1). Every map overwrite (a database
  cell, a shape's position) leaves a deleted yrs item in memory: the live heap grows about 14.7×
  the encoded growth, and the server cannot reduce that without changes in yrs (docs/22 §9.5).
- **Retention after eviction (fixed in this release, docs/22 §9.7):** idle rooms are saved and
  dropped after `OC_ROOM_IDLE_MS` (60 s), and jemalloc (the default allocator) now returns their
  memory. The purge had never run (`arena.4096.purge` was called with a non-null input and the
  error was ignored); it now uses null pointers, logs failures, and its sweeper starts in
  `AppState::new`. In the 1,000 rooms × 5 nonstop-typing run, RSS was about 1,077 MB at minute 3;
  60 s after typing stopped, with 0 rooms open, it was **174 MB** (856 MB before the fix), with p95
  43 ms. About 160 MB stays resident with no rooms (SQLite page cache, allocator metadata and
  thread caches, tokio). Tests: `alloc::tests::jemalloc_purge_is_accepted`,
  `tests/alloc_release.rs`.
- **Remaining limit:** live memory grows with the document while people type, because yrs keeps
  dead items: about 15–20× the encoded size (docs/22 §9.4, §9.5). Size for the documents you keep
  open, not for the idle baseline.
- **Sizing guidance:** [docs/22 §4](22-CAPACITY-AND-SIZING.md#4-sizing-for-self-hosters) and the
  Sizing section of [docs/13](13-OPERATIONS-AND-DEPLOYMENT.md#sizing). Restart a node that keeps
  RSS high after its load has gone, and watch it with `/metrics` and your own RSS monitoring.

### Durability modes

What "acknowledged" means depends on the mode ([docs/13](13-OPERATIONS-AND-DEPLOYMENT.md),
ADR-028, ADR-029, ADR-030):

| Mode | When | An acknowledged edit is | A server crash loses |
|---|---|---|---|
| `memory` | default without Redis | in server memory and in the editors' browsers; dumped to the DB every `OC_DB_SYNC_MS` (2 s), before each host save, on drain and on close | nothing while a client holding the edit reconnects; otherwise edits from the last `OC_DB_SYNC_MS` plus up to one 250 ms tick. Measured: 0 of 67,980 lost with clients reconnecting; 2,013 of 38,681 (5.2 %), the oldest 2,139 ms before the kill, with clients gone for good (docs/22 §9.4) |
| `wal` | `OC_DURABILITY=wal` | in the database WAL before anyone sees it | nothing acknowledged on a process crash (docs/22 §8 summary, R: 0 of 38,756). On SQLite (`synchronous=NORMAL`) a power loss or OS crash can roll back the last commits |
| Redis WAL | `OC_WAL_REDIS_URL` or `REDIS_URL` | in the Redis stream `oc:wal:{room}` | depends on Redis persistence: `appendonly yes` + `appendfsync always` loses nothing acknowledged (recommended); `appendfsync everysec` about the last second (only with a replica you fail over to); `appendonly no` everything since the room's last DB sync |

A SIGTERM drain loses nothing in any mode. The server logs a warning at start-up when Redis has
`appendonly no` or `appendfsync` other than `always`.

### WOPI compatibility

WOPI mode has **no proof keys** (`X-WOPI-Proof`; docs/23 **WOPI-13** FAIL, docs/05 §6). Callers
are trusted only through the WOPISrc allow-list and the access token. **Do not use WOPI mode with
a host that requires proof-key validation.** There is no `LOCK`/`UNLOCK`/`X-WOPI-Lock` by design:
conflicts use timestamps, like Collabora (WOPI-05).

### Single node first

The supported shape for this release is one node with SQLite. Cluster mode (Redis, optionally
MySQL/MariaDB) passes the crash and chaos runs in docs/22 §8 and §11.1, and the Redis-only
cluster reruns pass (docs/22 §9.7: K, 107,035 acknowledged edits and 0 lost, 124 stale writes
fenced; K2, 71,715 acknowledged and 0 lost; S1, 550 typing in one room at p95 49–69 ms), but **scale-out across
machines is not demonstrated**: on one laptop three nodes held less load than one (docs/22 §8
weakness 8, §12), and the multi-machine recipe in §12.1 has not been run. On SQLite, a server
with 1,000 rooms of nonstop typing in `wal` mode stays above the 700 ms p95 target
(1.2–1.6 s, docs/22 §9.3). The 550-user room cap (`MAX_PEERS`) is fixed.

### Block schema validation and format compatibility

`oc-model` has **no block schema validation** (tracker MOD-01, Todo): the schema is only mirrored
by the `doc.rs` walk and the web `schema.test.ts`. Unknown blocks and attributes are kept, not
checked. Format caveats:

- Only `.ocanvas` format version 1 exists; files from other writers are read as tested in
  **FC-03b** (`document.json` only, `ydoc.bin` only as a v2 update, no manifest).
- The reader prefers `ydoc.bin`: a tool that edits only `document.json` must drop `ydoc.bin` or
  bump `schemaVersion` (**FC-06**, docs/04 §2.3).
- HTML import is a forgiving parser and is tested by `tests/import.rs`, not a full round trip.
- The built-in templates are not loaded by a server-side test (**FC-07** Not run).

### AI and MCP

Experimental and off by default (see above). Canvas content goes to the configured model server.

### Other open items

- Link cards show the site's name until the SSRF-safe unfurl fetcher is built (UNF-01, Todo);
  server-rendered preview for viewers is not built (RND-01, Todo).
- Host-supplied team templates are not built (TPL-01, Todo).
- The Helm chart has not been installed in a real cluster and there are no dashboards (OPS-01).

## Backup and recovery

The host owns the documents: every saved canvas is a file in your storage, and OpenCanvas never
persists documents of its own (ADR-001). **Back up your host's files as you already do; there is
nothing in OpenCanvas to back up for them.** OpenCanvas keeps only transient state: sessions,
room dumps or the WAL tail, snapshots, the save and notification outboxes, fencing epochs and AI
usage counters.

### What to back up

| Deployment | Back up | Why |
|---|---|---|
| Single node, SQLite (default) | the SQLite file (`/data/opencanvas.db` in the image) | unsaved edits since the last host save, pending saves in the outbox, open sessions |
| SQL cluster (MySQL/MariaDB + Redis) | the MySQL/MariaDB database; Redis AOF/RDB if you use the Redis WAL | as above; the Redis stream holds the WAL tail since each room's last DB snapshot |
| Redis-only cluster | Redis persistence (AOF, and RDB if you keep it) | Redis holds every piece of state (ADR-030) |
| Every deployment | `OC_KEK`, the hosts file and the secrets it references | sealed rows (session callback tokens, outbox tokens) can only be read with the same `OC_KEK` |

docs/13: back the SQLite file up "only if you care about un-committed edits surviving a disk loss
— committed content is in the host". Copy the SQLite file while the server is stopped after a
SIGTERM drain, so the copy is consistent.

### What a crash loses

- **`memory` mode (default without Redis):** edits since the last dump (≤ `OC_DB_SYNC_MS`, 2 s)
  that no reconnecting client resends. The first host save after the restart is the dump's state
  until the clients' resync lands (docs/22 §9.4).
- **`wal` mode:** nothing acknowledged on a process crash; on SQLite a power loss or OS crash can
  roll back the last commits.
- **Redis WAL:** as set by Redis persistence (table above).
- **Redis-only cluster, Redis wiped:** rooms close with 1012 and rebuild from the host's last
  saved file plus what reconnecting clients resend; edits of clients that never return, commits
  the host had not acknowledged and open sessions are lost (users relaunch). With
  `DATABASE_URL` set the same wipe only costs the WAL tail since each room's last DB snapshot.
- **Disk lost with no backup:** unsaved edits, pending saves and sessions. Everything the host
  saved is safe in the host.

### Restore

1. Stop the server (SIGTERM; a drain commits dirty rooms and loses nothing).
2. Put the SQLite file back at its path (or restore the MySQL/MariaDB database, or Redis's AOF/RDB
   for a Redis-only cluster).
3. Start the server with the **same `OC_KEK`** and hosts file. Migrations run at start-up.
4. On start the outbox sweeper resumes pending saves (`hardening::pending_save_is_resumed_after_a_restart`),
   rooms reopen from their dumps or snapshot plus WAL, and clients reconnect and resend what the
   server lacks.
5. If there is no backup, start with an empty database: rooms load from the host's saved files
   when users open them again, and users relaunch from the host.

## Upgrade notes

- This is the first tagged version. There is no earlier release to upgrade from.
- From a pre-release build of `main`: the database migrations (`migrations/sqlite`,
  `migrations/mysql`, 0001 to 0007) run automatically at start-up. Back up the database first.
- Defaults to check when coming from an older `main`: `OC_DURABILITY=memory` is the default
  without Redis (set `OC_DURABILITY=wal` to keep every acknowledged edit on disk); idle eviction
  is `OC_ROOM_IDLE_MS=60000`; jemalloc is the default allocator; AI is off unless `OC_AI_CONFIG`
  enables it; server-side import is off unless a host lists `import_formats`.
- Helm: the chart version and `appVersion` are `0.1.0-alpha.1`; the image tag defaults to the
  chart `appVersion`.
- Alpha releases make no compatibility promise. Read the next release's notes before upgrading.

## Verification checklist

Run on the release commit, from the repository root, and fill in each result. Do not tag until
every line has a result.

```sh
OC_DEV=1 cargo test --workspace
```
Result:

```sh
cargo clippy --workspace --all-targets -- -D warnings
```
Result:

```sh
cargo fmt --all -- --check
```
Result:

```sh
cd web && pnpm install --frozen-lockfile && pnpm -r typecheck
```
Result:

```sh
cd web && pnpm -r test          # vitest
```
Result:

```sh
cd e2e && npm ci && npx playwright install chromium webkit && npm run e2e
```
Result:

```sh
scripts/e2e-db.sh sqlite
```
Result:

```sh
scripts/e2e-db.sh mariadb mysql://root:root@127.0.0.1:33061/opencanvas
```
Result:

```sh
scripts/e2e-db.sh mysql mysql://root:root@127.0.0.1:33062/opencanvas
```
Result:

```sh
scripts/audit.sh
```
Result:

```sh
docker build -f deploy/Dockerfile -t opencanvas:0.1.0-alpha.1 .
```
Result:

```sh
curl -s http://localhost:8080/healthz    # on the built server: "version":"0.1.0-alpha.1"
```
Result:
