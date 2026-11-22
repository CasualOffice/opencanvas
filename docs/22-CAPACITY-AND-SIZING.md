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
   **Throughput FIXED, latency still FAIL (2026-11-22, §9.3).** Per-room WAL batches, a 40 ms
   outbound tick with one merged frame, SQLite group commit, and an optional hot WAL in Redis.
   S1 (550 typing) now applies all ≈ 2,750 updates/s at p95 ≤ 81 ms; S2 applies all ≈ 25,000
   updates/s with 0 drops; p95 is 215–410 ms with the Redis WAL and MariaDB as the sync DB (PASS
   at 700 ms), but 1.2–1.6 s on SQLite alone and 0.19–1.33 s with Redis + SQLite (FAIL).
3. **A frozen node writes after it lost its rooms: two writers per room (K2).** After a 20 s
   `SIGSTOP` (longer than the 15 s lease), the resumed node appended WAL rows for 20 rooms that
   another node had claimed, until its 5 s renewal noticed. There is no fencing token. Both nodes
   then failed WAL appends with `Duplicate entry` on `(room_id, seq)` (986 + 1,539 errors over
   31 s).
   **FIXED 2026-11-22 (branch `fix-fencing-wal-drain`).** Fencing epochs: each room actor takes
   the room's next epoch from the database (`room_epochs`, migration 0006) before it reads the
   WAL; appends are one guarded `INSERT … SELECT … WHERE epoch = ?`, snapshots, outbox rows and
   the closing purge hold the epoch row first. A stale writer's first write changes nothing and
   its room closes with 1012 (docs/03 §5.2). Evidence: `tests/durability.rs`
   `epoch_1_writes_are_refused_once_epoch_2_owns_the_room` (run on SQLite and on MariaDB 10.11)
   and `stale_owner_stops_at_its_first_write_and_clients_get_1012`, both seen failing before
   the fix. **K2 rerun 2026-11-22 (§11.1): PASS.** The stale node was fenced at its first write
   within about 1 s of `SIGCONT`; 0 duplicate-key WAL errors, 0 `WALSEQ` refusals, 0 of 71,536
   acknowledged edits lost, 20 rooms closed with 1012 and every client back within 288 ms. Same
   result with node 2 in Docker under `docker pause` and under a network partition (KD, 0 of
   81,754 lost). Caveat: with `REDIS_URL` set the hot WAL is always in Redis (`OC_WAL_REDIS_URL`
   defaults to it and an empty value falls back), so in cluster mode the MariaDB WAL guard
   (`INSERT … SELECT … WHERE epoch = ?`) is not exercised: `room_updates` held 0 rows in every
   cluster run. The fencing that worked here is the Redis `APPEND` script's epoch check plus the
   guarded outbox/snapshot writes in MariaDB.
4. **A failed WAL append still acknowledges the update.** `Room::accepted` logs `WAL append failed`
   and fans the update out anyway (`crates/oc-server/src/room/actor.rs`, `accepted`). Peers see the
   edit, but it is not durable until the next compaction or save. In K2 this lasted 25 s for 20
   rooms. No acknowledged edit was lost in these runs only because clients resent their state.
   **FIXED 2026-11-22.** The update is fanned out only after its append succeeded; otherwise the
   room closes with 1012 and no save, and clients resend onto a room rebuilt from the WAL. Host
   patch calls get 503 `ROOM_UNAVAILABLE`. Evidence: `tests/durability.rs`
   `failed_wal_append_is_not_fanned_out` (the WAL table is renamed away mid-session; the peer
   never sees the edit, the sender resends it after reconnecting), seen failing before the fix.
   **Seen under chaos 2026-11-22 (§11.1):** in the KD partition 53 Redis appends failed and every
   one closed its room (`storage error`) instead of fanning out; 0 of 81,754 acknowledged edits
   lost. In K, 60 appends failed while Redis restarted, same outcome.
