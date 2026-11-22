# 13 — Operations and deployment

**Status:** draft v0.1, 2026-11-21. Implemented in SCAF-01 / OPS-01.

## Single node (default, SQLite)
```sh
docker run -p 8080:8080 -v oc-data:/data \
  -e OC_PUBLIC_URL=https://canvas.example.com \
  -e OC_KEK=$(openssl rand -base64 32) \
  -e OC_HOSTS_FILE=/data/opencanvas.hosts.toml \
  opencanvas/server:0.1
```
SQLite file at `/data/opencanvas.db` (WAL mode). Back it up only if you care
about un-committed edits surviving a disk loss — committed content is in the host.

## PDF export (optional Gotenberg sidecar, ADR-010)
```sh
docker run -d --name gotenberg gotenberg/gotenberg:8          # internal network only
-e OC_PDF_RENDERER=gotenberg:http://gotenberg:3000              # on the OpenCanvas container
```
Compose: `OC_PDF_RENDERER=gotenberg:http://gotenberg:3000 docker compose --profile pdf up`.
OpenCanvas sends Gotenberg self-contained HTML (images inlined, CSP `default-src 'none'`), so the
sidecar needs no route to hosts or the internet; keep it off public networks. Without it
`GET /v1/export/pdf` answers 501 and the editor prints from the browser. Board PNG/SVG and DOCX
need no sidecar (rendered in-process with `resvg`, see Fonts below).

## Fonts (board PNG, DOCX board images)
`oc_model::fonts` builds one font database per process on the first render (ADR-020):
embedded Geist (Latin) + subsets of Noto Sans Symbols 2 and Noto Sans Math (✓ ✗ → ⇒ ★ ☐ ⚠,
dingbats, shapes, arrows; ~270 KB), then system fonts, then every directory in `OC_FONT_DIRS`.
A character the board font lacks falls back to the symbol subsets, then Noto Sans / Noto Sans
CJK (SC, JP, KR, TC, HK) / other Noto families, then any face that has it. Characters no font
has render as boxes and log one `WARN` per script (`no font for this script`), never the text.

| Variable | Default | Meaning |
|---|---|---|
| `OC_FONT_DIRS` | image: `/opt/opencanvas/fonts` | Extra font directories, `:`-separated, searched recursively |
| `OC_SYSTEM_FONTS` | `1` | `0` skips system fonts (deterministic rendering, tests) |

The image installs Debian `fonts-noto-core` + `fonts-noto-cjk` (Sans only; Serif CJK removed),
so Latin, Greek, Cyrillic, Arabic, Hebrew, Indic, Thai and CJK render out of the box. Add
fonts by mounting them at `/opt/opencanvas/fonts`. Gotenberg (PDF) uses its own Chromium
fonts; `gotenberg/gotenberg:8` already ships Noto CJK and symbol fonts. `oc_model::fonts::coverage(text)`
lists the characters no loaded font can draw.

## Image
`docker build -f deploy/Dockerfile -t opencanvas .` — three stages: release binary
(`rust:1.98-slim-bookworm`), editor bundle (`node:24-slim`, `pnpm install --frozen-lockfile`,
`pnpm --filter @opencanvas/editor build`), runtime `debian:bookworm-slim` with the binary, the
editor at `/srv/web` (served at `/app/`) and the fonts. Runs as uid 10001, works with a
read-only root filesystem (`--read-only --tmpfs /tmp` + a writable `/data` for SQLite).
`HEALTHCHECK` probes `/healthz` on port 8080 through bash's `/dev/tcp` (no curl in the image).
Size: 327 MB (binary 23 MB, editor 8 MB, fonts 80 MB, the rest Debian).

