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
