# OpenCanvas

[![CI](https://github.com/CasualOffice/opencanvas/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CasualOffice/opencanvas/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.1.0-7a45f0)](docs/28-RELEASE-v0.1.0.md)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-2a5ad7)](LICENSE)

**An embeddable, real-time collaborative canvas for your app.** Rich text, databases and
whiteboards in one document, with live cursors and comments. Your application keeps the users,
the permissions and the file; OpenCanvas does the editing, the way Collabora Online does for
office documents.

[Website](https://canvas.casualoffice.org) ·
[Try the demo](https://canvas.casualoffice.org/app/#demo) ·
[Release notes](docs/28-RELEASE-v0.1.0.md) ·
[Integration guide](docs/05-INTEGRATION-GUIDE.md) ·
[Documentation](docs/00-README.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/canvas-dark.png">
  <img alt="A canvas open in OpenCanvas: the Sprint 42 planning notes with a callout, decisions, live cursors of two collaborators and the presence avatars in the top bar." src="site/assets/screens/canvas-light.png">
</picture>

> **v0.1.0.** The first release; best-effort support with no SLA. Read the
> [release notes](docs/28-RELEASE-v0.1.0.md), its
> [upgrade notes](docs/28-RELEASE-v0.1.0.md#upgrade-notes) (WOPI proof keys are now required) and
> [known limitations](docs/28-RELEASE-v0.1.0.md#known-limitations) (memory, durability modes,
> single node first) before you deploy it. The AI assistant and MCP endpoint are
> **experimental and off by default**.

## Goal

Give any product a shared workspace page (notes, plans, task databases, whiteboards) without
handing over its users or its data. OpenCanvas is built for **integration**: a host application
embeds it in an iframe, signs a short launch token saying who opens which file with which role,
and receives the saved file back through its own storage. It aims to be:

- **Yours to control.** The host owns authentication, ACL, users and files. OpenCanvas never
  becomes the system of record; it keeps only a transient room log and a save outbox.
- **Live.** Edits merge in real time with a CRDT (Yjs), with cursors, presence, comments and
  follow mode, and the roles are enforced on the server.
- **Light to run.** One container with SQLite to start; MySQL, MariaDB and Redis when you need a
  cluster. See the measured [capacity and sizing](docs/22-CAPACITY-AND-SIZING.md).
- **Usable.** A considered editor on desktop and phone, accessible to WCAG 2.2 AA, with autosave
  only.

## A quick tour

| | |
|---|---|
| <img alt="A task database in table view with typed fields, owners and statuses." src="site/assets/screens/database-light.png"> | <img alt="A whiteboard with sticky notes, shapes and connected arrows inside the canvas." src="site/assets/screens/whiteboard-light.png"> |
| **Databases**: typed fields with table, board, calendar and gallery views, inside the page. | **Whiteboards**: shapes, sticky notes, pen, arrows that stay attached, in the same document. |
| <img alt="The assistant's review bar after a run: suggested links on each note with accept and reject, and the new Tasks database tagged New by Assistant." src="site/assets/screens/assistant-review-light.png"> | <img alt="OpenCanvas on a phone, with the editing toolbar above the keyboard." src="site/assets/screens/phone-light.png" width="300"> |
| **Assistant (experimental, off by default)**: plan, approve, it builds in place, you review. | **Phone**: bottom sheets, a toolbar above the keyboard, touch-friendly boards. |

## How it fits

```
Your app  ── signs launch token (who, which file, which role) ──▶ OpenCanvas iframe
          ◀── load / save / assets / members / copies callbacks ──  OpenCanvas server
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
| Import | Markdown, HTML and CSV into a canvas on the server, one undoable step, editors only. **Off by default**: a host lists `import_formats`; `OC_IMPORT=off` turns it off everywhere |
| Assistant and MCP | **Experimental, off by default.** Phase 1, in review: plan → approve → act → review → undo run, suggestions for existing text, limits and audit; MCP endpoint with host-issued tokens; Claude Platform or an OpenAI-compatible server (OpenAI, vLLM, Ollama, llama.cpp) |

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

## Assistant and MCP (experimental)

**Experimental and off by default.** AI runs only in the OpenCanvas server and stays off until
the operator turns it on (`OC_AI_CONFIG` with `[ai] enabled = true`, then `[host.ai]` per host).
One server switch governs everything: with it off (the default, or `OC_AI=off`) there is no
assistant, no MCP endpoint and no model call for any host.
Its interfaces may change in any release. Select
text, press ⌘J (Ctrl+J) and ask: the assistant shows a plan, waits for you to run it,
builds in place with its own cursor, turns changes to existing text into suggestions you
accept or reject, and can undo the whole run. It acts only within your role. External
agents use the MCP endpoint, `POST /mcp/{hostId}`, with tokens your app issues.

**Canvas content is sent to the model server you configure.** Agent mode needs a model
with tool calling; others get answer mode only. Try a scripted run in the demo (`#demo`,
no AI server). Details: [docs/24](docs/24-AI-AND-MCP.md); configuration:
[docs/13](docs/13-OPERATIONS-AND-DEPLOYMENT.md#ai-optional-ai-02-adr-031).

```toml
# OC_AI_CONFIG=/etc/opencanvas/ai.toml
[ai]
enabled = true

[ai.providers.claude]                 # Claude Platform
kind        = "anthropic"
api_key_env = "OC_AI_ANTHROPIC_KEY"
model_agent = "claude-opus-5-5"
model_fast  = "claude-sonnet-5-5"

[ai.providers.ollama]                 # or vLLM, llama.cpp: any OpenAI-compatible server
kind        = "openai-compatible"
base_url    = "http://ollama:11434"
model_agent = "qwen3:14b"
```

```toml
# hosts.toml, per host
[host.ai]
enabled      = true
provider     = "claude"
default_mode = "suggest"              # changes to existing text arrive as suggestions
mcp          = true                   # POST /mcp/{hostId}; off by default
```

## Configure

The essentials; the full list is in [docs/13](docs/13-OPERATIONS-AND-DEPLOYMENT.md).

| Variable | What it does |
|---|---|
| `OC_PUBLIC_URL` | The server's public URL (also the MCP token audience; set it in production) |
| `OC_KEK` | 32-byte base64 key that seals secrets at rest (required unless `OC_DEV=1`) |
| `OC_HOSTS_FILE` | The hosts you trust: JWT keys, callback URL, allowed origins and per-host flags |
| `DATABASE_URL` | Unset: SQLite. `mysql://…` for MySQL or MariaDB |
| `REDIS_URL` | Enables cluster mode (room leases, relay, hot edit log) |
| `OC_DURABILITY` | `memory` (default without Redis) or `wal` (every edit written) |
| `OC_AI_CONFIG` / `OC_AI` | AI is off unless configured; `OC_AI=off` turns it off for every host |
| `OC_IMPORT` | `off` disables Markdown, HTML and CSV import for every host |

Per host, in the hosts file: `export_formats`, `import_formats` (off by default), `on_conflict`
(`copy` or `reload`) and `[host.ai]`.

## Security and privacy

- Launch tokens are verified (HS256, RS256, EdDSA, JWKS) and single use; callbacks to the host are
  signed. Roles (view, comment, edit) are enforced on the server for every edit.
- Exported and imported HTML is sanitised; embeds come from an allow-list and run sandboxed.
- The release audit for v0.1.0-alpha.1 is in [docs/18](docs/18-SECURITY-AUDIT.md); report issues
  as described in [SECURITY.md](SECURITY.md).
- With AI turned on, the parts of a canvas the assistant needs are sent to the model server the
  operator configures. Nothing is sent when AI is off.

## Test

```sh
OC_DEV=1 cargo test --workspace                  # server, room protocol, role filter, outbox, fuzz
cd web && pnpm -r typecheck && pnpm -r test      # editor, database, board
scripts/e2e-db.sh sqlite                         # launch → edit → autosave → export
scripts/e2e-db.sh mysql mysql://root:root@127.0.0.1:33062/opencanvas
```

## Roadmap

| Version | Focus |
|---|---|
| **v0.1** (this alpha) | The collaborative editor, databases, whiteboards and embedding |
| v0.2 | Portable live blocks, an extensible block SDK and stable headless APIs |
| v0.3 | Offline-first editing, version history, search and automation |
| v0.4 | Advanced databases, partial synchronization and performance improvements |
| v0.5 | Plugin ecosystem, developer tooling and enterprise hardening |

OpenCanvas integrates with any application through standardized APIs and SDKs and depends on no
specific CasualOffice product. Priorities and detail: [docs/09](docs/09-ROADMAP.md) and the
[roadmap page](https://canvas.casualoffice.org/roadmap.html).

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

OpenCanvas is open source under the [Apache License 2.0](LICENSE), copyright 2026 CasualOffice.

- Use, modify, self-host, embed and redistribute it, commercially or not.
- When you redistribute it or a derived work, keep the [NOTICE](NOTICE) file (Apache-2.0 §4(d)).
- The bundled fonts are under the SIL Open Font License 1.1 ([crates/oc-model/fonts/THIRD-PARTY.md](crates/oc-model/fonts/THIRD-PARTY.md)).
