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

## AI and MCP (`[host.ai]` in the hosts file)

Off unless set per host. Phase 1 (AI-01) reads:

```toml
[host.ai]
mcp              = true                        # POST /mcp/{hostId}; default false (404)
mcp_issuer       = "https://id.acme.example"   # `iss` of MCP tokens; default the host id
mcp_audience     = "https://canvas.example.com" # public base URL of /mcp; default OC_PUBLIC_URL
mcp_all_files    = false                       # true: without /access, a token with no `files`
                                               # covers every file of the host (broad)
default_mode     = "suggest"                   # suggest | direct, for changes to existing content
mcp_rate_per_min = 120                         # per token; burst 2x
```

MCP tokens are verified with the host's launch-token keys (`jwt_secret`, `jwt_public_key` or
`jwt_jwks_url`). The token audience and the protected-resource metadata URL come from
`[host.ai] mcp_audience`, else `OC_PUBLIC_URL`, never from request headers: with neither set, MCP
is off (`404`) and start-up logs `MCP is off because OC_PUBLIC_URL isn't set` once (SEC-33).
Without the host's `/access` callback, MCP tokens must carry a `files` claim unless
`mcp_all_files = true` (SEC-34). WOPI sessions are capped at 10 h whatever `access_token_ttl`
says (SEC-35). Tool calls run on the node that
owns the room; in cluster mode a call that lands on another node is forwarded to the owner over
the signed internal API (`POST /v1/internal/tools/:room`, `OC_CLUSTER_SECRET`), carrying only the
verified identity (never the bearer token), with a request id so a retry never runs twice. If
the owner is unreachable the client gets `503` with `Retry-After: 2`.
The in-editor assistant (AI-02) reads the same `[host.ai]` table; see below.

## AI server switch (one switch for every AI feature)

AI is **off by default** and on only when all three hold: `OC_AI_CONFIG` names a file, that file
has `[ai] enabled = true`, and the kill switch `OC_AI` is not `off`. When it is off, every AI
feature is off for every host, whatever `[host.ai]` says: the session's `ai.enabled` and `ai.mcp`
are false, `POST /mcp/{hostId}` and its protected-resource metadata answer `404`, `ai-run`,
`ai-approve`, `ai-undo` and `ai-cancel` are refused (`ai-done` with `outcome: "refused"`, `reason:
"ai_disabled"`), and no provider is probed. Per host, `[host.ai] enabled` and `mcp` narrow it
further. The effective state is logged once at start-up (`AI: on`, `AI: off (OC_AI=off)`,
`AI: off (OC_AI_CONFIG unset)`, `AI: off ([ai] enabled = false)`) and shown as `"ai"` in `/readyz`.
To stop all AI in an incident: set `OC_AI=off` and restart (rolling).

## WOPI proof keys (required with a WOPI host)

