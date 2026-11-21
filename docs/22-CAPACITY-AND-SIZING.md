# 22 — Capacity and sizing

**Status:** first measurement, 2026-11-22 (PERF-01); worst case, crash recovery and cluster
correctness added the same day (PERF-02, §8–§13; read §8's weaknesses before sizing a cluster). Laptop numbers: indicative, not a guarantee.
Rerun on your own hardware with `scripts/bench.sh` (below).

## 1. Machine and method

- **Machine:** Apple M4, 10 cores, 16 GB RAM, macOS 26.3. The server, the load generator and the
  mock host all ran on this one machine, over loopback. The load generator used up to 2.2 cores
  (one room of 550) and 0.6 cores (5,000 connections) next to the server, so the server never had
  the machine to itself.
- **Server:** `opencanvas` release build from main (`7e2de05`), SQLite (`DATABASE_URL=sqlite://…`),
  `OC_KEK` set, `OC_LOG=info`, default limits and autosave (2 s debounce, 10 s max).
- **Load generator:** `crates/oc-bench` (Rust, tokio, tokio-tungstenite, yrs). For each virtual
  user it mints an HS256 launch token for a `bench` host, `POST /v1/launch`, `GET /v1/sessions/<ticket>`
  and opens `/v1/collab/<room>`, like the SPA. The `bench` host's load and save callbacks are served
  by a mock inside the load generator that answers at once, so the host never limits a run.
- **Behaviour:** editors type 3–6 chars/s in bursts of 3–10 s with about 60 % duty, move their
  caret (awareness), and on about 6 % of keystrokes edit a database cell and on 2 % drag a board
  shape (10 moves at 20 Hz). Like the editor, each client sends at most one update frame and one
  awareness frame per 50 ms window. Viewers only receive. Mix: 20 % editors / 80 % viewers.
- **Document:** a Rust rebuild of the "Sprint 42 planning" demo canvas (same blocks, the 7-row
  database, a 12-shape board, one comment thread, a 40 KB inline image): **49 KB** encoded Yjs
  state. `big` adds a 1,000-row database and a 500-shape board: **408 KB** (`oc-bench sizes`).
- **Latency:** every update frame an editor sends is logged by (client id, start clock, time);
  probe clients (4–10 per room) decode each update they receive and look it up. The figure is
  editor frame sent → peer received: server apply, WAL append, fan-out and both sockets. The
  client's own ≤ 50 ms batching window comes on top.
- **Server resources:** `ps` (RSS, CPU time → CPU %, threads), `lsof` (open fds) and `/metrics`
  once per step. CPU % is per core: 100 % = one core busy. Each step ramps clients in, waits 5 s,
  then measures for 60 s (scenario C: 5 s).

## 2. Results

### A. One big room (demo doc, 20 % editors, ramp to the 550 cap)

| clients | editors | p50 ms | p95 ms | p99 ms | server CPU % | RSS MB | fds | updates/s in | frames/s out | MB/s out |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 2 | 0.5 | 5.8 | 10.3 | 0 | 17 | 35 | 7 | 121 | 0.02 |
| 50 | 10 | 0.3 | 0.7 | 1.1 | 2 | 26 | 75 | 32 | 3,049 | 0.55 |
| 100 | 20 | 1.0 | 2.2 | 3.4 | 13 | 37 | 125 | 61 | 11,859 | 2.19 |
| 200 | 40 | 2.1 | 5.2 | 7.1 | 47 | 63 | 225 | 122 | 47,148 | 8.75 |
| 350 | 70 | 1.5 | 3.7 | 4.5 | 73 | 112 | 375 | 207 | 140,878 | 26.61 |
| 550 | 110 | 2.8 | 6.8 | 9.9 | 177 | 193 | 576 | 322 | 345,255 | 65.15 |

No errors, no disconnects, connect (launch → `role`) p95 12 ms at 550. The p95 never came near the
150 ms PRD target; the room cap (550, `MAX_PEERS`) was reached first. Cost grows with the square
of the room size (every editor's frames go to every peer): at 550 the server sends 345,255 frames/s
and 65 MB/s, and uses 1.8 cores.

### B. Many small rooms (5 users per room, demo doc, 20 % editors)

| connections | rooms | p50 ms | p95 ms | p99 ms | max ms | server CPU % | RSS MB | fds | updates/s in | MB/s out | saves/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 500 | 100 | 0.4 | 4.2 | 10.5 | 41 | 22 | 142 | 534 | 293 | 0.42 | 9.5 |
| 1,000 | 200 | 0.4 | 4.3 | 10.9 | 114 | 42 | 268 | 1,034 | 595 | 0.88 | 18.7 |
| 2,000 | 400 | 1.1 | 10.2 | 23.1 | 243 | 73 | 519 | 2,036 | 1,176 | 1.75 | 37.0 |
| 5,000 | 1,000 | 0.8 | 9.3 | 24.0 | 760 | 91 | 1,217 | 5,042 | 2,992 | 4.46 | 93.0 |

No errors, no disconnects, no save errors; 11,028 autosaves reached the host (598 MB in total).
Autosave lag (oldest unsaved edit → PUT at the host) p50 8.3 s, p95 10.2 s: under continuous typing
rooms save on the 10 s `OC_AUTOSAVE_MAX_MS`, as designed. No knee up to 5,000 connections:
p95 stayed ≤ 10.2 ms and CPU under one core. Memory grew linearly (about 0.24 MB per connection
with this document) and is what runs out first. 10,000 connections were not run (timebox); by the
linear memory slope that would need about 2.4 GB (extrapolated, not measured).

### C. Idle memory (no edits)

One idle viewer per room, 1 → 400 rooms, then idle viewers spread over 100 demo rooms.

| run | RSS at 1 | RSS at 400 rooms | per room (incl. 1 connection) |
|---|---|---|---|
| empty doc | 12.4 MB | 76.3 MB | 0.16 MB |
| demo doc (49 KB) | 13.6 MB | 174.2 MB | 0.40 MB |
| big doc (408 KB) | 25.3 MB | 2,334.8 MB | 5.79 MB |

| idle viewers over 100 demo rooms | 100 | 1,000 | 2,000 | 4,000 |
|---|---|---|---|---|
| RSS MB | 53.8 | 235.5 | 436.7 | 840.5 |

- **Per connection:** (840.5 − 235.5) / 3,000 = **0.20 MB** per idle connection.
- **Per room:** about **5× the encoded document** for a text-heavy doc (demo: 0.40 − 0.16 = 0.24 MB
  for 49 KB) and about **14×** for a database/board-heavy one (big: 5.79 MB for 408 KB). An empty
  room plus its connection costs 0.16 MB.
- Idle process: 10 MB RSS, 15 threads (tokio uses one worker per core; threads stayed at 15–19 in
  every run).

## 3. What limits first

1. **Memory**, in many-room deployments: about 0.2 MB per connection plus 5–14× the document per
   open room. Rooms stay in memory for `OC_ROOM_TTL_SECS` (600 s) after the last client leaves.
2. **Fan-out CPU and bandwidth**, in big rooms: frames out = (editor updates + awareness) × peers.
   A 550-user room with 110 typing editors took 1.8 cores and 65 MB/s (520 Mbit/s).
3. **File descriptors:** one per connection plus 25–45 (measured fds = connections + 25 to 42).
   Set `ulimit -n` (or the container's `nofile`) above the connection target.
4. **The per-room actor** (one task per room applies, logs and fans out every update in order) did
   not limit anything measured: p95 6.8 ms at 550 peers.
5. **Latency** stayed far under the 150 ms target everywhere (worst p95 10.2 ms, worst p99 24 ms).
   Rare outliers grew with load (max 760 ms at 5,000 connections); not investigated yet.

Not limiting on this machine: threads, the 550 room cap's own overhead, SQLite (B wrote about
3,000 WAL rows/s with no errors; see §6 for what was not measured).

## 4. Sizing for self-hosters

In short: up to 1,000 concurrent users on 1 vCPU and 512 MB; up to 5,000 on 2 vCPU and 2 GB;
beyond 5,000, cluster mode.

Rules of thumb (keep ≤ 60 % of what was measured):

- **Memory** ≈ 50 MB base + **0.25 MB per concurrent user** + **5–14× the document size per open room**.
- **CPU** ≈ one core per 5,000 users in small rooms (20 % typing); one big room of 550 needs about
  2 cores on its own (measured 1.8).
- **Bandwidth out** ≈ 1.1 KB/s per typing editor per peer in the room (B: 4.46 MB/s for 1,000 editors
  with 4 peers each; A: 65 MB/s for 110 editors with 549 peers each).

| Concurrent users (small rooms, demo-size docs) | Node | Basis |
|---|---|---|
| up to 1,000 | 1 vCPU, 512 MB, SQLite | measured 1,000: 0.42 core, 268 MB |
| up to 3,000 | 2 vCPU, 1.5 GB, SQLite | interpolated between the 2,000 (0.73 core, 519 MB) and 5,000 steps |
| up to 5,000 | 2 vCPU, 2 GB, SQLite | measured 5,000: 0.91 core, 1,217 MB (61 % of 2 GB) |
| beyond 5,000 | cluster mode (MariaDB + Redis), one node per 5,000 users | **not measured**: single-node runs stopped at 5,000; cluster scale-out (E) not run yet |
| one room at the 550 cap, 20 % typing | 3 vCPU, 512 MB, ≥ 600 Mbit/s | measured 1.8 cores, 193 MB, 65 MB/s |

Large documents move the memory line: with 400 KB databases/boards per room, budget about 6 MB per
open room (C). **Maximum users in one room is 550** (`MAX_PEERS`, every role counts); the latency
curve up to it is table A.

**Database:** SQLite holds only transient state (sessions, WAL tail, snapshots, outbox); the size
under sustained typing was not measured in this round (scenario D below).

## 5. Rerun on your hardware

```sh
scripts/bench.sh            # quick check, about 3 minutes
scripts/bench.sh A          # one big room;  B: many small rooms;  C: idle memory
B_STEPS=500,1000,2000,5000,10000 scripts/bench.sh B
OUT=/tmp/oc-bench scripts/bench.sh A,B,C
```

The script raises `ulimit -n` to the OS limit (macOS: `kern.maxfilesperproc`, 61,440 here; the
loopback ephemeral port range of 16,384 ports also caps one load generator at about 16,000 sockets),
starts its own server on 127.0.0.1:8701 and the mock host on :8702, and writes a JSON and a
Markdown table per scenario to `target/bench/`. Run the load generator on another machine for
numbers that do not share CPU with it (`oc-bench run --server http://<host>:8080 --host-port 0`, with
the server's hosts file pointing `bench` at a mock you run next to it).

## 6. Not measured yet

| Scenario | Command |
|---|---|
| D. Autosave/WAL pressure: 200 rooms × 2 editors typing for 120 s; WAL rows/bytes, DB size | `scripts/bench.sh D` |
| MariaDB repeat of A, B and D (Docker `mariadb:10.11` on :8733, removed afterwards) | `scripts/bench.sh mA,mB,mD` |
| E. Cluster mode: 3 nodes (MariaDB + Redis in Docker), B's load hashed by room | `scripts/bench.sh E` |
| B at 7,500 and 10,000 connections | `B_STEPS=5000,7500,10000 scripts/bench.sh B` |

On one laptop E shows relay and lease overhead and how load spreads, not real scale-out: all three
nodes share the same cores.

## 7. Findings for the server

### Fixed 2026-11-22 (branch `perf-revocation-fanout`)

Measured on the same M4 laptop, but **not idle**: another session was running Docker cluster
benchmarks (load average 14–22 on 10 cores), so CPU and latency below are noisy. Every number
comes from `oc-bench` with the same arguments as §2, run back to back against a release build
of main (`79fa518`) and of the branch, on ports 8901/8902.

- **Memory per idle connection: 0.20 → 0.087 MB (−57 %).** Root cause: tungstenite's read
  buffer. Its default `read_buffer_size` is 128 KiB and the codec zero-fills the buffer up to
  its capacity on the first read (`FrameCodec::read_in`: `in_buffer.resize(capacity, 0)`), so
  every connection kept 128 KiB resident. `routes::collab::ws_config` now sets an 8 KiB read
  buffer on client sockets and the cluster relay (a larger frame still grows the buffer, up to
  the frame limit). Guard: `collab::tests::websocket_read_buffer_stays_small`.

  | scenario C, idle viewers over 100 demo rooms | RSS at 1,000 | RSS at 4,000 | MB per connection |
  |---|---|---|---|
  | main | 237 MB | 848 MB | 0.204 |
  | read buffer 8 KiB | 122 MB | 386 MB | 0.088 |
  | branch (read buffer + shared fan-out) | 120 MB | 381 MB | 0.087 |
  | branch, empty doc | 38 MB | 116 MB | 0.026 |

  **Left:** the rest scales with the document (0.087 MB with the 49 KB demo doc, 0.026 MB with an
  empty one). Likely cause, not verified with a heap profile: tungstenite's write buffer (`out_buffer`,
  a `Vec` that never shrinks) keeps the capacity of the largest frame sent, which is the
  initial sync step 2 (the whole document). The WebSocket config has no setting for this, so a fix
  would mean sending the initial state in chunks or a patched writer.
- **Fan-out shares one buffer.** `Outbound::Frame` now carries `bytes::Bytes`; `broadcast`
  clones a reference per peer instead of `to_vec()` per peer, and the relay forwards the owner's
  frames without a copy. Wire format unchanged. Test: `tests/rooms.rs`
  `fan_out_shares_one_buffer_between_peers` (two viewers get the same allocation; failed on main).
  Scenario A at 550 (20 % editors, 60 s), one step:

  | build | p50 ms | p95 ms | p99 ms | server CPU % | RSS MB | frames/s out |
  |---|---|---|---|---|---|---|
  | main, run 1 | 19.1 | 1,057.6 | 1,571.0 | 151 | 152 | 331,621 |
  | main, run 2 | 8.1 | 16.6 | 22.4 | 178 | 148 | 340,336 |
  | read buffer only | 4.1 | 7.5 | 10.3 | 195 | 82 | 340,327 |
  | branch, run 1 | 8.1 | 22.2 | 33.8 | 166 | 79 | 340,566 |
  | branch, run 2 | 9.3 | 21.1 | 32.4 | 176 | 78 | 340,955 |

  **No measurable CPU or latency gain from the shared buffer** on this loaded machine: CPU
  differs by less than the run-to-run spread (151–195 %), and p95 moves with the background
  load, not with the build (main's first run hit 1 s). The RSS drop at 550 (150 → 79 MB) comes
  from the read buffer. The change stays because it removes ~340,000 allocations and copies per
  second at the cap; rerun A on an idle machine to see whether it shows.
- **Revocation in a cluster** (docs/21 note 3): the members cache and revoke set are still per
  node, but every revoke, restore and invalidate is now published on Redis pub/sub
  (`oc:members`, HMAC-signed) and applied by every node within a second. Tests:
  `tests/cluster.rs` `revoke_on_one_node_reaches_every_node` (+ `…_over_redis` with
  `OC_TEST_REDIS_URL`).

### Still open

- **Room memory is 5–14× the document**, not the "~3× doc size" in docs/03 §5.3; docs/03's 300-room
  estimate is low for database/board-heavy documents.
- **`/metrics` lists fewer series than docs/13 says.** The server exports `oc_rooms_active`,
  `oc_connections_active`, `oc_launches_total`, `oc_updates_total`, `oc_saves_total` and a few error
  counters; `oc_update_apply_seconds`, `oc_fanout_bytes_total`, `oc_commit_seconds`,
  `oc_host_callback_seconds`, `oc_wal_bytes` and `oc_room_doc_bytes` do not exist yet, so save
  latency here was measured at the mock host.
- **§2–§4 still show main's numbers** (0.20 MB per connection). With the read-buffer fix the
  per-user memory rule of thumb in §4 is conservative; update it after a clean rerun of B and C.
## 8. Worst case, crash recovery and cluster correctness (PERF-02, 2026-11-22)

Same machine as §1 (Apple M4, 10 cores, 16 GB, macOS 26.3); server from main at `55c969f`,
release build. MariaDB 10.11 and Redis 7 ran in Docker Desktop on the same laptop. Every result
below is from a real run; raw JSON and Markdown are written to `target/bench/` by the commands in
§13. Server source was not changed: bugs are reported with the command that reproduces them.

### Weaknesses found

1. **A room of 550 with everyone typing cannot keep up (S1).** The room actor spends 85 % of its
   time in `on_awareness` → `fan_out_awareness` → `rewrite_for`, which parses and re-serialises
   each awareness JSON once per peer. It applies about 290 updates/s against about 2,500 offered:
   latency grows by about 0.9 s every second (p95 638 s after 12 minutes), RSS grows about
   70 MB/min, and autosave stalls (2 host saves in 12 minutes).
2. **The single-node SQLite WAL path tops out at about 5,900 appends/s, then degrades (S2).** At
   1,000 rooms × 5 with everyone typing (13,300 updates/s offered), 90 % of SQLite time was in
   `sqliteDefaultBusyCallback` sleeping on the writer lock (8 pooled connections). Throughput
   fell to about 2,000/s after 6 minutes, p95 reached 521 s, autosave lag p95 255 s.
3. **A frozen node writes after it lost its rooms: two writers per room (K2).** After a 20 s
   `SIGSTOP` (longer than the 15 s lease), the resumed node appended WAL rows for 20 rooms that
   another node had claimed, until its 5 s renewal noticed. There is no fencing token. Both nodes
   then failed WAL appends with `Duplicate entry` on `(room_id, seq)` (986 + 1,539 errors over
   31 s).
4. **A failed WAL append still acknowledges the update.** `Room::accepted` logs `WAL append failed`
   and fans the update out anyway (`crates/oc-server/src/room/actor.rs`, `accepted`). Peers see the
   edit, but it is not durable until the next compaction or save. In K2 this lasted 25 s for 20
   rooms. No acknowledged edit was lost in these runs only because clients resent their state.
5. **MariaDB deadlocks (1213) are not retried.** After a restart with many recovered rooms
   (mR) and during cluster chaos (K), these failed with `Deadlock found … try restarting
   transaction`: `compaction failed` (35), `writing the commit outbox failed`, `marking commit done
   failed`, and `room load failed`. The server logs them and moves on. An outbox row that is never
   written or never marked done weakens the outbox's crash guarantee.
6. **MariaDB runs are sensitive to the database's own state.** The same 1-node load gave p95
   1.9 s at 1,000 connections right after the K2 cluster run on the same container (database
   dropped and recreated), and p95 9 ms on a fresh container (§12). After a crash, rooms reopen
   about 10× slower than on SQLite (p95 533 ms vs 59 ms, WAL replay plus row reads over the Docker
   network). This setup (Docker Desktop on macOS) is not a production database; the server has no
   metric for WAL append latency (`oc_commit_seconds` in docs/13 does not exist yet), so an
   operator cannot see this happening.
7. **A draining node accepts WebSocket upgrades and then closes them** (`join failed: server is
   draining`, 8,760 in about 10 s on one node in K). Clients that reconnect to the same address
   loop until a load balancer removes the node.
8. **Three nodes held less load than one on this laptop (T).** With a room's clients spread
   over the nodes, 3 nodes hit p95 9.8 s at 5,000 connections, where 1 node held p95 8.9 ms. The
   same thing happened in two separate runs. It is not CPU-bound and not root-caused (§12).
9. **Minor:** after an owner moved, relayed peers of the 550 room were refused with `room full`
   (435 times), apparently because old slots still counted. Not root-caused. In the load
   generator, two of 550 clients in one room never got `role` (connect p95 90 s under S1's
   overload).

### Summary

| run | what | criterion | result |
|---|---|---|---|
| S1 | 1 room × 550, 100 % editors, no pauses, 12 min, SQLite | p95 ≤ 150 ms every bucket; RSS flat; host save ≤ 30 s; 0 errors | **FAIL**: p95 156 s → 638 s; RSS 299 → 929 MB; 2 saves in 12 min; 0 errors |
| S2 | 1,000 rooms × 5, 100 % editors, no pauses, 10 min, SQLite | same | **FAIL**: p95 57 s → 521 s; autosave lag p95 255 s; 0 errors, 0 drops |
| R | `kill -9` during typing, 200 rooms × 2, SQLite | 0 acked lost; converge; server = clients; first save after restart complete | **PASS**: 0 / 38,756 lost; ready in 28 ms; 200 rooms replayed in 234 ms |
| mR | same on MariaDB | same | **PASS** (0 / 35,196 lost; replay 2.2 s); 38 deadlock errors logged |
| K | 3 nodes under load: `kill -9` owner, rolling restart | 0 acked lost; converge; no two writers | **PASS**: 0 / 93,374 lost, resync max 20.5 s |
| K2 | Redis killed (keys lost) | same | **PASS**: 0 lost, resync max 2.4 s, no two writers |
| K2 | one node frozen 20 s | same | **FAIL**: two writers on 20 rooms (2,525 duplicate-key WAL errors); 0 / 68,389 acked lost |
| T | 1 node vs 3 nodes, rooms spread over nodes, host 20–50 ms | most connections / updates/s at p95 ≤ 150 ms | 1 node: 5,000 / 3,000 per s; 3 nodes: 2,500 / 1,460 per s (failed at 5,000). Relay: p95 +1.2 ms, CPU +35 %, RSS +62 % |

## 9. Sustained editing at the cap

### 9.1 S1: one room of 550, every client typing with no pauses — **FAIL**

`scripts/bench.sh S1`: 550 clients in one room, all editors, typing 3–6 chars/s with no burst
pauses (`--editors 1.0 --no-pauses`), demo doc, 10 probes. Planned as 10 one-minute buckets; each
bucket here took about 3 minutes, because two of the 550 clients never got their `role` and the load
generator waited 120 s for them before every bucket (fixed afterwards: a repeated step no longer
waits). The clients typed without a break for **12 minutes** (00:49–01:02); the run was stopped
after the fourth bucket because the trend was already unambiguous. The load generator's JSON is
written only at the end, so per-bucket max latency was not kept; p99 is within 1 % of it here.

| bucket (end) | p50 ms | p95 ms | p99 ms | samples | srv CPU % | RSS MB | upd/s applied | frames/s out | MB/s out | err | drop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 (≈3 min) | 132,243 | 155,793 | 158,165 | 158,880 | 294 | 299 | 289 | 307,815 | 57.8 | 0 | 0 |
| 2 (≈6 min) | 291,459 | 316,756 | 319,036 | 151,750 | 281 | 394 | 276 | 296,023 | 56.8 | 0 | 0 |
| 3 (≈9 min) | 453,776 | 478,550 | 480,550 | 145,486 | 284 | 661 | 265 | 282,796 | 54.3 | 0 | 0 |
| 4 (≈12 min) | 616,470 | 637,803 | 639,728 | 171,822 | 328 | 929 | 339 | 362,342 | 69.7 | 0 | 0 |

- **Latency grows without bound:** +160 s per 3 minutes, i.e. the room falls behind by about 0.9 s
  every second. Clients offer about 2,500 update frames/s plus as many awareness frames; the
  room applies about 290 updates/s.
- **RSS grows with the backlog** (299 → 929 MB in 9 minutes, ≈ 70 MB/min): queued frames, not a
  leak in the steady state sense, but unbounded.
- **Autosave starved:** `oc_saves_total` was **2** after 12 minutes of typing (target: one save per
  ≤ 10 s). Nothing is lost (the WAL holds every applied update), but the host's file was 12
  minutes stale and the lag was still growing.
- **WAL and compaction were fine:** `room_updates` stayed between 25 and 578 rows (≤ 19 KB)
  through the run; the snapshot grew with the document (0.17 → 1.43 MB); SQLite file 2.7 MB,
  `-wal` file 5.3 MB. No server warnings or errors, no disconnects.
- **Root cause (profiled with macOS `sample`, 3 s, bucket 1):** the room actor task was busy 83 %
  of one core; 85 % of that was `Room::on_awareness` → `fan_out_awareness` → `rewrite_for`, which
  clones each awareness update and parses and re-serialises its JSON **once per peer** (plus
  `on_awareness` rebuilds a set over all peers' client ids per frame). At 550 typing clients that is
  about 2,500 awareness frames/s × 549 peers ≈ 1.4 M JSON parses/s on one task. Yjs update
  apply, the WAL append and update fan-out were not the limit (`append` 40 of 1,920 samples).
  Server source was not changed (scope); see weaknesses.

Criteria: p95 ≤ 150 ms in every bucket, RSS growth < 10 % after the first bucket, a host save
at least every 30 s per room, 0 errors. Result: **FAIL** on latency, memory and autosave; PASS on
errors and WAL growth.

### 9.2 S2: 1,000 rooms × 5, every client typing with no pauses — **FAIL**

`scripts/bench.sh S2`: 5,000 connections, 1,000 rooms of 5, all editors, no pauses, demo doc,
SQLite, ten one-minute buckets (55 s measured + 5 s gap) after the ramp. The clients offered
**13,285 update frames/s** and 12,938 awareness frames/s (4.4× the update rate of PERF-01 B).

| min | p50 ms | p95 ms | p99 ms | max ms | samples | srv CPU % | RSS MB | upd/s applied | saves/s | MB/s out | DB MB | err | drop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 37,637 | 56,584 | 59,837 | 64,873 | 1,266,992 | 194 | 2,272 | 5,758 | 13.11 | 8.3 | 212 | 0 | 0 |
| 2 | 83,524 | 103,991 | 108,207 | 114,066 | 1,301,812 | 205 | 2,109 | 5,915 | 4.20 | 8.8 | 257 | 0 | 0 |
| 3 | 129,423 | 150,533 | 155,489 | 162,728 | 1,301,565 | 210 | 2,528 | 5,913 | 5.16 | 8.9 | 261 | 0 | 0 |
| 4 | 175,306 | 197,889 | 203,487 | 211,391 | 1,261,973 | 206 | 1,882 | 5,732 | 3.80 | 8.6 | 266 | 0 | 0 |
| 5 | 222,527 | 245,736 | 252,115 | 260,796 | 1,255,879 | 209 | 1,660 | 5,706 | 2.20 | 8.6 | 271 | 0 | 0 |
| 6 | 266,646 | 291,452 | 299,440 | 312,330 | 1,065,190 | 200 | 929 | 4,841 | 1.13 | 7.3 | 272 | 0 | 0 |
| 7 | 319,678 | 349,684 | 357,942 | 369,556 | 503,371 | 156 | 831 | 2,255 | 0.51 | 3.4 | 272 | 0 | 0 |
| 8 | 378,346 | 408,236 | 416,040 | 427,692 | 506,453 | 154 | 873 | 2,233 | 0.41 | 3.4 | 272 | 0 | 0 |
| 9 | 440,981 | 464,093 | 471,509 | 482,747 | 633,268 | 177 | 796 | 2,809 | 0.48 | 4.2 | 273 | 0 | 0 |
| 10 | 491,729 | 520,547 | 528,808 | 540,669 | 364,313 | 170 | 828 | 1,635 | 0.34 | 2.4 | 273 | 0 | 0 |

WAL (sampled every 2 minutes): `room_updates` 106,541 → 100,751 → 90,335 → 29,276 → 54,715 rows
(3.5 → 1.8 MB), 1,000 snapshots 52.8 → 66.7 MB; SQLite file 130 → 152 MB plus a 120 MB `-wal`
file (DB MB above = both). Host: 3,533 saves (203 MB); **autosave lag p50 30.5 s, p95 255 s, max
523 s**. 127 `slow statement` warnings (119 of them a single-row `INSERT INTO room_updates`, up
to 3.45 s). No errors, no disconnects.

- **The SQLite write path is the ceiling: about 5,900 WAL appends/s**, and it degrades to about
  2,000/s after 6 minutes. The server used only 1.5–2.1 cores of 10. A 3 s `sample` in bucket 3:
  of 14,309 samples inside `sqlite3_step` on the 8 `sqlx-sqlite-worker` threads, **12,820 (90 %)
  were in `sqliteDefaultBusyCallback` → `unixSleep`**: the 8 pooled connections queue on SQLite's
  single writer lock, and the busy handler sleeps instead of waiting in order. Each room actor
  awaits its WAL append before fanning out, so every room falls behind and latency grows without
  bound (≈ +50 s per minute).
- **Memory:** RSS peaked at 2.5 GB (backlog) and fell to 0.8 GB as throughput collapsed and the
  backlog moved into socket buffers; no steady state, so a leak check is not meaningful here.
- **Compaction kept up** (rows went down while typing continued); snapshots grow with the docs.

Criteria as S1. Result: **FAIL** (latency, autosave lag); PASS on errors, disconnects and WAL row
growth. Compare PERF-01 B: the same 5,000 connections at 20 % editors with pauses offered about
3,000 updates/s and stayed at p95 9.3 ms, so the single-node SQLite ceiling sits between 3,000
and 5,900 updates/s on this machine.

## 10. Crash recovery (`scripts/bench.sh R` / `mR`)

**Method.** `oc-bench verify`: 200 rooms × 2 editors (empty doc), each client appends a paragraph
holding a unique token every 250 ms (≈ 1,600 edits/s in all). A token counts as **acknowledged**
when the *other* client of the room holds it (the owner appends to the WAL before it fans out). At
25 s the harness records the acknowledged set, `kill -9`s the server and holds every client
offline; it then starts a new server on the same database, times `/readyz`, and opens one fresh
viewer per room **before any client reconnects** (so nothing can be re-sent): that viewer's state is
the recovered server state. Then the clients reconnect (Yjs resync) and type until 45 s, and the
run checks convergence, server state = client state, and the host's saved files. The mock host
keeps every saved file and serves it back on load, like a real host.

**Criteria.** PASS when: 0 acknowledged edits missing from the recovered state; every room
converges; the server state equals every client's; the first host save of every room after the
restart holds every edit acknowledged before the kill; the latest host file holds every edit sent.

| | SQLite | MariaDB 10.11 (Docker) |
|---|---|---|
| edits sent before the kill / acknowledged | 38,826 / 38,756 | 38,556 / 35,196 |
| acknowledged before the kill, missing after restart | **0** | **0** |
| sent-but-unacknowledged edits also recovered | 72 | 49 |
| process start → `/readyz` | 28 ms | 101 ms |
| 200 rooms reopened (WAL replay), all | 234 ms | 2,204 ms |
| one room open incl. WAL replay, p50 / p95 / max | 30 / 59 / 140 ms | 331 / 533 / 549 ms |
| `recovered unsaved room state from WAL` log lines | 200 | 200 |
| first host save after restart: rooms / missing pre-kill acked edits | 200 / **0** | 200 / **0** |
| first save after restart, p50 / max | 139 ms / 10.3 s | 1.3 s / 2.3 s |
| client resync after reconnect, p50 / max | 1.7 / 1.7 s | 4.1 / 4.5 s |
| total edits / acknowledged / missing from server at end | 68,078 / 68,078 / 0 | 63,971 / 63,971 / 0 |
| rooms converged / server ≠ clients / host file missing edits | 200 / 0 / 0 | 200 / 0 / 0 |
| server errors after restart | 0 | **38** (InnoDB deadlocks, see weaknesses) |
| **Result** | **PASS** | **PASS** (data); deadlock errors logged |

Notes: resync gap includes the 1 s the harness waits after the kill and the restart + viewer
check, so it is an upper bound on what a browser would see. On MariaDB 9 % of edits were not yet
acknowledged at the kill (35,196 of 38,556): WAL appends are slower than on SQLite, so fan-out lags
under 1,600 edits/s; none was lost, and the unacknowledged ones came back through client resync.

## 11. Cluster correctness (`scripts/bench.sh K` and `K2`)

**Setup.** 3 nodes (`opencanvas` processes on :8711–8713, same `OC_KEK`), MariaDB 10.11 and Redis 7
in Docker. Background load from two `oc-bench run` processes: 300 rooms × 5 (20 % editors, PERF-01
behaviour) and one room of 550 (20 % editors), every client on a different node than the previous
one (`--affinity rr`, so most sockets are relayed). Verified traffic: `oc-bench verify` with 60
rooms × 3 typing clients, client *k* of room *r* on node (*r*+*k*) mod 3, so every room has a client
on every node (two of three relayed). Clients reconnect with the same ticket, move to the next node
after two failed connects, and drop a socket that stays silent for 15 s. A lease watcher reads every
`room:*:owner` key once a second. Events are run by the script while the verified clients type.

**Criteria.** PASS when: 0 acknowledged edits lost; every room converges across nodes; a fresh
viewer on a third node sees the clients' exact content; the host's latest file holds every sent
edit; clients are back within 30 s of a failure; **no room is written by two nodes** (no
`Duplicate entry` on the WAL primary key `(room_id, seq)`, no `stepping down`).

| run | event (during verified typing) | lost acked | rooms converged | server = clients | host file complete | resync p50 / p95 / max | two writers | result |
|---|---|---|---|---|---|---|---|---|
| K | `kill -9` the node owning most rooms (bench-3), restarted after 5 s | 0 of 93,374 | 60 / 60 | 60 / 60 | yes | 5.3 / 19.6 / 20.5 s (whole run) | none | **PASS** |
| K | rolling restart of all 3 nodes (SIGTERM, restart, 8 s apart) | (same run) | | | | | none | **PASS**, see drain note |
| K2 | Redis `docker kill` + start (all lease keys lost) | 0 of 68,389 | 60 / 60 | 60 / 60 | yes | 0.3 / 1.9 / 2.4 s (whole run) | none | **PASS** |
| K2 | one node frozen 20 s (`SIGSTOP`, then `SIGCONT`; lease TTL is 15 s) | (same run) | | | | | **20 rooms on 2 nodes** | **FAIL** |

**K details.** The verified typing window was 150 s; the owner kill and the start of the rolling
restart fell inside it, and the Redis restart and pause in K happened after it (the node restart
after `kill -9` took longer than planned), which is why K2 repeats those two. Node logs for K:
31 `owner unreachable; took the room over`, 0 duplicate WAL rows, 0 panics. A restarted node keeps
its node id, so it re-acquires its own old leases at once (`ACQUIRE` accepts its own prefix);
moves were therefore short. The background load clients do not reconnect (`oc-bench run` is a load
generator, not a resilient client), so the load fell from 1,500 + 550 live clients to 0 over the
rolling restart; its latency over the whole 170 s window was p50 98 ms, p95 596 ms, p99 1,167 ms.
The 550 room's generator never printed a row (two of its clients never got a `role`; it waited
for them until the run ended). Node logs also show 435 `room full; connection refused` (peers 550)
for the 550 room on bench-1 after the owner moved: relayed peers reconnecting while their old
slots were still counted. Not root-caused.

Drain: during the rolling restart a SIGTERMed node kept **accepting WebSocket upgrades and then
closing them** (`join failed: server is draining`, 8,760 times on bench-1 in about 10 s): the
verified clients, which only change node when a connect fails, looped against it. A load balancer
that honours `/readyz` would take the node out; the server could also refuse the upgrade (HTTP
503) while draining.

**K2: frozen node = two writers (split brain).** Timeline (UTC): bench-2 stopped at 19:49:49;
its clients' sockets went silent and after 15 s they moved to bench-3, which claimed the 20 rooms
once bench-2's leases expired (TTL 15 s; no takeover was needed). At 19:50:09 bench-2 resumed and,
before its 5 s lease renewal ran, its room actors processed the frames queued in their sockets and
appended them to the WAL: **986 `WAL append failed … Duplicate entry '<room>-<seq>' for key
'PRIMARY'`** on bench-2 (19:50:09–19:50:18), then `room lease lost to another node; stepping down`
for 20 rooms. Because bench-2 had written rows with sequence numbers bench-3 had not reached yet,
**bench-3 then failed 1,539 WAL appends** (19:50:15–19:50:40, the same 20 rooms). In both cases
`Room::accepted` logs the error and **still fans the update out** (`actor.rs`: WAL append, then
`broadcast` regardless of the result), so for 25 s those edits were acknowledged to peers but not
in the WAL; a crash of bench-3 in that window would have lost them. Clients still converged and the
host file was complete, because Yjs merges and the clients resent their state on reconnect. The
lease has no fencing: nothing stops a resumed old owner from writing before it learns it lost
the room. Redis loss alone did not cause two writers: owners re-created their keys on the next
renewal (the `RENEW` script sets a missing key).

Failover time: clients were back on a working node within p50 5.3 s, max 20.5 s after the owner
kill and the rolling restart (K); for a frozen node the floor is the clients' own 15 s silence
timeout plus the lease TTL.

## 12. Throughput: 1 node vs 3 nodes (`scripts/bench.sh T1,T3`)

PERF-01 B's load (rooms of 5, 20 % editors with burst pauses, demo doc), 40 s per step, MariaDB in
Docker for both (cluster mode needs it). The mock host answers loads and saves over HTTP after
**20–50 ms**. On 3 nodes, client *i* goes to node *i* mod 3 for both launch and socket
(`--affinity rr`), so the 5 clients of a room sit on different nodes and about 60 % of sockets are
relayed to the room's owner (3,058 `relaying connection` log lines). Each half ran on a fresh
MariaDB container. CPU and RSS are summed over the nodes.

| connections | 1 node p50 / p95 / p99 ms | 3 nodes p50 / p95 / p99 ms | CPU % 1 → 3 | RSS MB 1 → 3 | upd/s applied | connect p95 ms 1 → 3 |
|---|---|---|---|---|---|---|
| 1,000 | 3.1 / 9.0 / 10.4 | 2.9 / 36.2 / 57.1 | 20 → 28 | 276 → 523 | 587 / 588 | 718 → 886 |
| 2,500 | 0.9 / 2.4 / 3.7 | 1.6 / 3.6 / 5.1 | 46 → 62 | 654 → 1,058 | 1,468 / 1,464 | 57 → 1,207 |
| 5,000 | 2.5 / 8.9 / 12.9 | **3,168 / 9,777 / 12,134** | 78 → 124 | 1,288 → 2,247 | 2,991 / 2,997 | 135 → 161 |

**At p95 ≤ 150 ms:** 1 node carried **5,000 connections and about 3,000 updates/s** (the most
tried). 3 nodes carried **2,500 connections and about 1,460 updates/s**, and failed at 5,000
(p95 9.8 s). An earlier T run with both halves on one reused container gave the same 3-node
result (2,500: p95 6.0 ms; 5,000: p95 15.9 s), so the 3-node knee repeats. The 1-node half of that
run was distorted by the database state (p95 1.9 s at 1,000; weakness 6), so it is left out here.

**Relay overhead** (2,500, the largest step where both held): p50 +0.7 ms, p95 +1.2 ms, p99 +1.4 ms;
CPU +35 % (62 % vs 46 % of a core summed); RSS +62 % (three processes, relayed sockets held on two
nodes). The 1,000 step's 3-node p95 (36 ms) includes the ramp's room loads at 20–50 ms each.

**Why 3 nodes fail at 5,000 is not root-caused.** The nodes were not CPU-bound (124 % of 1,000 %
summed, load generator 57 %). Candidates: the shared MariaDB (3 pools × 16 connections, one
Docker VM), relay socket fan-out, and Redis lookups per connect. Profiling the three nodes at
5,000 is the next step.

**Result:** on one laptop, cluster mode does **not** add throughput. It costs about 35 % CPU and 60 %
memory at equal load, and its p95 knee came earlier (between 2,500 and 5,000) than one node's
(above 5,000). Real scale-out needs nodes on separate machines and a database that is not
shared on the same host. This run cannot show that; it shows that relaying works and what it
costs.

## 13. Commands, and what did not run

```sh
scripts/bench.sh S1        # one room of 550, 100 % editors, no pauses, 10 one-minute buckets (SQLite)
scripts/bench.sh S2        # 1,000 rooms × 5, 100 % editors, no pauses, 10 buckets (SQLite)
scripts/bench.sh R,mR      # kill -9 during typing, restart, verify (SQLite, then MariaDB in Docker)
scripts/bench.sh K         # 3 nodes under load: kill -9 the owner, rolling restart, Redis kill, pause
scripts/bench.sh K2        # Redis kill and a 20 s SIGSTOP inside the verified window (repro for weakness 3-4)
scripts/bench.sh T1,T3     # throughput: 1 node, then 3 nodes, each on a fresh MariaDB (host 20-50 ms)
scripts/bench.sh T         # both halves back to back on one container (what §12 calls "reused")
scripts/bench.sh S2m       # S2 on MariaDB for 3 minutes
```

New load generator options: `--no-pauses` (editors type continuously; same as `--active 1`),
`--host-latency-ms LO,HI` (the mock host waits before each load/save), and the `verify` subcommand
(`crates/oc-bench/src/verify.rs`: typed tokens, acknowledgement by another client, crash mode with
`--crash-at/--kill-pid/--restart`, `--spread 1` to put a room's clients on different nodes; it
checks convergence, a fresh viewer's state and the host's saved files). The mock host now keeps
saved files and serves them back on load in `verify`. A repeated step (`--steps 550,550,…`) is one
more time bucket and no longer waits for clients that never connected.

Not run, or run short:

- **S1 ran 12 minutes in 4 buckets of about 3 minutes, not 10 one-minute buckets** (the wait
  described in §9.1, fixed after the run). Per-bucket max latency was not recorded for S1.
- **S2m (S2 on MariaDB) was stopped during its first bucket** to make time for the fresh T reruns;
  no numbers.
- In K the Redis kill and the node pause fell after the verified typing window; K2 repeats them
  inside it. K's background load does not reconnect, so it shrank during the rolling restart.
- The pause was a `SIGSTOP` of a node process, not a network partition of a container: the nodes
  run as processes on the host, so `docker pause` was not available. A frozen process and a
  partitioned node look alike to the others (no answers), but a partitioned node keeps running and
  would keep serving its own direct clients for longer. That case was not tested.
- The sample host (`examples/sample-host`) was not used for T. The mock host in the load generator
  answered over real HTTP with 20-50 ms added latency.
- Everything ran on one laptop: the three nodes, MariaDB, Redis and the load generator shared 10
  cores, so §12 measures relay cost and correctness, not scale-out.
