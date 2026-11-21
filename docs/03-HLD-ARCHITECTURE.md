# 03 — High-Level Design (HLD)

**Status:** draft v0.1, 2026-11-21. Decisions referenced as ADR-xxx live in
[08-ADR-REGISTER.md](08-ADR-REGISTER.md).

## 1. System context

```
                        ┌──────────────────────────────────────────────┐
                        │              HOST APPLICATION                │
                        │  (your app, Nextcloud, LMS, CRM, any app)    │
                        │                                              │
   end user ──login──▶  │  users · auth · ACL · files · versions       │
                        │                                              │
                        │  ① mints launch token (JWT) or WOPI token    │
                        │  ⑤ implements callbacks: load / save /       │
                        │     assets / users                           │
                        └───────┬───────────────────────▲──────────────┘
                     iframe /   │                       │ HTTPS callbacks
                     web comp.  │                       │ (server → host)
                                ▼                       │
   ┌──────────────────────────────────────────────────────────────────┐
   │                         OPENCANVAS                              │
   │                                                                  │
   │  Browser:  editor bundle (ProseMirror/Tiptap + Yjs + board)     │
   │              │  ② HTTPS: /launch, /preview, /export             │
   │              │  ③ WSS:   /collab/{room}  (Yjs sync + awareness)  │
   │              ▼                                                   │
   │  Server (Rust, single binary):                                   │
   │    gateway · session mgr · room engine · commit engine ·        │
   │    export/preview · unfurl · host connector                      │
   │              │                                                   │
   │              ▼ ④ transient state only                           │
   │    SQLite (default)  |  MySQL / MariaDB (+ Redis) in cluster     │
   └──────────────────────────────────────────────────────────────────┘
```

**Responsibility split (ADR-001):**

| Host owns | OpenCanvas owns |
|---|---|
| Users, login, SSO | Editor UI, block model |
| ACL / roles per file | Enforcing the role the host handed us, per connection |
| Canonical file + version history | Live session state (until commit + TTL) |
| Asset bytes (images, attachments) | Asset upload proxy + cache |
| Retention, legal hold, search index | Exports (MD/HTML/PDF/DOCX/PNG) and previews |
| Sharing UI | Presence, cursors, comments-in-file, commits |

## 2. Containers / components

```
opencanvas-server  (one binary, all components; can be split later)
├── gateway            axum HTTP + WS, CORS/CSP, rate limits, request ids
├── auth               launch-token verify (JWT) | WOPI CheckFileInfo
│                      → produces a SessionGrant {host, file, user, role, perms, exp}
├── session-manager    open/join/close sessions, room ownership, routing
├── room-engine        per-document actor: Yrs Doc, awareness, fan-out,
│                      role filter, update log, snapshotting
├── commit-engine      autosave/manual commits → serialize .ocanvas → host PutFile,
│                      conflict handling, retry with backoff, outbox
├── host-connector     typed client for host callbacks (load/save/assets/users),
│                      per-host config, circuit breaker, timeouts
├── render             SSR preview HTML, exports (MD/HTML/PDF/DOCX/PNG/SVG)
├── unfurl             SSRF-safe link-preview + oEmbed fetcher with cache
├── store              sqlx Any: SQLite | MySQL | MariaDB; migrations
├── bus (cluster)      Redis pub/sub + room leases (optional)
└── ops                /healthz /readyz /metrics, OTel traces, JSON logs

opencanvas-web  (TypeScript)
├── @opencanvas/core     block schema, Yjs bindings, serializers (shared with server via WASM later)
├── @opencanvas/editor   Tiptap/ProseMirror editor, slash menu, drag handles, tables
├── @opencanvas/board    board block: SVG/Canvas2D renderer on Y.Map shapes
├── @opencanvas/preview  tiny read-only renderer (no Yjs) for preview mode
└── @opencanvas/embed    host SDK: <open-canvas> web component + postMessage API
```

## 3. Key flows

### 3.1 Open (JWT launch mode)
```
Host backend        Browser (host page)          OpenCanvas            Host callbacks
     │ sign JWT{file,user,role,perms,cb}  │                    │                      │
     │──────────────────────────────────▶│                    │                      │
     │                 │ iframe POST /launch (token) ─────────▶│ verify sig, exp, aud │
     │                 │                                      │── GET file ─────────▶│ (if room not live)
     │                 │                                      │◀─ .ocanvas bytes ────│
     │                 │                                      │ load into room       │
     │                 │◀─ editor HTML + session cookie/ticket │                      │
     │                 │── WSS /collab/{room}?ticket ─────────▶│ sync step1/2, awareness
```
- If the room is already live (another user editing), the server **does not
  re-fetch** the file — the new user joins the live CRDT. This is how
  Collabora/Loop behave and avoids fork-on-open.