| Variable | Default | Meaning |
|---|---|---|
| `OC_WOPI_PROOF_KEY` | none; generated with `OC_DEV=1` | Path of the current RSA proof key (≥ 2048-bit): PEM (PKCS#8 / PKCS#1) or sealed with `OC_KEK` by `opencanvas seal-proof-key < key.pem` |
| `OC_WOPI_PROOF_KEY_OLD` | the current key | Path of the previous key, same forms; published as `old*` in discovery and signs `X-WOPI-ProofOld` |

On Kubernetes, the Helm chart mounts the keys from a Secret: `wopi.proofKeySecret` (keys `current` and, during rotation, `old` with `wopi.oldKey: true`). See `deploy/helm/opencanvas/values.yaml`.

Every node of a cluster needs the same keys. Without a key, a hosts file with a `mode = "wopi"`
or `"both"` host stops start-up. Rotation and the signed bytes: docs/05 §6 "Proof keys".

## Import switch

Editors and hosts can import Markdown, HTML and CSV into a canvas (`POST /v1/import`,
docs/05 §7). Off unless a host lists formats in `[host.flags] import_formats = ["md","html","csv"]`
(unknown values stop start-up). `OC_IMPORT=off` turns import off for every host. Bodies are
limited to 5 MiB, CSV to 10,000 rows and 200 columns.

## AI (optional; AI-02, ADR-031)

AI runs entirely in the OpenCanvas server; browsers never see a key or call a model. It is off
unless `OC_AI_CONFIG` names a TOML file with `[ai] enabled = true`, and a host has `[host.ai]
enabled = true`. **Document content is sent to the configured model provider.** Keys come from
env (`api_key_env`), are held in memory only and never logged. At start-up each profile gets one
tool-call probe; a profile without working tool calling (or `tools = false`) serves answer mode
only. `context_tokens` sets how much input is sent (older turns are dropped first). Calls time
out after `timeout_secs` and retry `max_retries` times with backoff on 429/5xx.

```toml
# OC_AI_CONFIG=/etc/opencanvas/ai.toml
[ai]
enabled = true

[ai.providers.claude]                 # Claude Platform (Claude API)
kind        = "anthropic"
api_key_env = "OC_AI_ANTHROPIC_KEY"
model_agent = "claude-opus-5-5"
model_fast  = "claude-sonnet-5-5"
timeout_secs = 120

[ai.providers.vllm]                   # vllm serve Qwen/Qwen3-32B --enable-auto-tool-choice --tool-call-parser hermes
kind        = "openai-compatible"
base_url    = "http://vllm:8000"
model_agent = "Qwen/Qwen3-32B"
context_tokens = 32768

[ai.providers.ollama]                 # ollama serve; a tool-capable model (qwen3, llama3.1)
kind        = "openai-compatible"
base_url    = "http://ollama:11434"
model_agent = "qwen3:14b"
context_tokens = 16384

[ai.providers.llamacpp]               # llama-server --jinja -m model.gguf --port 8080
kind        = "openai-compatible"
base_url    = "http://llama:8080"
model_agent = "local"
tools       = true                    # set false if the model cannot call tools
context_tokens = 8192
```

Per host, in `hosts.toml` (the same table as the MCP keys above; `default_mode` applies to
the agent too):

```toml
[host.ai]
enabled  = true
provider = "claude"                   # a profile name from [ai.providers]
[host.ai.limits]                      # defaults shown
max_steps = 25
max_run_secs = 300
max_tokens_per_run = 400000
max_writes_per_run = 500
runs_per_user_per_hour = 60
concurrent_runs_per_room = 3
monthly_token_quota = 0               # tokens (input + output) per UTC month; 0 = no quota
```

Quota counters are kept in memory on the room owner node in this phase (reset on restart).
Metrics: `oc_ai_requests_total{host,provider,model,outcome}`, `oc_ai_tokens_total{direction}`,
`oc_ai_runs_total{outcome}`, `oc_ai_run_seconds`. No content.

## Health & metrics
- `/healthz` — process alive. `/readyz` — DB reachable, (cluster) Redis reachable, not draining;
  its body also carries `"ai": "on" | "off (<reason>)"`, the server-wide AI switch.
- `/metrics` (Prometheus text; `OC_METRICS_TOKEN` makes it need `Authorization: Bearer`).
  Every series it exports (OPS-01; histograms have buckets 1 ms … 5 s plus `_sum`/`_count`):

| Series | Type | Labels | Meaning |
|---|---|---|---|
| `oc_rooms_active` | gauge | | Rooms open on this node |
| `oc_connections_active` | gauge | | WebSocket connections on this node |
| `oc_ready` | gauge | | 1 when `/readyz` would answer 200 (DB reachable, not draining) |
| `oc_draining` | gauge | | 1 while draining after SIGTERM |
| `oc_commit_outbox_pending` | gauge | | Commits waiting for the host, whole store (same on every cluster node: use `max`) |
| `oc_http_responses_total` | counter | `code` (`1xx`…`5xx`) | HTTP responses; WebSocket upgrades are `1xx` |
| `oc_launches_total` | counter | | Sessions started |
| `oc_launches_rejected_total` | counter | `code` (`TOKEN_INVALID`, `TOKEN_EXPIRED`, …) | Launches refused |
| `oc_updates_total` / `oc_updates_rejected_total` | counter | | Edits accepted / refused (role, malformed) |
| `oc_wal_append_seconds` | histogram | | One room batch appended to the WAL (retries included); every accepted edit waits for it before fan-out, so it is the floor of sync latency |
| `oc_wal_batches_total` / `oc_wal_rows_total` | counter | | WAL batches and the updates in them (ratio = mean batch size) |
| `oc_saves_total` / `oc_save_errors_total` / `oc_save_conflicts_total` | counter | | Host acknowledged a save / a save failed (retried with backoff) / host answered 409/412 (conflict policy ran) |
| `oc_host_callback_seconds` | histogram | `host`, `op` | One call to the host (callbacks or WOPI); `op` = `load`, `save`, `copy`, `access`, `members`, `notify` |
| `oc_host_callbacks_total` | counter | `host`, `op`, `result` | `result` = `ok`, `conflict`, `4xx`, `5xx`, `unreachable`, `error` |
| `oc_export_seconds` | histogram | `format` | One export render (PDF includes Gotenberg) |
| `oc_exports_total` | counter | `format`, `result` (`ok`, `error`) | Exports (`md`, `html`, `json`, `ocanvas`, `docx`, `pdf`) |
| `oc_awareness_broadcasts_total` / `oc_awareness_coalesced_total` | counter | | Presence frames fanned out / parked on a full room inbox |
| `oc_schema_warnings_total` | counter | | Unknown content kept on read/write |
| `oc_ai_requests_total` | counter | `host`, `provider`, `model`, `outcome` | AI model calls (AI on only) |
| `oc_ai_tokens_total` | counter | `direction` | AI tokens in/out |
| `oc_ai_runs_total` / `oc_ai_run_seconds` | counter / histogram | `outcome` / – | Agent runs |
| `process_start_time_seconds` | gauge | | Process start (every OS) |
| `process_cpu_seconds_total`, `process_resident_memory_bytes`, `process_virtual_memory_bytes`, `process_threads`, `process_open_fds`, `process_max_fds` | counter / gauges | | From `/proc`: **Linux only** (the image); absent on macOS dev builds |

- Logs: JSON, request id, room id, host id; never content.
- Traces: OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` set.

## Dashboards and alerts (OPS-01)

Files: the Grafana dashboard `deploy/helm/opencanvas/files/opencanvas-dashboard.json` (generated
by `python3 deploy/monitoring/build-dashboard.py`; edit the script, not the JSON) and the alert
rules `deploy/helm/opencanvas/files/opencanvas-alerts.yml` (plain Prometheus rules; unit tests in
`deploy/monitoring/alerts-test.yml`). Dashboard variables: data source, job, namespace,
instance, host id. Rows: traffic and health, collaboration, persistence, host callbacks,
exports, process, security signals, cluster/Redis (text: no series yet), AI (collapsed).

**Kubernetes** (all off by default):
```sh
helm upgrade --install oc deploy/helm/opencanvas ... \
  --set grafanaDashboard.enabled=true \
  --set serviceMonitor.enabled=true --set serviceMonitor.labels.release=kube-prometheus-stack \
  --set prometheusRule.enabled=true --set prometheusRule.labels.release=kube-prometheus-stack \
  --set prometheusRule.memoryLimitBytes=1073741824
```
`grafanaDashboard` creates a ConfigMap labelled `grafana_dashboard: "1"` (the Grafana sidecar
convention); keep `memoryLimitBytes` equal to `resources.limits.memory`.
With `OC_METRICS_TOKEN` set, point `serviceMonitor.bearerTokenSecret` at the Secret and key that
hold it. ServiceMonitor and PrometheusRule need the prometheus-operator CRDs. Example values:
`deploy/helm/opencanvas/ci/monitoring-values.yaml`.

**Local quick-start** (Docker for Prometheus and Grafana; OpenCanvas built from the checkout):
```sh
cargo build -p oc-server -p oc-bench
docker compose -f deploy/monitoring/docker-compose.yml up -d   # Prometheus :9391, Grafana :3391
deploy/monitoring/demo-load.sh 600   # server :8791 (SQLite), 2 editors in one room via oc-bench
                                     # (saves to its mock host), host `broken` whose saves get 500,
                                     # md/docx/pdf exports, refused launches
open http://localhost:3391/d/opencanvas-ops     # anonymous viewer; admin/admin to edit
open http://localhost:9391/alerts
docker compose -f deploy/monitoring/docker-compose.yml down -v
```
Checks: `promtool check rules deploy/helm/opencanvas/files/opencanvas-alerts.yml` and
`(cd deploy/monitoring && promtool test rules alerts-test.yml)`; CI runs both in the `helm` job
through the `prom/prometheus` image.

### Alerts and runbook

| Alert | Fires when | Do this |
|---|---|---|
| **OpenCanvasDown** (critical) | `up == 0` for 2 min | Pod/container status and logs (`kubectl describe`, OOMKilled?). Clients reconnect to another node in a cluster; on one node editing stops until it is back (no edits lost while clients keep their tabs open). |
| **OpenCanvasNotReady** (critical) | `oc_ready == 0` and not draining for 5 min | The database (or Redis) is unreachable: check `DATABASE_URL`/`REDIS_URL`, the DB's health and connection limits; `/readyz` shows `"db": false`. |
| **OpenCanvasRestarting** (warning) | ≥ 2 process starts in 30 min | Crash loop: logs before the restart, `OOMKilled` (see memory), panics. Restarts lose at most `OC_DB_SYNC_MS` of edits in memory mode (see Durability mode). |
| **OpenCanvasMemoryNearLimit** (warning) | RSS > 85 % of `prometheusRule.memoryLimitBytes` for 10 min | Compare `oc_rooms_active`/connections with the Sizing table; raise the limit or add nodes (cluster). Memory ≈ 50 MB + 0.25 MB/user + 5–14× doc per room. |
| **OpenCanvasFileDescriptorsNearLimit** (warning) | open fds > 80 % of the limit | Raise `nofile`; each WebSocket holds one fd. |
| **OpenCanvasSavesFailing** (critical) | > 20 % of saves fail for 10 min | Dashboard "Host callbacks": which host, which result. `5xx`/`unreachable`: the host's save endpoint is down (edits stay in the outbox and are retried; nothing is lost while the DB holds them). `4xx`: callback token expired or rejected, check the host's signature secret. |
| **OpenCanvasOutboxGrowing** (warning) | outbox ≥ 5 and still growing for 15 min | Same as saves failing; also check the host's rate limits. Outbox rows survive restarts and are resent at start-up. |
| **OpenCanvasOutboxStuck** (warning) | outbox > 0 for a whole hour | One file's save keeps failing (look for `save failed` with its room id in logs); a 412/409 loop means a conflict the host keeps refusing. |
| **OpenCanvasHighSyncLatency** (warning) | WAL append p95 > 50 ms for 10 min | Slow or contended database (docs/22 §8 weaknesses 2 and 6): DB CPU/IO, SQLite on network storage, MySQL lock waits; consider the Redis hot WAL (ADR-028). |
| **OpenCanvasHostCallbackErrors** (warning) | > 5 % of one host's calls fail (5xx, unreachable, error) for 10 min | Tell that host's operators; `op` shows which callback. Loads failing means users cannot open files. |
| **OpenCanvasHostCallbackSlow** (warning) | one host's callback p95 > 2 s for 15 min | The host is slow; opens and saves feel it. Check its latency from inside the cluster. |
| **OpenCanvasPdfExportsFailing** (warning) | ≥ 3 PDF export errors in 15 min | Gotenberg down or erroring (`OC_PDF_RENDERER`), or unset (501). Check the Gotenberg pod/sidecar logs. |

### What has no metric yet (gaps)
End-to-end edit/sync latency (only the WAL append floor), connections by role, sessions alive,
snapshot/compaction counts and WAL bytes, outbox retry attempts, document sizes, cluster relay
frames, lease moves and Redis latency (use redis_exporter), rate-limited requests (MCP, launch),
role changes/revocations through `/v1/files/{id}/role`, Gotenberg health on its own (only via
PDF export errors). Gotenberg itself and the database are not scraped by this dashboard.

## Graceful shutdown / deploys
SIGTERM → refuse new rooms → commit all dirty rooms (≤ 20 s each, in parallel) →
`{"t":"reconnect"}` + close 1012 to every client (local and relayed) → release leases → exit.
Rolling deploys move rooms with a ≤ 5 s client reconnect. Give the container a stop grace
period of ≥ 30 s. While draining, `/readyz` answers 503 and new WebSocket upgrades get HTTP 503
with `Retry-After: 5` (refused before the upgrade), so clients and load balancers move on.

## Ephemeral hosts (ADR-043)

A host with `storage = "ephemeral"` keeps canvases only while their room is open. Room close
(idle `OC_ROOM_IDLE_MS` after the last person leaves, a drain, or the host's
`DELETE /v1/files/{id}/session`) deletes everything of that room in SQLite/MySQL and Redis.
A deploy therefore ends live ephemeral canvases: clients are told "This canvas ended with the
meeting". Drain such nodes between meetings where you can.

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
