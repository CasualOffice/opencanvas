# 36 — v0.4 design plan: partial sync, benchmarks, performance and maturity

**Status:** Proposed 2026-11-26. The owner set the direction the same day and sharpened it: v0.4's
main thrust is **performance and partial synchronization**, as a broader benchmark, performance and
maturity release. ADRs 076–079 (Proposed) in [docs/08](08-ADR-REGISTER.md); tracker rows in
[docs/10](10-EXECUTION-TRACKER.md) §P3 v0.4. Prototypes (V4UI-01, §7) gate every UI row (ADR-011).
**Scope:** the v0.4 line of [docs/09](09-ROADMAP.md#release-roadmap).
**Not in scope:** a plugin marketplace, server-side third-party code and enterprise hardening
(v0.5); a new `.ocanvas` format version.

## 0. Direction and order

| # | Workstream | Role | Rough effort (§9) | Section |
|---|---|---|---|---|
| 1 | **Partial synchronization** | Main thrust | ≈ 7 engineer-weeks | §2 |
| 2 | **Benchmark program** | Main thrust; measures everything else | ≈ 6.5 | §3 |
| 3 | **Performance work driven by the benchmark** (fan-out, presence, memory, lazy loading) | Main thrust | ≈ 10.5 | §4 |
| 4 | **Maturity** (reliability, security, flaky tests, MySQL conformance) | Required for the release | ≈ 15 | §5 |
| 5 | **Also in v0.4**: advanced databases, integrations, UX refinement | Secondary | ≈ 20 committed + 7 stretch | §6 |

The owner's first split (performance and memory 30%, reliability and security 25%, advanced
databases 20%, integrations 15%, UX 10%) still names everything v0.4 contains. The sharpened focus
sets the **priority**: with at most two agents working at once, §2–§4 take the first track at all
times, §5 the second, and §6 fills the second track only when §5 is waiting. If the main thrust runs
long, the §6 rows marked *stretch* move to 0.4.x first, then the rest of §6; §2–§5 are never cut to
make room for §6.

Constraints every design below keeps (as in [docs/34](34-ROADMAP-v0.3.md)):

- **The host owns auth, ACL and files; OpenCanvas never persists documents** (ADR-001). Partial
  sync changes how the room holds and sends a document, never where it is stored.
- **The server enforces roles on every frame** (rule 6), including every partial-sync request.
- **`.ocanvas` stays format version 1** (ADR-042): what a 0.4 server saves opens in 0.3.x.
- **Reliability before scale** (owner rule): no cap is raised until the cluster, crash and
  sustained-load runs at the new size pass, and every number states its load mix. The documented
  cap today is **550 peers per room** (`MAX_PEERS`, [docs/22](22-CAPACITY-AND-SIZING.md) §4).
- **Feature flags:** partial sync, formulas, relations and rollups are off for a host until its
  `[host.*]` table turns them on; 0.3 behaviour is unchanged without them.

Sizes: **S** ≤ 2 days, **M** ≤ 1 week, **L** ≤ 3 weeks, for one engineer. Capacity facts come from
docs/22 (there is no docs/14; capacity lives in docs/22).

## 1. Starting point (measured, docs/22)

| Fact | Value | Source |
|---|---|---|
| Idle connection | 0.20 MB RSS each | docs/22 §2 C |
| Open room | ≈ 5× the encoded document (text-heavy), ≈ 14× (database/board-heavy) | docs/22 §2 C |
| One room at the cap, 20% typing | 550 peers, 1.8 cores, 193 MB, 345,255 frames/s out | docs/22 §2 A, §4 |
| 550 all typing (batched WAL + 40 ms tick) | p95 ≤ 67 ms (SQLite WAL) / ≤ 81 ms (Redis); RSS grows with the document | docs/22 §8, §9 |
| One load generator | ≈ 16,000 sockets (loopback ephemeral ports) | docs/22 §5 |
| Benchmarks | `scripts/bench.sh` (scenarios A–E, R, K, T), run by hand; not in CI; results only in docs/22 | docs/22 §13 |
| Editor initial JS | 286–289 KB gzip of a 300 KB budget (`check-budget.mjs`) | docs/10 log 2026-11-26 |
| Browser memory | no baseline, no budget | — |

What this means for 10k: 10,000 idle connections alone are about 2 GB; 500 rooms of a 408 KB
board-heavy document are about 2.9 GB. That is under 6 GB only with little room for the typing
load, so connections and rooms both have to get cheaper (§4.1), and partial sync (§2) is what makes
the room side cheaper.

---

## 2. Partial synchronization (main thrust; ADR-076)

### 2.1 Problem

A Yjs document syncs whole. A 50 MB canvas sends and builds 50 MB before the first paint, the
browser holds all of it, and the room holds all of it for every open canvas even when everyone is
reading the first page.

### 2.2 Design (to be confirmed by the PSYNC-01 spike)

1. **Heavy blocks become subdocuments.** Each database, board and diagram keeps its content in a
   Yjs subdocument (`guid = <fileId>/block/<blockId>`); the main document keeps the text, the
   outline and a small header per heavy block (title, kind, row and item counts, a size hint for
   the placeholder).
