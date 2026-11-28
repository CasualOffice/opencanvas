# 37 — Release v0.4.0: release and upgrade notes

**Status:** released 2026-11-28, tag `v0.4.0`.
**Licence:** Apache-2.0 (ADR-037).
**Plan:** [docs/36](36-ROADMAP-v0.4.md). **Approved prototypes:** [docs/prototypes/v04-approved/](prototypes/v04-approved/).
**Benchmarks:** [site benchmarks page](https://canvas.casualoffice.org/docs/benchmarks.html); results are in `bench/results/` and `e2e/perf/results/`.

OpenCanvas 0.4.0 adds spreadsheets, advanced databases and charts, and is a performance and
reliability release. The host still owns users, permissions and files; the server never stores
documents (ADR-001). Support is best effort, with no SLA.

## 1. What 0.4.0 contains

| Area | What it does | Decisions |
|---|---|---|
| Spreadsheet block (SHEET-00..08) | Excel-style grid on opencalc's engine with our own grid: name box, formula bar, Excel keyboard, about 120 functions per cell, sheets, fill and Ctrl-drag, paste from Excel and Sheets with options, formats, freeze, filters, merge, borders, wrap, find and replace, move/hide rows and columns, tab colours; full screen; live editing with peers' selections; phone layout and view only; offline. `.xlsx`/`.ods` import (with formats, styles and widths) and `.xlsx` export; values in exports, `search.json`, the API and MCP | ADR-080 |
| Linked charts | Column, line, area, pie, donut and scatter charts from a sheet range or a database grouped field; live updates; exports write the values as a table | SHEET-06 |
| Database ⇄ spreadsheet | "Open as spreadsheet" as a live view or a copy; a sheet range converted to a database | SHEET-06 |
| Advanced databases | Formulas in spreadsheet syntax, relations and rollups; virtualized tables at 100,000 rows; Timeline (Gantt) with dependencies, milestones and critical path; Workload by person and week | DB4, DB5-01 |
| Partial sync | Databases and boards load as subdocuments, on by default | ADR-076..079 |
| Performance | 10,000 connections on one node; up to 1,000 editors in a room (cap 550 by default); progressive first screen; memory fixes | docs/36 |
| Reliability | Overload answers 503 with `Retry-After`, never 500; recovery admission after a restart; crash and restore drills; downgrade-tolerant migrations; saves after a restart with a slow host | RLB-01..04 |
| Nextcloud Talk | A canvas beside a chat or call, meeting canvases, the canvas card, Follow me | TALK-01 |
| Board toolbar | One row with priority overflow; optional left rail | UX4-01 |
| Security | Dependency upgrades (jsonwebtoken 12, p256 0.14, resvg 0.50); import limits for spreadsheets; a time budget for formula computation on the server; SEC-54..64 | docs/18 §7 |

## 2. Upgrade notes (from 0.3.x)

1. **Partial sync is on by default.** Editors before 0.4 are closed with 4426 on split rooms.
   Deploy the 0.4 editor with the 0.4 server, or set `[host.flags] partial_sync = false`.
2. **Migrations** `0012` (WAL per document id) and `0013` (restore epoch) run at start-up.
3. **HS256 hosts need a non-empty secret** (jsonwebtoken 12 refuses an empty one).
4. **Busy servers answer 503 with `Retry-After`.** Clients should retry after the given delay; the editor and SDKs already do.
5. **New block types** `core.spreadsheet` and `core.chart`; `xlsx` and `ods` in `import_formats` and `export_formats` when the host allows them.
6. **Container:** `ghcr.io/casualoffice/opencanvas:0.4.0`. Helm chart `0.4.0`.

## 3. Known limitations

In 0.4.0, and whether 0.4.1 (2026-11-28, [CHANGELOG](../CHANGELOG.md)) closed them:

- Partial sync does not split spreadsheets yet, and the 50 MB first screen is above the 2 s target. Still open after 0.4.1: the partial-sync items PSYNC-BUG-2..4 are v0.4.2.
- Spreadsheet: no cell comments, no "changed since" undo message, no merge and wrap in the phone layout, and merges across frozen panes were two cells. Fixed in 0.4.1.
- Charts: no browser test for database charts and the live database ⇄ spreadsheet view; the chart was placed after the sheet, not floating over it. Fixed in 0.4.1.
- Timeline: Workload reassigned through a select, not by dragging; no Months grouping on phones; Timeline was not in the insert menu. Fixed in 0.4.1, except that on a phone reassigning still uses the select.
- The slow-host save drill ran on SQLite only, and DEP-01 lacked the SBOM and update policy. Since 0.4.1 the drill passes on SQLite and MySQL 8.4, and SBOMs and the update policy are in place.
- Benchmarks marked `local` ran on a developer laptop, not the reference machine.

## 4. Release checklist

1. Pre-push gates, `cargo test` for oc-server, oc-model and oc-sheet, and the full Playwright suite on the release commit (157 of 159 passed in one run; the import-dialog wording test was updated and passes, and the access-expiry test passed alone).
2. CI green on `main`.
3. Version 0.4.0 everywhere, CHANGELOG dated.
4. `gh release create v0.4.0 --target <sha>`.
5. Check the binaries and the container on the release.