## Kubernetes (Helm)
Chart: `deploy/helm/opencanvas` (values documented inline; examples in `ci/`).
```sh
helm install oc deploy/helm/opencanvas --set secrets.kek=$(openssl rand -base64 32) \
  --set publicUrl=https://canvas.example.com --set ingress.enabled=true --set ingress.host=canvas.example.com \
  --set-file hosts.toml=opencanvas.hosts.toml
```
- **SQLite** (no `database.url`): exactly one replica, `Recreate` rollouts, `/data` on an
  emptyDir (or `persistence.enabled` for a PVC). The chart refuses `replicaCount > 1` or HPA.
- **Cluster**: `database.url` (or `database.existingSecret`) + `redis.url`; HPA optional
  (`autoscaling.enabled`, scale-in one pod / 2 min). `OC_NODE_ID` = pod name.
- **Secrets**: the chart Secret (or `secrets.existingSecret`) is mounted with `envFrom`, so it
  holds `OC_KEK` and every `env:NAME` the hosts file references (JWT secrets, API keys).
  The hosts file itself comes from a ConfigMap (`hosts.toml` or `hosts.existingConfigMap`).
- **Gotenberg**: `gotenberg.enabled` + `mode: deployment` (Service + NetworkPolicy allowing only
  OpenCanvas pods) or `mode: sidecar` (bound to 127.0.0.1 in each pod), or `externalUrl`.
- **Ingress (ingress-nginx)**: one Ingress for `/` (round-robin) and, with
  `ingress.stickyRooms`, a second for `/v1/collab/` with `upstream-hash-by: "$uri"`, so all
  sockets of a room reach the same pod (the owner, fewer relays). 3600 s proxy timeouts,
  buffering off. Other controllers: hash on the path segment after `/v1/collab/`.
- **Drain**: `preStop` sleeps 5 s (endpoints drop the pod), then SIGTERM starts the drain below;
  `terminationGracePeriodSeconds: 40` covers the ≤ 30 s commit. PDB `maxUnavailable: 1`.
- Pods run non-root (10001), read-only root, all capabilities dropped, seccomp RuntimeDefault;
  `/tmp` and `/data` are emptyDirs. Probes: liveness `/healthz`, readiness `/readyz`.
- CI (`helm` job) lints and renders single-node SQLite, cluster MariaDB + Redis and
  Gotenberg value sets, and checks SQLite + 2 replicas is refused.

## Cluster (Redis, optionally MySQL/MariaDB; ADR-006, ADR-030)
```
DATABASE_URL=mysql://oc:***@mariadb:3306/opencanvas   # optional: leave unset for Redis-only
REDIS_URL=redis://redis:6379                 # enables cluster mode
OC_NODE_ID=node-1                            # default: $HOSTNAME
OC_CLUSTER_ADVERTISE=http://node-1:8080      # how other nodes reach this one (default http://$OC_NODE_ID:<port>)
OC_CLUSTER_SECRET=<≥ 32 chars, same on every node>
OC_KEK=<same on every node>                  # nodes read each other's sealed rows
```
`REDIS_URL` with SQLite refuses to start. Without `DATABASE_URL` the cluster keeps all of its
state in Redis (see **Redis-only cluster** below). Rooms are owned by one node through the Redis
lease `room:{id}:owner` (`SET NX PX 15000`, renewed every 5 s). A node that receives a socket
for a room it does not own relays it to the owner over `/v1/internal/relay/:room`; host-API
room calls go to `/v1/internal/rooms/:room`. **Never expose `/v1/internal/` through the load
balancer**; nodes must reach each other directly.

LB: HTTP round-robin; WebSocket `hash $room consistent` on the `/v1/collab/<room>` path
segment, `proxy_connect_timeout 1s` and `proxy_next_upstream error timeout` so a dead node's
rooms move along the ring (see `deploy/nginx/opencanvas-cluster.conf`).
`docker-compose.cluster.yml` ships 3 nodes + MariaDB + Redis + nginx (`:8580`) + the sample
host (`:4580`). `scripts/chaos-cluster.sh` brings it up, types from two clients, `docker kill`s
the room owner, checks reconnect ≤ 5 s, convergence and that the host's file has every
acknowledged edit, then removes everything.