2. **One socket, several documents.** Sync and awareness frames carry a document id (the
   "multiplexed room socket" deferred from v0.3). A client asks for a subdocument when its block
   comes within one screen of the viewport; the server checks the role on every request and only
   for blocks of the same file. Undo stays per document; one step that spans text and a database
   is grouped by transaction origin.
3. **Server.** The room loads subdocuments lazily from the WAL and the last snapshot, evicts a
   subdocument that no client holds, and keeps WAL entries per document id. The role filter,
   MOD-01 validation, automation and live blocks see the same blocks as before.
4. **Format v1 on save.** The save flattens subdocuments back into the v1 roots, so 0.3.x and
   0.2.x readers, exports, `search.json` and the API see the same file. Opening a v1 file splits it
   in the room; nothing new is stored by the host.
5. **Older editors.** Connections without `caps=subdoc` to a room with split blocks are either
   served a flattened view (cost: the server keeps both) or closed with 4426 as ADR-059 does (Q2).
   The plan assumes 4426.
6. **Offline.** An offline copy (ADR-063) asks for every subdocument once, so the whole canvas is
   on the device.
7. **First screen.** The launch answer includes the main document as one compressed snapshot
   (update v2, zstd). The editor paints text and heavy-block placeholders (size from the header,
   so nothing jumps) before any subdocument arrives.
8. **Client unload.** A subdocument out of view for 2 minutes is released in the browser (kept in
   IndexedDB when offline), which is also the largest single memory saving (§4.3).

**Alternative measured in the spike:** a server-side projection of the first screen with the full
sync behind it. It is simpler but saves no memory in the room or the browser. ADR-076 records the
measured choice. **Fallback** if the spike shows subdocuments cost more than sized: databases
first (the largest blocks), boards and diagrams in 0.4.x, behind `[host.flags] partial_sync`.

### 2.3 Fixture

`bench/fixtures/canvas-50mb.ocanvas`, generated by a seeded script (not committed as a blob): 200
pages of text, 20 databases × 5,000 rows × 12 fields, 10 boards of 2,000 items, 5 diagrams; 50 MB
encoded. The same generator makes the S/M/L memory fixtures (§3.4).

### 2.4 Tests and acceptance (PSYNC-A1..A6)

| Row | Pass |
|---|---|
| PSYNC-A1 | **The 50 MB canvas opens to its first screen in < 2 s** from launch to the first block painted and the caret placeable; Chromium, 4× CPU throttle, 40 Mbit/s, 40 ms RTT; median of 5, worst < 2.5 s |
| PSYNC-A2 | A database or board below the fold is usable within 1 s of scrolling into view (same profile) |
| PSYNC-A3 | A subdocument request for another file's block, or by a peer without read access, is refused (seen failing first with the check off) |
| PSYNC-A4 | Convergence fuzz with subdocuments (`tests/fuzz.rs`, 10,000 iterations nightly) and a two-node cluster test where peers on both nodes load different subdocuments |
| PSYNC-A5 | Save round trip: the saved file is format v1 and byte-equal in content to a 0.3 save of the same edits; opens in 0.3.x; exports, API, MCP and `search.json` unchanged |
| PSYNC-A6 | Room RSS for the 50 MB canvas with 20 viewers on the first page ≤ 30% of the 0.3 figure; an offline copy holds every subdocument |

---

## 3. Benchmark program (main thrust; ADR-079)

### 3.1 Problem

The capacity numbers in docs/22 are careful but hand-run: one script, run on one laptop when
someone remembers, results pasted into a document. Nothing stops a regression, browser memory and
startup are not measured at all, and the owner's targets need numbers anyone can reproduce.

### 3.2 Harness

- **`scripts/bench/`** replaces `scripts/bench.sh` (kept as a wrapper): one entry point
  `scripts/bench/run <scenario> [--size quick|full] [--store sqlite|mysql|mariadb|redis]`.
- **Scenarios as files.** Each scenario is a TOML file in `bench/scenarios/`: rooms, peers,
  the load mix (idle, presence-only, typing and their rates), fixture, duration, faults (crash at
  minute N, Redis restart), and its pass rules. The A–E, R, K, T scenarios of docs/22 move into
  this form unchanged, so old numbers stay comparable.
- **Load generation.** The Rust load client opens sockets from several source addresses (or
  several machines over SSH) to pass the ≈ 16,000-socket limit of one address; timestamped probe
  edits measure end-to-end latency (send → seen by another peer) with clock offsets corrected.
- **Results as data.** Every run writes `bench/results/<date>-<scenario>-<host>.json`: commit,
  scenario file hash, hardware (CPU model, vCPU, RAM, OS, kernel, storage), store, load mix,
  latency percentiles per 1-minute bucket, RSS, CPU, frames in/out, errors, drops, and pass/fail
  per rule. A run without the hardware and mix block is refused by the publisher.