- The JWT is used once; the browser gets a short-lived, single-room
  **session ticket** for the WebSocket (ADR-005).

### 3.2 Open (WOPI mode)
Identical, except step "verify" is `GET {WOPISrc}?access_token=…`
(CheckFileInfo) → role from `UserCanWrite` / `UserCanComment` / ReadOnly, and
file is fetched with GetFile. Saves use PutFile with `X-WOPI-Override: PUT` and
`X-COOL-WOPI-Timestamp`-style conflict detection (`LastModifiedTime`).

### 3.3 Edit
1. Client applies change locally (instant), produces a Yjs update.
2. Sends `sync:update` over WS.
3. Room engine: **role check** (edit role; comment role may only touch the
   `comments` subtree) → apply to server Doc → append to `room_updates`
   (durable tail) → fan out to all peers (local + other nodes via bus if
   viewers are spread).
4. Awareness (cursor, selection, pointer, colour, name) is ephemeral — never
   stored, fan-out only, throttled to 20 Hz.

### 3.4 Commit
Triggers: manual "Save version", autosave interval (default 60 s with
changes), idle (30 s without edits), last user leaves, session close API,
graceful shutdown.
```
room-engine ──(dirty since last commit)──▶ commit-engine
  serialize Doc → .ocanvas (zip: document.json, ydoc.bin, manifest.json)
  POST host save callback  (If-Match: last host version)
    200 → record host_version, clear dirty, emit "saved" to clients
    409 → host changed file outside session → emit "conflict" →
          policy: (a) save-as-copy callback, or (b) reload host version
          and merge as a new branch, per host config
    5xx/timeout → outbox retry with backoff; UI shows "saving… retrying"
```
Commits are **at-least-once** with an idempotency key
(`commit_id` = ULID) so hosts can dedupe.

### 3.5 Preview / download
- `GET /preview?token=…` → server fetches file (or uses live room state if
  `live=1` and room exists), renders static HTML via `render`. No WS, no Yjs on
  the client — fast and cacheable by `(file_id, host_version)`.
- `GET /export/{format}?token=…` → same source, renders MD/HTML/PDF/DOCX/PNG.
  PDF via headless Chromium pool **optional** sidecar; fallback to HTML print.

### 3.6 Close / cleanup
After final commit succeeds and no clients remain for `ROOM_TTL_SECS`
(default 10 min): drop room from memory, delete `room_updates` and snapshot
rows. Nothing about the document remains on our side (Principle 3).

## 4. Data & persistence (transient only)

| Data | Where | Lifetime |
|---|---|---|
| Canonical document | **Host** | forever (host-managed) |
| Room snapshot (Yjs state v2) | DB `room_snapshots` | until room purge |
| Update tail since snapshot | DB `room_updates` | compacted into snapshot every N=500 updates / 30 s |
| Sessions, tickets | DB `sessions` | ≤ token exp |
| Commit outbox | DB `commit_outbox` | until host ack |
| Host registry (keys, callback base, flags) | DB `hosts` or config file | static |
| Unfurl cache | DB `unfurl_cache` | 24 h |
| Awareness | memory only | connection lifetime |
| Audit events | logs/OTel (optional DB table) | ops policy |

Why keep snapshot + tail at all? So a node crash or deploy never loses an
acknowledged edit that has not been committed yet. It's a write-ahead log,
not storage.

Database selection (ADR-004): `DATABASE_URL` unset → `sqlite://./data/opencanvas.db`
(WAL mode). `mysql://` → MySQL 8 / MariaDB 10.6+. Same migrations, sqlx `Any`
driver, portable SQL subset.

## 5. Scalability model

### 5.1 Single node (default)
SQLite + in-process rooms. Handles thousands of connections. Zero
dependencies.

### 5.2 Cluster (MySQL/MariaDB + Redis)
```
             ┌───────── L7 load balancer ─────────┐
             │ HTTP: round-robin                  │
             │ WS: hash(room_id) → node (sticky)  │
             └───────┬──────────┬──────────┬──────┘
                   node-1     node-2     node-3   (identical binaries)
                     │  owns rooms by lease   │
                     └──── Redis (leases) ─ internal WS relay ┘
                     └──── MySQL/MariaDB (snapshots, tails, outbox) ────┘
```
- **One owner per room** (ADR-006). The owner holds the authoritative Yrs Doc
  in memory. Ownership is a Redis lease (`SET room:{id}:owner node NX PX`)
  renewed every 5 s.
- If the LB routes a client to a non-owner, that node **relays** the connection
  to the owner over one internal WebSocket per client connection
  (`/v1/internal/relay/:room`, HMAC-signed with `OC_CLUSTER_SECRET`, the grant
  forwarded signed). Per-connection order is TCP order; the owner treats the relayed
  connection like a local one and enforces roles. Clients never need to know.
  Host-API room calls (patch, commit, role, close, state for exports) on a non-owner
  are forwarded to the owner (`POST /v1/internal/rooms/:room`, same signature).