### Redis-only cluster (ADR-030)
```
REDIS_URL=redis://redis:6379   # and no DATABASE_URL
```
Snapshots, the WAL, fencing epochs, the commit and mention outboxes, sessions, used launch
tokens and WOPI assets all live in Redis (key map in docs/03 §5.2.2). Use one Redis primary
(standalone or Sentinel; Redis Cluster is not supported). Memory: each open or recently closed
room holds its encoded snapshot (about the size of the `.ocanvas` document) plus the WAL tail
since its last sync (`OC_DB_SYNC_MS`, 5 s); rooms are purged when they close cleanly.

**Redis persistence is the durability of the whole cluster.** Required:
```
appendonly yes
appendfsync always        # nothing acknowledged is lost on a Redis crash (recommended)
# or: appendfsync everysec + a replica you fail over to (accepts about 1 s of loss)
```
The server logs a warning at start-up when `appendonly` is `no` (Redis-only: "a Redis restart
loses every room snapshot, WAL entry, epoch, pending commit and session") or `appendfsync` is
not `always`. Every node writes `oc:instance` once and checks it every 2 s; if it disappears,
Redis lost its data and each node logs `REDIS LOST ITS DATA` at ERROR. **What a wipe costs in
Redis-only mode:** rooms close with 1012 and rebuild from the host's last saved file plus what
reconnecting clients resend; edits of clients that never return, commits the host had not yet
acknowledged, and open sessions (users relaunch) are lost; a launch token used before the wipe
could be replayed until it expires. With `DATABASE_URL` set the same wipe only costs the WAL
tail since each room's last DB snapshot (still in the owners' memory), and fencing epochs are
restored from `room_epochs` instead of reconnecting every client.

### Durability mode (ADR-029)
```
OC_DURABILITY=memory     # default without Redis: rooms in memory, state dumped to the DB
OC_DB_SYNC_MS=2000       # memory mode: dump each changed room at most this often (5000 with Redis)
OC_ROOM_IDLE_MS=60000    # a room with no peers and nothing unsaved is saved and dropped after this
```
**What you can lose.** In `memory` mode an acknowledged edit is in server memory and in the
editors' browsers, not yet on disk. If the server process dies (kill -9, OOM, power loss) it
restarts from the last dump, at most `OC_DB_SYNC_MS` old; clients that reconnect resend what
it lacks, so nothing is lost while some client holding the edit comes back. Edits from the last
`OC_DB_SYNC_MS` before the crash by clients that never return (tab closed, laptop gone) are
lost. A SIGTERM drain loses nothing. Set `OC_DURABILITY=wal` (or configure a Redis WAL) when
every acknowledged edit must be on disk; on SQLite this costs capacity (docs/22 §9.3–§9.4).

**SQLite settings** (set by the server on every connection): `journal_mode=WAL`,
`synchronous=NORMAL`, `busy_timeout=5000`, default `wal_autocheckpoint` (1,000 pages), and
writes are taken one at a time in process order. With `synchronous=NORMAL` in WAL mode a commit
survives an application crash; a power loss or OS crash can roll back the last commits since the
last checkpoint sync (the database stays consistent). In `wal` mode that means acknowledged edits
can be lost on power loss; use `OC_DURABILITY=wal` with MySQL/MariaDB, or a Redis WAL with
`appendfsync always`, if that matters.

