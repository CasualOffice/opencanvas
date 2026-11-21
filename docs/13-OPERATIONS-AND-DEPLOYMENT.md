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
need no sidecar (rendered in-process with `resvg` and an embedded font).

## Cluster (MySQL/MariaDB + Redis, ADR-006)
```
DATABASE_URL=mysql://oc:***@mariadb:3306/opencanvas
REDIS_URL=redis://redis:6379                 # enables cluster mode
OC_NODE_ID=node-1                            # default: $HOSTNAME
OC_CLUSTER_ADVERTISE=http://node-1:8080      # how other nodes reach this one (default http://$OC_NODE_ID:<port>)
OC_CLUSTER_SECRET=<≥ 32 chars, same on every node>
OC_KEK=<same on every node>                  # nodes read each other's sealed rows
```
`REDIS_URL` with SQLite refuses to start. Rooms are owned by one node through the Redis
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

## Health & metrics
- `/healthz` — process alive. `/readyz` — DB reachable, (cluster) Redis reachable, not draining.
- `/metrics` (Prometheus): `oc_rooms_live`, `oc_connections{role}`,
  `oc_updates_total`, `oc_update_apply_seconds`, `oc_fanout_bytes_total`,
  `oc_commit_total{result}`, `oc_commit_seconds`, `oc_host_callback_seconds{op,status}`,
  `oc_wal_bytes`, `oc_room_doc_bytes` (histogram), `oc_relay_frames_total`.
- Logs: JSON, request id, room id, host id; never content.
- Traces: OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` set.

## Graceful shutdown / deploys
SIGTERM → refuse new rooms → commit all dirty rooms (≤ 20 s each, in parallel) →
`{"t":"reconnect"}` + close 1012 to every client (local and relayed) → release leases → exit.
Rolling deploys move rooms with a ≤ 5 s client reconnect. Give the container a stop grace
period of ≥ 30 s. (Not yet: `/readyz` does not turn 503 while draining.)

## Sizing
| Load | Shape |
|---|---|
| Team ≤ 200 users | 1 node, 1 vCPU, 512 MB, SQLite |
| ≤ 5 000 concurrent | 3 nodes × 2 vCPU/2 GB, MariaDB, Redis |
| Large | scale nodes linearly; split export workers; Redis cluster |