5. **MariaDB deadlocks (1213) are not retried.** After a restart with many recovered rooms
   (mR) and during cluster chaos (K), these failed with `Deadlock found … try restarting
   transaction`: `compaction failed` (35), `writing the commit outbox failed`, `marking commit done
   failed`, and `room load failed`. The server logs them and moves on. An outbox row that is never
   written or never marked done weakens the outbox's crash guarantee.
   **FIXED 2026-11-22.** `store::retry_with`: 3 attempts, jittered backoff 25-50 ms then
   50-100 ms, for 1213 / 1205 (and SQLite busy), around compaction, outbox write, outbox mark
   done, room load (epoch claim, room row, outbox rows, WAL read, purge, put) and WAL appends.
   A save is no longer sent without its outbox row: the save fails loudly (`save not started`,
   `oc_save_errors_total`, `save_error` status) and retries with the save backoff. Evidence:
   `store::tests::transient_errors_are_retried_up_to_three_attempts` (seen failing) and
   `deadlocks_and_lock_waits_are_transient`. **mR rerun 2026-11-22 (§10.1): data PASS, deadlocks
   not fully gone.** Two runs, 0 acknowledged edits lost in both. Run 1: 86 retries, **9
   `compaction failed` with 1213 after all 3 attempts** (all within 50 ms, 30 s after restart, when
   200 recovered rooms compact together); run 2: 62 retries, 0 left. Compaction runs again on its
   next interval, so nothing was lost, but the retry budget is not enough for that burst. The
   InnoDB deadlocks captured in run 2 are all insert-intention waits on gap locks: `INSERT INTO
   rooms`, `INSERT INTO room_epochs`, `INSERT INTO room_snapshots` (compaction deletes then
   inserts) and `INSERT INTO commit_outbox` (index `ix_outbox_status`). Likely fixes, not tried:
   upserts (`INSERT … ON DUPLICATE KEY UPDATE`) instead of delete-then-insert or
   check-then-insert, more attempts for compaction, or `READ COMMITTED` for these transactions.
   Repro: `scripts/bench.sh mR`, then `grep '"level":"ERROR"' server-*.restart.log | grep -c
   Deadlock`. `scripts/bench.sh mR` prints deadlock errors left after retries and the
   number of retries. The missing WAL latency metric is added: `oc_wal_append_seconds`
   (histogram, docs/13; `wal_append_latency_is_a_histogram`).
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
   **FIXED 2026-11-22.** While draining, `GET /v1/collab/:room` answers HTTP 503 with
   `Retry-After: 5` before the upgrade (and `/readyz` is 503). Evidence: `tests/http.rs`
   `draining_node_refuses_websocket_upgrades_with_503`, seen failing before the fix (the
   upgrade was accepted). **K rerun 2026-11-22 (§11.1): PASS.** During the rolling restart the
   verified clients got **211 HTTP 503** refusals (178 from bench-1, 33 from bench-2, 0 from
   bench-3) and **0 accepted-then-closed** upgrades (`join failed: server is draining`: 0; it was
   8,760 before the fix). Another 175 connects were refused at TCP level while a node was down
   between stop and start.
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
| S1 rerun | same, 5 min, presence fan-out + bounded inbox + batched writes (§9.1.1) | same | **FAIL**: p95 39 s → 220 s; RSS 161 → 452 MB; 3 saves in 5 min; 0 errors, 0 disconnects |
| S2 | 1,000 rooms × 5, 100 % editors, no pauses, 10 min, SQLite | same | **FAIL**: p95 57 s → 521 s; autosave lag p95 255 s; 0 errors, 0 drops |
| S1 (§9.3) | 550 typing, 5 min, batched WAL + 40 ms tick; SQLite WAL / Redis WAL | p95 ≤ 700 ms every bucket; RSS flat; save ≤ 30 s | **PASS latency and saves** (p95 ≤ 67 / ≤ 81 ms; saves every 10 s); RSS grows with the document (not met) |
| S2 (§9.3) | 1,000 × 5 typing, 5 min, same | same | Redis WAL + MariaDB: **PASS** (p95 215–410 ms; saves ≤ 11.5 s; RSS grows with the docs). SQLite: **FAIL** (p95 1.2–1.6 s; Redis + SQLite 0.19–1.33 s). All ≈ 25,000 upd/s applied, 0 drops |
| R (§9.3) | `kill -9` with the Redis WAL (SQLite; Redis `kill -9` + restart first; MariaDB) | 0 acked lost | **PASS**: 0 / 38,305; 0 / 38,213; 0 / 38,302 |
| R | `kill -9` during typing, 200 rooms × 2, SQLite | 0 acked lost; converge; server = clients; first save after restart complete | **PASS**: 0 / 38,756 lost; ready in 28 ms; 200 rooms replayed in 234 ms |
| mR | same on MariaDB | same | **PASS** (0 / 35,196 lost; replay 2.2 s); 38 deadlock errors logged |
| mR rerun (§10.1) | same, with deadlock retries | same; deadlock errors left after retries = 0 | data **PASS** (0 / 38,408 and 0 / 38,004 lost); deadlocks **FAIL** in 1 of 2 runs (9 compactions failed after 3 attempts; 86 and 62 retries) |
| K | 3 nodes under load: `kill -9` owner, rolling restart | 0 acked lost; converge; no two writers | **PASS**: 0 / 93,374 lost, resync max 20.5 s |
| K2 | Redis killed (keys lost) | same | **PASS**: 0 lost, resync max 2.4 s, no two writers |
| K2 | one node frozen 20 s | same | **FAIL**: two writers on 20 rooms (2,525 duplicate-key WAL errors); 0 / 68,389 acked lost |
| K2 rerun (§11.1) | one node frozen 20 s, fencing epochs, Redis WAL with AOF | same, plus stale node's clients get 1012 | **PASS**: fenced at first write; 0 duplicate / `WALSEQ`; 0 / 71,536 lost; resync max 288 ms |
| K2 rerun, original config | Redis `docker kill` (no AOF), then frozen node | same | **PASS**: 0 / 70,308 lost; 0 duplicate / `WALSEQ`; Redis loss fences every room (all reconnect, resync max 2.5 s) |
| KD (§11.1) | node 2 in Docker: `docker pause` 20 s, then network partition 25 s | same | **PASS**: 0 / 81,754 lost; 0 duplicate / `WALSEQ`; resync max 208 ms |
| K rerun (§11.1) | owner `kill -9`, rolling restart, Redis kill (AOF), pause; Redis WAL | same; draining refusals are 503 | **PASS**: 0 / 105,123 lost; resync p50 0.4 / p95 0.9 / max 5.4 s; 211 × 503, 0 accepted-then-closed |
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

#### 9.1.1 Rerun after the awareness fan-out fix (2026-11-22) — still **FAIL**

Branch `perf-awareness-fanout` on top of `cf9c390` (which had already removed `rewrite_for`):

- **Presence** (`room/presence.rs`): each awareness update is stamped once from the sender's
  grant, held latest-per-client, and fanned out as one shared frame per batch. The client-id
  ownership map is kept incrementally.
- **Bounded room inbox**: 2,048 permits per room. Yjs updates wait for a permit and are never
  dropped. An awareness frame that finds the inbox full is held, one per connection (newest wins).
- **Socket writes**: `write_frames` feeds up to 64 queued frames, then flushes once.
- **Load generator**: `oc-bench` sends from its own task, as a browser's `bufferedAmount` does, so
  server pushback never stops a client reading.

`OUT=… S1_STEPS=550,550,550,550,550 scripts/bench.sh S1`: same scenario, 5 one-minute buckets
(55 s measured + 5 s gap), same machine. Clients offered **≈ 2,750 update frames/s** and
≈ 2,610 awareness frames/s in every bucket.

| bucket | p50 ms | p95 ms | p99 ms | samples | srv CPU % | RSS MB | upd/s applied | frames/s out | MB/s out | live | err | drop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 22,432 | 39,046 | 40,576 | 523,825 | 498 | 161 | 954 | 1,020,394 | 183.6 | 550 | 0 | 0 |
| 2 | 62,095 | 78,955 | 81,614 | 469,839 | 466 | 229 | 855 | 915,424 | 174.1 | 550 | 0 | 0 |
| 3 | 105,993 | 125,795 | 127,418 | 362,470 | 343 | 302 | 660 | 705,937 | 135.1 | 550 | 0 | 0 |
| 4 | 156,193 | 173,511 | 174,811 | 326,020 | 316 | 376 | 594 | 635,572 | 122.0 | 550 | 0 | 0 |
| 5 | 199,720 | 220,475 | 222,066 | 316,892 | 308 | 452 | 577 | 617,168 | 118.5 | 550 | 0 | 0 |

Host: 4 saves (3 during the run, 1 at shutdown), save lag p50 48.5 s, max 188 s. WAL rows ≤ 285,
SQLite file 5.3 MB, `-wal` file 7.1 MB. The server log had no warnings beyond the 4 start-up
config notices (short bench API keys, web app not built), and no slow-client drops.

