# 22 — Capacity and sizing

**Status:** first measurement, 2026-11-22 (PERF-01). Laptop numbers: indicative, not a guarantee.
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
rooms save on the 10 s `OC_AUTOSAVE_MAX_MS`, as designed. **No knee up to 5,000 connections**:
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

## 7. Findings for the server (not fixed here)

- **Memory per idle connection is high (0.20 MB).** Not root-caused. A likely part is the WebSocket
  read buffer, which tungstenite allocates per connection (128 KiB by default) and which
  `collab::upgrade` does not set. Checking needs a heap profile; a smaller `read_buffer_size` on the
  `WebSocketUpgrade` would be the first thing to try.
- **Room memory is 5–14× the document**, not the "~3× doc size" in docs/03 §5.3; docs/03's 300-room
  estimate is low for database/board-heavy documents.
- **`/metrics` lists fewer series than docs/13 says.** The server exports `oc_rooms_active`,
  `oc_connections_active`, `oc_launches_total`, `oc_updates_total`, `oc_saves_total` and a few error
  counters; `oc_update_apply_seconds`, `oc_fanout_bytes_total`, `oc_commit_seconds`,
  `oc_host_callback_seconds`, `oc_wal_bytes` and `oc_room_doc_bytes` do not exist yet, so save
  latency here was measured at the mock host.
- **Fan-out copies each frame per peer** (`broadcast` does `frame.to_vec()` for every peer). At 550
  peers that is 345,255 allocations and copies per second; a shared `Bytes` would avoid it. Not
  limiting at the cap on this machine.