- **Browser benchmarks** (Playwright, Chromium): first screen of the fixtures (PSYNC-A1),
  heap after GC per fixture (CDP `HeapProfiler.collectGarbage`, `Runtime.getHeapUsage`), DOM
  nodes, initial JS bytes, long animation frames while scrolling a large database.

### 3.3 Scenarios with stated load mixes

| Scenario | Machine | Load mix | Pass |
|---|---|---|---|
| **X10K: 10k connections** | 1 node, 4 vCPU, 8 GB | 10,000 WebSockets over ≈ 500 rooms; 80% idle viewers, 15% presence-only (cursor moves 2/s), 5% typing at 1 edit/s; demo and big fixtures 3:1; 30 min; `kill -9` and restart at minute 15; SQLite, and Redis + MySQL | p99 edit latency < 250 ms in every 1-minute bucket except the 60 s after the restart; RSS < 6 GB; no drops except by the restart; every client back < 60 s; 0 acknowledged edits lost |
| **R1K: 1k editors in one room** | 1 node, 4 vCPU, 8 GB | 1 room of 1,000 peers: 100 typing at 2 edits/s, 900 moving cursors at 5 moves/s; 15 min | p99 < 500 ms every bucket; all clients converge (state vectors and text equal); RSS within ± 10% after warm-up |
| **STORM: reconnect storm** | as X10K | 10,000 clients lose the node at once | normal latency within 90 s; no client retries faster than its backoff |
| **SOAK: sustained** | as X10K | X10K mix for 8 h | RSS within ± 10% of the first hour; p99 < 250 ms |
| **PSYNC50** | browser profile §2.4 | the 50 MB fixture | PSYNC-A1, A2 |
| **MEM: browser memory** | Chromium | fixtures S (20 pages), M (5 databases × 2,000 rows, 3 boards), L (50 MB) | L heap −40% against the MEM baseline; S, M ≤ +5% |
| **START: startup** | production build | initial JS and first screen of S | initial JS ≤ 220 KB gzip; no advanced module in the initial graph |
| docs/22 A–E, R, K, T | as documented | unchanged | as documented (comparison with earlier runs) |

### 3.4 Where it runs

- **Locally:** any scenario with `--size quick` in minutes on a laptop; `--size full` on the
  reference machine.
- **Pull requests (gates):** START, MEM (S and M) and PSYNC50 on Chromium; a quick X10K at 1,000
  connections and a quick R1K at 200 peers on SQLite. Fails on a budget breach.
- **Scheduled CI job (nightly):** the quick server scenarios on SQLite, MySQL, MariaDB and Redis,
  plus MEM L; compared with the last seven nightly results.
- **Weekly (and before every release):** the full X10K, R1K, STORM on a dedicated 4 vCPU / 8 GB
  machine with the load generators on separate machines; SOAK before each release. Who provides
  the machine is Q1.
- Server benchmark jobs run at background CPU priority with no fixed waits (CI rule).

### 3.5 Budgets and regression gates

- **Browser budgets** (`bench/budgets.toml`, ADR-079): initial JS steps 300 → 260 → 240 → 220 KB
  gzip; heap per fixture; first screen time per fixture. `check-budget.mjs --forbid` fails when an
  advanced module is in the initial graph.
- **Server regression gates:** a nightly result fails when p99 is > 20% or RSS > 10% worse than
  the median of the last seven nightly runs on the same runner class, or when any pass rule of the
  scenario fails. A failed gate opens an issue with the two result files linked.
- Budgets change only in a reviewed commit that says why; the baseline is never refreshed
  automatically.

### 3.6 Published results

`tools/build-site.py` renders `bench/results/` into a **Benchmarks** page on the site (and the
capacity summary in docs/22): per scenario, the latest full run and a trend over releases, each
with the hardware, store, load mix and commit stated next to the number, and a link to the raw
JSON. Only full runs on the reference machine are published as headline numbers; quick runs feed
gates only. The page says what was not measured.

### 3.7 Acceptance (BENCH-A1..A4)

| Row | Pass |
|---|---|
| BENCH-A1 | A new person reproduces the docs/22 scenario A and B numbers within ± 15% on the reference machine using only `scripts/bench/` and the README |
| BENCH-A2 | Each gate is seen failing first: a deliberate 30 KB import fails START; a leaked 20 MB array fails MEM; a 50 ms sleep in the fan-out fails the quick R1K |
| BENCH-A3 | The nightly job has run green for 14 consecutive nights before the release |
| BENCH-A4 | The site's Benchmarks page shows every headline number with hardware, store, load mix and commit; the link and SEO checks pass |

---

## 4. Performance work driven by the benchmark

Each item below starts from a benchmark result that shows the problem and ends with the result
that shows it fixed. Nothing is tuned without a scenario that measures it.

### 4.1 Connections and rooms (X10K, STORM)

1. **Per-connection footprint.** Break down the 0.20 MB per idle connection (buffers, the socket
   task, awareness copies, the grant) and cut it: shrink buffers after a large frame (done for
   frames, docs/22 §7), one shared encoded awareness state per room, release an idle viewer's
   write buffer. Goal 0.08 MB.