- **Better than before, not enough.** Compared with §9.1 (p95 156 s after 3 minutes), p95 is 39 s
  after 1 minute and 220 s after 5. The room still applies only 21–35 % of what is offered, so
  latency grows by about 45 s per minute and RSS by about 70 MB per minute.
- **No disconnects.** An earlier run on this branch lost all 550 clients in bucket 2. In that run
  the load generator wrote and read on one task, so a send blocked by the bounded inbox also
  stopped that client's reads. With sends on their own task, all 550 stayed live through all 5
  buckets, with 0 closes and 0 errors.
- **Where the time goes** (macOS `sample`, 5 s, bucket 3): the room actor task was busy in about
  6 % of samples and the 8 SQLite workers in about 1.5 % each. Worker threads spent most of their
  busy time in `__sendto`, called from `poll_flush` once per batch. Nothing is saturated: the room
  applies one update, waits for its WAL append (`Room::accepted`), then takes the next. Throughput
  is bounded by that round trip, not by CPU. Applied updates/s fall as the document and snapshot
  grow (954 → 577).
- **Next:** batch WAL appends in `accepted`, after fencing (weakness 3) has merged. This branch
  does not touch `accepted` or the WAL.

Criteria as §9.1. Result: **FAIL** on latency, memory and autosave; PASS on errors, disconnects
and WAL growth.

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

### 9.3 Batched WAL, outbound tick, hot WAL in Redis (PERF-04, 2026-11-22)

Branch `perf-wal-group-commit` (ADR-028; design in docs/03 §5.2.1):

1. **Per-room batches.** Updates are applied as they arrive and queued; the queue is appended
   as one batch (a row and `seq` per update; one epoch-guarded statement, or one Lua script on
   Redis; all or nothing) and only then fanned out. Anything that reads the doc's state writes
   the queue first.
2. **Outbound tick (40 ms).** A room writes its batch and sends **one** merged update frame
   (`merge_updates_v1`, only when every update in the batch integrated in order) plus one
   presence frame, shared by every peer, at most every 40 ms.
3. **SQLite group commit** (no Redis): one writer task commits every room's queued batch in one
   transaction.
4. **Hot WAL in Redis** (`OC_WAL_REDIS_URL`, default `REDIS_URL`; allowed with SQLite): one
   stream per room, fenced Lua append; DB snapshot every 5 s / 500 updates and on close; trim
   after the snapshot commits. Redis 8.6 local, `appendonly yes`, `appendfsync always`.

Same machine and scenarios as §9.1.1 and §9.2, 5 one-minute buckets each (55 s measured + 5 s
gap). **Criterion (owner, 2026-11-22): p95 ≤ 700 ms in every bucket (aim 400 ms), RSS flat, a
host save ≤ 30 s.** "before" is main at `cf43468`, rerun today.

#### S1: one room of 550, everyone typing (≈ 2,750 updates/s offered)

| variant | p95 ms per bucket (1 → 5) | upd/s applied | RSS MB (1 → 5) | srv CPU % | frames/s out | host saves / max lag |
|---|---|---|---|---|---|---|
| before (`cf43468`) | 28,964 · 46,542 · 41,051 · 15,937 · 227 ¹ | 1,428 → 1,569 | 174 → 323 | 378 → 279 | 788 k → 533 k | 27 / 11.8 s |
| batched WAL only (`4f9c1ea`) | 6.9 · 10.5 · 21.2 · 40.7 · 70.2 | 2,744–2,763 (all) | 121 → 406 → 315 | 388 → 320 | 1.69 M → 1.57 M | 29 / 10.3 s |
| + outbound tick, SQLite WAL | 53.7 · 46.0 · 50.6 · 66.4 · 67.1 | 2,747–2,765 (all) | 165 → 457 | 73 → 62 | ≈ 24 k | 29 / 10.3 s |
| + tick, **Redis WAL**, SQLite sync | 60.0 · 73.4 · 80.0 · 81.1 · 75.2 | 2,748–2,762 (all) | 170 → 358 → 288 | 69 → 64 | ≈ 25 k | 29 / 10.3 s |
| + tick, Redis WAL, **MariaDB 10.11** sync (Docker) | 72.6 · 77.1 · 77.2 · 72.7 · 99.8 | 2,747–2,766 (all) | 198 → 569 | 75 → 65 | ≈ 22–25 k | 30 / 10.3 s |

¹ In the "before" run 236 of the 550 clients were dropped in bucket 2 (`Connection reset by
peer`; nothing in the server log at info), so the last buckets carry 314 clients, not 550.

- **Every variant with batching keeps up**: all offered updates are applied and p95 stays
  under 100 ms (criterion 700 ms). The tick cuts server CPU from about 3.9 cores to 0.7 and
  outbound frames 65× (one merged frame per 40 ms per peer instead of one per update). Bytes
  out stay ≈ 540 MB/s: most of that is the presence frame (550 cursors per tick to 550 peers).
- **RSS is not flat** (≈ +60 MB/min). It follows the document, which grows from 0.5 MB to
  5.2 MB encoded in 5 minutes of 550 people typing without a pause (the Y.Doc in memory is a
  multiple of that); latency stays flat and there is no queue (inbox and WAL batches drain every
  tick), so this is document growth, not backlog. The "RSS flat" criterion cannot hold for a
  document that grows 10× under test; it is reported as **not met**.
- **Host saves**: one every ≈ 10 s (autosave max), lag ≤ 10.3 s in every variant: PASS.

#### S2: 1,000 rooms × 5, everyone typing (≈ 25,000 updates/s offered ²)

| variant | p95 ms per bucket (1 → 5) | upd/s applied | RSS MB | drops | host saves / lag p95 / max |
|---|---|---|---|---|---|
| before (`cf43468`) | 47,919 · 90,997 · stopped (fewer than half the clients left) | 6,828 → 7,625 | 1,518 → 1,554 | 3,530 | 3,053 / 84.7 s / 101 s |
| tick + SQLite group commit | 1,354 · 1,367 · 1,241 · 1,388 · 1,604 | 24,829–25,795 (all) | 1,141 → 1,411 | 0 | 28,558 / 11.8 s / 18.5 s |
| tick + **Redis WAL**, SQLite sync | 189 · 604 · 583 · 1,330 · 880 | 25,143–25,376 (all) | 1,026 → 1,524 | 0 | 29,398 / 11.3 s / 13.7 s |
| tick + Redis WAL, **MariaDB 10.11** sync (Docker) | **215 · 331 · 398 · 410 · 403** | 25,244–25,320 (all) | 769 → 1,205 | 0 | 29,958 / 10.5 s / 11.5 s |

