# 09 — Roadmap and delivery

**Status:** updated 2026-11-28 (third revision of this plan). Released: v0.4.1 (2026-11-28). In progress: v0.4.2 (the
partial-sync remainder) and v0.5 (plugins, backlinks, a knowledge graph), with the Workspace track in
parallel. Planned: v0.6. Rows in [10-EXECUTION-TRACKER.md](10-EXECUTION-TRACKER.md) carry the detail.

| Phase | Goal | Exit gate |
|---|---|---|
| **P0 Foundation** | Research, PRD, HLD, technical design, ADRs, tracker; **UI prototype approved on Artifact**; repo scaffold + CI | User approval of PRD/HLD and UI-01 prototype (met: UI-02 approved 2026-11-21, PRD and HLD signed off 2026-11-24) |
| **P1 MVP** | Rust server (JWT launch, rooms, WAL, commits, SQLite); editor with text/lists/tables/images/files/links/embeds; presence + cursors; preview; MD/HTML/.ocanvas export; embed SDK; sample host. Shipped in v0.1.0-alpha.1 and v0.1.0 (2026-11-23) | Two browsers co-edit via sample host; commit round-trip; convergence fuzz green; p95 < 150 ms @ 20 editors |
| **P2 Board & scale** | Board block; columns; comments; WOPI mode; MySQL/MariaDB + Redis cluster; PDF/DOCX/PNG export; templates; role API; Helm. Shipped across v0.1.0 to v0.1.2 | 3-node chaos test (kill owner, no acked edit lost); MySQL+MariaDB CI; board fuzz green |
| **P3 Platform** | The releases in the release roadmap: the stable headless API, webhooks, version history and the block SDK (v0.2); live blocks, offline-first editing, search and automation (v0.3); spreadsheets, advanced databases, partial sync and performance (v0.4); plugins, backlinks and a knowledge graph (v0.5); advanced automation and app building (v0.6) | Each release has its acceptance rows in docs/23, a security audit in docs/18, release notes with upgrade notes and known limitations, and a tag; the release notes name every changed default (partial sync is on by default since v0.4.0) |

AI was brought forward (owner directive, 2026-11-22): phase 1 of the assistant, the MCP
endpoint and the model providers shipped in v0.1.0-alpha.1, experimental and off by default
(tracker rows AI-01, AI-02, AI-UI; design [24](24-AI-AND-MCP.md) §11).

## Architectural principle

**OpenCanvas integrates with any third-party application through standardized APIs and SDKs,
without depending on specific CasualOffice products.** Hosts connect through the documented
launch tokens, callbacks, WOPI, REST, postMessage, the `<open-canvas>` SDK and MCP; nothing in the
server or editor assumes a particular host. This keeps the project independent and modular, and
open to a broad developer ecosystem (ADR-038).

## Release roadmap

