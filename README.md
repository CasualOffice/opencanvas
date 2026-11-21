# OpenCanvas

**A real-time collaborative canvas built for integration.** It has rich text, checklists,
tables, databases, images, files, link cards, embeds and whiteboards, with live
cursors. It works like Collabora Online: your application keeps the users, the
permissions and the file. OpenCanvas handles the editing.

> **Status: P1 alpha.** The server, editor, database and whiteboard blocks, and
> the sample host all run end to end. See [the tracker](docs/10-EXECUTION-TRACKER.md)
> for what is done and what is open.

## How it fits

```
Your app  ── signs launch token (who, which file, which role) ──▶ OpenCanvas iframe
          ◀── load / save / assets / users / copies callbacks ──  OpenCanvas server
```

- **You own** authentication, users, ACL, files, versions and retention.
- **OpenCanvas owns** the editor, real-time merge (Yjs CRDT), presence and cursors,
  preview, export, and autosave back to your storage.
- **OpenCanvas keeps nothing** once a session is saved and idle. Its database only
  holds the transient room log and the save outbox.

## What works today

| Area | Status |
|---|---|
| Blocks | Text, headings, lists, checklists, toggles, quotes, callouts, code, simple tables, images, files, link cards, sandboxed embeds, columns |
| Databases | Typed fields; table, board (kanban), calendar and gallery views; filter, sort and search; row detail; CSV import and export |
| Whiteboard | Pen, sticky notes, shapes, text, arrows that stay attached to shapes, images, zoom and full screen, live pointers, SVG and PNG export |
| Collaboration | Live co-editing, cursors with names, avatars, follow mode, comments, view, comment and edit roles enforced on the server |
| Saving | Autosave only, with no save button. Saves go through a durable outbox. Conflicts are handled by either saving a copy or reloading. |
| Templates | 40 templates in 9 categories, plus blank canvas, database, whiteboard and import |
| Integration | HS256, RS256, EdDSA and JWKS launch tokens; signed callbacks; live role changes; `<open-canvas>` SDK; postMessage API |
| Storage | SQLite by default. MySQL 8.4 and MariaDB 11.4 work when `DATABASE_URL=mysql://…` is set. |
| Mobile | Side-panel and phone layouts, bottom sheets, an editing toolbar above the keyboard, and touch-friendly whiteboard and kanban |

## Run it

You need Rust (stable), Node 24 and pnpm 9.

```sh
cd web && pnpm install && pnpm --filter @opencanvas/editor build && cd ..
OC_DEV=1 cargo run --release -p oc-server     # http://localhost:8080
node examples/sample-host/server.mjs          # http://localhost:4000
```

Open http://localhost:4000 and open a file. In a second tab, pick another user under
"Signed in as" and open the same file to see live collaboration. Use the "Access
control" column to change roles while people are editing.

To review the UI without a backend, use the editor in demo mode: run
`pnpm --filter @opencanvas/editor dev` and open `http://localhost:5173/app/#demo`.

`docker compose up --build` runs both services. `OC_DEV=1` allows starting without
`OC_KEK`. In production, set `OC_KEK` (32 bytes, base64) and the other variables listed
in [docs/13](docs/13-OPERATIONS-AND-DEPLOYMENT.md).

## Embed it

```html
<script type="module" src="https://canvas.example.com/sdk/embed.js"></script>
<open-canvas server="https://canvas.example.com" token="{{ launch_jwt }}" style="height:100vh"></open-canvas>
```

The host contract (token claims, callbacks, postMessage events and REST) is in
[docs/05](docs/05-INTEGRATION-GUIDE.md). [docs/15](docs/15-BUILD-CONTRACT.md) has
the exact wire formats.

## Test

```sh
OC_DEV=1 cargo test --workspace                  # server, room protocol, role filter, outbox, fuzz
cd web && pnpm -r typecheck && pnpm -r test      # editor, database, board
scripts/e2e-db.sh sqlite                         # launch → edit → autosave → export
scripts/e2e-db.sh mysql mysql://root:root@127.0.0.1:33062/opencanvas
```

## Documentation

Start at [docs/00-README.md](docs/00-README.md). The main documents are the
[PRD](docs/02-PRD.md), [HLD](docs/03-HLD-ARCHITECTURE.md),
[technical design](docs/04-TECHNICAL-DESIGN.md),
[integration guide](docs/05-INTEGRATION-GUIDE.md),
[build contract](docs/15-BUILD-CONTRACT.md) and
[tracker](docs/10-EXECUTION-TRACKER.md).

## Contributing

Read [AGENTS.md](AGENTS.md) first. All work is tracked in
[docs/10-EXECUTION-TRACKER.md](docs/10-EXECUTION-TRACKER.md).

## License

OpenCanvas is source-available under the [Business Source License 1.1](LICENSE) (BUSL-1.1), with CasualOffice as the licensor.

- **Free to use in production**, including self-hosting and embedding it in your own products, whether open or closed source.
- **Not allowed without a commercial licence:** offering OpenCanvas itself to others as a hosted collaborative-editing service.
- **Each version becomes open source** under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/) four years after its release.

Bundled fonts are under the SIL Open Font License; see `crates/oc-model/fonts/THIRD-PARTY.md`.