² The load generator now sends from its own task (§9.1.1), so S2 offers ≈ 25,000 updates/s, not
the 13,285 of §9.2.

- **Throughput is fixed**: every variant applies everything offered (≈ 25,000 updates/s, 4× the
  old ceiling) with 0 drops, where main collapsed and lost 70 % of its clients.
- **Latency.** Redis WAL + MariaDB sync: **PASS** (p95 215–410 ms, at the 400 ms aim). On
  SQLite it **FAILS** 700 ms: group commit alone sits at p95 1.2–1.6 s, Redis WAL + SQLite sync at
  0.19–1.33 s (2 of 5 buckets over). With MariaDB as the sync DB there were no slow Redis appends
  at all, so in the SQLite run the Redis fsyncs and SQLite's own writes (snapshot syncs, outbox,
  checkpoints) competed for the same disk and the same single SQLite writer.
- **Where the time goes (Redis WAL, bucket 3; macOS `sample`, 4 s, and Redis `INFO`):** Redis
  ran 39,000 ops/s at **8 % CPU**: its main thread waits on `fsync` (`appendfsync always`). A plain
  `SET` took 14.7 ms p50 / 35.7 ms p95 during the run, and 15,240 room appends took > 500 ms
  (`slow Redis WAL append`); `oc_wal_append_seconds` averaged 67 ms per batch. On the server,
  the 8 SQLite workers spent 6,213 of 8,504 `sqlite3_step` samples in the busy handler: every
  room's 5 s snapshot sync (≈ 200/s), autosave outbox writes (≈ 100 saves/s) and `mark_room`
  still contend for SQLite's single writer lock, and a room's actor waits for its sync.
- **Next limits**, in order: (1) the fsync of an `appendfsync always` Redis on this laptop
  (APFS, 95 % full disk); (2) room actors waiting on their own DB snapshot sync and autosave
  writes on SQLite; (3) the per-room append is awaited before the next tick's batch, so one slow
  fsync delays the room by a whole tick. Pipelining the next batch behind the in-flight append
  (same connection, so order holds) and moving the snapshot sync off the actor are the next steps.

#### Correctness

- Tests, each seen failing first (by a mutation that brings the bug back, or on main):
  `durability.rs` `wal_batch_is_all_or_nothing`, `stale_epoch_refuses_the_whole_batch`,
  `batched_wal_replays_in_order`, `failed_wal_append_is_not_fanned_out` (now a burst sharing one
  batch); `redis_wal.rs` `stale_epoch_xadd_is_refused`, `failed_redis_append_is_not_fanned_out`,
  `snapshot_plus_stream_replay_gives_the_same_document`, `trim_happens_only_after_a_successful_sync`
  (run with `OC_TEST_REDIS_URL`). `fuzz.rs` failed (seed 43, a client missing structs) when
  batches with out-of-order updates were merged; merging is now limited to in-order batches and
  2,000 fuzz iterations pass.
- **Crash recovery with the Redis WAL** (§10's harness, SQLite sync): `kill -9` of the server at
  25 s, Redis alive: **0 of 38,305** acknowledged edits lost, 200 rooms recovered from snapshot +
  stream in 591 ms, PASS. Redis `kill -9` and restart (same AOF) at +12 s, then the server
  `kill -9` at 25 s: **0 of 38,213** lost, 20 rooms closed with 1012 during the Redis outage and
  resynced, PASS. MariaDB 10.11 sync (`mR`): **0 of 38,302** lost, 200 rooms recovered in 928 ms, first save after restart p50 573 ms, 27 transient-retry lines and 0 errors after restart, PASS.

### 9.4 Memory durability, idle eviction, socket buffers (PERF-05, 2026-11-22)

Branch `perf/memory-and-sqlite-writer` (ADR-029). `OC_DURABILITY=memory` is now the default
without Redis: no per-update write, the room state is dumped to the DB every 2 s (background,
epoch-fenced), before each host save, on drain and on close. SQLite writes take an in-process
FIFO write turn. Socket write batches are capped at 64 KiB and tungstenite's write buffer at
16 KiB. Idle eviction: `OC_ROOM_IDLE_MS`, default 60 s (it existed as a 10-minute TTL).

**Where S1's memory went** (macOS `heap`, main, `wal` mode, 1 min vs 3 min): blocks > 64 KB went
from 92 to 170 MB, almost exactly one per connection (555–865 blocks of 80–384 KB). They are the
per-socket write buffers: `write_frames` fed up to 64 frames (presence frames of 550 cursors
are tens of KB each) before one flush, and a Rust `Vec` keeps the capacity of its largest batch
for the connection's life. Small blocks (≤ 256 B, mostly 160 B yrs items) grew about
10–19 MB/min with the document. yrs GC is on (`Doc::new()`, `skip_gc` false); this workload only
appends text and overwrites map keys, so there is little deleted content to collapse. The
allocator was not changed (not measured: time). The DB/Redis path held no copies (no growth
in 16 KB–4 KB blocks).

**S1 (550 in one room, all typing, 5 × 1 min, SQLite):**

| | p95 ms per bucket | RSS MB per bucket | snapshot MB at end | saves / max lag |
|---|---|---|---|---|
| before (main, `wal`, 3 buckets) | 45.5 · 92.8 · 69.7 | 237 · 200 · 403 | 3.1 | 18 / 10.4 s |
| §9.3 (main, `wal`) | 53.7 · 46.0 · 50.6 · 66.4 · 67.1 | 165 → 457 | 5.2 | 29 / 10.3 s |
| **after (`memory`)** | **43.5 · 48.1 · 52.3 · 47.7 · 45.1** | **106 · 179 · 252 · 242 · 216** | 5.2 | 29 / 10.3 s |

PASS latency. RSS after warm-up (bucket 2 → 5): 179 → 216 MB, **+21 %**, peaking at 252 MB
in bucket 3 and then falling; the end is 216 MB against 457 MB before. Large blocks at minute 3:
136 MB (one ≈ 245 KB buffer per connection: a socket write buffer is at least its largest
single frame plus 16 KiB, and a 550-cursor presence frame is large). What is left that grows is
the Y.Doc: ≈ 0.75 retained 160-byte items per applied update here (2,750 updates/s ≈
+19 MB/min while the encoded doc grows ≈ 1 MB/min), i.e. **about 20× the encoded size**
for this append-only, 550-author workload. That part is irreducible while the room is open;
idle eviction returns it when the room empties.

**S2 (1,000 rooms × 5, all typing, ≈ 25,000 updates/s, SQLite):**

| | p95 ms per bucket | p99 ms | RSS MB | saves / lag p95 |
|---|---|---|---|---|
| §9.3 `wal` (group commit) | 1,354 · 1,367 · 1,241 · 1,388 · 1,604 | – | 1,141 → 1,411 | 28,558 / 11.8 s |
| **`memory`** | **83.5 · 74.1 · 44.0 · 946.6 · 104.5** | 323 · 380 · 188 · 8,702 · 2,923 | 636 · 786 · 947 · 1,052 · 717 | 27,156 / 13.9 s |

All 25,000 updates/s applied, 0 errors, 0 drops. Four of five buckets PASS at 44–105 ms; bucket
4 FAILS (947 ms). During bucket 4 another session's Docker chaos benchmark (MariaDB + Redis
containers) started on the same laptop, the load generator's in-process mock host stopped
answering (1,864 `save failed: host unreachable`, all inside that minute) and its sample count
fell by 30 %; the server log has no other warning. This is not proven to be the machine, so the
run is reported as **FAIL (1 bucket)**; rerun on a quiet machine. The DB held 1,000 snapshots
(95 MB) and 0 WAL rows.