2. **Per-room footprint.** With partial sync a room keeps only the main document hot until a
   client asks for more. Goal: ≤ 6× the encoded document for board-heavy files.
3. **Idle viewers cost nothing per tick.** The 40 ms outbound tick skips peers with nothing queued.
4. **Reconnect storm control.** Full jitter (0–5 s, then exponential to 60 s); a token bucket for
   upgrades per node with `503 Retry-After`; room loads after a restart queued so WAL replay does
   not starve live traffic.
5. **Operational limits.** File descriptors (`LimitNOFILE` ≥ 65,536 in the Helm chart and systemd
   unit), backlog; TLS placement for the run is Q10.

### 4.2 Fan-out and presence (R1K; ADR-077)

Fan-out is quadratic: every editor frame goes to every peer and every cursor move is an awareness
frame to every peer. At 1,000 peers, 900 cursors at 5 moves/s would be 4.5 million frames per
second.

1. **Presence batching and throttling.** Clients send awareness at most every 100 ms (latest
   wins). The room sends **one merged awareness frame per peer per tick**, latest state per client
   only; a peer that falls behind gets the newest states, never a backlog. Above 200 peers, cursors
   outside the reader's visible blocks are sent at 1 Hz (Q3).
2. **Encode once.** The tick's updates are merged (`merge_updates`) and encoded once; every peer
   gets the same bytes, minus its own changes.
3. **Fan-out sharded across cores.** The room actor stays the single writer of the yrs document
   (ordering and the role filter stay where they are). After apply, the encoded tick goes to N
   shards (N = cores − 1), each owning a fixed subset of sockets, so each peer's frames stay in
   order. Slow peers leave by the existing back-pressure rule.
4. **Cluster.** A 1,000 room still has one owner node; relayed peers on other nodes get the tick
   once per node over the bus, then fan out locally.
5. **Cap.** `MAX_PEERS` moves from 550 to 1,000 only after X10K, R1K, SOAK and the RLB-A1..A3
   drills pass, and docs/22 is rewritten with these mixes (PERF-16; Q4 on the default).

### 4.3 Browser memory (MEM)

Large canvases hold the Yjs document, the ProseMirror document, view models for each database
and board, undo stacks and decoded images at once. After the baseline (BENCH-03): subdocuments
unloaded when out of view (§2.2.8); database and board view models for visible rows only (§6.1);
no `toJSON()` of whole databases; undo stacks capped by size; awareness only for people in view;
images decoded at display size. Target −40% heap on L, enforced by the MEM gate.

### 4.4 Lazy loading (START)

Every advanced module loads on first use behind `import()`: diagram mode, database views other
than the plain table shell, automation (already lazy), offline (service worker registration only
when the host offers it), live blocks (already lazy), the SDK runtime and sandbox bridge, find and
search (already lazy), the assistant, export dialogs and the formula engine (§6.1). The budget
steps toward 220 KB as the splits land, one commit per step.

---

## 5. Maturity: reliability and security

### 5.1 Reliability

1. **Crash and restart drills (RLB-01).** Scripted `kill -9` of a single node under the X10K mix
   on SQLite and MySQL, then restart: no acknowledged edit lost, outbox resumes, every client back.
   A reduced drill (1,000 connections, 5 minutes) runs in the nightly benchmark job.
2. **Failover drills (RLB-02).** On the 3-node cluster (Redis + MySQL/MariaDB,
   `scripts/chaos-cluster.sh`, moved under `scripts/bench/`): kill the owner of a busy room,
   restart Redis, restart the database primary, partition one node. No acked edit lost, rooms move
   within 10 s, automation and webhooks do not run twice.
3. **Backup and restore (RLB-03).** The server's database holds only transient room state and
   metadata (WAL not yet committed to the host, commit outbox, automation schedules and run log,
   offline generations, idempotency keys). Runbook in docs/13 for SQLite (`VACUUM INTO`),
   MySQL/MariaDB (dump plus binlog) and Redis (RDB/AOF), and `scripts/restore-drill.sh`.
   **Restore hazards found while designing:** a restored, older `offline_generation` would accept
   devices revoked after the backup; an older idempotency table could run a request twice; an older
   schedule table could run a slot twice. Fix: a **restore epoch** (`--restored` at start bumps
   every offline generation, refuses idempotency keys older than the restore and marks earlier
   schedule slots done).
4. **Flaky tests (RLB-04).** Inventory failures on `main` for 30 days (`gh run list`), fix root
   causes (no fixed waits), keep a quarantine list with an owner and expiry for anything not fixed
   within a week; new or changed Playwright tests run `--repeat-each=5` in CI at background CPU
   priority. Includes the `ze-live-blocks.phone` (webkit-phone) failure left open on 2026-11-26.
5. **MySQL `storage_conformance` (RLB-05).** `stale_epoch_is_refused_on_every_guarded_write` and
   `snapshot_replaces_the_covered_wal_and_never_goes_back` fail on MySQL 8.4 with
   `OC_TEST_MYSQL_URL` when the file runs in parallel and pass alone (docs/10 log, AUTO-CL); the CI
   Rust job sets no MySQL URL, so it never ran there. Reproduce with `--test-threads`, find the
   shared state (most likely tests sharing one database or room id), give each test its own
   database, and add a CI job running the file on MySQL 8.4, MariaDB 10.11 and Redis.