| Version | Status | Focus |
|---|---|---|
| v0.1.0 | Released 2026-11-23 ([notes](28-RELEASE-v0.1.0.md)) | First final release, after v0.1.0-alpha.1 the same day: the collaborative editor, databases, whiteboards, templates and embedding, WOPI with proof keys, block schema validation |
| v0.1.1 | Released 2026-11-23 ([changelog](../CHANGELOG.md)) | Jitsi Meet integration and temporary canvases |
| v0.1.2 | Released 2026-11-24 ([notes](31-RELEASE-v0.1.2.md)) | Additional host integrations (Nextcloud, Mattermost, Element / Matrix), structured diagramming, version history, headless API foundation, link previews, team templates and viewer previews |
| v0.2.0 | Released 2026-11-25 ([notes](32-RELEASE-v0.2.0.md)) | Stable headless API (`/api/v1`) with TypeScript and Rust clients, webhooks, version history, the block SDK, and host editor profiles. Live blocks moved to v0.3 |
| v0.2.1 | Released 2026-11-26 ([changelog](../CHANGELOG.md)) | The categorised insert menu (INS-01) and three fixes |
| v0.3.0 | Released 2026-11-26 ([notes](35-RELEASE-v0.3.0.md)) | Portable live blocks, offline-first editing, find and replace and cross-canvas search, and automation rules ([plan](34-ROADMAP-v0.3.md)) |
| v0.4.0 | Released 2026-11-28 ([notes](37-RELEASE-v0.4.0.md)) | Spreadsheets; advanced databases (formulas, relations, rollups, 100,000 rows, Timeline/Gantt, Workload); linked charts; partial sync on by default; 10,000 connections per node; reliability drills; Nextcloud Talk ([plan](36-ROADMAP-v0.4.md)) |
| v0.4.1 | Released 2026-11-28 ([changelog](../CHANGELOG.md)) | Spreadsheet cell comments and collaborative undo, floating linked charts, Timeline and Workload finishing touches, faster large-sheet edits, a smaller first load, SBOMs on every release |
| v0.4.2 | Released 2026-11-28 ([changelog](../CHANGELOG.md)) | Partial sync completed: spreadsheets as parts, a fast reopen of large canvases (50 MB in about 2 s), one render on open; the v0.5 links preview (off unless the host enables it) |
| v0.4.3 | Released 2026-11-28 ([changelog](../CHANGELOG.md)) | The release container builds again (the first published image since 0.3.0) |
| v0.4.4 | In progress | OpenCanvas Workspace image (`ghcr.io/casualoffice/opencanvas-workspace`), install script and SHA256SUMS on every release, the whiteboard UX pass (context menu, tool lock, style panel, rotation, selection and smart guides, quick-connect, frames and Present, export and copy as image, templates, cursors and Follow, centred tool bar), the knowledge graph view, and fixes |
| [v0.5](38-ROADMAP-v0.5.md) | In progress | Built: links and backlinks, the graph API and the knowledge graph view. Next: plugins with a marketplace (signed packages, admin policy) and SDK extension points (database views, commands, importers, exporters, automation actions, integration providers). Prototypes and ADR-081 to ADR-084 approved 2026-11-28 |
| [Workspace](40-WORKSPACE.md) | In progress (parallel track; MVP built) | OpenCanvas Workspace by CasualOffice: one Docker image with accounts, passkeys, workspaces, teams, sharing and admin-controlled public links, typed files that open full screen (documents, spreadsheets, whiteboards, databases), search, trash, version history, backups and admin. Image published from v0.4.4. Next: e-mail sending, scheduled backups and restore, SSO (backlog) |
| v0.6 | Planned | Advanced automation and app building (direction set 2026-11-28) |

Alongside the releases, **structured diagramming** is its own workstream ([docs/29](29-DIAGRAMMING.md)):
diagram mode on a board, shape libraries, ports, connectors that route around shapes, auto-layout,
generic icons plus your own, and draw.io, Excalidraw and Mermaid import. It ships when each part is
ready and does not move the release commitments above.

## Feature priorities

