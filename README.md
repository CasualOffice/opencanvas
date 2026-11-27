# OpenCanvas

[![CI](https://github.com/CasualOffice/opencanvas/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CasualOffice/opencanvas/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.4.0-7a45f0)](https://github.com/CasualOffice/opencanvas/releases/tag/v0.4.0)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-2a5ad7)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-canvas.casualoffice.org-2a5ad7)](https://canvas.casualoffice.org/docs/)

**An embeddable, real-time collaborative canvas for your app.**

OpenCanvas puts docs, databases, whiteboards and diagrams in one live document that your
application embeds, the way apps embed Collabora Online for office files. Your app keeps the
users, the permissions and the files; OpenCanvas does the editing and saves the file back to
you. It never stores documents. It is open source under Apache-2.0.

[Website](https://canvas.casualoffice.org) ·
[Try the demo](https://canvas.casualoffice.org/app/#demo) ·
[Documentation](docs/00-README.md) ·
[Integration guide](docs/05-INTEGRATION-GUIDE.md) ·
[Release notes 0.4.0](docs/37-RELEASE-v0.4.0.md) ·
[Changelog](CHANGELOG.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/canvas-dark.png">
  <img alt="A canvas open in OpenCanvas: the Sprint 42 planning notes with a callout, decisions, live cursors of two collaborators and the presence avatars in the top bar." src="site/assets/screens/canvas-light.png">
</picture>

## Features

**Editing**
- Blocks: text, headings, lists, checklists, toggles, callouts, code, tables, images, files,
  link cards, sandboxed embeds and columns, from a categorised insert menu.
- Databases: typed fields with table, board, calendar and gallery views; filter, sort, CSV
  import and export.
- Whiteboards and diagrams: shapes, sticky notes, pen, attached arrows, shape libraries,
  connector routing, layout, and draw.io and Excalidraw import ([diagram guide](docs/29-DIAGRAMMING.md)).
- 40 templates in 9 categories. Autosave only, on desktop and phone.

**Collaboration**
- Edits merge in real time with a CRDT (Yjs), with cursors, presence, follow mode and comments.
- View, comment and edit roles enforced on the server; role changes apply live
  ([collaboration](docs/06-COLLABORATION-AND-PRESENCE.md)).

**Platform**
- Headless API (`/api/v1`) with TypeScript (`@opencanvas/client`) and Rust (`opencanvas-client`)
  clients, and signed webhooks ([integration guide §7](docs/05-INTEGRATION-GUIDE.md)).
- [Block SDK](docs/33-BLOCK-SDK.md): write your own sandboxed blocks.
- Editor profiles: each host picks notebook, meeting, project, diagramming, document or the
  full workspace.
- Live blocks shown and edited in several canvases; find and replace, and search across canvases
  through the host's search; automation rules; offline editing. All four are off until the host
  turns them on ([release notes 0.3.0](docs/35-RELEASE-v0.3.0.md)).
- [Version history](docs/30-VERSION-HISTORY.md): named versions, comparison and restore;
  availability depends on the host and permissions.
- Assistant and MCP endpoint: **experimental, off by default**, run only in the server with a
  model the operator configures on the Claude Platform or an OpenAI-compatible server (OpenAI,
  vLLM, Ollama, llama.cpp) ([AI and MCP](docs/24-AI-AND-MCP.md)).

**Integrations**
- [Jitsi Meet](integrations/jitsi/README.md), [Nextcloud](integrations/nextcloud/README.md),
  [Mattermost](integrations/mattermost/README.md) and [Element / Matrix](integrations/matrix/README.md).
  Host integrations for WOPI files, channel canvases and room widgets.
- Any WOPI host, or the `<open-canvas>` web component and signed launch tokens for your own app.

**Storage and scale**
- One container with SQLite to start; MySQL, MariaDB and Redis when you need a cluster.
- SQLite by default. MySQL 8.4 and MariaDB 11.4 work when `DATABASE_URL=mysql://…` is set;
  `REDIS_URL` turns on cluster mode. Docker image and Helm chart ([operations](docs/13-OPERATIONS-AND-DEPLOYMENT.md),
  [capacity and sizing](docs/22-CAPACITY-AND-SIZING.md)).

## Run it

With Docker, using a hosts file written from the [integration guide](docs/05-INTEGRATION-GUIDE.md):

```sh
docker run -p 8080:8080 -v oc-data:/data \
  -v "$PWD/hosts.toml:/etc/opencanvas/hosts.toml:ro" \
  -e OC_PUBLIC_URL=https://canvas.example.com \
  -e OC_KEK=$(openssl rand -base64 32) \
  ghcr.io/casualoffice/opencanvas:0.4.0
```

From source, with the sample host (Rust stable, Node 24 and pnpm 9):

```sh
cd web && pnpm install && pnpm --filter @opencanvas/editor build && cd ..
OC_DEV=1 cargo run --release -p oc-server     # http://localhost:8080
node examples/sample-host/server.mjs          # http://localhost:4000
```

Open http://localhost:4000 and open a file; in a second tab pick another user under "Signed in
as" to see live collaboration. `docker compose up --build` runs both services. `OC_DEV=1` allows
starting without `OC_KEK`; in production set `OC_KEK` (32 bytes, base64) and the variables in
[operations](docs/13-OPERATIONS-AND-DEPLOYMENT.md). For the UI alone, run
`pnpm --filter @opencanvas/editor dev` and open `http://localhost:5173/app/#demo`.

## Embed it

```html
<script type="module" src="https://canvas.example.com/sdk/embed.js"></script>
<open-canvas server="https://canvas.example.com" token="{{ launch_jwt }}" style="height:100vh"></open-canvas>
```

The token claims, callbacks, postMessage events and REST API are in the
[integration guide](docs/05-INTEGRATION-GUIDE.md); the wire formats are in the
[build contract](docs/15-BUILD-CONTRACT.md).

## How it works

```
Your app  ── signs launch token (who, which file, which role) ──▶ OpenCanvas iframe
          ◀── load / save / assets / members / copies callbacks ──  OpenCanvas server
```

- **Your app owns** authentication, users, permissions, files, versions and retention.
- **OpenCanvas owns** the editor, real-time merge, presence, export and autosave back to your storage.
- **OpenCanvas never becomes the system of record:** it keeps only a transient room log and a save outbox.
- HS256, RS256, EdDSA and JWKS launch tokens are single use, and callbacks are signed
  ([security](docs/07-SECURITY-AND-LIMITS.md)).

## Releases and roadmap

The latest release is [0.4.0](docs/37-RELEASE-v0.4.0.md) (2026-11-28); every version is in the
[CHANGELOG](CHANGELOG.md). Next: v0.4 brings advanced databases, partial synchronization and
performance work; v0.5 a plugin ecosystem, developer tooling and enterprise hardening
([roadmap](docs/09-ROADMAP.md)). Support is best-effort, with no production SLA.

## Documentation

The [website](https://canvas.casualoffice.org) hosts the guides. In the repository, start at
[docs/00-README.md](docs/00-README.md).

## Contributing

Read [AGENTS.md](AGENTS.md) first; work is tracked in
[docs/10-EXECUTION-TRACKER.md](docs/10-EXECUTION-TRACKER.md). Report security issues as described
in [SECURITY.md](SECURITY.md).

## License

OpenCanvas is open source under the [Apache License 2.0](LICENSE), copyright 2026 CasualOffice.
When you redistribute it or a derived work, keep the [NOTICE](NOTICE) file. The bundled fonts are
under the SIL Open Font License 1.1 ([crates/oc-model/fonts/THIRD-PARTY.md](crates/oc-model/fonts/THIRD-PARTY.md)).

*Nextcloud is a registered trademark of Nextcloud GmbH. Mattermost is a trademark of Mattermost, Inc. OpenCanvas is an independent open-source project, not affiliated with or endorsed by either company.*