6. **Sustained load (RLB-06)** is the SOAK scenario (§3.3).
7. **Observability (RLB-07).** Metrics for fan-out queue depth per shard, superseded presence
   frames, reconnect and admission rates, subdocument loads and evictions; Grafana dashboard and
   alert rules in the Helm chart. The benchmark records them in each result.
8. **Upgrade drill (RLB-08).** A rolling 0.3 → 0.4 upgrade of the cluster under load, and back.

### 5.2 Security audit for v0.4 (SEC-V4, docs/18 §7)

Surfaces from v0.3: **offline grants** (ES256 grant replay and lifetime, device key extraction,
logout clear, revocation after a restore, a copy kept past a role change); **automation URL
calls** (SSRF through DNS rebinding and IPv6 forms, `allow_origins` bypass, redirects, signature
replay, runs on behalf of someone who lost access, cost amplification); **live-block
permissions** (derived-session escalation, the depth rule, projection and snapshot leaks, audience
counts, SDK block data after PSDK). New in v0.4: subdocument requests, presence batching (no state
of a peer who left), formula evaluation cost, relations across canvases. Each finding gets a SEC
number, a fix and a test seen failing first.

**Dependency audit (DEP-01):** `cargo deny` and `cargo audit` (`scripts/audit.sh`), `pnpm audit`,
licences against Apache-2.0, an SBOM attached to the release, and a written update policy.

### 5.3 Acceptance (RLB-A1..A6)

| Row | Pass |
|---|---|
| RLB-A1 | Single-node crash drill: 0 acked edits lost, every client back < 60 s, on SQLite and MySQL |
| RLB-A2 | Cluster failover drill (owner kill, Redis restart, DB primary restart, partition): 0 acked edits lost, no duplicate automation run or webhook |
| RLB-A3 | SOAK passes |
| RLB-A4 | Restore drill passes from a backup taken under load; a device revoked after the backup stays revoked |
| RLB-A5 | 50 consecutive `main` CI runs with no flaky failure; quarantine list empty at release |
| RLB-A6 | `storage_conformance` green on SQLite, MySQL 8.4, MariaDB 10.11 and Redis in CI, in parallel |

---

## 6. Also in v0.4 (secondary)

These ship in v0.4 when the main thrust allows; *stretch* rows move to 0.4.x first.

### 6.1 Advanced databases (ADR-078)

- **Formulas.** Typed expressions over a row's fields (numbers, text, booleans, dates, durations,
  lists, empty); errors are values (`#TYPE`, `#REF`, `#CYCLE`, `#DIV/0`, `#LIMIT`) shown in the
  cell with a reason, type errors at edit time with the position. One Rust engine (`oc-formula`)
  native in the server (exports, API, MCP, `search.json`, automation conditions) and WASM in the
  editor, loaded lazily; shared test vectors. Only the expression is stored; values are computed
  through a dependency graph. Limits: 4 KB, depth 64, a step budget per cell. Syntax chosen in the
  prototype (Q5).
- **Relations.** Row ids of a target database: same canvas `{dbId, rowIds}`, optionally two-way;
  across canvases only through a live block `{fileId, dbId, rowIds}` under the live file's ACL,
  "No access" otherwise, one-way (*stretch*).
- **Rollups.** Count, sum, average, min, max, earliest, latest, percent checked, unique; across
  canvases from the live projection (ADR-072) on refresh.
- **Virtualized databases.** Table rows and columns virtualized with a frozen first column; board
  lanes and cards virtualized; sort, filter and group in a Web Worker index built from Yjs events.
  Rows stay one `Y.Map` each (format v1); if MEM shows 100k × 30 cannot fit, packed rows get their
  own ADR first.
- **Acceptance.** DB-A1 ≥ 500 formula vectors identical natively and in WASM; DB-A2 a three-field
  cycle shows `#CYCLE` and recovers; DB-A3 relations and rollups update in another client
  < 250 ms, a reader without access sees "No access"; DB-A4 **100,000 rows × 30 fields at 60 fps**
  (p95 frame ≤ 16.7 ms over a 10 s scripted scroll and while editing every 500 ms) in table view
  and DB-A5 in board view (100,000 cards, 6 lanes), both a benchmark scenario (`DB100K`); DB-A6
  computed values in exports, API, MCP and `search.json`, 0.3 round trip.

### 6.2 Integrations

