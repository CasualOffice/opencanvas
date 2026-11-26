# OpenCanvas

[![CI](https://github.com/CasualOffice/opencanvas/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CasualOffice/opencanvas/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.1.2-7a45f0)](https://github.com/CasualOffice/opencanvas/releases/tag/v0.1.2)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-2a5ad7)](LICENSE)

**An embeddable, real-time collaborative canvas for your app.** Rich text, databases and
whiteboards in one document, with live cursors and comments. Your application keeps the users,
the permissions and the file; OpenCanvas does the editing, the way Collabora Online does for
office documents.

[Website](https://canvas.casualoffice.org) ·
[Try the demo](https://canvas.casualoffice.org/app/#demo) ·
[Release notes](https://github.com/CasualOffice/opencanvas/releases/tag/v0.1.2) ·
[Jitsi Meet](integrations/jitsi/README.md) ·
[Nextcloud](integrations/nextcloud/README.md) ·
[Mattermost](integrations/mattermost/README.md) ·
[Element / Matrix](integrations/matrix/README.md) ·
[Integration guide](docs/05-INTEGRATION-GUIDE.md) ·
[Documentation](docs/00-README.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/canvas-dark.png">
  <img alt="A canvas open in OpenCanvas: the Sprint 42 planning notes with a callout, decisions, live cursors of two collaborators and the presence avatars in the top bar." src="site/assets/screens/canvas-light.png">
</picture>

> **New in v0.3.0.** Live blocks shown and edited in several canvases, find and replace and search
> across canvases, automation rules, and offline editing. All are off until the host turns them on;
> read the [release and upgrade notes](docs/35-RELEASE-v0.3.0.md). **v0.2.1** brought a simpler insert
> menu, and **v0.2.0** brought the stable headless API (`/api/v1`, on by default) with TypeScript and Rust
> clients, signed webhooks, the [block SDK](docs/33-BLOCK-SDK.md) for your own blocks, and host
> editor profiles (notebook, meeting, project, diagramming, document or the full workspace).
> Read the [release and upgrade notes](docs/32-RELEASE-v0.2.0.md) before upgrading.
> v0.1.2 brought the Nextcloud, Mattermost and Element / Matrix integrations, diagramming and
> version history. Support is best-effort, with no production SLA. AI and MCP are experimental
> and off by default.

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

## Build your own blocks

A block is a small web component that lives inside a canvas: an OKR tracker, a ticket card, a
chart from your own service. You write it once with `@opencanvas/block-sdk`; OpenCanvas runs it in
a sandbox, keeps its data in the document, lets people edit it together and exports it.

```ts
import { defineBlock, h } from "@opencanvas/block-sdk";

defineBlock<{ value: number }>({
  render(el, ctx) {
    const slider = h("input", { type: "range", min: "0", max: "100" });
    slider.addEventListener("change", () => ctx.setAttrs({ value: Number(slider.value) / 100 }));
    el.append(slider);
  },
});
```

Describe it in a `block.json`, bundle it, and the host turns it on:

```toml
[host.blocks]
enabled = ["oc.progress", "acme.okr@^1"]
```

Block code never runs on the server and only reaches what the host allows. Read the
[Block SDK guide](docs/33-BLOCK-SDK.md); the samples are in
[`web/packages/block-sdk/samples`](web/packages/block-sdk/samples).

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
| Jitsi Meet | A shared canvas in every meeting, like Etherpad: one Prosody plugin and config, no Docker changes. Temporary: blank or from a chosen template, deleted when the meeting ends. Tested against a stock docker-jitsi-meet. [Guide](integrations/jitsi/README.md) |
| Nextcloud, Mattermost and Element / Matrix | Host integrations for WOPI files, channel canvases and room widgets. See the [release notes](docs/31-RELEASE-v0.1.2.md). |
| Diagramming | Shape libraries, ports, connector routing, layout and interchange. [Diagram guide](docs/29-DIAGRAMMING.md) |
| Your own blocks (v0.2) | The [block SDK](docs/33-BLOCK-SDK.md) (`@opencanvas/block-sdk`): write a block once and it runs sandboxed in every canvas, with live co-editing, comments, export and a saved copy when it is missing. Samples: Progress and an OKR tracker |
| Editor profiles (v0.2) | Each host picks what its users see: notebook, meeting, project, diagramming, document or the full workspace. Hidden blocks are never deleted. [Guide](docs/05-INTEGRATION-GUIDE.md) |
| Version history | Named versions, comparison, restore and a short undo window. Availability depends on the host and permissions. [History guide](docs/30-VERSION-HISTORY.md) |
| Storage | SQLite by default. MySQL 8.4 and MariaDB 11.4 work when `DATABASE_URL=mysql://…` is set. |
| Mobile | Side-panel and phone layouts, bottom sheets, an editing toolbar above the keyboard, and touch-friendly whiteboard and kanban |
| Import | Markdown, HTML and CSV into a canvas on the server, one undoable step, editors only; draw.io and Excalidraw diagrams into a board after a dry-run report (DGM-15). **Off by default**: a host lists `import_formats`; `OC_IMPORT=off` turns it off everywhere |
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

Other ways in:

- **WOPI:** open it from an existing WOPI host such as Nextcloud ([docs/05 §6](docs/05-INTEGRATION-GUIDE.md)).
- **Jitsi Meet:** add `integrations/jitsi/mod_opencanvas.lua` to Prosody and a few `.env` lines;
  everyone in a meeting gets the same temporary canvas under **Shared document**
  ([guide](integrations/jitsi/README.md)).
- **No file storage of your own:** `storage = "ephemeral"` gives temporary canvases that are
  deleted when the session ends ([docs/05 §8a](docs/05-INTEGRATION-GUIDE.md)).

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
| v0.1.0 | First final release of the collaborative editor, databases, whiteboards and embedding |
| [v0.1.2](docs/31-RELEASE-v0.1.2.md) | Additional host integrations, structured diagramming, version history, headless API foundation, link previews, team templates and viewer previews |
| v0.2.1 (released 2026-11-26) | The categorised insert menu (INS-01) and three fixes |
| [v0.2.0](docs/32-RELEASE-v0.2.0.md) (released 2026-11-25) | Stable headless API (`/api/v1`) with TypeScript and Rust clients, webhooks, version history, the block SDK, and host editor profiles. Live blocks moved to v0.3 |
| [v0.3.0](docs/35-RELEASE-v0.3.0.md) (released 2026-11-26) | Portable live blocks, search (find and replace, search all canvases), automation and offline editing; all off until the host turns them on |
| v0.4 | Advanced databases, partial synchronization and performance improvements |
| v0.5 | Plugin ecosystem, developer tooling and enterprise hardening |

Alongside the releases, **structured diagramming** is its own workstream ([docs/29](docs/29-DIAGRAMMING.md)):
diagram mode on a board, shape libraries, ports, connectors that route around shapes, auto-layout,
generic icons plus your own, and draw.io, Excalidraw and Mermaid import. It ships when each part is
ready and does not move the release commitments above.

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
