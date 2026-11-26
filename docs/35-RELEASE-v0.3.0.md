# 35 — Release v0.3.0: release and upgrade notes

**Status:** released 2026-11-26, tag `v0.3.0` (tracker REL-05).
**Licence:** Apache-2.0 (ADR-037).
**Plan:** [docs/34](34-ROADMAP-v0.3.md). **Acceptance:** [docs/23 §v0.3](23-ACCEPTANCE.md#v03-acceptance-acc-v3).
**Approved prototypes:** [docs/prototypes/v03-approved/](prototypes/v03-approved/).

OpenCanvas 0.3.0 adds portable live blocks, search, automation and offline editing. Every new
feature is off until the host turns it on. The host still owns users, permissions and files;
the server never stores documents (ADR-001). Support is best effort, with no SLA.

## 1. What 0.3.0 contains

| Area | What it does | Decisions |
|---|---|---|
| Live blocks (LIVE-01..11) | One block shown live in several canvases and edited in place; "Make live", the host's picker, references that refresh, convert to a copy, `<open-canvas view="block">`, the folder path in the header, the "/" menu inside a live block | ADR-039, ADR-069..073 |
| Search (SRCH-01..06) | Find and replace in a canvas (also inside live blocks, with its own confirmation); search all canvases through the host's own search; `search.json` in every save, `POST /api/v1/extract`; Nextcloud unified search | ADR-065, ADR-066 |
| Automation (AUTO-01..07) | Rules stored in the canvas: triggers (row added, field changed, checklist checked, comment, date, schedule), actions (set a field, move a row, checklist, comment, notify, call a URL), limits, auto-pause, run history, Undo | ADR-067, ADR-068 |
| Offline (OFF-01..07) | A copy kept on the person's device, opted in by the host and then per canvas; editing without a network; reconnect and merge with a summary; revocation; sign-out clears the device | ADR-063, ADR-064, ADR-074 |

Also: the categorised insert menu (0.2.1), the trademark notices (LEGAL-01), and the site's
structured data and facts page (SITE-03).

## 2. Upgrade notes (from 0.2.x)

1. **Migrations.** `0010_automation` and `0011_offline_generation` run at start-up on SQLite and
   MySQL/MariaDB. They hold metadata only (schedules, run log, a generation number per person).
2. **New host sections, all off by default** (docs/05):
   - `[host.flags] live_blocks` and `[host.live]` (§2c); live blocks need `/access`, `POST /files` and `perms.live`.
   - `[host.search]` with the optional `GET /search` callback (§2).
   - `[host.automation]` and `perms.automate` (§2e). Scheduled runs call the load, save and
     `POST /mentions` callbacks with no bearer token; the v2 signature is the proof.
   - `[host.offline]`, `perms.offline` and `offlineReason` (§2d); JWT hosts only. Reconnect asks
     the host for a fresh token; a person who lost access is answered with `Action_RefreshToken { access: "none" }`.
3. **Editors older than 0.3 on documents with live blocks** are closed with 4426, as 0.2 did for SDK blocks.
4. **Every save now carries `search.json`** (plain text, capped at 2 MB, no comments by default).
5. **Container:** `ghcr.io/casualoffice/opencanvas:0.3.0`. Helm chart `0.3.0`.

## 3. Known limitations

- Offline is tested in Chromium; the phone layout is built but has no WebKit/Firefox run, and
  there is no end-to-end test for the expiry lock or queued uploads (OFF-08 deferred).
- Automation with Redis-only storage is refused at start-up; a cluster with Redis as its shared store was not tested.
- Nextcloud unified search is unit-tested; its Nextcloud glue is checked manually (no Nextcloud CI).
- The live block "from which canvas" cursor label was dropped (owner decision, ADR-069 note).
- SDK blocks cannot be made live yet.

## 4. Release checklist

1. Full local run on the release commit: `cargo test --workspace`, `pnpm -r test`, the full Playwright suite.
2. CI green on `main`.
3. Version 0.3.0 everywhere, CHANGELOG dated.
4. `gh release create v0.3.0 --target <sha>` (the release must exist before `release.yml` publishes).
5. Check the binaries and the container on the release.