| Item | Approach |
|---|---|
| Nextcloud Talk (TALK-01, *stretch*) | New prototype (§7): share a canvas into a conversation, open it beside the call, a temporary canvas per call (ADR-049 wording); Talk's public APIs only (integration points unverified); scripted run like NC-03 |
| Mattermost Marketplace (MM-03) | After the owner's trademark email is answered: listing copy with the LEGAL-01 line, manifest and support URLs, the Marketplace's review and signing steps (unverified) |
| Richer Matrix widget (MX-03, *stretch*) | Canvas pinned per room, mentions posted through the bridge, guest read-only, Element theme; a prototype only for screens beyond the approved MX ones |
| Rust client sync (RCL-01, *stretch*) | Realtime module in `oc-client`: room WebSocket with yrs, sync step 1/2, awareness optional; converges with the TypeScript client under the fuzz. Also usable as a benchmark load client |
| Generated MCP schemas (MCPS-01) | MCP input and output schemas generated from the tool-layer definitions; CI fails on drift |
| Conformance on every store (CONF-01) | Client conformance suite on MySQL 8.4, MariaDB 10.11 and Redis in CI |
| Nextcloud in CI (NC-04) | Nightly `integrations/nextcloud/test/e2e.sh` |
| Portable SDK blocks (PSDK-01..08) | ADR-075 accepted; if they do not ship in 0.3.1 the rows move here unchanged (≈ 5–6 weeks) |

### 6.3 UX refinement

| Item | Approach |
|---|---|
| Board toolbar at narrow widths and 200% (UX4-01) | SCALE-02 S3: prototype (§7) first; overflow into "More" by priority, toolbar and zoom pill in one row; reflow checks at 24 px root, 200% and 320 px |
| Embedded first-click caret (UX4-02) | In `<open-canvas>` the first click focuses the frame but places no caret: reproduce in Playwright in an embed (seen failing), then place the caret from the click on focus |
| SCALE-02 leftovers (UX4-03) | S2 stored column widths in px; database tabs under the toolbar at 24 px with comments open; S7 `aria-multiselectable`; S8 text spacing, 400% and reflow checks |
| Offline concurrent delete (UX4-04) | OFF-08 known limit: text written offline in a block someone else deletes offline and sends later is lost with no summary. The merge compares the unsent log with remotely deleted blocks; the summary says "Your text was in a block someone deleted" with Restore |
| v0.3 known limitations (UX4-05) | docs/35 §3: `zf-offline` and `zf-offline-2` in WebKit, Firefox and the phone projects; decide automation with Redis-only storage (Q9) |

---

## 7. Prototypes needing owner approval (V4UI-01)

Same format as V3UI-01 (sticky bar, light and dark, fit and actual size, real-size frames with
notes, owner decisions at the top). Nothing under them is built before approval (ADR-011).

1. `large-tables.html`: partial-sync placeholders and loading states (main thrust), 100k-row table
   and board (scrollbar with a position label, frozen column, sticky group headers, worker
   "sorting…" states), phone.
2. `formulas-relations.html`: formula field editor (syntax, autocomplete, errors with position),
   error cells, relation picker (same canvas and live block), relation chips, rollup setup,
   "No access", phone.
3. `nextcloud-talk.html`: share to a conversation, canvas beside a call, temporary meeting canvas,
   guests, narrow Talk sidebar.
4. `board-toolbar.html`: board and diagram toolbar at 1440, 768 and 320 px and at 200% / 24 px
   root, with and without the side panel; overflow order.

Optional: `matrix-widget.html` if MX-03 needs screens the approved Matrix prototype lacks. The
Benchmarks site page follows the site's existing page design and needs no prototype.

## 8. ADRs (Proposed, docs/08)

- **ADR-076** Partial sync: heavy blocks as Yjs subdocuments on one multiplexed socket, loaded on
  view, role-checked per request, flattened to format v1 on save, `caps=subdoc` with 4426 for
  older editors, offline loads all.
- **ADR-077** Room fan-out and presence at scale: 100 ms client throttle; one merged awareness frame
  per peer per tick; updates merged and encoded once; fan-out shards per core with per-peer order;
  reduced presence outside the reader's view above 200 peers; the cap stays 550 until the gates pass.
- **ADR-078** Formula engine, relations and rollups: one typed Rust engine (native and WASM),
  errors as values, expressions stored and values computed, limits; relations same canvas or
  through live blocks under the live file's ACL; rollups, cross-canvas on refresh.
- **ADR-079** Benchmark program and performance budgets in CI: scenario files with load mixes,
  results as JSON with hardware, PR gates (initial JS stepping to 220 KB with forbidden modules,
  heap per fixture, first screen), nightly server gates against the last seven runs, weekly full
  runs on a reference machine, published results that always state hardware and mix.

## 9. Delivery

Rows are in docs/10 §P3 v0.4. Dependencies:

```
V4UI-01 (prototypes, now) ─► gates every * row
BENCH-01 ─► BENCH-03 ─► BENCH-04 ; BENCH-02 ; BENCH-05
PSYNC-01 (ADR-076) ─► PSYNC-02 ─► PSYNC-03* ─► PSYNC-04
BENCH-01 ─► PERF-11, PERF-12 ─► PERF-13 ─► PERF-14, PERF-15 ─► PERF-16 (cap)
BENCH-03 ─► MEM-02 ; LAZY-01
RLB-05, RLB-04 first (green CI) ; RLB-01, RLB-02 with PERF-14 ; RLB-03, RLB-07, RLB-08
SEC-V4 after the surfaces freeze ─► SEC-V4F ; ACC-V4 alongside ; REL-06 last
§6 rows: DB4-01 ─► DB4-02 ─► DB4-03* ; DB4-04* ─► DB4-05, DB4-06 ; DB4-09 ─► DB4-07*, DB4-08*
```

