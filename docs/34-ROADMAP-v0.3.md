# 34 — v0.3 design plan: live blocks, offline-first editing, search, automation

**Status:** Proposed 2026-11-26 (owner asked to start v0.3 the same day). ADRs 063–069 (Proposed) in
[docs/08](08-ADR-REGISTER.md); tracker rows in [docs/10](10-EXECUTION-TRACKER.md) §P3 v0.3.
Prototypes for every screen are in V3UI-01 and gate all UI rows (ADR-011).
**Scope:** the v0.3 line of [docs/09](09-ROADMAP.md#release-roadmap): portable live blocks, offline-first
editing, search and automation.
**Not in scope:** partial sync, multiplexed room sockets and advanced databases (v0.4); a plugin
marketplace and server-side third-party code (v0.5); cross-canvas automation actions (§5.9).

Constraints every design below keeps (as in [docs/27](27-ROADMAP-v0.2.md)):

- **The host owns auth, ACL and files; OpenCanvas never persists documents** (ADR-001, AGENTS
  rule 5). The server's database holds transient room state and metadata only. §3 and §4 explain
  how offline and search keep this.
- **The server enforces roles on every frame** (rule 6). Offline edits, replaces and automation
  writes all pass through the same role filter and MOD-01 validation as typing.
- **One canvas tool layer** shared by the REST API, MCP and the agent runtime (ADR-032, ADR-041).
  Automation actions are operations on it, not a second write path.
- **Standard APIs only** (ADR-038): tokens, callbacks, REST, WebSocket, webhooks, postMessage,
  `<open-canvas>`, MCP. Nothing assumes a particular host.
- **`.ocanvas` stays format version 1** (ADR-042): every addition (the `automations` root,
  `search.json`) is additive and round-trips through 0.2.x and 0.1.x.
- **Feature flags:** each feature is off for a host until its `[host.*]` table turns it on, and the
  0.2 behaviour is unchanged without it.

Sizes in §7: **S** ≤ 2 days, **M** ≤ 1 week, **L** ≤ 3 weeks, for one engineer.

---

## 1. Research

Accessed 2026-11-26 from the project's notes and earlier research (docs/01, docs/27 §1); facts
not re-checked today are marked "unverified".

| Topic | Prior art | What we take |
|---|---|---|
| Browser persistence for Yjs | `y-indexeddb` stores the update log per document in IndexedDB and merges it on load; Yjs updates are commutative and idempotent, so replaying local and remote updates in any order converges (docs/27 [18]). | Use `y-indexeddb` (or the same scheme in our own small module) for the cache; no custom merge. |
| Storage in third-party iframes | Chrome and Firefox partition storage of embedded frames by top-level site; Safari partitions and may delete script-written storage after 7 days without use (ITP; unverified for the current release). `navigator.storage.persist()` asks the browser not to evict. | The cache is naturally per host site. We ask for persistence and tell people a browser may still evict it. |
| Offline in collaborative editors | Google Docs offline is opt-in per file and per device, and asks admins to allow it; Notion and Loop keep recent pages; Linear and Figma show a clear offline indicator and a sync count (unverified details). | Opt-in at two levels (host, person), a status pill with a count, and a quiet result. |
| Logout on shared devices | OIDC front-channel logout loads a hidden iframe per relying party to clear its session; `Clear-Site-Data` clears only the unpartitioned storage of a top-level response. | A logout iframe endpoint for the host to load, and an SDK call. |
| Cross-product search | Nextcloud's full-text search lets apps provide content to the host's index; Confluence and Google Drive index on save; Notion search is in-product. | The host indexes; OpenCanvas provides the text with every save. |
| Automation | Notion database automations (trigger on property change, actions set property, notify, webhook); Airtable automations (triggers on record/schedule, run history, limits per base); Zapier and n8n (external, webhook-driven). | Sentence-style rules on a canvas, a run history, hard limits, and the webhook rules for outbound calls. |

---

## 2. Portable live blocks

docs/27 §2 is the design (LIVE-01..06, ADR-039, owner decisions docs/27 §9). This section lists only
what changes for v0.3 (ADR-069).

### 2.1 Deltas

1. **Header always visible.** A live block shows a thin header (Live mark, title, the host path,
   people inside, Open source, menu). SDK blocks show their badge on hover only; live blocks
   differ because their access and edits belong to another file (prototype 2a).
2. **Insert from the host's picker.** postMessage `UI_PickLiveBlock` → the host shows its own
   picker → `Action_InsertLiveBlock {fileId}`. OpenCanvas keeps no list of live files. Pasting a
   block link asks Live block / Reference / Link (1d, 1e).
3. **Unlink ("Convert to a copy").** Replaces the reference with a plain copy of what the person
   can read now, one undoable transaction; needs edit on the canvas and view on the live file
   (LIVE-07).
4. **Usage events.** New event types `live.embedded` and `live.removed` on the events stream and
   webhooks (ADR-056 config `events`), so the host can answer "where is it used". OpenCanvas
   keeps no usage index (LIVE-07).
5. **Who can see this.** The popover counts canvas members who cannot open the live file, from
   `/access` answers (cached 30 s), only when the member list has 200 people or fewer.
6. **Presence labels** say where a person is ("Amara · in Leadership weekly"): the awareness
   state of a live room gains `from: {fileId, title}`, written by the server from the parent
   grant (never by the client), and omitted when the viewer cannot read that parent's title
   (owner decision 3 on the page).
7. **Offline (§3).** A live block is cached only when its own file is available offline; otherwise
   it shows its last projection as "Not up to date" with editing off (5b).
8. **Search (§4).** In-canvas find includes live blocks the person can read; replace inside one
   applies in the live file's room and needs edit there. `search.json` of the embedding canvas
   lists the live block by id and title only; the live file has its own `search.json`.
9. **Automation (§5).** Rules never write into a live block from the embedding canvas; a live file
   can carry its own rules.

### 2.2 Prototype

`live-blocks.html` (V3UI-01): Make live, paste and host picker; chrome at rest, presence, menu,
access, view only, unlink; reference card states; compact view in a chat, a narrow panel and the
read-only render; failure states (connecting, not up to date, no access with and without title,
deleted, revoked, limits); phone; host contract.

### 2.3 Tests and acceptance

docs/27 §2.6 stays (LIVE-A1..A7 in docs/23, deferred from ACC-V2), plus: unlink produces a plain
copy and leaves the live file untouched; `live.embedded` and `live.removed` arrive once per
insert or removal across a two-node cluster; presence `from` is absent for a viewer without
access to the other canvas.

---

## 3. Offline-first editing

### 3.1 Problem and user value

People edit on trains, in planes and on bad hotel Wi-Fi. Today a dropped connection keeps the
document in memory and resyncs when the socket returns, but closing the tab loses unsent edits,
and a canvas cannot be opened without the network. Offline-first editing lets a person open and
edit a canvas they chose to keep on their device, and merges the changes when they are back,
without losing anyone's work.

### 3.2 How it squares with "never persist documents"

ADR-001 is about the **server**: OpenCanvas stores no document beyond transient room state; the
host stores files. Offline editing adds no server storage of content. It puts a copy **on the
person's own device**, which is what a download already does (`perms.download`), so it is the
host's decision in the same way:

- **Off by default.** `[host.offline] enabled = false`. A host that turns it on also decides per
  launch with the token claim `perms.offline` (for example false for shared or "don't keep me
  signed in" sessions, or for files above a sensitivity label).
- **Opt-in per canvas per device** by the person ("Available offline on this device"), unless the
  host sets `auto_recent = N`.
- **Bounded and revocable:** every cached canvas carries a server-signed **offline grant** with an
  expiry (7 days by default, at most 30); every reconnect is a fresh launch through the host; the
  host can revoke all of a person's offline copies (§3.6).
- **Server side:** the only new server state is one metadata row per (host, user) holding a
  revocation generation number (§3.6). No content.

### 3.3 Design

**Three levels of resilience.**

| Level | When | Storage | What the person sees |
|---|---|---|---|
| Session | always (as in 0.2) | memory only | "Offline · not saved yet"; closing the tab warns |
| Offline cache | host allows and the person turned it on for the canvas (or `auto_recent`) | IndexedDB on the device | "Offline · saved on this device"; the canvas opens without network |
| Locked | the offline grant expired while offline | IndexedDB, unreadable in the UI | title only and "Reconnect to unlock"; unsent changes kept |

**Local store.** One IndexedDB database per (host id, user id, file id), holding the Yjs update
log (`y-indexeddb` scheme), the offline grant, the last confirmed server state vector, a pending
queue of uploads, and small metadata (title, last sync time, sizes). The editor writes to it on
every local transaction, as Yjs does for the socket. Values are encrypted with AES-GCM under a
**device key** (a non-extractable WebCrypto key in its own IndexedDB store, one per host and user).
This is not protection against someone who controls the browser profile; its purpose is
crypto-shredding: deleting the key makes every cached canvas unreadable even if the browser keeps
the database files for a while (§3.7).

**Offline grant.** When a session opens with `perms.offline` and the host allows it, the server
returns `offlineGrant`: a compact JWS (ES256) signed with the server's key, claims `{iss, host, sub
(user), file, role, exp, gen, perms}`; `role` is the launch role capped by `[host.offline]
max_role` (default `edit`). The editor uses it **only locally**: to decide whether the cached
canvas may open, in which role, until when. It is never a credential to the server.

**Opening offline.** The `<open-canvas>` web component (and the iframe launch page, through a
service worker) detects that the launch cannot reach the server or the host. If the device has a
cached canvas for that host, user and file with a valid grant, it opens it from IndexedDB with the
editor assets from Cache Storage (the service worker caches the editor build, versioned). The
host page itself must load offline for this; that is the host's part (an installed web app, or a
native shell).

**Reconnect and merge.**

1. The editor notices the network (socket opens or `online`) and asks the host for a fresh launch
   token through the existing `POST /tokens/refresh` callback (through the SDK; WOPI hosts are
   out of scope in v0.3). With a new token it gets a new ticket. **The grant is not used.**
2. The server answers with the current role and `offline: {allowed, gen}`. If the role is lower
   or the access is gone, §3.6 applies before anything is sent.
3. The editor sends its state vector; the server answers with what the device lacks (normal
   SyncStep1/2). Queued uploads go first (below); then the device sends its pending updates
   **chunked**: each frame ≤ 1 MB (under `OC_MAX_FRAME_KB`) and within the frame rate limit
   (60/s), so a large offline session does not trip 1009 or 4429.
4. Every frame is checked like typing: role filter, MOD-01 validation, size limit, SDK schemas.
   A refused frame is reported to the client (auth frame) and the client keeps the rest; refused
   changes are listed in the merge summary.
5. **Checkpoint first.** When the pending log covers more than 10 minutes or 200 transactions, the
   client sends a control message `{"t":"offline_merge","changes":N,"since":ts}` before the first
   chunk; the server saves a checkpoint version (`X-OpenCanvas-Checkpoint: 1`, commit message
   "Before Priya's offline changes", ADR-051) so the host's history can restore the state before
   the merge.
6. Yjs converges. The editor then compares its pre-merge snapshot with the merged document to
   find what needs attention (below), shows a quiet toast "Your 23 offline changes are saved", and
   the server's next autosave sends the merged file to the host.

**What can need attention after a merge** (shown in a merge summary only if one of these happened):

- **Edits inside a block someone else deleted.** Yjs drops them with the block. The client still
  has its pre-merge copy and offers "Restore my text as a new block" next to where it was.
- **The same database cell changed on both sides.** Y.Map keeps one value, chosen by client id:
  deterministic, but not "the last writer". The summary shows both values and whose was kept,
  with "Use mine" and "Keep theirs".
- **Changes the server refused** (role changed, validation, limits), with a count.
- Text edited concurrently in the same sentence is merged character by character and is **not**
  flagged (that is normal collaborative editing).

**Queued uploads.** An image or file added offline is stored in the device's queue (≤ 20 files,
≤ 50 MB per canvas) and inserted with `src = "oc-pending:<uuid>"` plus `pendingBy`. On reconnect
the client uploads through the existing asset callback and rewrites the attribute in one
transaction. Collaborators see "Uploading from Priya's device" until then. MOD-01 accepts the
`oc-pending:` scheme only with `pendingBy` equal to the writing user; exports draw a placeholder;
a pending asset older than 7 days is shown as "Upload didn't arrive".

**Features offline.** Available: editing text, checklists, databases, boards, comments (sent on
reconnect; mentions notify then). Disabled with a reason: the AI assistant, version history,
cross-canvas search, insert templates from the host, live blocks whose file is not cached (they
show their last projection), SDK blocks that need the network (the block decides; the sandbox
still runs from the cache).

**Limits (per person, per host, per device).** 50 cached canvases (`max_canvases`); 200 MB in
total (`max_mb`); 5 MB of unsent changes per canvas (`unsent_mb`), after which editing pauses with
an explanation; queued uploads 20 files and 50 MB per canvas (`uploads_mb`); the grant lifetime
`grant_days` (default 7, at most 30). The editor asks `navigator.storage.persist()` when the first
canvas is cached.

### 3.4 Data model changes

```ts
// launch token (docs/05 §3)
perms.offline?: boolean               // default false
offlineReason?: "shared-device" | string   // optional: shown when the menu item is unavailable
// session answer (GET /v1/session) gains
offline?: { allowed: boolean, gen: number, grant?: string /* JWS */, maxDays: number }
// image/file node attrs (additive)
src: "oc-pending:<uuid>", pendingBy: "<userId>"
```

New metadata table `offline_generation (host_id, user_id, gen, updated_at)` (migration 0011, SQLite,
MySQL, MariaDB; Redis key `oc:offgen:<host>:<user>`). No content.

### 3.5 API sketch

```http
POST /api/v1/offline/revoke                 # host key or canvas:admin; all of a user's offline copies
{ "userId": "u_123" }                       # → 200 { "gen": 4 }   (gen += 1)

GET  /v1/offline/clear?host=acme            # page for a hidden iframe at host logout:
                                            # deletes the device keys, then the databases,
                                            # for that host on this browser; posts OC_OfflineCleared
```

SDK: `OpenCanvas.clearOffline({ host?, userId? }) → Promise<void>`; `OpenCanvas.offlineFiles()`
(the canvases kept on this device, for the host's own offline page); `<open-canvas offline>`
attribute to allow offline opening; events `UI_OfflineState {state, pending}`.

Config:

```toml
[host.offline]
enabled      = false    # opt-in per host
auto_recent  = 0        # >0: cache the last N opened canvases without asking
grant_days   = 7        # offline grant lifetime, 1-30
max_role     = "edit"   # edit | comment | view
max_canvases = 50
max_mb       = 200      # all cached canvases of one person on one device
uploads_mb   = 50       # queued uploads per canvas (and at most 20 files)
unsent_mb    = 5        # unsent changes per canvas before editing pauses
```

### 3.6 Security

- **Revocation on reconnect.** Every reconnect is a fresh host launch, so the host's current ACL
  decides. Role now `view`: pending changes are not sent; the person can download their version
  (if `perms.download`) or discard. Access gone (`none`, 403, or `/access` none): the canvas's
  local copy is deleted, the pending changes are discarded and their number is shown. **Host-wide
  revocation:** `POST /api/v1/offline/revoke` raises the user's generation; a device whose grants
  carry a lower `gen` deletes every cached canvas for that host and user at the next contact with
  the server (any session answer carries `gen`).
- **Expiry while offline.** After `exp` the canvas locks: only the title shows; pending changes
  stay encrypted until a reconnect decides as above. The device clock can be wound back; the grant
  limits how long a stolen device keeps working only together with the OS lock, which is why the
  default is 7 days.
- **Shared computers and logout.** The host decides with `perms.offline` (false for shared
  sessions). At logout the host calls `OpenCanvas.clearOffline()` or loads
  `/v1/offline/clear` in a hidden iframe (the storage is partitioned by host site, so the host
  page must do it from its own site). Clearing deletes the device key first (crypto-shred), then
  the databases and the upload queue. Another person signing in on the same browser profile gets
  their own databases (keyed by user id) and never sees the previous person's canvases or titles.
- **XSS.** The cache is reachable from the editor origin's script, as the live document already
  is; the editor's CSP (no inline script, no third-party script; SDK blocks are on their own
  origin) is the control. SDK block iframes cannot read the cache.
- **What the device holds** is listed in the person's settings ("Offline canvases on this device",
  with storage used and Remove).

### 3.7 Tests and acceptance (ACC-V3 rows OFF-A1..A8)

- Fuzz: two clients edit the same canvas, one offline for a simulated day with 2,000 transactions
  (text, lists, database cells, board shapes), then reconnect; documents converge byte-equal and
  the server's role filter saw every frame (extend the convergence fuzz harness).
- Chunked catch-up of 5 MB of pending updates is accepted without 1009 or 4429.
- Downgrade to view while offline: nothing is applied; revoke: the IndexedDB databases for that
  file are gone (checked in Playwright through `indexedDB.databases()`).
- `POST /api/v1/offline/revoke` then any session for that user deletes every cached canvas on the
  device.
- `clearOffline()` and the clear iframe leave no OpenCanvas IndexedDB database or Cache Storage
  entry for that host.
- Locked after expiry by an injected clock; unlocked and merged after reconnect.
- Edits in a block deleted remotely are offered for restore; concurrent cell edits are listed.
- The server database contains no document text after an offline merge (byte search, as the
  ADR-001 test does).
- Playwright `context.setOffline(true)` end to end in Chromium, Firefox and WebKit.

---

## 4. Search

### 4.1 Problem and user value

People need to find a phrase in a long canvas and fix a name everywhere in it, and to find which
canvas holds a decision. The first is ours alone; the second crosses files the host owns.

### 4.2 Find and replace in a canvas (ADR-066)

Client-side over the live document, so it sees every collaborator's latest text and costs the
server nothing.

- **Where it looks:** text blocks, database cells and titles, board text (shapes, stickies,
  connectors' labels), headings; comments as an option (find only). Live blocks the person can
  read are included and labelled. SDK blocks are searched through their stored fallback text
  (their content lives in the sandbox).
- **Options:** match case, whole word, regular expression (JavaScript syntax, run with a 50 ms
  budget per pass; an invalid or slow pattern shows an inline error).
- **UI:** a floating find bar at the top right of the document column; ⌘F / Ctrl+F opens it
  while focus is in the canvas (the browser's own find still works outside it); Enter and
  Shift+Enter move; ⌘⌥F / Ctrl+H opens replace; Esc closes and returns focus. "3 of 12", matches
  marked in the scrollbar, decorations that update as others type.
- **Replace** is offered to editors only; viewers and commenters see find only, and the server
  refuses anything else anyway. "Replace all" is **one transaction and one undo step**, with a
  toast "Replaced 12 · Undo". Matches inside a live block are replaced in that block's room, as a
  second step that needs edit there.
- **Limits:** up to 10,000 highlighted matches; beyond that the count shows "10,000+" and only
  the visible ones are drawn.

### 4.3 Search across canvases (ADR-065)

**The decision: the host indexes. OpenCanvas keeps no index and supplies the text.**

1. **Text with every save.** Each saved `.ocanvas` gains `search.json` (additive, format 1): a
   plain-text projection of the document with block ids for deep links. The host's save handler
   (JWT `PUT /files/{id}` or WOPI `PutFile`) already has the bytes; it reads `search.json` from the
   zip and indexes it in its own engine under its own ACL. Nothing extra is sent anywhere.
2. **Stateless extraction.** `POST /api/v1/extract` (host key or `canvas:read`) takes a `.ocanvas`
   (or Markdown) body and returns the same JSON, for hosts that cannot unzip or that want to
   re-index old files. It stores nothing.
3. **Search from inside OpenCanvas.** An optional host callback `GET /search?q=&cursor=&limit=`,
   signed like every callback and sent with the person's `callbackToken`, returns results the
   host's ACL allows: `{items:[{fileId, title, path, blockId?, snippet, updatedAt}], next}`. The
   editor shows "Search all canvases" (⌘⇧F) only when the host has it; results open the canvas at
   the block (`#block=<id>`), which scrolls into view and flashes.
4. **For programs.** `GET /api/v1/search?q=` proxies the same callback, and an MCP tool
   `canvas_search` adapts it (ADR-041 parity). It needs a **user** token (a host key gets 400
   `USER_TOKEN_REQUIRED`: no "search as everyone"), 10 requests a minute per user.

Host config `[host.search]`: `callback` (on/off), `comments` (default false), `timeout_ms` (8,000).
The callback returns at most 50 items per page, may group them in up to 4 host scopes and may set
`partial: true` (the editor says some results are missing). Results are never cached by
OpenCanvas. Opening a result in another canvas sends the new postMessage event
`UI_OpenFile {fileId, blockId}` so the host navigates (docs/05 gains the row); the editor opened
with `#block=<id>` scrolls to the block and flashes it. `POST /api/v1/extract` accepts
`application/vnd.opencanvas+zip` (or Markdown) up to 100 MB and answers 413 or 422.

```json
// search.json (in the .ocanvas zip; ≤ 2 MB, then "truncated": true)
{ "v": 1, "title": "Sprint 42 planning", "lang": "en",
  "blocks": [ { "id": "b_9f2", "type": "heading", "path": ["Release 4.2"], "text": "Release 4.2" },
              { "id": "b_a10", "type": "todo", "path": ["Release 4.2"], "text": "SSO set-up docs updated", "done": false } ],
  "databases": [ { "id": "db_1", "title": "Sprint 42 backlog",
                   "rows": [ { "id": "r_1", "text": "Fix CSV export timeout · Marco Bianchi · In review" } ] } ],
  "boards": [ { "id": "bd_1", "text": "Hero copy is too long on phones · Pricing toggle: monthly first" } ],
  "live": [ { "blockId": "b_c3", "fileId": "doc_9120", "title": "Release 4.2 checklist" } ],
  "truncated": false }
```

Comments are left out unless `[host.search] comments = true` (a comment's audience can differ
from the file's in some hosts). In-file history (ADR-055) is never included. Live blocks are
listed by title only; their text is in their own file's `search.json`.

**Why this design** (alternatives kept in ADR-065):

| Option | Verdict |
|---|---|
| A. OpenCanvas keeps a full-text index of every canvas | **Rejected:** persists document content on the server (ADR-001), duplicates the host's ACL and goes stale when the host changes permissions. |
| B. Search only rooms that are open on the cluster | **Rejected as the main design:** most files are closed; results would depend on who happens to be editing. Possible later as a freshness overlay. |
| C. A host-fed index callback (OpenCanvas asks the host for candidate files, then loads and scans them) | **Rejected:** loads many files per query through callbacks; slow and expensive for the host. |
| D. Text in the `file.saved` webhook | **Rejected:** webhook payloads are written to the outbox table, which would put text in our database (ADR-056 keeps payloads to ids and counts). |
| **E. Text inside every save + stateless extract + optional host search callback** | **Chosen:** no new storage anywhere in OpenCanvas, the host's ACL and search engine decide, fresh at every save (autosave runs within seconds of a pause), works for JWT and WOPI hosts. |

**Freshness.** Results reflect the last save; the editor says "Results update when a canvas is
saved". Autosave makes that seconds, not minutes.

### 4.4 Security

- No text leaves OpenCanvas except inside the file the host already receives and in answers to
  authorised API calls.
- The host's callback answers must be ACL-filtered; OpenCanvas also drops results whose `fileId`
  the person cannot open (`/access`, when the host has it) before showing snippets.
- Snippets are text, escaped; query highlighting is done by the editor.
- `POST /api/v1/extract` has the upload size limits and import checks of FC-10, a 2 s CPU budget,
  and the per-subject rate limit.

### 4.5 Tests and acceptance (SRCH-A1..A6)

- Replace all of 500 matches is one undo step; a viewer's crafted replace update is refused by the
  server.
- Find sees a collaborator's new text within one update.
- `search.json` round-trips in 0.2.x and 0.1.x readers (ignored, preserved); it contains no
  comment text by default and no in-file history.
- The sample host indexes `search.json` on save and serves `GET /search`; the editor's results
  open at the block.
- `GET /api/v1/search` and `canvas_search` return the same items (parity test).
- The server database holds no text after extraction and searches (byte search).

---

## 5. Automation

### 5.1 Problem and user value

Teams repeat small chores in canvases: move finished tasks to an archive, remind the owner the day
before a due date, add next week's checklist every Monday, tell another system when an item is
done. Webhooks (v0.2) let developers react outside; automation lets the people in the canvas set
up rules themselves, inside the canvas, safely bounded.

### 5.2 Where rules live and run (ADR-067)

- **Stored in the canvas.** A new document root `automations: Y.Map<ruleId, Y.Map>` (additive,
  format 1). Rules travel with the file, the host stores them, copies and templates carry them
  (disabled on copy until someone turns them on), and version history shows their changes. No rule
  table on the server.
- **Run by the OpenCanvas server**, on the node that owns the room, after the change that
  triggered them is applied, as server edits through the canvas tool layer (the same operations as
  the API), origin `automation:<ruleId>`.
- **Time-based triggers** (dates and schedules) need to run when nobody has the canvas open. The
  room actor writes one metadata row per enabled time rule to `automation_schedule (host_id,
  file_id, rule_id, next_run_at, claimed_by, claimed_until)` (migration 0010; Redis sorted set in
  Redis-only mode). A worker on every node claims due rows (the webhook outbox pattern), opens the
  room (loading the file from the host with the host key, as the headless API does), runs the
  rule, saves through the normal commit path, and lets the room close. The row holds ids and a
  time only.
- **On whose behalf.** A rule runs as the collaborator **"Automation"** on behalf of the person who
  last enabled or edited it (`ownerId` in the rule). At every run the server asks the host
  `/access {fileId, ownerId}` (cached 30 s): with less than `edit` the rule **pauses** ("Paused:
  Lea no longer has edit access") and the run is recorded as skipped. Without `/access` the rule
  uses the role from the owner's last session and pauses after 30 days without one.
- **Who may create rules:** editors whose token has `perms.automate` (default false). Viewers
  see rules read-only; the run history is shown to editors only.
- **Taking over a rule.** Saving a rule makes the saver its owner, so the editor says so ("Runs as
  you from now on"); a paused rule offers "Run it as me" to any editor. Accountability moves
  with an explicit action, never silently.
- Automation needs a database (SQLite, MySQL or MariaDB): with Redis-only storage the server
  refuses `[host.automation]` at start-up, as it does webhooks.

### 5.3 Rule model

```ts
automations[ruleId] = {
  v: 1, name: "Move done items to Archive", enabled: true,
  ownerId: "u_lea", updatedAt: "2026-11-26T09:12:00Z",
  trigger:    { kind: "field.changed", database: "db_1", field: "status", to: "Done" },
  conditions: [ { field: "owner", op: "isNot", value: null } ],      // all must hold
  actions:    [ { kind: "row.move", to: { database: "db_archive" } },
                { kind: "notify", people: ["field:owner"], text: "{row.title} moved to Archive" } ]
}
```

| Triggers | Conditions | Actions (same canvas only in v0.3) |
|---|---|---|
| `checklist.checked` (any or one checklist) | field is / is not / contains / is empty / is before / is after | `field.set` (value, person, date, today) |
| `row.added` | person is (field or actor) | `row.move` (another database in the canvas, or another group) |
| `field.changed` (to a value) | in database / view | `todo.set` (check, uncheck), `todo.add` |
| `date.reached` (a date field, offset, time, canvas time zone) | | `comment.add` |
| `schedule` (cron subset: daily, weekly, monthly; at least every 15 min) | | `notify` (people or a person field; through the host's `POST /mentions`; OpenCanvas sends no mail) |
| `comment.added`, `mention.added` | | `http.post` (call a URL, §5.6) |

Conditions are "all of" by default, with one "any of" group as an option; no nested groups in
v0.3. `row.move` works between databases of the same canvas that share the moved fields.

Templates in actions (`{row.title}`, `{field.status}`, `{actor.name}`, `{canvas.title}`) are plain
substitutions, escaped, no expressions.

### 5.4 Execution rules

- **Ordering:** a rule runs after the triggering change is applied; actions in order; a run's
  writes are one transaction (one undo step for anyone who wants to revert it, shown as
  "Automation · Move done items").
- **Loop guard:** writes made by a rule never trigger that same rule; a chain of rules triggered
  by automation writes stops at depth 3 (recorded as `stopped`).
- **Idempotency:** each run has an id from the trigger (event id or schedule slot); a run that
  crashed is retried once by the next owner; actions use the API idempotency store. A date or
  schedule run whose file cannot be loaded is retried for an hour, then recorded as failed.
- **Attribution:** `edited` events from a run carry `by: "automation:<ruleId>"`; the person whose
  change triggered the run gets a toast with Undo.
- **Dry run.** "Test run" in the editor evaluates the rule against current data and returns what
  would change without changing it (the tool layer's dry-run mode).

### 5.5 Audit

- **Run log:** `automation_runs (id, host_id, file_id, rule_id, trigger, result, error_code,
  http_status?, changes, duration_ms, at)`; results `done | skipped | failed | stopped`; kept 30
  days, then purged; metadata only (no text, no field values). Migration 0010.
- **Events:** `automation.ran` and `automation.failed` on the events stream and webhooks.
- **History:** automation writes are attributed to "Automation (on behalf of Lea Fischer)" in the
  authors list of the next save (`X-OpenCanvas-Authors`), so the host's version history shows them.
- **Auto-pause** after 10 consecutive failures, shown on the rule and announced to its owner
  through `notify`.

### 5.6 Calling a URL (ADR-068)

`http.post` sends `{ruleId, runId, fileId, trigger, row?: {id, fields}}` (only the fields the rule
names) as JSON, signed exactly like webhooks (`X-OpenCanvas-Signature` v2, the host secret,
`Idempotency-Key: <runId>`), 10 s timeout, no redirects, 3 tries (now, after 1 minute, after 10
minutes), `X-OpenCanvas-Event: automation.url`. **Destination rule:** the host's callback origin (as webhooks, ADR-056) or an origin listed
in `[host.automation] allow_origins` by the operator; the editor shows the allowed origins and
refuses others before saving the rule, and the server checks again before every call. This
payload is the one place where field values leave the canvas through automation, so it is named
in the rule editor ("Sends the row's Status and Owner to hooks.acme.example").

### 5.7 Limits

`[host.automation]`: `enabled = false`, `max_rules = 25` per canvas (at most 100),
`runs_per_minute = 60` per rule, `runs_per_day = 1000` per canvas, `max_changes = 50` per run,
`max_depth = 3`, `min_interval_min = 15`, `time_zone` (default for canvases without one),
`allow_origins = []`, `actions = ["field.set", "row.move", "todo.set", "todo.add", "comment.add",
"notify", "http.post"]`. Over a limit a run is `skipped` with the
reason; the editor shows the limit before it is hit (25th rule).

### 5.8 Security

- Server writes from automation go through the role filter as the owner's role, MOD-01 and SDK
  schemas: an automation can never do what its owner could not.
- SSRF: §5.6. No other outbound network.
- Rules are document data: anyone who can **read** the file (inside or outside OpenCanvas) can
  read every rule, its owner, its URL targets and the fields it sends. URL actions therefore must
  not carry secrets (signing uses the host secret, never a value in the rule), and the rule
  editor says so. `perms.automate` governs creating and enabling.
- A copied canvas keeps rules disabled and with no owner until an editor turns them on.
- The schedule and run tables hold ids, times, counts and codes only (rule 5, rule 9).

### 5.9 Not in v0.3

Cross-canvas actions (create a canvas, move a row to another file), actions that call AI, and
branching or loops in rules. Each needs a host callback or a design of its own.

### 5.10 Tests and acceptance (AUTO-A1..A8)

- A status change to Done moves the row and notifies the owner once, in a two-node cluster.
- A date rule fires once at 09:00 in the canvas time zone with the room closed (pinned clock).
- A rule whose owner lost edit is paused and changes nothing.
- A loop of two rules stops at depth 3; a rule never triggers itself.
- `http.post` to an origin not allowed is refused at save and at run; redirects are not followed.
- 10 failures auto-pause; run log rows contain no text (byte search).
- A 0.2 reader round-trips a canvas with `automations` unchanged.

---

## 6. UI that needs prototypes (V3UI-01)

All four pages follow the approved format (sticky bar, light and dark, fit and actual size,
section chips, labelled real-size frames with notes, owner decisions at the top):

1. `live-blocks.html`: Make live, live block chrome, block reference card, compact block view,
   failure states, phone (docs/27 §6.1–6.4).
2. `offline.html`: offline indicator, working offline, reconnecting and merging, conflicts and
   limits, host opt-in, logout on a shared computer, phone.
3. `search.html`: find and replace, search across canvases, the host's own search showing canvas
   content, keyboard, empty states, phone.
4. `automation.html`: rule list, rule editor, database automations, run history and errors,
   limits, phone.

## 7. ADRs (Proposed, docs/08)

- **ADR-063** Offline cache on the person's device: opt-in per host (`[host.offline]`,
  `perms.offline`) and per canvas; IndexedDB with a device key for crypto-shredding; a
  server-signed offline grant used only locally; no server content.
- **ADR-064** Offline reconnect: always a fresh host launch; chunked, re-validated catch-up;
  checkpoint before large merges; merge summary; revocation by generation number; logout clear.
- **ADR-065** Cross-canvas search: the host indexes; `search.json` in every save, stateless
  `POST /api/v1/extract`, optional host `GET /search` callback; no index in OpenCanvas.
- **ADR-066** Find and replace: client-side over the live document, replace all as one
  transaction, server role filter, live blocks in their own rooms.
- **ADR-067** Automation: rules in the `automations` root, run by the room owner as "Automation"
  on behalf of the rule owner with access re-checked each run; metadata-only schedule and run log.
- **ADR-068** Automation outbound calls and limits: webhook signing and SSRF rule plus an
  operator allow-list; per-rule, per-canvas and chain limits; auto-pause.
- **ADR-069** Live blocks in v0.3: deltas to ADR-039 (header, host picker, unlink, usage events,
  presence `from`).

## 8. Delivery

Rows are in docs/10 §P3 v0.3. Dependencies:

```
V3UI-01 (prototypes, now) ─► gates every * row
SRCH-02 ─► SRCH-03 ─► SRCH-04* ; SRCH-01* ; SRCH-05
LIVE-01 ─► LIVE-02 ─► LIVE-03*, LIVE-04, LIVE-05, LIVE-06, LIVE-07
OFF-01 ─► OFF-02 ─► OFF-03 ─► OFF-04 ─► OFF-05 ; OFF-06* ; OFF-07 ; OFF-08
AUTO-01 ─► AUTO-02 ─► AUTO-03, AUTO-04, AUTO-05 ─► AUTO-06* ; AUTO-07
ACC-V3 alongside; REL-05 last
```

| Row | Item | Size | Depends on |
|---|---|---|---|
| V3UI-01 | Prototypes §6 (four pages), owner approval | M | — |
| LIVE-01..06 | As docs/27 §8 | 3 L, 3 M | LIVE-03 on V3UI-01 |
| LIVE-07 | Unlink (convert to a copy), `live.embedded`/`live.removed` events, presence `from` | M | LIVE-02 |
| OFF-01 | Host contract: `[host.offline]`, `perms.offline`, offline grant, `offline_generation` (0010), revoke API | M | — |
| OFF-02 | IndexedDB store (y-indexeddb scheme), device key, limits, `storage.persist` | M | OFF-01 |
| OFF-03 | Service worker app shell, offline open in `<open-canvas>`, grant checks, lock on expiry | L | OFF-02 |
| OFF-04 | Reconnect: fresh launch, chunked catch-up, checkpoint, refused-frame reporting, merge analysis | L | OFF-02 |
| OFF-05 | Queued uploads (`oc-pending:`), MOD-01 rule, exports placeholder | M | OFF-04 |
| OFF-06 | Editor UI to the approved prototype: pill, popover, settings, merge summary, locked, phone | L | OFF-04, V3UI-01 |
| OFF-07 | Logout: `clearOffline()`, `/v1/offline/clear`, revocation by generation | M | OFF-02 |
| OFF-08 | Offline fuzz (a day offline), three-browser Playwright, ADR-001 byte search | M | OFF-04 |
| SRCH-01 | Find and replace in a canvas, to the prototype | M | V3UI-01 |
| SRCH-02 | `search.json` in every save; `POST /api/v1/extract` | M | — |
| SRCH-03 | Host `GET /search` callback, `GET /api/v1/search`, MCP `canvas_search` | M | SRCH-02 |
| SRCH-04 | "Search all canvases" UI and `#block=` deep link | M | SRCH-03, V3UI-01 |
| SRCH-05 | Sample host and Nextcloud app index `search.json` | S | SRCH-02 |
| AUTO-01 | `automations` root, rule schema, MOD-01 validation, 0.2 round trip | M | — |
| AUTO-02 | Engine: event triggers, conditions, actions over the tool layer, loop guard, limits | L | AUTO-01 |
| AUTO-03 | Schedules and dates: `automation_schedule` (0010), claimed worker, closed-room runs | M | AUTO-02 |
| AUTO-04 | `notify` and `http.post` actions (signing, SSRF, allow-list) | M | AUTO-02 |
| AUTO-05 | Run log (0010), events, auto-pause, `GET /api/v1/files/{id}/automations/runs` | M | AUTO-02 |
| AUTO-06 | Editor UI to the prototype: panel, editor, test run, history, phone | L | AUTO-05, V3UI-01 |
| AUTO-07 | API and MCP for rules (list, create, enable, test) | S | AUTO-01 |
| ACC-V3 | docs/23 rows LIVE-A*, OFF-A*, SRCH-A*, AUTO-A* | S | — |
| REL-05 | v0.3.0 scope lock, audit, release notes | M | all |

Rough total: 7 L + 22 M + 4 S ≈ 40–45 engineer-weeks.

**Recommended order.** (1) V3UI-01 approval now. (2) Server work that needs no UI, in two tracks
(the two-agent limit): track A SRCH-02, SRCH-03, AUTO-01, AUTO-02 … AUTO-05; track B LIVE-01,
LIVE-02, OFF-01, OFF-02. (3) After approval: SRCH-01 and SRCH-04 (smallest UI, quick value), then
LIVE-03..07, then AUTO-06/07, with OFF-03..08 running on track B as the long pole. (4) ACC-V3 and
REL-05. If the release must ship before offline is proven (OFF-08 green on all three browsers),
offline ships behind `[host.offline]` marked preview rather than holding the tag.

## 9. Questions for the owner

The prototype pages carry the UI decisions; these are the design-level ones.

1. Offline grant default lifetime 7 days (maximum 30)? (§3.3)
2. Offline needs a host token refresh callback; WOPI hosts get session resilience only in v0.3. OK?
3. Cross-canvas search: the host indexes `search.json` (ADR-065). OK to leave comments out by
   default?
4. Automation rules stored in the document (travel with copies, disabled on copy). OK?
5. Automation runs on behalf of the rule owner, paused when they lose edit. OK?
6. `http.post` allowed beyond the callback origin only by the operator's `allow_origins`. OK?
7. Offline may ship as "preview" in 0.3.0 if OFF-08 is not green on WebKit in time.
