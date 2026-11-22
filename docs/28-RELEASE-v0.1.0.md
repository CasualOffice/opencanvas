# 28 — Release notes: v0.1.0

**Embeddable collaborative workspace canvas.**

**Status:** prepared from main; not yet tagged. Scope: [docs/26](26-RELEASE-v0.1.0-SCOPE.md)
(tracker REL-02, REL-03). Licence: Apache-2.0 (ADR-037).

v0.1.0 is the first final release of OpenCanvas. It is open source under the
[Apache License 2.0](../LICENSE); keep [NOTICE](../NOTICE) when you redistribute it. Your
application keeps the users, the permissions and the files; OpenCanvas does the editing,
real-time merge (Yjs CRDT), presence, export and autosave back to your storage (ADR-001).

Support is **best effort, with no SLA** (see [Known limitations](#known-limitations) and
[SECURITY.md](../SECURITY.md)).

> **Upgrading from v0.1.0-alpha.1? Read [Upgrade notes](#upgrade-notes) first.** WOPI hosts now
> need proof keys or the server refuses to start; MCP needs `OC_PUBLIC_URL` (or `mcp_audience`);
> MCP tokens must name their files unless the host has `/access` or `mcp_all_files`; WOPI
> sessions are capped at 10 h; invalid `.ocanvas` files and invalid writes are refused.

## What's included

v0.1.0 is **v0.1.0-alpha.1 + the alpha.2 security fixes + the three release blockers**, and
nothing else (docs/26 §1). Everything that alpha.1 shipped is unchanged and its evidence is in
[docs/25 §What's included](25-RELEASE-v0.1.0-alpha.1.md#whats-included): rich text, databases,
whiteboards, 40 templates, collaboration and roles, autosave through the outbox, the standalone
SQLite deployment (MySQL/MariaDB and Redis optional), the host SDK and REST API, JWT and WOPI
launch, the tested import and export formats, and the experimental AI assistant and MCP endpoint
(off by default). The durability modes and backup and recovery are also as described in
[docs/25](25-RELEASE-v0.1.0-alpha.1.md#durability-modes).

## What changed since v0.1.0-alpha.1

Rust tests are in `crates/oc-server/tests/` and `crates/oc-model/tests/`; acceptance IDs are
in [docs/23](23-ACCEPTANCE.md); security IDs in [docs/18](18-SECURITY-AUDIT.md).

### Security: the three Medium findings of the alpha.1 audit (SEC-33, SEC-34, SEC-35)

- **SEC-33, MCP audience.** The MCP token audience comes from `[host.ai] mcp_audience` or
  `OC_PUBLIC_URL`, never from the request's `Host` header. With neither, `/mcp/{hostId}` answers
  404 and start-up logs one warning. Test: `mcp::without_a_public_url_a_token_matching_the_host_header_is_refused`
  (seen failing: 200 instead of 404).
- **SEC-34, MCP file scope.** Without the host `/access` callback, an MCP token without a
  `files` claim is refused (`FILES_REQUIRED`) unless the host sets
  `[host.ai] mcp_all_files = true`. Tests: `mcp::without_the_access_callback_a_token_without_files_is_refused`
  (seen failing), `mcp::mcp_all_files_lets_a_token_without_files_cover_every_file`,
  `mcp::the_host_access_callback_decides_the_role_over_the_token_claim`.
- **SEC-35, WOPI session cap.** A WOPI session ends at `access_token_ttl` or 10 h after the
  launch, whichever is first. Test: `wopi::a_far_future_access_token_ttl_is_clamped_to_the_session_cap`
  (seen failing: expiry 10 years out).

### WOPI proof keys (WOPI-13 PASS, SEC-44)

Every WOPI call to the host carries `X-WOPI-TimeStamp`, `X-WOPI-Proof` and `X-WOPI-ProofOld`
(SHA256withRSA over the spec bytes), and `/hosting/discovery` publishes the current and old
`<proof-key>`. Keys come from `OC_WOPI_PROOF_KEY` and `OC_WOPI_PROOF_KEY_OLD` (PEM, or sealed
with `OC_KEK` by `opencanvas seal-proof-key`); `OC_DEV=1` generates one. The Helm chart mounts
them from a Secret, `wopi.proofKeySecret` (keys `current` and, during rotation, `old` with
`wopi.oldKey: true`). The reference WOPI host verifies every call and refuses missing, tampered
and stale (> 20 min) proofs.

- docs/23 **WOPI-13** PASS (was FAIL in alpha.1): `proof::tests::*`,
  `wopi::every_wopi_call_carries_a_valid_proof`, `wopi::discovery_route_serves_xml`,
  `scripts/e2e-wopi.sh` (seen failing with `WOPI_PROOF=off`).
- docs/18 **SEC-44** (Medium) fixed. Rotation: [docs/05 §6](05-INTEGRATION-GUIDE.md); variables:
  [docs/13](13-OPERATIONS-AND-DEPLOYMENT.md).

### Block schema validation (MOD-01) and the template load test (FC-07)

- **MOD-01.** `oc-model` validates the block schema (docs/15 §4.1): `oc_model::validate`,
  `validate_json` and `validate_blocks` return errors and warnings with a JSON-pointer path.
  Errors refuse the input: `read_ocanvas` fails with `Error::Invalid` naming the bad node
  (`POST /v1/convert` answers 400 `INPUT_INVALID`; a host file that breaks the schema does not
  open), and REST patch, server-side import and MCP writes answer 400 `PATCH_INVALID`. Unknown
  blocks, marks and attributes are warnings only, kept verbatim and counted in
  `oc_schema_warnings_total`. Tests (seen failing first): `tests/validate.rs`,
  `acceptance::mod01_rich_document_validates`,
  `host_api::patch_applies_to_the_live_room_and_reaches_clients` (REST 400),
  `metrics::tests::schema_warnings_are_exported`. docs/23 **FC-01**, **FC-02**, **FC-04** still
  PASS (unknowns kept).
- **FC-07** PASS (was Not run): all 40 built-in templates are built as the gallery builds them,
  checked against `crates/oc-model/tests/fixtures/templates.json`, validated with no errors or
  warnings and round-tripped through `.ocanvas`
  (`web/packages/editor/src/templates.fixture.test.ts`,
  `templates::fc07_every_builtin_template_validates_and_round_trips`; seen failing with a
  corrupted heading level).
- The web editor still relies on ProseMirror's own schema; MOD-01 is the server's view.

### Memory returned after eviction

The jemalloc purge had never run (`arena.4096.purge` was called with a non-null input and the
error was ignored). It now uses null pointers, logs failures, and its sweeper starts in
`AppState::new`. In the 1,000 rooms × 5 nonstop-typing run, RSS 60 s after typing stopped, with
0 rooms open, fell from **856 MB to 174 MB** ([docs/22 §9.7](22-CAPACITY-AND-SIZING.md)). Tests:
`alloc::tests::jemalloc_purge_is_accepted`, `tests/alloc_release.rs`. (This fix is also recorded
in the alpha.1 notes and CHANGELOG.)

### Release artefacts

`.github/workflows/release.yml` builds from the tag:

- a multi-architecture container image, `ghcr.io/casualoffice/opencanvas` (linux/amd64 and
  linux/arm64, native builds), pinned to the tag;
- standalone Linux binaries (x86_64, aarch64) with the editor bundle;
- SHA-256 checksums and build provenance for both.

Running them: [docs/13](13-OPERATIONS-AND-DEPLOYMENT.md).

### Licence and planning

- Relicensed to the **Apache License 2.0** (ADR-037), with NOTICE and an SPDX header in every
  source file.
- The v0.2 plan is [docs/27](27-ROADMAP-v0.2.md) (portable live blocks, block SDK, stable
  headless API under `/api/v1`; ADR-039 to ADR-042).

## Upgrade notes

From v0.1.0-alpha.1 (or a build of `main` before it). **Each item can stop a working
deployment; check them before you upgrade.**

1. **WOPI hosts now require proof keys.** If the hosts file has any WOPI host, the server
   **refuses to start** without a proof key. Generate a 2048-bit (or larger) RSA key
   (`openssl genrsa -out proof.pem 2048`), set `OC_WOPI_PROOF_KEY` to its path (or a file sealed
   with `opencanvas seal-proof-key < proof.pem`), and give every node the same key. On Helm, set
   `wopi.proofKeySecret` to a Secret with the key `current`. To rotate later, set
   `OC_WOPI_PROOF_KEY_OLD` (Helm: key `old` and `wopi.oldKey: true`). Hosts that do not check
   proofs keep working. See [docs/05 §6](05-INTEGRATION-GUIDE.md) and
   [docs/13](13-OPERATIONS-AND-DEPLOYMENT.md).
2. **MCP needs a public URL.** Set `OC_PUBLIC_URL`, or `[host.ai] mcp_audience`, on any host that
   uses MCP. Without either, MCP is off (404) and start-up logs a warning. Tokens whose `aud` was
   built from a `Host` header no longer work.
3. **MCP tokens must name their files** (`files` claim) unless the host implements the `/access`
   callback or sets `[host.ai] mcp_all_files = true` (broad: one token's role on every file).
   Otherwise the call is refused with `FILES_REQUIRED`.
4. **WOPI sessions are capped at 10 h.** An `access_token_ttl` further out is clamped; past the cap
   the host launches again.
5. **Invalid documents and writes are refused.** An `.ocanvas` that breaks the block schema is
   refused when read (`/v1/convert` answers 400 `INPUT_INVALID`; a host file of that kind does
   not open), and a REST patch, import or MCP write that breaks it answers 400 `PATCH_INVALID`
   with the path of the bad node. Unknown blocks and attributes are still accepted and kept.
   Check any tool that writes `.ocanvas` or calls `/v1/files/{id}/patch`.

Unchanged from alpha.1: the database migrations run at start-up (back up first); `.ocanvas`
stays format version 1 and `schemaVersion` 1 for all of 0.1.x (docs/26 §3); the defaults listed
in [docs/25 §Upgrade notes](25-RELEASE-v0.1.0-alpha.1.md#upgrade-notes) still apply. The host
REST API (`/v1/…`) is usable but not yet versioned as stable; v0.2 adds `/api/v1` and keeps the
0.1 routes as aliases until v0.3 (docs/27).

## Known limitations

- **No SLA.** Support is best effort, as stated in [SECURITY.md](../SECURITY.md): 0.1.x gets
  security fixes and P0/P1 bug fixes only (docs/26 §3); there is no maintained release branch
  beyond that and no uptime, response-time or data-retention commitment.
- **Memory grows with document size under nonstop typing.** yrs keeps dead items, so a room's
  live document is about 15–20× its encoded size while people type
  ([docs/22 §9.4, §9.5](22-CAPACITY-AND-SIZING.md)). Memory is now returned after rooms close
  (above), but size for the documents you keep open. Sizing: docs/22 §4 and docs/13.
- **Single node first.** Cluster mode passes the crash and chaos runs, but scale-out across
  machines is not demonstrated (docs/22 §12); the room cap is 550.
- **Durability depends on the mode** (`memory`, `wal`, Redis WAL):
  [docs/25](25-RELEASE-v0.1.0-alpha.1.md#durability-modes).
- **AI and MCP are experimental and off by default**; canvas content goes to the model server
  you configure. AI-01, AI-02 and AI-UI are in Review.
- **WOPI:** no `LOCK`/`UNLOCK` by design; conflicts use timestamps (WOPI-05).
- **Not built:** SSRF-safe link unfurl (UNF-01), server-rendered preview for viewers (RND-01),
  host team templates (TPL-01), an editor import menu (docs/23 FC-10: server import only).
- **Helm** is linted and rendered in CI but has not been installed in a real cluster, and there
  are no dashboards (OPS-01).
- **No portable live blocks, block SDK or stable headless API**: these are v0.2
  ([docs/27](27-ROADMAP-v0.2.md)). Third-party block types are kept as unknown blocks, not
  rendered. Only `.ocanvas` version 1 exists.
- **MOD-01 is server-side only**; the web editor uses ProseMirror's schema, and link and embed
  URLs are sanitised on export rather than checked.
- **Open Low security findings**, each with a recorded decision (docs/18 §5): SEC-36 (redirects
  in operator-configured clients), SEC-37 (`canvas:write:direct` not checked), SEC-38 to SEC-42
  accepted; SEC-43 (MCP `comment_add` always refused, fails closed) is an open functional bug.
- **Owner review.** Most design documents (docs/02 to docs/08) and several built features are
  still `Review` in the tracker, awaiting the owner's approval; the owner's approval of the
  docs/26 scope lock is pending.

## Verification checklist

Run on the release commit, from the repository root. A check that ran only on an earlier commit
does not count (docs/26 §2).

```sh
OC_DEV=1 cargo test --workspace
```
Result: PENDING

```sh
cargo clippy --workspace --all-targets -- -D warnings
```
Result: PENDING

```sh
cargo fmt --all -- --check
```
Result: PENDING

```sh
cd web && pnpm install --frozen-lockfile && pnpm -r typecheck
```
Result: PENDING

```sh
cd web && pnpm -r test          # vitest
```
Result: PENDING

```sh
cd e2e && npm ci && npx playwright install chromium webkit && npm run e2e
```
Result: PENDING

```sh
scripts/e2e-db.sh sqlite
```
Result: PENDING

```sh
scripts/e2e-db.sh mariadb mysql://root:root@127.0.0.1:33061/opencanvas
```
Result: PENDING

```sh
scripts/e2e-db.sh mysql mysql://root:root@127.0.0.1:33062/opencanvas
```
Result: PENDING

```sh
scripts/e2e-wopi.sh             # proof keys verified; tampered and stale proofs refused
```
Result: PENDING

```sh
scripts/audit.sh
```
Result: PENDING

```sh
docker build -f deploy/Dockerfile -t opencanvas:0.1.0 .
```
Result: PENDING

```sh
curl -s http://localhost:8080/healthz    # on the built server: "version":"0.1.0"
```
Result: PENDING

```sh
# Release workflow on the tag: pull ghcr.io/casualoffice/opencanvas:0.1.0 on linux/amd64 and
# linux/arm64, start it, and check /readyz; verify the binaries' SHA-256 checksums and provenance
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/readyz
```
Result: PENDING
