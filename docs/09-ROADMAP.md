# 09 — Roadmap and delivery

**Status:** v0.2 of this plan, 2026-11-23 (release roadmap and feature priorities added; owner). Rows in
[10-EXECUTION-TRACKER.md](10-EXECUTION-TRACKER.md) carry the detail.

| Phase | Goal | Exit gate |
|---|---|---|
| **P0 Foundation** | Research, PRD, HLD, technical design, ADRs, tracker; **UI prototype approved on Artifact**; repo scaffold + CI | User approval of PRD/HLD and UI-01 prototype |
| **P1 MVP** | Rust server (JWT launch, rooms, WAL, commits, SQLite); editor with text/lists/tables/images/files/links/embeds; presence + cursors; preview; MD/HTML/.ocanvas export; embed SDK; sample host | Two browsers co-edit via sample host; commit round-trip; convergence fuzz green; p95 < 150 ms @ 20 editors |
| **P2 Board & scale** | Board block; columns; comments; WOPI mode; MySQL/MariaDB + Redis cluster; PDF/DOCX/PNG export; templates; role API; Helm | 3-node chaos test (kill owner, no acked edit lost); MySQL+MariaDB CI; board fuzz green |
| **P3 Platform** | The release roadmap below: portable live blocks, an extensible block SDK and stable headless APIs (v0.2), then offline-first editing, version history, search and automation (v0.3) | Each release ships behind feature flags with its acceptance rows in docs/23 |

AI was brought forward (owner directive, 2026-11-22): phase 1 of the assistant, the MCP
endpoint and the model providers is built and in review (tracker rows AI-01, AI-02, AI-UI;
design [24](24-AI-AND-MCP.md) §11).

## Architectural principle

**OpenCanvas integrates with any third-party application through standardized APIs and SDKs,
without depending on specific CasualOffice products.** Hosts connect through the documented
launch tokens, callbacks, WOPI, REST, postMessage, the `<open-canvas>` SDK and MCP; nothing in the
server or editor assumes a particular host. This keeps the project independent and modular, and
open to a broad developer ecosystem (ADR-038).

## Release roadmap

| Version | Focus |
|---|---|
| v0.1 | First public alpha: the collaborative editor, databases, whiteboards and embedding |
| [v0.1.2](31-RELEASE-v0.1.2.md) | Additional host integrations, structured diagramming, version history, headless API foundation, link previews, team templates and viewer previews |
| [v0.2.0](32-RELEASE-v0.2.0.md) (released 2026-11-25) | Stable headless API (`/api/v1`) with TypeScript and Rust clients, webhooks, version history, the block SDK, and host editor profiles. Live blocks moved to v0.3 |
| [v0.3](34-ROADMAP-v0.3.md) | Portable live blocks, offline-first editing, search and automation (plan proposed 2026-11-26) |
| v0.4 | Advanced databases, partial synchronization and performance improvements |
| v0.5 | Plugin ecosystem, developer tooling and enterprise hardening |

Alongside the releases, **structured diagramming** is its own workstream ([docs/29](29-DIAGRAMMING.md)):
diagram mode on a board, shape libraries, ports, connectors that route around shapes, auto-layout,
generic icons plus your own, and draw.io, Excalidraw and Mermaid import. It ships when each part is
ready and does not move the release commitments above.

## Feature priorities

| Feature | Value | Complexity | Priority |
|---|---|---|---|
| Portable live blocks | Very high | High | P1 (v0.3) |
| Extensible block SDK | Very high | High | P0 |
| Stable headless API | Very high | Medium | P0 |
| Offline-first collaboration | High | Very high | P1 |
| Version history and visual diffs | High | High | P0 (v0.2) |
| Database formulas and relations | High | Medium–high | P1 |
| Full-text search API | High | Medium | P1 |
| Webhooks (v0.2) and automation (v0.3) | High | Medium | P0 / P1 |
| Developer plugin marketplace | Medium initially | Very high | P3 |

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
