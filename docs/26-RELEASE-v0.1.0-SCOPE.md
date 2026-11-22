# 26 — Release v0.1.0: scope lock

**Status:** Locked, 2026-11-23 (tracker REL-02). Owner approval of the lock: pending.
**Licence:** Apache-2.0 (ADR-037). **Principle:** integration through standard APIs and SDKs only,
no dependency on a specific CasualOffice product (ADR-038).

This document freezes what the final **v0.1.0** contains, what must be true before it is tagged,
and what may still change after the lock. The release notes for the first pre-release are
[docs/25](25-RELEASE-v0.1.0-alpha.1.md); the v0.1.0 notes will be written from it once the exit
criteria below are met. What comes next is [docs/27](27-ROADMAP-v0.2.md).

## 1. What v0.1.0 contains (frozen)

v0.1.0 = **v0.1.0-alpha.1** (tag `v0.1.0-alpha.1` on `e122c26`) **+ the alpha.2 security fixes
+ the three remaining blockers.** Nothing else.

| Part | Content | Reference |
|---|---|---|
| alpha.1 | Collaborative editor (rich text, tables, images, files, links, embeds, columns, comments, mentions), databases (table, board, calendar, gallery, CSV), whiteboards (shapes, connectors, frames, images, SVG/PNG), 40 templates, presence and follow, autosave with the commit outbox, standalone SQLite and optional MySQL/MariaDB/Redis, JWT launch and WOPI host modes, `<open-canvas>` SDK and postMessage API, host REST (role, patch, commit, import, convert, session close), exports (Markdown, HTML, JSON, `.ocanvas`, DOCX, PDF through Gotenberg), the experimental AI assistant and MCP endpoint (off by default) | [docs/25 §What's included](25-RELEASE-v0.1.0-alpha.1.md#whats-included) |
| alpha.2 security | **SEC-33** MCP audience only from `[host.ai] mcp_audience` or `OC_PUBLIC_URL`, never a request header; **SEC-34** without the host `/access` callback an MCP token must name its `files`; **SEC-35** a WOPI session is capped at the 10 h JWT cap | [docs/18 §5](18-SECURITY-AUDIT.md), tracker SEC-MED-A2 |
| Blocker 1 | **WOPI-13** WOPI proof keys: verify `X-WOPI-Proof` / `X-WOPI-ProofOld` against the discovery `proof-key` (current and old key, timestamp ≤ 20 min) on every WOPI request from a host that publishes proof keys | docs/23 WOPI-13, docs/05 §6, tracker WOPI-01 (P2 row) |
| Blocker 2 | **MOD-01** block schema validation in `oc-model`: one schema for every block, inline and attribute in docs/15 §4, checked on `.ocanvas` load, patch, import and convert; unknown blocks and attributes still kept verbatim (no silent loss) | tracker MOD-01, docs/04 §2 |
| Blocker 3 | **FC-07** template load test: each of the 40 built-in templates is built into a Y.Doc, written as `.ocanvas`, read by the Rust reader and passes MOD-01 validation | docs/23 FC-07 |

The release workflow (`.github/workflows/release.yml`) is already part of the frozen content.

## 2. Exit criteria

All four must hold on **the release commit itself** (not an earlier commit), and the evidence is
recorded in the v0.1.0 release notes the way docs/25 records it.

1. **Every verification checklist command is green on the release commit**: the full list in
   [docs/25 §Verification checklist](25-RELEASE-v0.1.0-alpha.1.md#verification-checklist):
   `OC_DEV=1 cargo test --workspace`; `cargo clippy --workspace --all-targets -- -D warnings`;
   `cargo fmt --all -- --check`; `pnpm -r typecheck` and `pnpm -r test`; the Playwright suite
   (`npm run e2e`, desktop Chromium, WebKit iPhone, Android Chromium); `scripts/e2e-db.sh` on
   SQLite, MariaDB and MySQL; `scripts/e2e-wopi.sh`; `scripts/audit.sh`; the Docker build. A
   check that only ran on an earlier commit does not count.
2. **docs/23 has no FAIL in scope.** Every row for the content in §1 is PASS; a row that is
   genuinely out of scope (§5) says so in the row. In particular WOPI-13 and FC-07 move to PASS
   with a named test. A `test.fail()` spec (MOB-11b) counts as a FAIL unless the row is moved out
   of scope with the owner's agreement.
3. **No Critical or High security finding, and no open Medium.** docs/18 §5 is re-run against
   the release commit for the code added since alpha.1 (WOPI proof keys, MOD-01 validation on the
   load path). Low findings may stay open if each has a recorded decision.
4. **Release artefacts are built and published from the tag**: the multi-architecture container
   image on ghcr.io (linux/amd64, linux/arm64, pinned to the tag), standalone Linux binaries
   (x86_64, aarch64) with the editor bundle, SHA-256 checksums and build provenance for both,
   and the GitHub release with the notes. The image is pulled and started once on each
   architecture and `/readyz` answers 200.

## 3. Change control after the lock

From the lock until v0.1.0 is tagged, and for every later **0.1.x**:

- **Allowed:** fixes for **P0 and P1 bugs** (data loss, crash, security, a broken documented
  flow, a failed exit criterion) and **security fixes** of any severity.
- **Not allowed:** features, new configuration, new endpoints, new block types, format changes,
  dependency upgrades not needed by a fix. These go to **0.2.0** ([docs/27](27-ROADMAP-v0.2.md)).
- Each 0.1.x change has a tracker row, a test seen failing first, and a CHANGELOG line.
- The three blockers in §1 are the only scoped work still open; they are not features under this
  rule, because they close FAIL rows in the release gate.
- `.ocanvas` stays format version 1 and `schemaVersion` 1 throughout 0.1.x.

Severity: **P0** = data loss, crash of the server process, a security finding of Medium or above;
**P1** = a documented flow does not work with no workaround. Anything else waits for 0.2.0.

## 4. Tracker rows in scope

Status as recorded in [docs/10](10-EXECUTION-TRACKER.md) on 2026-11-23.

| Row | What | Status | Needed for |
|---|---|---|---|
| REL-01 | v0.1.0-alpha.1 documents, version, tag | Done | §1 alpha.1 |
| SEC-MED-A2 | SEC-33/34/35 | Done | §1 alpha.2 |
| WOPI-01 (P2 row) | WOPI proof keys (docs/23 WOPI-13) | Review (proof keys not built; being finished on a branch) | Blocker 1 |
| MOD-01 | Block schema and validation | Todo (being finished on a branch) | Blocker 2 |
| ACC-FWE | File compatibility, WOPI, exports acceptance, incl. FC-07 | Review (FC-07 Not run) | Blocker 3 |
| ACC-01 | Permissions and mobile acceptance | Review | Exit criterion 2 |
| SCAF-01 | CI matrix | Done | Exit criterion 1 |
| REL-02 | This scope lock, the v0.1.0 notes and tag | In progress | All |

Rows that are `Review` only for the owner's approval (most DOC-xx, SRV-01, WEB-04, BRD-01, CMN-01,
OPS-01, PERF-0x) do not block the tag: their features are built and tested. The owner's approval
of the docs set stays an open item, stated in the release notes.

## 5. Out of scope: stated limitations of v0.1.0

These are not built or not demonstrated in v0.1.0, and the release notes say so:

- **Single node first.** Cluster mode passes the crash and chaos runs, but scale-out across
  machines is not demonstrated (docs/22 §12); the room cap is 550.
- **Memory** grows with a document while people type (yrs keeps dead items, docs/22 §9.4–9.5).
- **Durability** depends on the mode (`memory`, `wal`, Redis WAL); see docs/25.
- **WOPI:** no `LOCK`/`UNLOCK` by design; conflicts use timestamps.
- **Not built:** SSRF-safe link unfurl (UNF-01), server-rendered preview (RND-01), host team
  templates (TPL-01), Helm in a real cluster and dashboards (OPS-01).
- **AI and MCP** are experimental and off by default; canvas content goes to the configured model
  server.
- **No portable live blocks, block SDK or stable headless API**: these are v0.2. The host REST
  API in v0.1.0 (`/v1/files/{id}/patch` and friends) is usable but **not** versioned as stable;
  it may change in 0.2.0 (docs/27 §5 keeps it working as a compatibility alias).
- **Format:** only `.ocanvas` version 1. Third-party block types are kept as unknown blocks, not
  rendered.
- **No SLA, no maintained release branch** beyond 0.1.x security and P0/P1 fixes.
