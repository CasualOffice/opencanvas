# 38 — v0.5 design plan: plugins and a marketplace, backlinks, a knowledge graph, SDK extensions

**Status:** In progress. Plan, prototypes ([docs/prototypes/v05-approved/](prototypes/v05-approved/)) and ADRs 081–084
approved by the owner 2026-11-28. The owner set the direction on 2026-11-28: **v0.5 = plugins (with a
marketplace), backlinks, a knowledge graph and SDK extensions; v0.6 = advanced automation and app
building**. ADRs 081–084 (Accepted 2026-11-28) in [docs/08](08-ADR-REGISTER.md); tracker rows in
[docs/10](10-EXECUTION-TRACKER.md) §P3 v0.5. Prototypes (V5UI-01, §8) gate every UI row (ADR-011).
**Scope:** the v0.5 line of [docs/09](09-ROADMAP.md#release-roadmap).
**Not in scope:** multi-step workflows, forms, buttons and app pages (v0.6, §13); paid plugins;
ratings and reviews; synced databases from outside services (v0.6); a new `.ocanvas` format
version.

## 0. Direction and order

| # | Workstream | Role | Rough effort (§10) | Section |
|---|---|---|---|---|
| 1 | **Links and backlinks**: canvas and block links, the server's link index, "Linked from", unlinked mentions, hover preview | Main thrust | ≈ 9 engineer-weeks | §2 |
| 2 | **Knowledge graph**: the graph API and the graph view, local and full, with a list fallback | Main thrust | ≈ 6 | §3 |
| 3 | **Plugins and the marketplace**: packaging, signing, distribution, install, policy, updates | Main thrust | ≈ 14 | §4 |
| 4 | **SDK extension points**: database views, commands, importers, exporters, automation actions, integration providers; the plugin SDK and CLI | Main thrust | ≈ 15 | §5 |
| 5 | **Maturity**: security audit of every new surface, acceptance, release | Required for the release | ≈ 5 | §6 |

Order of work, with at most two agents at once (owner rule): links first (the index is what the
graph reads, and it is the smallest piece that touches storage), then the graph; in parallel the
plugin package format and the WebAssembly runtime (§5.2), because every server-side extension
point and the marketplace depend on them. If time runs short, integration providers (§5.8) move
to 0.5.x first, then exporters; links, the graph, signed plugins and the browser-side extension
points are the release.

Constraints every design below keeps (as in [docs/34](34-ROADMAP-v0.3.md) and
[docs/36](36-ROADMAP-v0.4.md)):

- **The host owns auth, ACL and files; OpenCanvas never persists documents** (ADR-001). The link
  index (§2) stores **ids only**: which file and block points at which file and block. No titles,
  no text, no excerpts at rest. Titles come from the host and excerpts from the file at read time.
- **The host's ACL is applied at read time, every time** (§2.5). A backlink, a graph node or a
  preview for a canvas the reader cannot open is left out, with no placeholder and no count.
- **The server enforces roles on every frame** (rule 6), including plugin writes, which go through
  the same tool layer and MOD-01 validation as the editor, the API and MCP.
- **Third-party code is sandboxed and signed.** Browser parts run in the block origin's sandboxed
  iframes (ADR-040); server parts run as WebAssembly components with fuel, memory and time limits
  and no network or files unless declared and allowed (§5.2). This amends ADR-040's "no
  third-party code runs on the server" (ADR-084), and is off until the operator turns it on.
- **`.ocanvas` stays format version 1** (ADR-042): new nodes (`canvasLink`) and view types are
  additive; a 0.4 reader shows a canvas link as an ordinary link and a plugin view as a table.
- **Feature flags:** `[host.flags] links`, `graph` and `plugins` are off until a host turns them
  on; 0.4 behaviour is unchanged without them.

Sizes: **S** ≤ 2 days, **M** ≤ 1 week, **L** ≤ 3 weeks, for one engineer.

## 1. Starting point

| Fact | Today (0.4.0) | Source |
|---|---|---|
| Links between canvases | Ordinary `link` marks to host URLs; "Copy link to block" posts `UI_Block_Link {blockId, fileId}` and the host builds the URL | ADR-023 |
| Block ids | Every block gets a `blockId` when linked or referenced; database rows have row ids | ADR-023, ADR-013 |
| Cross-file references | Live blocks and `blockRef` projections (ADR-039/069), cross-canvas relations through live blocks (ADR-078) | docs/34 §2, docs/36 §6.1 |
| Search across canvases | The host indexes `search.json`; optional `GET /search` callback; OpenCanvas keeps no index | ADR-065 |
| Per-file access check | Signed `POST /access {fileId, userId}` → role, name, path (cached 30–60 s) | docs/05 §8, ADR-032 |
| Third-party code | Block packages only: browser sandbox, operator-installed from `OC_BLOCKS_DIR`, SRI hash, enabled per host | ADR-040, ADR-058, docs/33 |
| Signing, registry, updates | None: the operator copies a directory and restarts | docs/33 §5 |
| Server-side extension | None (ADR-040); automation `http.post` to allowed origins only | ADR-068 |
| Import / export | Markdown, HTML, CSV, xlsx/ods, draw.io, Excalidraw, Mermaid in; MD/HTML/DOCX/PDF/xlsx out | docs/29, ADR-080 |

ADR-065 rejected an OpenCanvas **search** index because it would store content and duplicate the
host's ACL. The link index in §2 is different in both respects: it holds no content, only pairs of
ids, and it never answers on its own: every answer goes through the host's ACL first. It is
metadata in the same class as `automation_schedule` (ADR-067) and the commit outbox, and ADR-081
records it as a narrow, explicit extension of ADR-001.

---

## 2. Links and backlinks (main thrust; ADR-081)

### 2.1 Problem

People link canvases constantly ("see the SSO rollout plan"), but a link today is a host URL in a
text mark: OpenCanvas cannot tell which canvases point at this one, cannot show context, cannot
offer the target block, and the link breaks silently on a move or a deletion.

### 2.2 Link model (in the document)

1. **`canvasLink` inline node** `{fileId, targetBlockId?, rowId?, label}` (the target block is `targetBlockId`: `blockId` is a node's own id, ADR-023). `label` is the text written
   at insert time and is shown only when the host cannot be asked (export, a 0.4 reader); the
   editor shows the host's current title. Inserted with **`[[`** (a picker over the host's
   `GET /search` and recent canvases from the session), by pasting a host URL that matches
   `[host.links] url_patterns`, or by "Copy link to block" then paste.
2. **Block-level targets.** Any block with a `blockId` (headings, paragraphs, databases, boards,
   diagrams, spreadsheets), a database row (`rowId`), and a heading anchor. `[[SSO rollout
   plan#` lists the target's headings and databases; `#^` lists blocks by their first words.
   Opening a block link scrolls to the block and flashes it (`Action_ScrollToBlock`, ADR-023).
3. **Edges the index also records** without a new node: live blocks and `blockRef` (kind
   `embed`), cross-canvas database relations (kind `relation`), and plain `link` marks whose URL
   matches `url_patterns` (kind `link`).
4. **Exports** write a canvas link as a link to the host URL (from `[host.links] url_template`)
   with the label; Markdown export can also write `[[Title]]` (option).
5. **Older editors.** A 0.4 editor has no `canvasLink` in its schema, and its Yjs binding
   deletes every node it cannot show (measured, `links/compat.test.ts`; rule 7 does not hold for
   it). So the server guards the node as it does SDK and live blocks: a connection keeps links
   only if it says `caps=links` (0.5 editors and the bench clients do); an update from any other
   connection that removes a `canvasLink` is refused and that session is closed with 4426
   ("editor out of date: reopen the canvas"). Exports and readers outside OpenCanvas get the
   label with a link to the host URL (item 4).

### 2.3 The index (server)

- **When.** At every successful save (the commit outbox has the host's acknowledgement), the
  server extracts the outgoing edges from the saved `document.json` (the same pass that writes
  `search.json`, so no extra decode) and replaces that file's rows in one transaction. A save that
  is not acknowledged changes nothing, so the index follows what the host stores.
- **What.** Table `link_edges` (migration 0014, SQLite, MySQL 8, MariaDB 10.11):
  `host_id, src_file, src_block, dst_file, dst_block (nullable), dst_row (nullable), kind
  (link|embed|relation), saved_at`. Primary key `(host_id, src_file, src_block, dst_file,
  dst_block, dst_row, kind)`; index on `(host_id, dst_file)`. **No titles, labels or text.**
- **Size.** About 80 bytes per edge; 1 million edges ≈ 80 MB with indexes. Limits: 2,000 edges
  per source file (more are dropped and counted in a metric), MOD-01 on node attributes.
- **Deletions.** A source file deleted at the host (`/access` 410 or the `file.deleted`
  webhook-in, when the host sends it) loses its rows on the next read that sees it, or at once
  through `DELETE /api/v1/links/files/{id}` (host key). A target that answers 410 shows as
  "Deleted canvas" and the rows stay until their source is saved again.
- **Backfill.** `POST /api/v1/links/index {fileIds[]}` (host key, ≤ 100 per call) loads each file
  through the host, extracts and writes edges, and discards the document. The sample host and the
  Nextcloud app ship a one-off script that walks their files.
- **Cluster.** The writer is the node that saved; rows are keyed by file, so no coordination is
  needed beyond the database. **Redis-only storage is refused for `[host.flags] links`** at
  start-up, as for automation and webhooks (ADR-056, ADR-067): the index is a relational query.
- **Partial sync.** Extraction reads the flattened v1 save (ADR-076), so subdocuments need no
  change.

### 2.4 Reading backlinks

`GET /api/v1/files/{id}/backlinks?block=&kind=&cursor=` (and the editor's session call, and MCP
`canvas_backlinks`):

1. Read the rows where `dst_file = id` (and `dst_block` when asked), grouped by source file.
2. **ACL at read time:** ask the host for the reader's role on every distinct source file with the
   new optional **`POST /access/batch {userId, fileIds[≤200]}`**; without it, fall back to
   `POST /access` per file (8 at a time, cached 30 s per user and file). Sources with role `none`
   or 410 are dropped. **Nothing about a dropped source is returned or counted.**
3. Titles, paths and icons come from the host's answer, never from the index.
4. **Context excerpts** (the sentence around each link) are made at read time for the first 20
   sources: from the open room if the source is open, else by loading the source through the
   host with the reader's own callback token, extracting the paragraph that holds the link
   (≤ 240 characters) and discarding the document. Excerpts are held in memory for 5 minutes per
   (reader, source version) and never written anywhere. "Show more" loads the next 20.
5. **The target must be readable too**: the request needs at least view on `id`.

### 2.5 Unlinked mentions

Canvases that mention this canvas's title (or its aliases, §2.6) as text without linking it. They
come from the host's search callback (ADR-065) as an exact-phrase query, so the host's index and
ACL answer; sources that already link here are removed. **Link** replaces the mention with a
`canvasLink` in the source canvas through its room (edit role in the source required, checked by
the server; one undo step there). Hosts without `GET /search` do not show the section.

### 2.6 Editor (to the prototype, frames in `links-backlinks.html`)

- **"Linked from" panel** at the end of the canvas and in the side panel: sources grouped by
  canvas, each with its excerpt and the block it points at; filter (this canvas / a block / kind),
  sort (recent, title); counts only of what the reader can open.
- **Unlinked mentions** below, collapsed by default, with **Link** and **Link all in this canvas**.
- **Hover preview** of any canvas or block link after 400 ms (focus + Space on keyboard): title,
  path, updated time and editor, the first lines or the target block, rendered from the
  live-block projection (`GET /v1/live/projection`, ADR-072), which already checks the role.
- **Block targets:** a link icon on a block's handle ("Copy link to block"); the block shows a
  small "Linked from 3" chip when it has backlinks.
- **States:** no access (chip "No access", no title), deleted ("Deleted canvas", struck), moved
  or renamed (title follows the host), the target block deleted ("Block not found", opens the
  canvas at the top).
- **Aliases:** an optional `aliases` list in the canvas's properties for unlinked-mention search
  and the `[[` picker.
- **Phone:** "Linked from" as a section at the end and a sheet from the top bar; long-press a link
  for the preview sheet.

### 2.7 Acceptance (LINK-A1..A7)

| Row | Pass |
|---|---|
| LINK-A1 | Saving a canvas with 2,000 outgoing links updates its rows in < 50 ms p95 (SQLite and MySQL; local M4, stated in the result) and never runs before the host's acknowledgement (test with a failing save) |
| LINK-A2 | A backlink from a canvas the reader cannot open is absent from the API, the editor, MCP and the counts; tested with `/access` answering `none`, 410 and a timeout (seen failing first with the filter off) |
| LINK-A3 | `link_edges` holds no text: a test scans the table after indexing a fixture whose every string is a marker and finds none |
| LINK-A4 | Backlinks for a canvas with 500 sources answer in < 300 ms p95 with `/access/batch` (host stub at 20 ms) and < 1.5 s with per-file `/access` |
| LINK-A5 | A pre-0.5 editor (no `caps=links`) cannot delete a `canvasLink`: its update is refused and the session closed with 4426, while a 0.5 editor edits links freely (seen failing first with the guard off); exports write host URLs |
| LINK-A6 | Unlinked mention → Link needs edit in the source (refused for view, seen failing first) and is one undo step there |
| LINK-A7 | The panel, preview and `[[` picker pass the accessibility checks (axe, keyboard-only script, 200% zoom, 320 px) |

---

## 3. Knowledge graph (main thrust; ADR-082)

### 3.1 Graph API

`GET /api/v1/graph` (host key or a person's token; MCP `canvas_graph`; both clients):

| Parameter | Meaning |
|---|---|
| `root` | A file id for a local graph; absent for the full graph |
| `depth` | 1–3 around `root` (default 1) |
| `kinds` | `link,embed,relation` (default all) |
| `blocks` | `true` adds block nodes for link targets (default `false`) |
| `limit` | Nodes, ≤ 500 for local and ≤ 2,000 for full (defaults 200 / 2,000) |

Answer: `{nodes: [{id, kind: canvas|block, fileId, blockId?, title, path, space, updatedAt,
in, out}], edges: [{from, to, kind}], truncated, total?}`. `total` is given only when every node
counted is readable by the caller.

- **Local graph:** breadth-first over `link_edges` from `root` in both directions, stopping at
  `depth` or `limit`; every node is checked with `/access/batch` **before** it is expanded, so the
  walk never passes through a canvas the reader cannot open (edges through hidden canvases are
  cut, not bridged).
- **Full graph:** the most-connected readable canvases of the host, up to 2,000. Candidates are
  read from the index by degree, checked in batches of 200 until the limit is reached or 10,000
  candidates are checked; the answer says `truncated: true`. Hosts that can answer "which files
  can this person read" in bulk may implement the optional `GET /files/readable?userId=&cursor=`
  callback instead, which makes the full graph exact.
- **Titles, spaces and dates** come from the host's access answers (`name`, `path`); `space` is
  the first segment of `path` unless the host sends `space`. Block node titles are the heading text
  or the database name, read at request time like excerpts (§2.4) and only for blocks in readable
  canvases.
- **Caching:** per (reader, root, parameters) for 30 s in memory; the index changes invalidate by
  file.
- **Cost guard:** 10 graph requests per minute per person, 2 full-graph requests per minute.

### 3.2 Graph view (to the prototype, `knowledge-graph.html`)

- **Local graph** in the side panel of a canvas (top-bar Graph button): depth 1 by default,
  slider to 3; the current canvas centred.
- **Full graph** opened from the panel or the host's navigation (`Action_OpenGraph`), with
  filters: spaces, link kinds, blocks on or off, orphans, updated within; search that highlights
  and dims; colour by space, updated or owner; drag to pin (positions are per person, kept in the
  browser, not in any document).
- **Rendering:** force layout in a Web Worker (no library in the initial graph; a lazy chunk, as
  ADR-079 requires), SVG up to 500 nodes, Canvas 2D above; the layout stops when it settles;
  reduced motion shows the settled layout without animation.
- **Keyboard and screen readers:** one Tab stop, arrow keys move to the nearest neighbour in that
  direction, Enter opens, Space selects, `/` searches, `L` switches to **List**: the same nodes as
  a sortable table (Canvas, Space, Links in, Links out, Linked from, Updated) with each row
  expandable to its neighbours. The list is the default on a phone.

### 3.3 Acceptance (GRAPH-A1..A5)

| Row | Pass |
|---|---|
| GRAPH-A1 | No node, edge, title or count for a canvas the reader cannot open, at any depth; a hidden canvas between two readable ones does not connect them (seen failing first) |
| GRAPH-A2 | Local graph, depth 2, 500 edges: API < 250 ms p95 with `/access/batch` (stub 20 ms) |
| GRAPH-A3 | Full graph of 2,000 nodes and 6,000 edges: first layout drawn < 2 s and settled < 4 s in Chromium at 4× CPU throttle; panning ≥ 50 fps on the CI runner class (docs/36 Q8) |
| GRAPH-A4 | The graph chunk is not in the initial JS (`check-budget --forbid graph`) |
| GRAPH-A5 | Keyboard-only and screen-reader scripts reach every node through the graph and through the list; 320 px and 200% zoom |

---

## 4. Plugins and the marketplace (main thrust; ADR-083)

### 4.1 What a plugin is

A **plugin** is one signed package, `<publisher>.<name>-<version>.ocplugin` (a zip), that may
contribute any of: blocks (the existing block SDK), database views, commands, importers,
exporters, automation actions and integration providers (§5). A v0.2 block package is a plugin
with one `blocks` entry; `OC_BLOCKS_DIR` keeps working, unsigned, for the operator's own blocks.

```
plugin.json            manifest (JSON Schema subset, ADR-058), required
ui/*.js                browser parts, run in the block origin's sandbox (ADR-040)
server/*.wasm          server parts, WebAssembly components (ADR-084), optional
assets/                icon (SVG, sanitised), screenshots (PNG ≤ 512 KB each, ≤ 5)
README.md CHANGELOG.md LICENSE sbom.cdx.json
signatures/            publisher.sig, marketplace.sig (§4.2)
```

`plugin.json` names: `id` (`publisher.name`), `version` (SemVer), `engines.opencanvas`
(a range, e.g. `>=0.5 <0.7`), `publisher` `{id, name, url}`, `contributes {…}`, `permissions`
(§4.4), `discovery` (as ADR-058), `sha384` of every file. Anything not named in the manifest is
refused at install.

### 4.2 Signing and trust

- **Publisher signature.** Ed25519 over the canonical manifest (which holds every file's hash).
  Publishers register public keys with the marketplace (and prove a domain with a DNS TXT record
  for the "verified" badge). Key rotation: the new key is signed by the old one; a lost key is
  revoked by the marketplace.
- **Marketplace countersignature.** After review (§4.5) the marketplace signs the same manifest
  hash. An installed package needs **both** signatures unless the operator trusts a private
  registry's single key. Unsigned packages are possible only from a named private registry with
  `[plugins.registries.<name>] allow_unsigned = true` (operator only), never from the public
  marketplace, and no admin or person can override it.
- **Signed index (TUF-style roles, small).** The registry publishes `index.json` (every plugin,
  version, hash, permissions, publisher, revocations) signed by an online *timestamp* key, with a
  monotonically increasing `version` and an `expires` (7 days). The server refuses an index older
  than the one it has (rollback) or past `expires` (freeze). The *root* key that certifies the
  online keys is offline; its rotation ships in a release.
- **Revocation.** A revoked version or publisher is listed in the index; servers fetch it hourly
  and switch revoked plugins off within the hour. Canvases keep working: blocks show their saved
  fallback, plugin views fall back to Table, rules with a revoked action pause with a reason.
- **Verification** happens at download, at install, at every start and on every load of a server
  part from disk (hash checked against the manifest).

### 4.3 Distribution

- **The OpenCanvas Marketplace** is a static registry run by the project: `index.json`, packages
  and screenshots on a CDN, a submission and review service (PLUG-04), and the publisher portal.
- **Private registries** use the same format (`oc-plugin registry build`), so an organisation can
  host its own plugins or mirror the marketplace.
- **Air-gapped servers** accept an uploaded `.ocplugin` with its signatures; the index is replaced
  by a signed offline bundle.
- The operator chooses sources in `[plugins] registries` and whether server parts may run at all
  (`[plugins] server_code = false` by default).

### 4.4 Permissions, people and policy

Permissions are named in plain words in the manifest and shown at install and in the manager:

| Permission | Meaning |
|---|---|
| `canvas.read` / `canvas.write` | The canvas it runs in, through the person's role (writes as the person, MOD-01) |
| `view.rows` | The rows and fields shown in its database view, nothing else |
| `members` | Names and avatars of people on the canvas (ADR-026) |
| `network: [origins]` | Only these HTTPS origins, from the sandbox (browser) or through the server's fetch (server parts, SSRF rules of ADR-068) |
| `server` | Has server parts (WebAssembly) |
| `connections: [provider]` | Uses a stored connection (§5.8) |
| `files.input` | Reads the file the person chooses (importers) |

**Who does what.** The **operator** installs the server, picks registries, allows server code and
sets permission ceilings for every host. The **host admin** (marked by the host in the launch
token, `perms.plugins: "admin"`; or the host itself through `/api/v1/plugins` with the host key)
chooses the organisation's plugins and policy. **People** browse, use enabled plugins and
**request** others. A plugin only ever sees what the person using it can see; the host's ACL and
roles are unchanged.

**Policy** (per host): install mode (`admins`, `request` (default), `anyone-allowed-list`);
allowed sources; signatures required (always for the public marketplace); server plugins allowed;
allowed network origins; permission ceilings (e.g. never `members`); auto-update (patch and minor
when permissions do not change; anything that adds a permission or a network origin waits for an
admin); pinned versions; roll back to the previous version.

### 4.5 Marketplace review

Automated on every submission: manifest and schema checks, signature, SBOM licence allow-list,
malware and secret scanning, a WebAssembly import check (only the `opencanvas:plugin` world), a
bundle check (no `eval`, no remote script), and a smoke run in the sandbox. Manual review for a
publisher's first plugin, any `server`, `network` or `connections` permission, and every
permission increase. Target: 3 working days. Published with the reviewer's countersignature.

### 4.6 Editor and admin (to the prototype, `plugin-marketplace.html`)

Browse (search, categories, verified-only, browser-only), details (what it adds, permissions,
publisher, signatures, versions, licence, source), install consent, installed manager (enable,
disable, version, updates, roll back), update needing approval with a permission diff, admin
policy, request queue, and blocked states: unsigned, network origin not allowed, revoked,
incompatible version, server plugins off. Phone: browse, details, request.

### 4.7 Acceptance (PLUG-A1..A7)

| Row | Pass |
|---|---|
| PLUG-A1 | A package with one changed byte, a missing signature, a signature by an unregistered key, or an index older than the installed one is refused, with a clear reason in the manager and on `/healthz` (each seen failing first) |
| PLUG-A2 | A revoked plugin is off on every node of a cluster within 60 minutes of the index that revokes it; canvases using it open with fallbacks and no error |
| PLUG-A3 | An update that adds a permission is not applied until an admin approves it; patch updates with the same permissions apply on the next index fetch |
| PLUG-A4 | Policy enforcement is server-side: a person without `perms.plugins: "admin"` cannot enable a plugin through the API (seen failing first) |
| PLUG-A5 | Installing, enabling and the plugin runtime add 0 bytes to the editor's initial JS (`check-budget --forbid plugins`) |
| PLUG-A6 | The v0.2 sample blocks (`oc.progress`, `acme.okr`) work unchanged from `OC_BLOCKS_DIR` and as `.ocplugin` packages |
| PLUG-A7 | Marketplace and manager pass the accessibility checks (axe, keyboard script, 200%, 320 px) |

---

## 5. SDK extension points (main thrust; ADR-084)

### 5.1 Overview

| Extension point | Runs in | Where people meet it | Fallback without the plugin |
|---|---|---|---|
| Custom database view | Browser sandbox | "Add view" → From plugins | The view shows as Table with a note |
| Command | Browser sandbox | Command palette, `/` menu, block menu, shortcuts | Hidden |
| Importer | Server (WebAssembly) | Import dialog, drop a file, `POST /api/v1/import` | The format is not offered |
| Exporter | Server (WebAssembly) | Export menu, `GET /api/v1/files/{id}/export?format=` | The format is not offered |
| Automation action | Server (WebAssembly) | Rule editor "Then" list (ADR-067) | The rule pauses with a reason |
| Integration provider | Server (WebAssembly) + browser sandbox for pickers | Connections in settings; link previews; actions; pickers | Links stay plain links |

### 5.2 The server runtime

- **wasmtime** (Apache-2.0 WITH LLVM-exception, Bytecode Alliance) with the component model; one
  WIT world `opencanvas:plugin@0.5.0` with interfaces `importer`, `exporter`, `action`,
  `provider`, and host imports `log`, `http-fetch` (only declared and allowed origins, the SSRF
  rules of ADR-068, 10 s, 10 MB), `connection-token` (providers), `clock`, `random`. No WASI
  filesystem, sockets or environment.
- **Limits per call:** fuel (≈ 2 × 10⁹ instructions), memory 256 MB, wall time 10 s (importers
  and exporters 60 s), output 50 MB; epoch interruption for wall time. A limit hit is an error
  `PLUGIN_LIMIT` for that call, never a server crash.
- **Isolation:** a fresh instance per call from a pre-compiled module cache (compiled once per
  version, verified hash), so no state leaks between people or hosts. Calls run on a bounded pool
  (`[plugins] workers`, default 2 per core) with a queue; the room and save paths never wait on it.
- **Output is data, not authority:** importers return document JSON and exporters return bytes
  plus a compatibility report; actions return a list of canvas operations. Everything goes through
  the canvas tool layer: role filter, MOD-01, limits, one transaction.

### 5.3 Custom database views

A view plugin receives the rows and fields of the database as the person can see them (only the
fields the view config names, `view.rows`), the view's config (validated by its JSON Schema), the
theme tokens and the locale; it renders in a sandboxed iframe sized by the editor; it writes cells
through the checked bridge (60 writes/s, the database's field types). Filters, sorts and grouping
come from the editor's worker index (DB4-09), so a plugin view of 100,000 rows gets pages, not the
whole set. Stored as a view `{type: "ext:<plugin id>/<view>", config}`; readers without the plugin
see Table with "Shown as Table: Swimlanes is not available here".

### 5.4 Commands

A command has an id, a title, an icon (Lucide name), where it appears (`palette`, `slash`,
`block-menu`), a suggested shortcut (never a core one; people can change or remove it) and a
`when` (selection is text, a database is focused, …). Running it gives the sandbox the selection,
the current block and the canvas through the person's role; it can open a sandboxed dialog and
apply validated operations (one undo step).

### 5.5 Importers

Declared with extensions, MIME types and an optional magic-bytes prefix; listed in the import
dialog under "From plugins" with the publisher and a "Runs on the server" note. The server streams
the file into the component (≤ 50 MB unless the operator raises it), takes the document JSON it
returns, validates it (MOD-01) and opens the new canvas; the import report lists what was
dropped. Same path for `POST /api/v1/import` and MCP.

### 5.6 Exporters

Declared with a format name, extension and MIME type; get the flattened document JSON, the
computed values (formulas, sheets) and the assets; return bytes and a compatibility report shown
before download, as the built-in exporters do (rule 7).

### 5.7 Automation actions

Declared with a title, an icon, an input JSON Schema (the rule editor builds its form from it,
with row tokens), and the connection it needs. Run by the automation engine (ADR-067) on behalf
of the rule owner, under ADR-068's limits (60 runs/min per rule, 50 changes per run, retries
for idempotent actions only). The action's result is shown in the run log; its outbound calls use
`http-fetch` only. v0.6 builds multi-step workflows on the same action contract (§13).

### 5.8 Integration providers

A provider declares a connection type (OAuth 2.0 authorization code with PKCE, or an API key),
the origins it calls, and what it offers: link previews for URL patterns, pickers (search an
outside service from the `/` menu), and actions. **Connections** are per person (default) or per
organisation (admin), stored in `plugin_connections` encrypted under `OC_KEK` (as callback tokens,
ADR-017), shown and revocable in the person's settings, and deleted with the plugin. A connection
token is handed to the provider's component only for that call through `connection-token` and is
never given to browser code.

### 5.9 Plugin SDK and CLI

`@opencanvas/plugin-sdk` (TypeScript, browser parts; extends `@opencanvas/block-sdk`), WIT
bindings for Rust (`opencanvas-plugin` crate) and for any language with a component toolchain;
`oc-plugin` CLI: `init <template>`, `dev` (a local OpenCanvas with hot reload and a fake host),
`test` (runs the conformance cases for each contribution), `pack`, `sign`, `verify`, `publish`.
A guide in docs/39 and one sample per extension point under `examples/plugins/`.

### 5.10 Acceptance (EXT-A1..A8)

| Row | Pass |
|---|---|
| EXT-A1 | A server part that loops, allocates without limit, or sleeps is stopped with `PLUGIN_LIMIT` inside its limit + 100 ms; the server keeps serving rooms (p95 frame latency unchanged in a test that runs 20 such calls) |
| EXT-A2 | A server part cannot open a file, a socket or an undeclared origin (each attempted in a test component and refused) |
| EXT-A3 | A plugin view receives only the fields its config names and only rows the person can read; its writes fail for a viewer (seen failing first) |
| EXT-A4 | An importer's output that violates MOD-01 is refused with the import report; a 50 MB import completes within 60 s on the reference machine |
| EXT-A5 | An exporter's compatibility report is shown before download, and the API returns it in a header |
| EXT-A6 | An action plugin in a rule respects ADR-068 limits and pauses after 10 failures; a revoked action pauses its rules with the reason |
| EXT-A7 | Connection tokens are encrypted at rest (scan of the table), never reach browser code (bridge test), and are deleted with the plugin or by the person |
| EXT-A8 | Each sample plugin builds, signs, installs and passes `oc-plugin test` in CI |

---

## 6. Maturity and security

- **SEC-V5** (docs/18 §8): threat model and audit of the link index and its ACL path, the graph
  API, the plugin package and signing chain, the WebAssembly runtime (including a fuzzing run of
  the host imports), the bridge for views and commands, provider connections, and the marketplace
  review service. External review of the runtime if the owner agrees (Q4).
- **Supply chain:** the marketplace itself publishes its index and release keys' fingerprints in
  the repository; `cargo deny` gains `wasmtime`'s tree; SBOMs for the server include it.
- **Operations:** metrics for index writes, access batch latency, graph requests, plugin calls,
  limits hit, revocations applied; alerts for an expired index.
- **Acceptance rows** LINK-A*, GRAPH-A*, PLUG-A*, EXT-A* go into docs/23 (ACC-V5).

## 7. Host-owned and ours

| Concern | Host | OpenCanvas |
|---|---|---|
| Files, titles, paths, deletion | Stores files; answers `/access` with name and path; may send `file.deleted` | Never stores titles or text; shows what the host answers |
| Who can read what | `POST /access`, optional `/access/batch`, optional `/files/readable` | Calls them on every read; drops what is not readable; caches ≤ 30 s |
| Link index | — | `link_edges` (ids only), written at acknowledged saves |
| Search for unlinked mentions and `[[` | `GET /search` over its own index (ADR-065) | Calls it; removes canvases already linked |
| URLs | `[host.links] url_patterns` and `url_template` | Recognises and writes them |
| Graph | Optional `space` in `/access`; `Action_OpenGraph` entry point | Graph API and view |
| Plugin policy for an organisation | Marks admins (`perms.plugins`); may manage through `/api/v1/plugins` | Enforces policy server-side; stores the per-host policy (configuration, not documents) |
| Registries, server code, ceilings | — | Operator configuration (`[plugins]`) |
| Marketplace | — | The project runs it; private registries are the organisation's |
| Provider connections | May forbid providers by policy | Stores encrypted connections; deletes on request |
| Notifications from plugin actions | `POST /mentions` (ADR-027) | Never sends mail |

## 8. Prototypes needing owner approval (V5UI-01)

Same format as the v0.4 pages (sticky bar, light and dark, fit and actual size, real-size frames
with notes, owner decisions at the top), in `docs/prototypes/v05-approved/`. Nothing under them is built
before approval (ADR-011).

1. `links-backlinks.html`: `[[` picker and block targets, the "Linked from" panel and unlinked
   mentions, hover preview, link states (no access, deleted, block not found), phone.
2. `knowledge-graph.html`: full graph (interactive force layout), local graph in the side panel,
   filters and search, preview and selection, the list fallback and keyboard map, phone, empty
   and too-large states.
3. `plugin-marketplace.html`: browse, details with permissions and publisher, signatures, install
   and update, installed manager, admin policy, requests, blocked states (unsigned, network,
   revoked, incompatible), phone.
4. `extension-points.html`: a plugin database view, a plugin importer in the import dialog, a
   plugin automation action in the rule editor, a plugin command, a provider connection, and what
   people see when a plugin is missing.

## 9. ADRs (Proposed, docs/08)

- **ADR-081** Link index across canvases: `canvasLink` node and block targets; the server keeps
  `link_edges` (ids only) from acknowledged saves; the host's ACL applied at read time through
  `/access/batch` (or `/access`); excerpts and titles at read time, never stored; unlinked mentions
  through the host's search; Redis-only refused.
- **ADR-082** Graph API: local (depth ≤ 3) and full (≤ 2,000 most-connected readable canvases)
  graphs from the index; every node checked before it is expanded; no placeholders or counts for
  hidden canvases; optional `/files/readable`; rate limits; MCP and clients.
- **ADR-083** Plugin packaging, signing and distribution: `.ocplugin` with `plugin.json`;
  publisher Ed25519 signature plus marketplace countersignature; signed index with version and
  expiry and hourly revocation; private registries and offline bundles; operator, host admin and
  person roles; per-host policy; auto-update only without new permissions.
- **ADR-084** SDK extension points and the server runtime: views and commands in the browser
  sandbox; importers, exporters, actions and providers as WebAssembly components on wasmtime with
  fuel, memory and time limits and no ambient I/O; outputs validated by the tool layer; provider
  connections encrypted under `OC_KEK`; amends ADR-040 (server code off unless the operator
  allows it).

## 10. Delivery

Rows are in docs/10 §P3 v0.5. Dependencies:

```
V5UI-01 (prototypes, now) ─► gates every * row
LINK-01 ─► LINK-02 ─► LINK-03 ─► LINK-04* ─► LINK-05*
LINK-03 ─► GRAPH-01 ─► GRAPH-02* ─► GRAPH-03*
PLUG-01 ─► PLUG-02 ─► PLUG-03 ─► PLUG-05* ; PLUG-06 ; PLUG-04 (project infra, parallel)
EXT-01 ─► EXT-04, EXT-05, EXT-06, EXT-07 ; PLUG-01 ─► EXT-02*, EXT-03* ; EXT-08 alongside
SEC-V5 after the surfaces freeze ─► SEC-V5F ; ACC-V5 alongside ; REL-07 last
```

| Row | Item | Size | Workstream |
|---|---|---|---|
| V5UI-01 | Prototypes §8, owner approval | M | Prototypes |
| LINK-01 | `canvasLink` node, block and row targets, `[[` picker, URL patterns, exports, 0.4 round trip (ADR-081) | M | Links |
| LINK-02 | Link index: extraction at acknowledged saves, `link_edges` migration (3 stores), backfill, deletes, Redis-only refusal | L | Links |
| LINK-03 | Backlinks read path: `/access/batch` with fallback, read-time excerpts, API, MCP, clients | M | Links |
| LINK-04 | Editor: "Linked from", unlinked mentions, hover preview, block chips, states, phone, to the prototype | L | Links |
| LINK-05 | Unlinked mention → link in the source room; aliases | S | Links |
| GRAPH-01 | Graph API (local, full), ACL before expansion, cache, limits, MCP, clients (ADR-082) | M | Graph |
| GRAPH-02 | Graph view: worker layout, local panel, full view, filters, search, pins, to the prototype | L | Graph |
| GRAPH-03 | List fallback, keyboard, screen reader, phone | M | Graph |
| PLUG-01 | `.ocplugin` and `plugin.json` schema; block packages as plugins (ADR-083) | M | Plugins |
| PLUG-02 | Signatures, publisher keys, signed index with version and expiry, revocation, verification | L | Plugins |
| PLUG-03 | Server plugin store: install, verify at start, per-host enablement and policy, updates, rollback, `/healthz` | L | Plugins |
| PLUG-04 | Marketplace registry and review service, publisher portal (project infrastructure) | L | Plugins |
| PLUG-05 | Marketplace and manager UI to the prototype (browse, details, install, updates, requests, policy, blocked, phone) | L | Plugins |
| PLUG-06 | Host admin API `/api/v1/plugins`, `perms.plugins` in the launch token | M | Plugins |
| EXT-01 | WebAssembly runtime: wasmtime, WIT world, limits, host imports, module cache, pool (ADR-084) | L | Extensions |
| EXT-02 | Custom database views to the prototype | L | Extensions |
| EXT-03 | Commands to the prototype | M | Extensions |
| EXT-04 | Importers (dialog, drop, API, MCP) | M | Extensions |
| EXT-05 | Exporters (menu, API, report) | M | Extensions |
| EXT-06 | Automation actions in the rule editor and engine | M | Extensions |
| EXT-07 | Integration providers: connections, link previews, pickers (stretch: moves to 0.5.x first) | L | Extensions |
| EXT-08 | `@opencanvas/plugin-sdk`, `opencanvas-plugin` crate, `oc-plugin` CLI, docs/39 guide, samples | L | Extensions |
| SEC-V5 | Security audit of v0.5 surfaces (docs/18 §8) | L | Maturity |
| SEC-V5F | Fixes for the audit findings, each with a test | M | Maturity |
| ACC-V5 | docs/23 rows LINK-A*, GRAPH-A*, PLUG-A*, EXT-A* | S | Maturity |
| REL-07 | v0.5.0 scope lock, audit sign-off, release notes | M | Release |

Rough total: 12 L + 13 M + 2 S ≈ 44 engineer-weeks (L ≈ 2.5, M ≈ 1, S ≈ 0.4), of which ≈ 2.5
is stretch (EXT-07). Links ≈ 9, graph ≈ 6, plugins ≈ 14, extensions ≈ 15 (with EXT-07), maturity
and release ≈ 5.

**Recommended order.**

1. **Now:** V5UI-01 to the owner (links first, it carries the most new interaction); the 0.4.x
   leftovers in docs/10 §P3 v0.4 that are still open; LINK-01 and PLUG-01 (no UI).
2. **Track A:** LINK-02 → LINK-03 → GRAPH-01, then the UI rows LINK-04, GRAPH-02/03, LINK-05.
3. **Track B:** EXT-01 → PLUG-02 → PLUG-03 → PLUG-06, then EXT-04/05/06, then the UI rows PLUG-05,
   EXT-02/03; EXT-08 grows with each extension point; PLUG-04 as project infrastructure.
4. SEC-V5 once plugins and the runtime are merged, then SEC-V5F, ACC-V5, REL-07. If the
   marketplace service is not ready, v0.5 ships with private registries and uploaded packages and
   the public marketplace opens in 0.5.x; signing is never dropped.

## 11. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| `/access` per file is slow for large backlink sets and full graphs | Slow panel, host overload | `/access/batch` (≤ 200), 30 s cache, local graph default, rate limits, full graph capped |
| The index is read as an ADR-001 breach by hosts with strict data rules | Hosts refuse the flag | Ids only (LINK-A3 proves it), off by default, `DELETE` per file, documented in docs/05 |
| Read-time excerpts load source files often | Host and server load | First 20 only, 5 min memory cache, the open room first, "Show more" |
| A side channel through counts or timing reveals hidden canvases | Information leak | No counts of hidden items; batch checks always run for every candidate; audited in SEC-V5 |
| WebAssembly runtime bugs or escapes | Server compromise | wasmtime with no ambient I/O, fresh instance per call, limits, server code off by default, fuzzing, external review |
| Marketplace review is a bottleneck | Few plugins at launch | Automated checks first; manual only for server, network and connection permissions; first-party samples |
| A compromised publisher key | Malicious update | Countersignature, permission increases need an admin, hourly revocation, key rotation |
| Plugin views of large databases are slow | Bad experience blamed on OpenCanvas | Paged rows from the worker index; the view runs in its own frame; "This view is slow" with a switch to Table |
| Provider OAuth differs per service | EXT-07 slips | Stretch row; API key providers first |

## 12. Questions for the owner

1. **Excerpts:** made at read time and kept 5 minutes in memory (plan), or a short encrypted
   excerpt stored with each edge (faster, but text at rest)?
2. **Link syntax:** `[[` for canvas links and pasted host URLs recognised (plan); also `@` for
   canvases next to people?
3. **Full graph:** in v0.5 with the 2,000-node cap (plan), or local graph only until hosts
   implement `/files/readable`?
4. **Server-side plugins:** WebAssembly components in the server (plan), or only remote calls to a
   publisher's service? And an external security review of the runtime before release?
5. **Signing:** publisher Ed25519 keys plus a marketplace countersignature and a TUF-style index
   (plan), or Sigstore keyless signing with a transparency log?
6. **Who runs the marketplace** (domain, review staff, terms for publishers), and is the v0.5
   release blocked on it or may it open in 0.5.x (plan: private registries are enough for 0.5.0)?
7. **Default install mode** for a host: people request and admins approve (plan), admins only, or
   anyone from an allowed list?
8. **Provider connections:** stored by OpenCanvas encrypted under `OC_KEK` (plan), or always by the
   host through a new secrets callback?
9. **Redis-only deployments:** refuse links and the graph (plan, as automation), or build a Redis
   implementation?
10. **Paid plugins, ratings and reviews:** out of v0.5 (plan)?

## 13. What v0.6 builds on (advanced automation and app building)

v0.5 lays the rails v0.6 needs, without building v0.6:

- **Actions** (§5.7) are the step type of v0.6's multi-step workflows (branches, waits, loops over
  rows, approvals).
- **The runtime** (§5.2) runs v0.6's scripted steps and computed app logic under the same limits.
- **Provider connections** (§5.8) become v0.6's synced databases from outside services.
- **Custom views and commands** (§5.3, §5.4) are the first pieces of v0.6's app pages: forms,
  buttons and layouts over databases.
- **The graph API** (§3) lets v0.6 rules react to links ("when a canvas links to this project").

A v0.6 plan (docs/40) follows the v0.5 owner decisions.
