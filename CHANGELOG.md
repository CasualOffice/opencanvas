# Changelog

All notable changes to OpenCanvas are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Day-by-day detail and the evidence for
each change are in the integration log of [the tracker](docs/10-EXECUTION-TRACKER.md).

## [Unreleased]

Targeted for v0.1.0-alpha.2.

### Security

- **MCP audience (SEC-33):** the MCP token audience comes from `[host.ai] mcp_audience` or
  `OC_PUBLIC_URL`, never from the request's `Host` header. Without either, MCP is off (`404`) and
  the server logs one start-up warning. **Upgrade:** set `OC_PUBLIC_URL` (or `mcp_audience`) on
  any host that uses MCP.
- **MCP file scope (SEC-34):** when the host has no `/access` callback, an MCP token must name
  its files in a `files` claim; a token without one is refused (`FILES_REQUIRED`). The broad
  behaviour (one token's role on every file) needs `[host.ai] mcp_all_files = true`.
- **WOPI session cap (SEC-35):** a WOPI session ends at `access_token_ttl` or 10 h after the
  launch, whichever is first, like a JWT session.

## [0.1.0-alpha.1] - 2026-11-23

**Licence:** relicensed from BUSL-1.1 to the Apache License 2.0 before this first release, with
attribution through NOTICE and an SPDX header in every source file (ADR-036).

Embeddable collaborative workspace canvas. The first alpha, for evaluation; there is no production
SLA. Release notes, known limitations, backup and recovery:
[docs/25](docs/25-RELEASE-v0.1.0-alpha.1.md).

### Added

- **Editor:** rich text blocks (headings, lists, checklists, toggles, quotes, callouts, code with
  syntax highlighting, simple tables, images, files, link cards, sandboxed embeds, columns), slash
  menu, block menu, selection toolbar, and side-panel and phone layouts.
- **Databases:** typed fields; table, board, calendar and gallery views; filter, sort and search;
  row detail; spreadsheet keyboard, ranges and clipboard; CSV import and export.
- **Whiteboards:** pen, sticky notes, shapes, text, bound and elbow connectors with waypoints,
  frames, images, multi-select, groups, alignment, snapping, minimap, SVG and PNG export.
- **Templates:** 40 templates in 9 categories, plus blank canvas, database, whiteboard and import.
- **Collaboration:** live co-editing over Yjs, cursors, avatars, follow mode, comments with
  mentions, a shared undo stack, and view, comment and edit roles enforced on the server.
- **Host integration:** HS256, RS256, EdDSA and JWKS launch tokens; signed callbacks; the live
  role API; host members and revocation; the `<open-canvas>` embed SDK and postMessage API;
  access expiry warning and quiet renewal (ADR-036).
- **WOPI client mode:** discovery, CheckFileInfo, GetFile, PutFile, PUT_RELATIVE conflict copies,
  assets and mentions, and a reference WOPI host.
- **Saving:** autosave only, through a durable outbox; host 409 conflicts save a copy or reload.
- **Import and export:** `.ocanvas`, Markdown, HTML, CSV, DOCX, PDF (Gotenberg sidecar, with a
  print fallback) and board SVG/PNG; server-side Markdown, HTML and CSV import, off by default.
- **Storage and deployment:** SQLite by default; MySQL 8.4 and MariaDB 11.4 with `DATABASE_URL`;
  cluster mode with Redis leases and relay, and a Redis-only cluster (ADR-030); Docker image and
  Helm chart.
- **Durability:** `memory` mode by default without Redis (ADR-029), `wal` mode with batched WAL
  and group commit, and a hot WAL in Redis (ADR-028); fencing epochs against stale room owners.
- **AI assistant and MCP endpoint (experimental, disabled by default):** server-side model
  providers (Claude Platform, OpenAI-compatible servers), plan → approve → act → review → undo
  runs, suggestions, limits, quotas and audit; MCP at `POST /mcp/{hostId}` with host-issued
  tokens (ADR-031 to ADR-035).
- **Operations:** `/healthz`, `/readyz`, Prometheus `/metrics` including `oc_wal_append_seconds`,
  graceful drain with HTTP 503 for new WebSocket upgrades, `scripts/bench.sh` capacity and chaos
  benchmarks, and `scripts/audit.sh` supply-chain checks.
- Documentation: PRD, architecture, technical design, integration guide, build contract,
  security and limits, capacity and sizing (docs/22), acceptance matrix (docs/23), and AI and MCP
  (docs/24); the public website.

### Changed

- jemalloc is the default allocator; memory is purged when a room closes (docs/22 §9.6, §9.7).
- Idle rooms are saved and dropped after `OC_ROOM_IDLE_MS` (60 s).
- Outbound updates are merged into one frame per room every 40 ms; socket write batches are capped.

### Fixed

- A `.ocanvas` file whose `ydoc.bin` is a v2 Yjs update loaded as an empty canvas (docs/23 FC-03b).
- Saves kept using a revoked editor's token after a role change (docs/23 PERM-05).
- A frozen node could keep writing rooms another node had claimed; a failed WAL append was still
  fanned out; MariaDB deadlocks were not retried; a draining node accepted and then closed
  WebSocket upgrades (docs/22 §8 weaknesses 3, 4, 5, 7).
- The host's `export_formats` flag was not enforced (docs/23 EX-09).
- Memory was not returned after idle rooms closed: the jemalloc purge call was refused and the
  error ignored; RSS with 0 rooms fell from 856 MB to 174 MB in the S2 run (docs/22 §9.7).

### Security

- Callback and outbox tokens sealed at rest with AES-256-GCM under `OC_KEK`; the server refuses
  to start without `OC_KEK` outside development.
- HTML export is sanitised and served with a sandbox CSP; imported HTML drops scripts, event
  handlers and `javascript:` links.

[Unreleased]: https://github.com/CasualOffice/opencanvas/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/CasualOffice/opencanvas/releases/tag/v0.1.0-alpha.1
