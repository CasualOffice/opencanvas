# 09 — Roadmap and delivery

**Status:** draft v0.1, 2026-11-21. Rows in
[10-EXECUTION-TRACKER.md](10-EXECUTION-TRACKER.md) carry the detail.

| Phase | Goal | Exit gate |
|---|---|---|
| **P0 Foundation** | Research, PRD, HLD, technical design, ADRs, tracker; **UI prototype approved on Artifact**; repo scaffold + CI | User approval of PRD/HLD and UI-01 prototype |
| **P1 MVP** | Rust server (JWT launch, rooms, WAL, commits, SQLite); editor with text/lists/tables/images/files/links/embeds; presence + cursors; preview; MD/HTML/.ocanvas export; embed SDK; sample host | Two browsers co-edit via sample host; commit round-trip; convergence fuzz green; p95 < 150 ms @ 20 editors |
| **P2 Board & scale** | Board block; columns; comments; WOPI mode; MySQL/MariaDB + Redis cluster; PDF/DOCX/PNG export; templates; role API; Helm | 3-node chaos test (kill owner, no acked edit lost); MySQL+MariaDB CI; board fuzz green |
| **P3 Platform** | Portable live blocks (embed one block in another host surface), AI assist (pluggable), DOCX import, offline-first option, Loro re-evaluation | Feature-flagged GA |

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