**Crash recovery in memory mode (`scripts/bench.sh R`, SQLite, kill -9 at 25 s):**

- Clients reconnect: **0 of 67,980** acknowledged edits missing from the server at the end, all
  200 rooms converged, server = clients, the latest host file of every room has every edit:
  **PASS**. Ready in 30 ms; 200 rooms reopened from their dumps in 227 ms.
- Clients gone for good (the fresh viewer opened before any client resends): **2,013 of 38,681**
  acknowledged edits (5.2 %) were not in the recovered state, the oldest acknowledged
  **2,139 ms** before the kill. The bound is `OC_DB_SYNC_MS` (2 s) plus up to one 250 ms room
  tick. The first host save after the restart (p50 188 ms) is the dump's state, so it lacks the
  same edits until the clients' resync lands; the next saves have them.

**Not run (time):** S1/S2 with MariaDB as the dump target, S1/S2 Redis + SQLite reruns (that
path is unchanged), a mimalloc/jemalloc comparison. Tests, each seen failing first by
mutation: `config` `idle_eviction_defaults_to_a_minute_and_reads_oc_room_idle_ms`,
`durability_defaults_to_memory_without_redis`; `rooms.rs`
`idle_room_is_saved_and_dropped_from_memory`; `durability.rs`
`memory_mode_fans_out_without_wal_rows_and_a_restart_loads_the_dump`,
`an_older_dump_never_replaces_a_newer_one`. The requested "writer prioritises WAL over
snapshots" test was superseded by the owner's memory-mode decision (no WAL writes on the default
path); `wal` mode keeps the group writer and now shares the FIFO write turn.

#### 9.4.1 S2 rerun on a quiet machine (memory mode, SQLite dump, 2026-11-22)

`S2_STEPS=5000,5000,5000,5000,5000 scripts/bench.sh S2`, no other benchmark or Docker container
running, no `REDIS_URL` (so `OC_DURABILITY=memory`, dumps every 2 s):

| bucket | p50 ms | p95 ms | p99 ms | srv CPU % | RSS MB | upd/s in | frames/s out | err | drop |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 40.2 | 42.9 | 44.3 | 180 | 843 | 25,325 | 133,002 | 0 | 0 |
| 2 | 39.4 | 42.9 | 44.3 | 187 | 993 | 25,290 | 132,587 | 0 | 0 |
| 3 | 39.8 | 43.0 | 44.5 | 196 | 1,137 | 25,289 | 132,320 | 0 | 0 |
| 4 | 39.3 | 43.1 | 44.5 | 203 | 1,292 | 25,283 | 132,008 | 0 | 0 |
| 5 | 39.0 | 43.0 | 44.3 | 209 | 1,451 | 25,310 | 132,215 | 0 | 0 |

Host saves 29,993, save lag p95 10.25 s (max 10.7 s); a few saves retried after `host unreachable`
from the in-process mock host. **Latency PASS** (p95 43 ms every bucket; the 947 ms bucket in §9.4
was the noisy machine). **RSS FAIL** against "flat": +72 % over 5 minutes (≈ 150 MB/min) while
1,000 documents grow under nonstop typing (2.36 GB of saves in 5 minutes). This is the Y.Doc
in-memory cost (≈ 20× encoded, §9.4) times 1,000 growing documents; next: allocator comparison
and the in-memory Y.Doc overhead.

### 9.5 Where S2's RSS growth goes, and the allocator (PERF-06, 2026-11-23)

Branch `perf-memory-reliability` off main `63e9e01`. **Target** (RSS growth per minute ≤ about
3× the growth of the summed encoded documents, and RSS falls back after idle eviction): **FAIL,
not fixable in the server without changing yrs.**

**S2 before** (`S2_STEPS=5000,5000,5000`, memory mode, SQLite; the machine was not fully quiet:
another session was running debug tests, so p95 was 324–1,367 ms, not the 43 ms of §9.4.1):
RSS 757 · 943 · 1,088 MB, **≈ 165 MB/min**; summed snapshots (the encoded documents) 55.2 →
78.6 MB over 2.5 min, **≈ 9.4 MB/min**. RSS grows ≈ 17× the encoded growth.

