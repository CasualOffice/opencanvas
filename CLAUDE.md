# CLAUDE.md

This repository is governed by [AGENTS.md](AGENTS.md). Read it first.

Essentials:
- **Design first. No UI code before the Artifact prototype is approved** (ADR-011).
- **Track everything** in [docs/10-EXECUTION-TRACKER.md](docs/10-EXECUTION-TRACKER.md).
- **Host owns auth, ACL and files. We never persist documents** (ADR-001).
- **SQLite by default. MySQL/MariaDB when `DATABASE_URL` is set** (ADR-004).
- Check means running it. Every fix ships with a test that was seen to fail first.

Current state: **P0. The docs are written and in review. UI-02 prototype is
awaiting approval.** No code has been written yet.