| Row | Item | Size | Workstream |
|---|---|---|---|
| V4UI-01 | Prototypes §7, owner approval | M | Prototypes |
| PSYNC-01 | Spike and ADR-076: subdocuments vs projection, measured on the 50 MB fixture | M | Partial sync |
| PSYNC-02 | Server: subdocuments, multiplexed sync, per-request role check, WAL per document, lazy load and evict, flatten on save | L | Partial sync |
| PSYNC-03 | Editor: load on view, placeholders to the prototype, unload, undo across documents, offline loads all | L | Partial sync |
| PSYNC-04 | Compatibility: `caps=subdoc`, 4426, 0.3 round trip, API/MCP/exports/search unchanged, PSYNC-A1..A6 | M | Partial sync |
| BENCH-01 | `scripts/bench/`: scenario files, several source addresses, probe latency, faults, JSON results with hardware; docs/22 scenarios moved; fixture generator | L | Benchmark |
| BENCH-02 | Scheduled CI job (nightly quick runs on four stores) and the weekly full run on the reference machine | M | Benchmark |
| BENCH-03 | Browser benchmarks: first screen, heap per fixture (baseline now), initial JS, long frames | M | Benchmark |
| BENCH-04 | Regression gates: PR budgets (`bench/budgets.toml`, `--forbid`), nightly comparison, issue on failure (ADR-079) | M | Benchmark |
| BENCH-05 | Benchmarks page on the site from `bench/results/` with hardware and mix; docs/22 summary | M | Benchmark |
| PERF-11 | Connection and room footprint, idle-viewer path, reconnect storm control, fd limits (X10K, STORM) | M | Performance |
| PERF-12 | Presence throttling and per-tick merged awareness (ADR-077) | M | Performance |
| PERF-13 | Encode once and fan-out shards across cores; relayed peers once per node (ADR-077) | L | Performance |
| PERF-14 | Full X10K and STORM runs passing, published | M | Performance |
| PERF-15 | Full R1K run passing, published | M | Performance |
| PERF-16 | Cap raise to 1,000 (`MAX_PEERS`, docs/22 §4, docs/13) after the gates | S | Performance |
| MEM-02 | Browser heap reductions to −40% on L | L | Performance |
| LAZY-01 | Advanced modules behind `import()`, initial JS 300 → 220 KB | M | Performance |
| RLB-01 | Single-node crash drills (SQLite, MySQL), reduced drill nightly | M | Maturity |
| RLB-02 | Cluster failover drills (owner, Redis, DB primary, partition) | M | Maturity |
| RLB-03 | Backup and restore runbook, `restore-drill.sh`, restore epoch | L | Maturity |
| RLB-04 | Flaky-test elimination, quarantine policy, repeat-each job | L | Maturity |
| RLB-05 | MySQL `storage_conformance` parallel failures; CI job on MySQL, MariaDB, Redis | S | Maturity |
| RLB-06 | SOAK (8 h at the X10K mix) before the release | M | Maturity |
| RLB-07 | Metrics, dashboard and alerts for fan-out, presence, reconnects, subdocuments | M | Maturity |
| RLB-08 | Rolling upgrade and downgrade drill 0.3 ↔ 0.4 under load | M | Maturity |
| SEC-V4 | Security audit of v0.3 and v0.4 surfaces (docs/18 §7) | L | Maturity |
| SEC-V4F | Fixes for the audit findings, each with a test | M | Maturity |
| DEP-01 | Dependency audit, SBOM, update policy | S | Maturity |
| ACC-V4 | docs/23 rows PSYNC-A*, BENCH-A*, scenario rows, RLB-A*, DB-A* | S | Maturity |
| DB4-01 | `oc-formula`: parser, types, evaluator, errors, limits, test vectors (ADR-078) | L | Also: databases |
| DB4-02 | WASM build in the editor (lazy), native/WASM parity | M | Also: databases |
| DB4-03 | Formula field UI to the prototype | M | Also: databases |
| DB4-04 | Relations in one canvas: model, MOD-01, two-way, UI to the prototype | L | Also: databases |
| DB4-05 | Relations across canvases through live blocks, "No access" (stretch) | M | Also: databases |
| DB4-06 | Rollups (in canvas; across canvases on refresh) | M | Also: databases |
| DB4-07 | Virtualized table view to the prototype (DB100K) | L | Also: databases |
| DB4-08 | Virtualized board view to the prototype (DB100K) | M | Also: databases |
| DB4-09 | Worker index for sort, filter and group | M | Also: databases |
| DB4-10 | Computed values in exports, API, MCP, `search.json`, automation conditions | S | Also: databases |
| TALK-01 | Nextcloud Talk integration to the prototype, scripted run (stretch) | L | Also: integrations |
| MM-03 | Mattermost Marketplace readiness (after the trademark reply) | M | Also: integrations |
| MX-03 | Richer Matrix widget (stretch) | M | Also: integrations |
| RCL-01 | Rust client realtime sync (yrs) and conformance (stretch) | L | Also: integrations |
| MCPS-01 | Generated MCP schemas with a drift check | M | Also: integrations |
| CONF-01 | Client conformance on MySQL, MariaDB and Redis in CI | S | Also: integrations |
| NC-04 | Nightly Nextcloud integration job | S | Also: integrations |
| UX4-01 | Board toolbar at narrow widths and 200% to the prototype | M | Also: UX |
| UX4-02 | Embedded first-click caret | S | Also: UX |
| UX4-03 | SCALE-02 leftovers (S2 widths, tabs, S7, S8 checks) | M | Also: UX |
| UX4-04 | Offline concurrent delete: summary item and Restore | M | Also: UX |
| UX4-05 | v0.3 known limitations: offline in WebKit/Firefox/phone, Redis-only automation decision | M | Also: UX |
| REL-06 | v0.4.0 scope lock, audit sign-off, release notes, published benchmark results | M | Release |