| Feature | Value | Complexity | Priority | Status |
|---|---|---|---|---|
| Portable live blocks | Very high | High | P1 (v0.3) | Shipped in v0.3.0 |
| Extensible block SDK | Very high | High | P0 | Shipped in v0.2.0; SDK blocks inside live blocks (PSDK) to do |
| Stable headless API | Very high | Medium | P0 | Shipped in v0.2.0 (behind a flag in v0.1.2) |
| Offline-first collaboration | High | Very high | P1 | Shipped in v0.3.0 |
| Version history and visual diffs | High | High | P0 (v0.2) | Shipped in v0.1.2 |
| Database formulas and relations | High | Medium–high | P1 | Shipped in v0.4.0 |
| Full-text search API | High | Medium | P1 | Shipped in v0.3.0 (through the host's search) |
| Webhooks (v0.2) and automation (v0.3) | High | Medium | P0 / P1 | Shipped in v0.2.0 and v0.3.0 |
| Developer plugin marketplace | Medium initially | Very high | P3 | In progress (v0.5) |

Owner decision 2026-11-24: version history and webhooks move into v0.2; portable live blocks move to
v0.3 so v0.2 ships sooner. Before v0.2 starts, 0.1.x also gets link previews (UNF-01), host team
templates (TPL-01), viewer preview (RND-01) and Jitsi with Jitsi's own JWT sign-in, an owner
exception to the 0.1.x scope lock below.

Priority here is the order of work across the releases above, not the delivery phases P0–P3 in
the first table.

## v0.1.0 scope lock

The final v0.1.0 is frozen as v0.1.0-alpha.1 plus the alpha.2 security fixes and three blockers
(WOPI proof keys, block schema validation, the template load test); after the lock only P0/P1 bug
and security fixes go into 0.1.x and features go to 0.2.0. Exit criteria and limitations:
[docs/26](26-RELEASE-v0.1.0-SCOPE.md) (tracker REL-02).

## v0.2 detail

The detailed design plan for v0.2 is [docs/27](27-ROADMAP-v0.2.md): portable live blocks as host files embedded by reference and opened as their own rooms (ADR-039), a block SDK with one generic sandboxed block node and server-side schema validation (ADR-040), and a stable, versioned headless API shared with the MCP tools (ADR-041), keeping `.ocanvas` at format version 1 (ADR-042). Its delivery rows are the P3 section of the tracker.

## v0.3 detail

The detailed design plan for v0.3 is [docs/34](34-ROADMAP-v0.3.md): live blocks as designed in docs/27 §2 with small deltas (ADR-069), offline copies kept only on the person's device under host and per-canvas opt-in with fresh host launches on reconnect (ADR-063, ADR-064), find and replace in the client and cross-canvas search indexed by the host from a `search.json` in every save (ADR-065, ADR-066), and automation rules stored in the document and run by the server on the rule owner's behalf (ADR-067, ADR-068). Its delivery rows are the P3 v0.3 section of the tracker; prototypes (V3UI-01) gate the UI rows.

## v0.4 detail

The detailed design plan for v0.4 is [docs/36](36-ROADMAP-v0.4.md) (owner direction 2026-11-26): the main thrust is performance and partial synchronization. Partial sync keeps databases, boards and diagrams as subdocuments loaded on view so a 50 MB canvas opens in under 2 s (ADR-076); a benchmark program (`scripts/bench/`, scheduled CI, published results with hardware and load mix, regression gates; ADR-079) drives the performance work: 10,000 connections on a 4 vCPU / 8 GB node and 1,000 editors in one room with batched presence and fan-out sharded across cores (ADR-077), lower browser memory and lazy modules. Maturity follows: crash, failover and restore drills, flaky tests, the MySQL conformance failures and a security audit of the v0.3 surfaces. Formulas, relations and rollups (ADR-078), virtualized databases, integrations and UX fixes are also in v0.4 but secondary. Caps rise only after the cluster, crash and sustained runs pass. Its delivery rows are the P3 v0.4 section of the tracker; prototypes (V4UI-01) gate the UI rows.

## v0.5 detail

The detailed design plan for v0.5 is [docs/38](38-ROADMAP-v0.5.md) (owner direction 2026-11-28): plugins packaged as signed files with a marketplace and admin policy (ADR-083), backlinks and linked references from a link index across canvases (ADR-081), a knowledge graph from a graph API (ADR-082), and SDK extension points for database views, commands, importers, exporters, automation actions and integration providers (ADR-084). The plan, the prototypes and ADR-081 to ADR-084 were approved on 2026-11-28. Its delivery rows are the P3 v0.5 section of the tracker.

## Workspace track

[docs/40](40-WORKSPACE.md) plans OpenCanvas Workspace by CasualOffice, a first-party host: one Docker image with accounts, passkeys, workspaces, teams, sharing, typed files, search, trash, version history, backups and admin, using only the documented host contract (ADR-038). The owner accepted the plan, the prototype and ADR-085 on 2026-11-28 with the changes in docs/40 §0: SSO moves to the backlog (WS-07), UX first, lightweight, a benchmark on the user base (WS-25), large rooms, and admin-configurable public links. It runs in parallel to v0.5; its rows are the Workspace track section of the tracker.

## Milestone sequence (P0 → P1)

1. P0-a Docs set approved (this PR).
2. P0-b **UI-01 prototype** (editor + presence + board + embed chrome) published as Artifact → approval.
3. P0-c Scaffold: Cargo workspace, pnpm workspace, CI (fmt, clippy, tests, SQLite+MySQL+MariaDB matrix).
4. P1-a `oc-model` + `.ocanvas` round-trip.
5. P1-b `oc-store` migrations + repos.
6. P1-c `oc-host` JWT + callbacks + sample host.
7. P1-d `oc-collab` room actor + WAL + role filter + fuzz harness.
8. P1-e `oc-server` routes + WS.
9. P1-f Web editor (after UI-01 approval) + embed SDK.
10. P1-g Preview + exports; commit engine; e2e.
