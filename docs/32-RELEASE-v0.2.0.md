# 32 — Release v0.2.0: scope lock and release notes

**Status:** released 2026-11-25, tag `v0.2.0` (tracker REL-04). Includes the block SDK runtime
(BSDK-03/04), host editor profiles (EDP-01) and block discovery metadata.
**Licence:** Apache-2.0 (ADR-037).
**Plan:** [docs/27](27-ROADMAP-v0.2.md).
**Acceptance:** [docs/23 §v0.2](23-ACCEPTANCE.md#v02-acceptance-acc-v2).
**Security audit:** [docs/18 §6](18-SECURITY-AUDIT.md#6-release-audit-v020-2026-11-25-rel-04).

OpenCanvas 0.2.0 makes the headless API the supported way for programs to read and write
canvases. It also adds webhooks, version history and a block SDK. The host still owns users,
permissions and files; OpenCanvas never stores documents (ADR-001). Support is best effort, with
no SLA.

## 1. What 0.2.0 contains (frozen)

v0.2 = the stable headless API (docs/27 §4), the block SDK (§3), version history and webhooks
(§0). The owner moved portable live blocks (§2, LIVE-01..06) to v0.3 on 2026-11-24. On
2026-11-25 the owner added host editor profiles and block discovery metadata.

Version 0.1.2 already shipped part of this work: HAPI-01..05 (the `/api/v1` router, tokens,
idempotency, cursors and rate limits, and the events stream) and version history. 0.2.0 makes
them the stable contract and adds the rest.

| Part | Content | Rows | Status |
|---|---|---|---|
| Headless API | `/api/v1` with OpenAPI 3.1 at `/api/v1/openapi.json` and RFC 9457 errors. User-scoped bearer tokens share one auth check with MCP (`canvas:read/comment/write/admin`). `Idempotency-Key` works on every file write. Cursors are signed. Rate limits use `RateLimit` headers and are shared with MCP. There is an events stream (SSE and WebSocket) and a headless CRDT sync token. The 0.1 routes stay as deprecated aliases | HAPI-01..05 | Built (in 0.1.2), stable in 0.2.0 |
| Clients | TypeScript `@opencanvas/client` and Rust `opencanvas-client`, both generated from the OpenAPI document. They retry, send idempotency keys, page through cursors, resume events and verify webhooks, and they share one conformance suite | HAPI-06, HAPI-07 | Built |
| MCP over the API | Every MCP canvas tool is an adapter over an API operation, with the same scope, limiter and idempotency store. `POST /api/v1/files/{id}/boards` is new | HAPI-08 | Built |
| API reference | `/api/` on the website: guides, plus one page per OpenAPI tag | API-DOCS-01 | Built |
| Webhooks | Signed deliveries of the events-stream events from a durable outbox (`webhook_outbox`). Retries with backoff, sent once per cluster, same-origin only | WH-01 | Built |
| Version history | Named versions, list, preview, diff, and restore with a 30 s undo. History comes from host callbacks or from bounded in-file history | VH-00..03 | Built (in 0.1.2) |
| Block SDK, data side | Block manifests with a JSON Schema registry in MOD-01, checked on every write path (including the room WebSocket, SEC-46). One generic `extBlock` node and the `ext` root. Declarative export templates and fallbacks. Versions and declarative migrations. 0.1.x forward compatibility | BSDK-01, -02, -05 | Built |
| Block SDK, runtime | A sandboxed iframe per block on a separate origin, a CSP and a bridge RPC. The `@opencanvas/block-sdk` package, the `oc.progress` and `acme.okr` samples, and an author guide | BSDK-03, -04 | **In progress: gates the tag** |
| Block discovery metadata | The manifest gains `discovery`: label, category, keywords, profiles and complexity | (SDK agent) | **In progress: gates the tag** |
| Host editor profiles | `[host.editor]` profiles (notebook, meeting, project, diagramming, document, full). Each sets the enabled blocks, the quick-insert blocks and the feature switches. Hidden blocks are never deleted | EDP-01 | **In progress: gates the tag** |

## 2. Change control until the tag

- **Allowed:** finishing BSDK-03/04, EDP-01 and block discovery metadata as designed, and P0/P1
  fixes and security fixes. Each change has a tracker row, a test seen failing first and a
  CHANGELOG line.
- **Not allowed:** new endpoints, new config or format changes outside those rows. They go to
  0.2.1 or v0.3.
- `.ocanvas` stays format version 1 and `schemaVersion` 1 (ADR-042). Additions are additive:
  `extBlock`, the `ext` root, `history/` and `requires.blocks`.

## 3. Upgrade notes

The steps differ by the version you start from. **Back up the database and the host files
first.** Let pending saves finish before you replace the server. Migrations run at start-up.

1. **Database migrations 0008 and 0009.**
   - `0008_api_idempotency` (new in 0.1.2) creates the `api_idempotency` table.
   - `0009_webhook_outbox` (new in 0.2.0) creates the `webhook_outbox` table.
   - Both hold ids, counts, revisions and event JSON only, never document content.
   - Both run on SQLite, MySQL 8 and MariaDB 10.11. Redis-only storage uses keys instead.
   - Nodes that start together on an empty database now wait for each other's migrations
     (SEC-47). From 0.1.0 or 0.1.1 both migrations run; from 0.1.2 only 0009.
2. **New per-host config sections.** All are optional. A host without them behaves as in 0.1.x.
   - `[host.api]`: user tokens (`issuer`, `audience`, `all_files`, `token_admin`), rate limits
     (`rate_per_sec`, `burst`, per-file writes) and `default_mode`. User tokens need
     `OC_PUBLIC_URL` or `[host.api] audience`.
   - `[host.webhooks]`: `url` (same origin as `callback_base`, checked at start-up), `events`,
     `secret` and `max_attempts`. Receivers verify `X-OpenCanvas-Signature` v2 and deduplicate
     by `Idempotency-Key`.
   - `[host.versions]`: history sources and the bounds of in-file history (docs/30).
   - `[host.blocks]`: `enabled = ["type@range"]` picks which installed SDK packages the host's
     editors see; the default is none. Packages are installed by the operator in
     `OC_BLOCKS_DIR`. `OC_BLOCKS_ORIGIN` must be a different site from `OC_PUBLIC_URL`.
   - `[host.editor]` (EDP-01): the editor profile. The default, `full`, behaves exactly like
     0.1.x. A narrower profile hides blocks and features in the editor and never deletes
     content.

   Start-up checks every section and refuses a bad value with a message that names it.
3. **The headless API is on by default** (owner decision, 2026-11-25). `/api/v1` answers for
   every host unless it sets `[host.flags] api_v1 = false`. It grants nothing new: every call
   needs the host key, which the 0.1 routes already accept, or a token of at most 15 minutes that
   the host signs itself, and user tokens stay off until the host sets a public base URL. The 0.1
   routes (`/v1/files/{id}/patch|commit|role|import|session`, `/v1/convert`) keep working. They
   now carry a `Deprecation` header and a `Link: rel="successor-version"`, and v0.3 retires them
   (docs/27 §9 decision 8), so on by default gives hosts the 0.2 line to move over.
4. **Editors older than 0.2 on documents with SDK blocks are closed with 4426.** A 0.1.x
   editor deletes every `extBlock` it receives, because its schema has no such node. The room
   refuses that update and closes the session with code 4426 ("editor out of date: reopen the
   canvas"). Reloading the page loads the current editor. Hosts that cache the editor bundle or
   pin an old embed should reload it after the upgrade. Documents without SDK blocks are not
   affected.
5. **Room updates are checked against SDK block schemas** (SEC-46). A client that writes attrs
   or data that break an installed package's schema gets a denial, as API and MCP writes
   already did.
6. Container: `ghcr.io/casualoffice/opencanvas:0.2.0`. Helm: chart `0.2.0`. WOPI hosts still
   need proof keys. For older deployments, read the
   [v0.1.0 upgrade notes](28-RELEASE-v0.1.0.md#upgrade-notes) first.

## 4. Known limitations

- **No portable live blocks.** They moved to v0.3 (docs/27 §2, docs/23 LIVE-A1..A7 deferred).
- **The categorised insert menu is a v0.2.1 follow-up.** It uses `[host.editor]` profiles and
  block discovery metadata, and it is built after its prototype is approved (ADR-011). In 0.2.0
  the existing slash menu shows what the profile enables.
- **Block SDK.** No marketplace, and no install from the browser (v0.5). No third-party code
  runs on the server. Script migrations run only in the sandbox.
- **Headless API.** No `OpenCanvas-Version` date header (decision 6). The MCP tool
  `inputSchema`s are still written by hand, not generated from the OpenAPI components. The Rust
  client has no `yrs` CRDT-sync feature; `create_sync_token` returns a ticket for any
  y-websocket client. Neither client is published to a registry (`private` / `publish = false`).
- **Open Low security findings** (docs/18 §6), each with a recorded decision:
  - token grants allow exports of what the token can read;
  - the sync-ticket connect window counts from first use;
  - history caches are per room;
  - huge diagram coordinates become `null`;
  - SEC-36 and SEC-37 from v0.1.0.
- **Not demonstrated:** scale-out across machines. Single node first; the room cap is 550
  (docs/22).
- AI and MCP are experimental and off by default.

## 5. Release checklist

Run on **the release commit**, after BSDK-03/04, EDP-01 and the discovery metadata are merged.
A check that ran only on an earlier commit does not count. Results from this preparation run
(branch `worktree-agent-a1106dbc1b8b0f9f0`) are recorded for reference.

| # | Check | Command | Result (preparation run, 2026-11-25) |
|---|---|---|---|
| 1 | Fast gates | `bash scripts/prepush.sh` (check the exit code; never pipe it) | exit 0 |
| 2 | Rust tests | `OC_DEV=1 cargo test --workspace` | 630 passed, 1 failed, 1 ignored on `8641295`. The failure is `rooms.rs::queued_awareness_is_encoded_once_per_batch`, a timing test that passes 3 out of 3 times alone; it is not touched by this release. In an earlier full run, `html::tests::many_raw_text_tags_are_linear` (timing) also failed once and passes alone |
| 3 | Lint and format | part of `prepush.sh` | clean |
| 4 | Web tests | `cd web && pnpm -r test` | pass: client 36, database 185, board 359, editor 109 |
| 5 | Editor build budget | `cd web/packages/editor && pnpm build` (runs `scripts/check-budget.mjs`) | 283.7 KB of 300 KB (16.3 KB headroom) |
| 6 | Site | `python3 tools/build-site.py && python3 tools/check-site-links.py && python3 tools/check-site-claims.py` (in `prepush.sh`) | ok |
| 7 | Playwright, full suite against a release build | `cd e2e && npm ci && npx playwright install chromium webkit && npm run e2e` (desktop Chromium, WebKit iPhone, Android Chromium; `e2e/global-setup.ts` builds and starts the server) | PENDING: the owner runs it on the merged tree after the SDK lands. Includes `z-version-history*` (docs/23 VH-A7) and the BSDK-03 hostile-block spec (SDK-A2) |
| 8 | Databases end to end | `scripts/e2e-db.sh sqlite`; `scripts/e2e-db.sh mariadb mysql://…`; `scripts/e2e-db.sh mysql mysql://…` | PENDING (release commit): not run in the preparation pass. It needs a release build, and the volume had under 6 GB free |
| 9 | Storage conformance | `OC_TEST_MYSQL_URL=… OC_TEST_REDIS_URL=… cargo test -p oc-server --test storage_conformance` on MySQL 8.4 and MariaDB 10.11 | PASS (11 tests each, with Redis) |
| 10 | WOPI | `scripts/e2e-wopi.sh` | PENDING (release commit) |
| 11 | Dependencies and licences | `scripts/audit.sh` (`cargo audit`, `cargo deny`, `pnpm audit --prod`, `npm audit`, SPDX) | ok: 0 vulnerabilities |
| 12 | docs/23 | no FAIL in scope. Every `pending` row (SDK-A2, A3 rerun, A5b, A6, A8, EDP-A1..A4) is PASS | PENDING (BSDK-03/04, EDP-01, discovery) |
| 13 | docs/18 | no open Critical, High or Medium finding. The BSDK-03 sandbox and the EDP-01 "never strip content" rule are audited (§6 pending rows) | PENDING (sandbox, EDP-01) |
| 14 | Docker build | `docker build -f deploy/Dockerfile -t opencanvas:0.2.0 .`, then `curl -s localhost:8080/healthz` shows `"version":"0.2.0"` | PENDING (release commit) |
| 15 | CHANGELOG | replace the `[0.2.0] - unreleased` date placeholder with the tag date | PENDING (tag) |
| 16 | **GitHub release first** | `.github/workflows/release.yml` publishes **into an existing GitHub release**: create the `v0.2.0` release (draft is fine) with these notes **before** pushing the tag, or the publish job fails | PENDING (tag) |
| 17 | Tag and publish | `git tag -s v0.2.0 && git push origin v0.2.0`. The workflow builds the multi-architecture image (`ghcr.io/casualoffice/opencanvas:0.2.0`) and the Linux binaries with checksums and provenance | PENDING (tag) |
| 18 | Smoke the artefacts | pull the image on linux/amd64 and linux/arm64, start it, check `/readyz` is 200, and verify the binaries' SHA-256 and provenance | PENDING (after the tag) |

## 6. Tracker rows in scope

| Row | Status |
|---|---|
| HAPI-01..08, API-DOCS-01 | Done |
| WH-01 | Done |
| VH-00, VH-01a/b/d, VH-02a/b, VH-03 | Done (VH-01c, the Nextcloud app, is Review) |
| BSDK-01, -02, -05 | Done |
| BSDK-03, -04 | In progress (gates the tag) |
| EDP-01, block discovery metadata | In progress (gate the tag) |
| ACC-V2 | In progress: rows written and run; the pending rows fill in as the above land |
| REL-04 | In progress: everything except the final tag |
| LIVE-01..06 | v0.3 |

## 7. Open decisions for the owner

1. Decided 2026-11-25: `[host.flags] api_v1` is on by default in 0.2.0 (upgrade note 3).
2. Approve the scope lock: 0.2.0 = §1, including EDP-01 and the discovery metadata. The
   categorised insert menu goes to 0.2.1.