Rough total: 13 L + 32 M + 8 S ≈ 65–70 engineer-weeks (L ≈ 2.5, M ≈ 1, S ≈ 0.4 weeks), of which
≈ 7 is stretch; plus PSDK-01..08 (≈ 5–6) if they do not ship in 0.3.1. Main thrust (partial sync,
benchmark, performance) ≈ 24, maturity ≈ 15, also in v0.4 ≈ 20 committed + 7 stretch.

**Recommended order.**

1. **Now:** V4UI-01 to the owner (large-tables first, it carries the partial-sync placeholders);
   RLB-05 and RLB-04 (CI must be green before numbers mean anything); BENCH-01 and BENCH-03 (the
   baselines); PSYNC-01 spike.
2. **Track A (main thrust, always busy):** PSYNC-02 → PSYNC-03 → PSYNC-04, with BENCH-04/02 as soon
   as the baselines exist; then PERF-11 → PERF-12 → PERF-13 → PERF-14/15; MEM-02 and LAZY-01 in the
   gaps.
3. **Track B (maturity first):** RLB-01/02 alongside the first full X10K runs, RLB-03, RLB-07,
   then §6 rows (DB4-01/02/09 need no UI; after approval DB4-07/08, DB4-03/04/06, UX4-01 and the
   small UX rows); integrations last.
4. SEC-V4 once partial sync is merged, then SEC-V4F, RLB-06 (SOAK), RLB-08, BENCH-05, ACC-V4.
5. PERF-16 (cap raise) only after X10K, R1K, SOAK and RLB-A1..A3 pass.
6. REL-06. If partial sync is not proven in time it ships behind `[host.flags] partial_sync`
   marked preview; the release waits for the benchmark gates, not for §6.

## 10. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Subdocuments and y-prosemirror (undo, node views, offline) cost more than sized | Partial sync slips; memory target missed | PSYNC-01 spike first; fallback databases only; feature flag |
| No dedicated reference machine | Full runs noisy or not reproducible | Q1; until then full runs on one named cloud instance type with the generators on others, stated in every result |
| Benchmark gates flaky on shared CI runners | Gates ignored | Quick runs compare to the median of seven, budgets with margins; only the weekly reference run publishes numbers |
| Load generation needs more than one machine | 10k runs slow to set up | BENCH-01 supports several addresses and machines from the start |
| Fan-out shards break per-peer order or back-pressure | Divergent or stuck clients | One shard per peer; convergence check in R1K; fuzz |
| 100k × 30 rows as one `Y.Map` per row exceed the heap budget | DB-A4 or MEM fails | Measured in BENCH-03 early; packed rows get their own ADR |
| Talk and the Marketplace depend on outside parties | Rows block | Not release gates; stretch or blocked rows |
| Restore hazards (revocation, idempotency, schedules) | Security regression after a restore | Restore epoch in RLB-03; audited in SEC-V4 |

## 11. Questions for the owner

1. Reference machine for the weekly full runs: a dedicated 4 vCPU / 8 GB server (who provides
   it), or a named cloud instance type rented per run?
2. Partial sync with older editors: close 0.3 editors with 4426 on split documents (plan), or
   serve them a flattened view at extra server cost?
3. Presence above 200 peers: reduce the rate of cursors outside the reader's view (plan), or show
   only the N nearest people?
4. After the gates pass, does `MAX_PEERS` default to 1,000, or stay 550 with 1,000 as a configured
   maximum?
5. Formula syntax: spreadsheet-style `[Field]` or function-style `prop("Field")`? (decided in the
   prototype)
6. Publish benchmark results on the public site from the first full run, or only from the release?
7. Memory budgets gated in Chromium only (CDP), with Firefox and WebKit measured but not gated?
8. The 60 fps reference for DB100K: the CI runner class and which named mid laptop?
9. Automation with Redis-only storage: support it in v0.4, or keep the refusal as permanent?
10. The 10k run: TLS terminated by a proxy on another machine (plan), or on the same 4 vCPU node?
