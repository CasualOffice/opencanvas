# Changelog

All notable changes to OpenCanvas are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Day-by-day detail and the evidence for
each change are in the integration log of [the tracker](docs/10-EXECUTION-TRACKER.md).

## [Unreleased]

## [0.1.2] - 2026-11-24

See the [release and upgrade notes](docs/31-RELEASE-v0.1.2.md).

### Added

- Nextcloud WOPI app, Mattermost channel canvases, and Element / Matrix room widgets.
- Diagram mode with searchable shape libraries, ports, obstacle-aware connectors, auto-layout,
  draw.io and Excalidraw import, and draw.io and Mermaid export.
- Version history with named versions, preview and comparison, restore and temporary undo
  where supported by the host.
- Headless API under `/api/v1` with OpenAPI 3.1, scoped tokens, and idempotency keys on file writes.
- API events stream (SSE and WebSocket) with resume, and a headless sync token.
- Server-rendered previews, host team templates, and a Grafana dashboard with alert rules.

### Changed

- Large boards use incremental projection and draw less detail when zoomed out.
- Editor controls and icons scale with the reader's text size.
- Hosts can set per-host frame ancestors and temporary-canvas wording.

### Fixed

- Concurrent edits preserve separate diagram properties during mixed-version collaboration.
- A Jitsi role change takes precedence over launch tokens issued before the change.

## [0.1.1] - 2026-11-23

Jitsi Meet integration and temporary canvases. No upgrade steps: existing hosts behave as before.

### Added

- **Jitsi Meet** (`integrations/jitsi/`, JIT-02): `mod_opencanvas.lua` gives every meeting a
  shared canvas in Jitsi's Shared document slot, like Etherpad. One Prosody plugin plus `.env`
  lines, no Docker image or compose changes. Per-person launch tokens, a fresh token on reload,
  the meeting end closes the canvas. Tested end to end against a stock docker-jitsi-meet
  (stable-11509-1) with two browsers; guide in `integrations/jitsi/README.md`.
- **Temporary canvases** (`storage = "ephemeral"`, ADR-043, JIT-01) for hosts with no file
  storage: no load or save callbacks; everything is deleted when the room closes (idle grace or
  `DELETE /v1/files/{id}/session`). A server restart or deploy keeps the canvas for the reconnect.
- `template` for temporary canvases: a built-in template id (`meeting`, `standup`, `retro`, …)
  or an `.ocanvas`/Markdown file, applied once by the server. Unset: blank.
- Editor: a temporary canvas says "Not saved · temporary", opens without the template picker,
  shows no host name, and its ended screen says it was deleted.

### Fixed

- The block handle (+ and drag grip) disappeared when the pointer crossed the gap between the
  text and the handle, so it could not be clicked or dragged.
- Plugin: tokens signed with Jitsi's `luajwtjitsi` did not verify (non-standard signature
  encoding); the plugin now signs with Prosody's own HMAC. Jitsi appends its Etherpad options
  with `?`, which broke the token; the launch URL now ends in `&ep=`.

### Changed

- The template button in the top bar of an open canvas is gone; new canvases still start from
  the template picker (or blank, for a temporary canvas).

## [0.1.0] - 2026-11-23

The first final release: v0.1.0-alpha.1 plus the alpha.2
security fixes and the three release blockers (scope: [docs/26](docs/26-RELEASE-v0.1.0-SCOPE.md)).
Support is best effort with no SLA. Release notes, upgrade notes and known limitations:
[docs/28](docs/28-RELEASE-v0.1.0.md).

### Upgrade notes

- **WOPI hosts require proof keys.** With any WOPI host configured, the server refuses to start
  without `OC_WOPI_PROOF_KEY` (PEM, or sealed with `opencanvas seal-proof-key`); on Helm set
  `wopi.proofKeySecret`. Rotate with `OC_WOPI_PROOF_KEY_OLD` (Helm `wopi.oldKey: true`).
- **MCP needs `OC_PUBLIC_URL`** or `[host.ai] mcp_audience`; without either, MCP answers `404`.
- **MCP tokens must name their files** (`files` claim) unless the host has the `/access`
  callback or sets `[host.ai] mcp_all_files = true`.
- **WOPI sessions are capped at 10 h** after the launch.
- **Invalid documents and writes are refused:** an `.ocanvas` that breaks the block schema is
  refused when read (`/v1/convert`: 400 `INPUT_INVALID`), and a REST patch, import or MCP write
  that breaks it answers 400 `PATCH_INVALID`. Unknown blocks and attributes are still kept.

### Added

- **WOPI proof keys (WOPI-13):** every WOPI call is signed (`X-WOPI-TimeStamp`, `X-WOPI-Proof`,
  `X-WOPI-ProofOld`, SHA256withRSA); `/hosting/discovery` publishes the current and old keys;
  `opencanvas seal-proof-key`; the reference WOPI host verifies proofs; Helm
  `wopi.proofKeySecret`.
- **Block schema validation (MOD-01)** in `oc-model` on `.ocanvas` read, REST patch, import and
  MCP writes, with JSON-pointer paths; unknown nodes are warnings, kept and counted in
  `oc_schema_warnings_total`.
- **Template load test (FC-07):** all 40 built-in templates validate and round-trip through
  `.ocanvas`.
- **Release artefacts:** `.github/workflows/release.yml` builds a multi-architecture image
  `ghcr.io/casualoffice/opencanvas` (linux/amd64, linux/arm64) pinned to the tag, standalone
  Linux binaries (x86_64, aarch64) with the editor bundle, checksums and build provenance.
- The v0.2 plan ([docs/27](docs/27-ROADMAP-v0.2.md)) and the release roadmap (ADR-038).

### Changed

- Licence: the Apache License 2.0 (ADR-037), with NOTICE and SPDX headers.

### Fixed

- Memory was not returned after idle rooms closed (jemalloc purge refused and the error
  ignored): RSS with 0 rooms after eviction fell from 856 MB to 174 MB (docs/22 §9.7).

### Security

- **MCP audience (SEC-33):** the MCP token audience comes from `[host.ai] mcp_audience` or
  `OC_PUBLIC_URL`, never from the request's `Host` header. Without either, MCP is off (`404`) and
  the server logs one start-up warning.
- **MCP file scope (SEC-34):** when the host has no `/access` callback, an MCP token must name
  its files in a `files` claim; a token without one is refused (`FILES_REQUIRED`). The broad
  behaviour (one token's role on every file) needs `[host.ai] mcp_all_files = true`.
- **WOPI session cap (SEC-35):** a WOPI session ends at `access_token_ttl` or 10 h after the
  launch, whichever is first, like a JWT session.
- **WOPI caller authenticity (SEC-44):** WOPI hosts can verify that calls come from OpenCanvas
  (proof keys, above). Signing uses `rsa` 0.10.

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

[Unreleased]: https://github.com/CasualOffice/opencanvas/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CasualOffice/opencanvas/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/CasualOffice/opencanvas/releases/tag/v0.1.0-alpha.1
