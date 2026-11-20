# AGENTS.md — Agent contract for OpenCanvas

Every coding agent working in this repository reads this file first.

## Repository boundary

- `canvas/` (OpenCanvas) is the work surface.
- Sibling services `../opencalc`, `../opensign`, `../openslide` and `../meet`
  are reference only. OpenCalc's WOPI and collaboration notes
  (`../opencalc/docs/56–63, 72, 74`) are useful prior art. **Do not modify siblings.**

## Mission

Build an embeddable, real-time collaborative canvas that is lightweight and
scalable. The host application owns identity, ACL and storage. OpenCanvas owns
editing, collaboration, preview, export and commits (ADR-001).

## Rules

1. **Design first.** Read [docs/00-README.md](docs/00-README.md). Any change
   to a boundary, wire format, file format or dependency needs an ADR row in
   [docs/08](docs/08-ADR-REGISTER.md).
2. **UI approval gate.** No UI code (anything under `web/packages/editor`,
   `board`, `embed` chrome) until its prototype has been published as an
   Artifact and the user has approved it. Approval is recorded in the tracker.
3. **Track everything.** Every unit of work has a row in
   [docs/10-EXECUTION-TRACKER.md](docs/10-EXECUTION-TRACKER.md).
4. **Cycle:** design → execute → check (run it) → find issues → fix → tests.
   Each fix comes with a test that was seen to fail without it.
5. **Never persist documents.** The DB holds only transient room state
   (snapshot, WAL tail, sessions, outbox). Anything else is a design change.
6. **Server enforces roles on every frame.** Client read-only is cosmetic.
7. **No silent data loss.** Unknown blocks and attrs round-trip. Lossy exports
   produce a compatibility report.
8. **Portable SQL.** Every migration must pass on SQLite, MySQL 8 and MariaDB 10.11.
9. **No secrets or content in logs.**

## Stack

Rust (tokio, axum, yrs, sqlx), TypeScript (Tiptap/ProseMirror, Yjs), pnpm.
