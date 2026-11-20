# OpenCanvas

**A real-time collaborative canvas built for integration.** Rich text, lists,
tables, images, files, links, embeds and whiteboards, with live cursors.
It works like Collabora Online: your application keeps the users, the
permissions and the file. OpenCanvas handles editing.

> **Status: P0 design.** The docs are in review. Before any UI is built, a
> prototype has to be approved as an Artifact (see
> [docs/11](docs/11-DESIGN-FIRST-PROCESS.md)).

## Why

Slack Canvas, Zoom Canvas and Microsoft Loop show that teams want a live,
block-based canvas inside the tools they already use. None of them can be
embedded in *your* product with *your* storage and *your* permissions.
OpenCanvas can.

## How it fits

```
Your app  ── signs launch token (who, which file, which role) ──▶ OpenCanvas iframe
          ◀── load / save (commit) / assets / users callbacks ──  OpenCanvas server
```

- **You own:** authentication, users, ACL, files, versions, retention.
- **We own:** the editor, real-time merge (Yjs CRDT), presence and cursors,
  preview, export, and commits back to your storage.
- **We keep nothing** once a session is committed and idle.

## Features (target)

| | |
|---|---|
| Content | headings, rich text, lists, checklists, toggles, quotes, callouts, code, tables, images, files, link cards, embeds (YouTube/Figma/Loom/Maps…), columns, **native whiteboard** |
| Collaboration | live co-editing, cursors and selections, board pointers, follow mode, per-user undo, comments |
| Modes | edit · comment · view/preview · download/export |
| Commits | autosave, idle and last-leave saves, plus "Save version" with a message and an author list |
| Formats | `.ocanvas` (native), Markdown, HTML, PDF, DOCX, PNG/SVG for boards |
| Integration | signed JWT launch or WOPI-compatible; iframe or `<open-canvas>` web component; postMessage API; REST for bots |
| Storage | SQLite by default; MySQL/MariaDB when `DATABASE_URL` is set; Redis for clusters. **Transient session state only.** |

## Quick start (planned, P1)

```sh
docker compose up            # single node, SQLite
open http://localhost:8080/examples/sample-host
```

## Documentation

Start at [docs/00-README.md](docs/00-README.md). Key reads:
[PRD](docs/02-PRD.md) · [HLD](docs/03-HLD-ARCHITECTURE.md) ·
[Technical design](docs/04-TECHNICAL-DESIGN.md) ·
[Integration guide](docs/05-INTEGRATION-GUIDE.md) ·
[Tracker](docs/10-EXECUTION-TRACKER.md).

## Contributing

Read [AGENTS.md](AGENTS.md) first. All work is tracked in
[docs/10-EXECUTION-TRACKER.md](docs/10-EXECUTION-TRACKER.md).