- Owner dies → its relays break; the edge node probes the owner's `/healthz` and, if
  the process is gone, takes the lease over with a compare-and-set on the dead
  owner's value (otherwise the lease expires after 15 s). The new owner loads
  snapshot + WAL from the DB and continues; clients are told `reconnect` (1012) and
  resync in well under 5 s. Unacked client updates are resent by the Yjs client on
  reconnect (Yjs sync is idempotent). A node whose renewal finds another owner steps
  the room down (clients reconnect, no save).
- **Fencing** (docs/22 §8 weakness 3). A lease alone cannot stop a node that was paused past
  its TTL from writing before its next renewal. Every room actor takes the room's next
  **epoch** from the database (`room_epochs`, bumped in one transaction) as it loads, with the
  lease held and before it reads the WAL. WAL appends are a single guarded
  `INSERT … SELECT … FROM room_epochs WHERE room_id = ? AND epoch = ?`; snapshots, outbox rows
  and the closing purge start their transaction with `UPDATE room_epochs … WHERE epoch = ?`
  (row lock). A write with an older epoch changes nothing and the actor stops at once: no
  fan-out, no save, clients get 1012 and reconnect to the new owner. The same holds on SQLite
  and MySQL/MariaDB, and with Redis lost (the epoch lives in the database).
- An update is fanned out only after its WAL append succeeded. A failed append (after
  deadlock retries) closes the room with 1012 and no save: the next actor rebuilds from the
  WAL and clients resend what it lacks. Deadlocks (1213) and lock waits (1205) are retried
  3 times with jittered backoff (25-50 ms, 50-100 ms); a save never goes to the host without
  its outbox row.
- The outbox sweeper claims a row (`claimed_by`, `claim_until`) and the room lease
  before resuming it, so two nodes never resend the same commit.
- SIGTERM drain: `/readyz` turns 503, WebSocket upgrades are refused with 503 +
  `Retry-After: 5` (before the upgrade), refuse new rooms, commit dirty rooms, `{"t":"reconnect"}` + close
  1012 to every client (local and relayed), release leases, exit.
- `REDIS_URL` with SQLite refuses to start (SQLite is single-node only).
- Stateless HTTP (launch/preview/export) scales horizontally with no
  coordination. Export rendering can be split into a worker pool.
- Large rooms: viewers can be fanned out by non-owner nodes from a Redis
  channel, so a 500-viewer room does not saturate one node.

### 5.3 Capacity math (2 vCPU node)
- Yrs apply + broadcast ≈ 10–50 µs per small update; 300 rooms × 10 upd/s =
  3 000 upd/s ≪ capacity. Bottleneck is fan-out bytes, not merge.
- Memory: ~ 3× doc size per live room; 300 rooms × 1 MB × 3 ≈ 900 MB worst,
  typical 100–200 MB.

## 6. Security architecture (summary — detail in [07](07-SECURITY-AND-LIMITS.md))
- Per-host keys; JWT `aud`, `iss`, `exp ≤ 10 h`, `jti` replay cache.
- Role enforced **server-side per frame**; client UI is advisory only.
- Embeds rendered in `sandbox` iframes from an allow-list; user HTML never
  rendered unsanitised; CSP `frame-ancestors` = host origins.
- Unfurl fetcher: DNS-pinned, private-IP block, size/time caps.
- No document content in logs; PII limited to display name/avatar in memory.

## 7. Deployment
- Docker image (distroless, ~20 MB) + `docker-compose.yml` (single node,
  SQLite) + `docker-compose.cluster.yml` (3 nodes, MariaDB, Redis, nginx).
- Helm chart (P2). Config via env vars + optional `opencanvas.toml`.
- Graceful shutdown: stop accepting, commit all dirty rooms, release leases.

## 8. Technology choices

| Concern | Choice | ADR |
|---|---|---|
| Server | Rust, tokio, axum | ADR-003 |
| CRDT | Yjs (client) / yrs (server) | ADR-002 |
| DB | sqlx Any: SQLite default; MySQL/MariaDB | ADR-004 |
| Cluster bus | Redis (optional) | ADR-006 |
| Editor | Tiptap (ProseMirror) + y-prosemirror | ADR-007 |
| Board | custom SVG/Canvas2D on Y.Map | ADR-008 |
| File format | `.ocanvas` zip (JSON + Yjs state) | ADR-009 |
| Integration | JWT launch + WOPI-compatible | ADR-005 |
| Exports | Rust renderers; optional Chromium sidecar for PDF | ADR-010 |