**Why** (`tests/ydoc_memory.rs`, a measurement on the S2 editor mix: 92 % typed characters,
6 % cell overwrites, 2 % drags of 10 x/y overwrites): typed text squashes on the server (2,000
characters in one update each, merged windows, or 5 interleaved clients: 3–15 blocks), so text
costs almost nothing. Every **map overwrite** (a status cell, a shape's x or y) leaves a deleted
yrs `Item` that can never merge with its neighbour (different key, non-consecutive clock): about
210 heap bytes per block against a few encoded bytes. The live heap grows **14.7× the encoded
growth** with the system allocator's overhead excluded. A 3× bound would need yrs to drop or
compact dead map items in memory (it keeps them for causality); the server cannot get there
by itself.

**Allocator (WIP branch `worktree-agent-a638f7cbfb02756d4`, reviewed, not merged).** Its
`alloc::release` (macOS `malloc_zone_pressure_relief`, glibc `malloc_trim`) after rooms close was
tested: 400 MB of freed 160-byte blocks, RSS 405 MB before the call and **405 MB after** on macOS,
the same as with the call removed, so it is not proven to help and was dropped. The optional
mimalloc/jemalloc features were dropped untested (no time for the S2 comparison; they add four
dependencies). Kept: the yrs squash/heap tests and `oc-bench --idle-secs` (bench.sh
`S_IDLE_SECS`), which samples the server's RSS after typing stops.

**Idle eviction does not give the memory back (FAIL).** Same main server, `S2_STEPS=5000,5000
S_IDLE_SECS=120`: RSS 884 → 1,039 MB over the 2 typing minutes (p95 380 / 44 ms), then every
client disconnected. Rooms saved, and all 1,000 closed 60–70 s later (`OC_ROOM_IDLE_MS`), but RSS
was **1,004 MB with 0 rooms open** at 120 s (peak 1,087 MB). The freed Y.Docs stay in the macOS
allocator's free lists and the release call above did not return them. Next: measure mimalloc
(`mi_collect(true)`) or jemalloc (`arena.<all>.purge`) on S2 + idle; on Linux, glibc
`malloc_trim(0)` is likely to work but was not measured here.

**Not run (PERF-06):** the Redis-only cluster runs (K, K2, S1 with `CLUSTER_DB=none`) and any
build after the measurements: free disk fell to 7.7 GB (below the 8 GB floor for builds and
Docker) after the release build.

### 9.6 Allocator comparison, dead-item compaction (PERF-07, 2026-11-23)

Branch `perf-allocator-compaction` off main `34b685c`. Same release source for all three
variants (cargo features `jemalloc` (now the default), `mimalloc`, none = system). Each:
`S2_STEPS=5000,5000,5000 OC_ROOM_IDLE_MS=20000 S_IDLE_SECS=60 scripts/bench.sh S2`, memory mode,
SQLite, one at a time on a quiet M4. On a room close the server drops the doc and calls
`alloc::release` (jemalloc `arena.<all>.purge`, mimalloc `mi_collect(true)`), plus a 2 s sweeper
while rooms close. jemalloc: `dirty_decay_ms:1000,muzzy_decay_ms:0` (and `background_thread`
on Linux only; macOS does not support it). RSS is `ps` resident size; for jemalloc the macOS
`phys_footprint` was sampled too and tracked it (1,174 MB peak → 684 MB with 0 rooms).

| allocator | p95 ms per bucket | p99 ms | RSS MB per bucket | RSS 60 s after typing stopped, 0 rooms open |
|---|---|---|---|---|
| system | 43.3 · 134.4 · 48.9 | 73 · 2,203 · 307 | 744 · 907 · 1,074 | **1,069** (peak 1,088) |
| mimalloc + `mi_collect` | 118.5 · 46.4 · 80.1 | 2,150 · 1,275 · 940 | 756 · 970 · 1,101 | **1,063** (peak 1,101) |
| **jemalloc + purge** | 43.3 · 43.4 · 243.2 | 47 · 46 · 3,790 | **594 · 734 · 972** | **628** (peak 977) |

All three applied ≈ 25,000 updates/s with 0 errors and 0 drops; every variant had one slow
bucket (single-run noise on a laptop; p95 stays ≤ 700 ms). **Pick: jemalloc** — lowest steady
RSS (−10 to −20 %) and the only one that gave memory back after eviction (−36 %). mimalloc
returned nothing. Docker: the image builds on `rust:1.98-slim-bookworm` (glibc); jemalloc's
build needs `make`, now installed in the server stage (not built here: free disk under 6 GB).

**Still FAIL: RSS does not return to baseline.** 628 MB stays with 0 rooms and 0 connections.
The guard test `tests/alloc_release.rs` (24 rooms × 20,000 x/y overwrites, then eviction) shows
why it is not the allocator: RSS 22 → 117 MB with the rooms open, **134 MB after all closed, and
134 MB after an explicit `arena.<all>.purge`** — the memory is still live, so something keeps
part of the closed rooms reachable. The test is `#[ignore]` with that reason until the holder is
found (next: a heap snapshot of the test after eviction; candidates are per-room state kept by
the room manager, the mock host's recorded puts are ≈ 5 MB).

**Dead-item compaction: skipped, it does not help with yrs 0.28.** Measured on the S2 mix
(`ydoc_memory::rebuilding_the_s2_doc_from_its_encoding_measurement`): original doc 333,304 heap
bytes in 1,574 blocks, encoded 22,550 B; a fresh Doc with that encoding applied: **332,331 B in
1,574 blocks** (−0.3 %). Encoding keeps every deleted map item as its own `Item` with
`ContentDeleted` (they cannot merge: different key, non-consecutive clock), so decoding rebuilds
the same blocks. A rebuild would also have to re-create the awareness, the mentions tracker
and drop any AI undo managers (bound to the old Doc) for no gain. Only yrs can shrink these
(dropping dead map items in memory), so no failing test was written for a feature not built.

**Not run (disk):** the Redis-only reruns K, K2 and S1. Free disk fell to 5.8 GB (stop rule:
6 GB) after the three release builds and the test/clippy builds. `scripts/bench.sh` now takes
`REDIS_LOCAL=1` (local `redis-server` on `REDIS_PORT` with its files under the work dir, kill -9 +
restart for the Redis-restart event), so the reruns are:
`REDIS_LOCAL=1 REDIS_ARGS="--appendonly yes" CLUSTER_DB=none NODE_BASE=8810 REDIS_PORT=8834 HOST_PORT=8802 HOST2_PORT=8842 HOST3_PORT=8852 scripts/bench.sh K`
(then `K2_REDIS_KILL=0 … K2`, and `S_DB=redis REDIS_LOCAL=1 OC_PORT=8801 … S1`).

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

### 10.1 mR rerun with fencing and deadlock retries (2026-11-22)

Branch `chaos-rerun-fencing` off main `6d59084`, release build, MariaDB 10.11 in Docker, no Redis.
`scripts/bench.sh mR` twice (the second with an InnoDB status poller saving each new `LATEST
DETECTED DEADLOCK`).

| | run 1 | run 2 |
|---|---|---|
| edits sent before the kill / acknowledged | 38,509 / 38,408 | 38,133 / 38,004 |
| acknowledged before the kill, missing after restart | **0** | **0** |
| process start → `/readyz`; 200 rooms reopened | 83 ms; 2,359 ms | 164 ms; 1,419 ms |
| first host save after restart: missing pre-kill acked edits | 0 (p50 1.6 s, max 2.4 s) | 0 (p50 1.0 s, max 1.6 s) |
| client resync p50 / max | 4.4 / 6.1 s | 3.1 / 3.2 s |
| total edits / missing from server at end; rooms converged | 63,228 / 0; 200 | 64,905 / 0; 200 |
| transient retries (op × attempt) | compaction 35 + 27, outbox write 14, outbox mark done 10 | compaction 31 + 10, outbox write 21 |
| deadlock errors left after 3 attempts | **9** (`compaction failed`) | **0** |
| **Result** | data **PASS**; deadlocks **FAIL** | **PASS** |

Run 1 also logged 9 `compaction failed … expected to read 4 bytes, got 0 bytes at EOF` at the
very end: the harness's `stop_server` cannot `wait` for the restarted server (it is not the
script's child), so the MariaDB container was removed while the server was still shutting down.
That is a harness artifact, not a server fault.

**Fix and rerun (PERF-05, branch `perf/memory-and-sqlite-writer`).** The deadlocks were range
deletes (`DELETE FROM room_updates WHERE room_id = ? AND seq <= ?` in compaction, and room
purges) taking next-key locks on the `(room_id, seq)` primary key, past the room's last row
into the neighbouring room's range, while other rooms' guarded inserts and other compactions
locked in the opposite order. Snapshot writes and purges now take a process-wide gate
exclusively and WAL batches take it shared, so in one process they never overlap each other or
a WAL batch (on SQLite they also share the write turn). `OC_DURABILITY=wal scripts/bench.sh mR`
twice (MariaDB 10.11, Docker): **0 of 38,464 and 0 of 38,468** acknowledged edits lost; 0 of
67,370 / 67,376 missing at the end; **0 deadlock errors and 0 ERROR lines** in either run
(before and after the kill); transient retries 4 and 28 (all succeeded). PASS. A cluster can
still deadlock across nodes (the gate is per process); the 3 retries cover that.

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

### 11.1 Rerun with fencing epochs, the Redis hot WAL and draining 503 (2026-11-22)

Branch `chaos-rerun-fencing` off main `6d59084` (fencing epochs, ADR-028 Redis hot WAL with
periodic DB sync, deadlock retries, 503 while draining). Release build, same laptop, MariaDB 10.11
and Redis 7 in Docker, ports 89xx. Same load and verified clients as above. In cluster mode the
hot WAL is in Redis (`REDIS_URL` turns it on), so the WAL rows live in Redis streams and
MariaDB gets snapshots and outbox rows; `room_updates` stayed empty in every run. **Two writers**
would show as `Duplicate entry` (DB WAL), `WALSEQ` (a Redis append whose seq is not above the
stream's last entry) or a non-fenced WAL failure on the new owner; the stale owner's refused
writes show as `a newer owner holds the room`. Redis ran with `--appendonly yes --appendfsync
always` (the documented setting for the hot WAL) except where noted.

| run | events | lost acked | converged / server = clients / host file | resync p50 / p95 / max | duplicate / `WALSEQ` | result |
|---|---|---|---|---|---|---|
| K2 | bench-2 (121 rooms) `SIGSTOP` 20 s, `SIGCONT` | 0 of 71,536 | 60 / 60 / complete | 118 / 174 / 288 ms | 0 / 0 | **PASS** |
| K2, original config | Redis `docker kill` + start without AOF; then the same pause | 0 of 70,308 | 60 / 60 / complete | 136 / 151 / 2,538 ms | 0 / 0 | **PASS** |
| KD | node 2 in Docker: `docker pause` 20 s (95 rooms), then partition 25 s (90 rooms) | 0 of 81,754 | 60 / 60 / complete | 103 / 137 / 208 ms | 0 / 0 | **PASS** |
| K | `kill -9` bench-3 (restart after 5 s), rolling restart, Redis kill (AOF kept 582 keys), bench-2 pause 20 s | 0 of 105,123 | 60 / 60 / complete | 392 / 861 / 5,371 ms (707 reconnects) | 0 / 0 | **PASS** |

**K2, frozen node.** bench-2 resumed and its first writes were refused: 46 `a newer owner holds
the room; this node stops writing` and 19 outbox writes refused (`save not started … a newer
owner holds the room (stale epoch)`) between 0 and 1 s after `SIGCONT`, then 20 rooms closed with
`room moved`. Its relayed clients got **1012** (40 closes `Restart`, all reconnected); its 60
direct clients had already left after 15 s of silence. No node logged a takeover (leases
expired normally), and the other nodes logged no WAL failure. Redis epoch keys were never lower
than `room_epochs`. Before the fix this run gave 2,525 duplicate-key errors.

**K2 in the original configuration (Redis without AOF).** `docker kill` lost every Redis key,
including the mirrored fencing epochs (`oc:epoch:{room}`). The next append of every room on
every node was refused as fenced (105 / 192 / 124 fenced log lines on bench-1/2/3) and those rooms
closed with 1012 (`room moved`, 245 client closes) and reloaded from MariaDB; clients resent
what was missing. That is safe (no writer without a valid epoch) but heavy: a Redis restart
without persistence reconnects every client of the cluster. Edits acknowledged since the last
DB sync (≤ 5 s) existed only in the clients in that window; a client that left in it would have
lost them. The server already warns at start (`WAL Redis has appendonly=no`).

**KD, container freeze and partition.** Node 2 ran in Docker (`NODE2_IMAGE`, the `server`
stage of `deploy/Dockerfile`); its network namespace belonged to a socat container forwarding
`127.0.0.1:<port>` to the host for Redis, MariaDB, the other nodes and the mock hosts.
`docker pause` of node 2 behaved like `SIGSTOP` (60 direct clients silent, fenced on resume).
For the partition the forwarder was paused: node 2 kept running and kept answering on its own
port but could not reach Redis, the DB, the other nodes or the host. Its Redis appends hit the
5 s response timeout (55 `slow Redis WAL append` at 4.0–5.0 s, 53 `WAL append failed`); 75 rooms closed with
`storage error` without fanning the update out; DB work failed with pool timeouts (41 compaction,
22 outbox, 22 `marking room dirty failed`). No edit was acknowledged without a durable append
and no other node saw a conflicting write. The partition was one-way (others could still reach
node 2's port); a symmetric partition was not built.

**K, owner kill, rolling restart, Redis kill, with the Redis WAL.** 22 takeovers after the
`kill -9` (12 on bench-1, 10 on bench-2). While Redis restarted (`BusyLoading`), 60 appends failed
and those rooms closed with `storage error` and resynced; one room load failed mirroring its epoch
and was retried. The pause fenced 58 writes on bench-2. Deadlocks: 13 retries, 0 left. Draining:
211 × HTTP 503, 0 accepted-then-closed (weakness 7). Resync times are for the whole run (the
harness does not split them per event); the 5.4 s maximum fell in the rolling restart. `room
full` (weakness 9) did not recur (0 lines).

**Found, not fixed (server source unchanged):**

- **MariaDB WAL fencing is unreachable in cluster mode.** `OC_WAL_REDIS_URL` falls back to
  `REDIS_URL`, and an empty value is ignored, so a cluster cannot run with the WAL in MariaDB.
  Either document that the DB WAL is single-node only, or add an explicit off switch so the
  guarded MariaDB append can be chaos-tested.
- **A refused (fenced) outbox write is logged at ERROR** (`save not started`), 19 per frozen node.
  It is the expected outcome after losing a room; WARN would keep the error count meaningful.
- **Compaction deadlocks can exhaust the retries** (weakness 5, §10.1).

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

### 12.1 Why one laptop cannot show scale-out, and the multi-machine recipe (PERF-06)

Not rerun on purpose. On one machine the three nodes, the load generator, its mock hosts, Redis
and the database share the same 10 cores, memory bandwidth, loopback and (for MariaDB) one Docker
VM. Adding a node adds no hardware, only work: about 60 % of sockets are relayed (every relayed
update crosses loopback twice and is framed on two nodes), each node keeps its own Redis lease
traffic and DB pool, and the load generator (57 % of a core at 5,000) competes with the nodes it
measures. A cluster can only beat one node when each node brings its own CPU and network, so the
single-laptop T result is an upper bound on relay *cost*, not a measure of scale-out.

**Recipe (5 machines, same LAN, ≥ 1 Gbit/s, same CPU class; record `machine` on each):**

1. **Data machine D:** Redis 7 (`redis-server --appendonly yes --appendfsync always --bind 0.0.0.0
   --protected-mode no`, port 6379) and, for the DB variant, MariaDB 10.11
   (`--max-connections=500`, database `opencanvas`). For ADR-030, skip MariaDB.
2. **Nodes N1–N3:** the same release build (`cargo build --release -p oc-server --bin opencanvas`),
   one `opencanvas` each, the same `OC_KEK` and `OC_CLUSTER_SECRET`, and:
   `DATABASE_URL=mysql://root:root@D:3306/opencanvas` (omit for Redis-only),
   `REDIS_URL=redis://D:6379`, `OC_NODE_ID=node-<n>`, `OC_BIND=0.0.0.0:8701`,
   `OC_PUBLIC_URL` and `OC_CLUSTER_ADVERTISE` both `http://N<n>:8701`, and a hosts file whose `bench`
   host has `callback_base = "http://L:8702/api"` and the bench secret (copy the one
   `scripts/bench.sh` writes). `ulimit -n 65536` first.
3. **Load machine L:** `OC_BENCH_HOST_BIND=0.0.0.0 oc-bench run --server
   http://N1:8701,http://N2:8701,http://N3:8701 --host-port 8702 --secret <bench secret>
   --per-room 5 --editors 0.2 --probes 5 --doc demo --steps 1000,2500,5000,10000,15000
   --step-secs 60 --connect-rate 250 --host-latency-ms 20,50 --affinity hash --out T3.json`.
   `--affinity hash` sends a room's clients to one node (what a room-aware load balancer does);
   rerun with `--affinity rr` for the relay worst case. Leave `--server-pid` empty: CPU and RSS
   come from each node (`ps -o %cpu=,rss= -p $(pgrep opencanvas)` every 10 s, or `/metrics`).
4. **Baseline:** the same command against N1 alone (N2, N3 stopped), same D. Both halves on a
   fresh database and an empty Redis (`FLUSHALL`).
5. **Report** per step: p50/p95/p99, connections and updates/s applied, CPU and RSS per node, D's
   CPU, and the largest step with p95 ≤ 150 ms for 1 and 3 nodes. Scale-out holds when the
   3-node knee is about 3× the 1-node knee with `hash` affinity; check that L stays below 70 %
   CPU (add a second load machine with a different `--run-id` if not).

## 13. Commands, and what did not run

```sh
scripts/bench.sh S1        # one room of 550, 100 % editors, no pauses, 10 one-minute buckets (SQLite)
scripts/bench.sh S2        # 1,000 rooms × 5, 100 % editors, no pauses, 10 buckets (SQLite)
scripts/bench.sh R,mR      # kill -9 during typing, restart, verify (SQLite, then MariaDB in Docker)
scripts/bench.sh K         # 3 nodes under load: kill -9 the owner, rolling restart, Redis kill, pause
scripts/bench.sh K2        # Redis kill and a 20 s SIGSTOP inside the verified window (repro for weakness 3-4)
scripts/bench.sh KD        # node 2 in Docker (NODE2_IMAGE): docker pause 20 s, then a 25 s partition
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
  would keep serving its own direct clients for longer. That case was not tested. **Covered
  2026-11-22 by `scripts/bench.sh KD`** (§11.1): `docker pause` of a containerised node and a
  one-way partition (outbound blocked, its own port still served). A symmetric partition was
  not built (Docker Desktop on macOS has no host networking here).
- Reruns of 2026-11-22 (§10.1, §11.1): `scripts/bench.sh mR`; `REDIS_ARGS="--appendonly yes
  --appendfsync always" K2_REDIS_KILL=0 scripts/bench.sh K2`; `scripts/bench.sh K2`;
  `NODE2_IMAGE=<server image> REDIS_ARGS=… scripts/bench.sh KD`; `REDIS_ARGS=… scripts/bench.sh K`.
  With ports moved off the defaults: `OC_PORT=8901 HOST_PORT=8902 MARIA_PORT=8933
  REDIS_PORT=8934 NODE_BASE=8910 HOST2_PORT=8942 HOST3_PORT=8952 CPFX=oc-k2`. `OC_BIN` / `OC_LG`
  run prebuilt binaries without `cargo build`; `WORK` keeps node logs. The lease watch and the
  owner lookups now read all leases in one Redis call (one `docker exec` per key took about 18 s
  for 360 keys, which had delayed the events and made the "1 s" lease watch far slower).
- The sample host (`examples/sample-host`) was not used for T. The mock host in the load generator
  answered over real HTTP with 20-50 ms added latency.
- Everything ran on one laptop: the three nodes, MariaDB, Redis and the load generator shared 10
  cores, so §12 measures relay cost and correctness, not scale-out.