### Hot WAL in Redis (ADR-028)
```
OC_WAL_REDIS_URL=redis://redis:6379   # default: REDIS_URL; also allowed with SQLite (single node)
OC_DB_SYNC_MS=5000                    # DB snapshot per room at most this often (and on close/drain)
OC_DB_SYNC_UPDATES=500                # … or after this many updates
OC_WAL_GROUP_COMMIT=1                 # SQLite without Redis: one writer task, many rooms per commit
```
With a WAL Redis, every edit is appended to the stream `oc:wal:{room}` before anyone sees it,
and **acknowledged means in Redis**. Redis persistence therefore decides what a Redis crash can
lose: `appendonly yes` + `appendfsync always` loses nothing acknowledged (recommended);
`appendfsync everysec` can lose about the last second (acceptable only with a replica you fail
over to); `appendonly no` loses everything since the room's last DB sync (≤ `OC_DB_SYNC_MS`).
After such a loss the fencing epochs are restored from `room_epochs` as rooms write (ADR-030),
so owners keep their rooms instead of every client reconnecting.
The server logs a warning at start-up when `appendonly` is `no` or `appendfsync` is not
`always` (or when `CONFIG GET` is refused). Redis memory per room is the updates since the last
sync (a busy room: a few thousand entries, well under 1 MB). Fencing: the append script refuses
a writer whose epoch is older than `oc:epoch:{room}` (raised at every room claim), and that room
closes with 1012.

## Health & metrics
- `/healthz` — process alive. `/readyz` — DB reachable, (cluster) Redis reachable, not draining.
- `/metrics` (Prometheus): `oc_rooms_live`, `oc_connections{role}`,
  `oc_updates_total`, `oc_update_apply_seconds`, `oc_fanout_bytes_total`,
  `oc_commit_total{result}`, `oc_commit_seconds`, `oc_host_callback_seconds{op,status}`,
  `oc_wal_bytes`, `oc_room_doc_bytes` (histogram), `oc_relay_frames_total`.
- **Implemented today**: `oc_rooms_active`, `oc_connections_active`, `oc_launches_total`,
  `oc_launches_rejected_total`, `oc_updates_total`, `oc_updates_rejected_total`, `oc_saves_total`,
  `oc_save_errors_total`, `oc_save_conflicts_total`, and **`oc_wal_append_seconds`**: a
  histogram (buckets 1 ms … 5 s, plus `_sum` and `_count`) of the time to append one room's
  batch of updates to the WAL, deadlock retries included, success or failure, and
  `oc_wal_batches_total` / `oc_wal_rows_total` (their ratio is the mean batch size). Every
  accepted edit waits for its batch before it is fanned out, so its p95 is the floor of edit
  latency; alert when
  `histogram_quantile(0.95, rate(oc_wal_append_seconds_bucket[5m]))` stays above 50 ms (a slow
  or contended database; docs/22 §8 weaknesses 2 and 6). The other names above are planned.
- Logs: JSON, request id, room id, host id; never content.
- Traces: OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` set.

## Graceful shutdown / deploys
SIGTERM → refuse new rooms → commit all dirty rooms (≤ 20 s each, in parallel) →
`{"t":"reconnect"}` + close 1012 to every client (local and relayed) → release leases → exit.
Rolling deploys move rooms with a ≤ 5 s client reconnect. Give the container a stop grace
period of ≥ 30 s. While draining, `/readyz` answers 503 and new WebSocket upgrades get HTTP 503
with `Retry-After: 5` (refused before the upgrade), so clients and load balancers move on.

## Sizing
Measured on an Apple M4 laptop (10 cores, 16 GB); method, raw tables and caveats in
[22](22-CAPACITY-AND-SIZING.md). Keep ≤ 60 % of measured use.

| Load (small rooms, 20 % typing) | Shape |
|---|---|
| ≤ 1 000 concurrent users | 1 node, 1 vCPU, 512 MB, SQLite |
| ≤ 5 000 concurrent users | 1 node, 2 vCPU, 2 GB, SQLite |
| One room at the 550 cap | 3 vCPU and ≥ 600 Mbit/s for that room |
| Beyond 5 000 | cluster mode (MariaDB + Redis), about one node per 5 000 users (not measured yet) |

Memory ≈ 50 MB + 0.25 MB per user + 5–14× the document per open room. Raise `nofile` above the
connection count. Rerun on your hardware: `scripts/bench.sh`.
