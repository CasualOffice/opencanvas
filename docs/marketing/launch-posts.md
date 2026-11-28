# OpenCanvas by CasualOffice — launch post drafts

> **DRAFT — NOT POSTED.** Every text below is a draft for the owner to review, edit and post
> by hand. Nothing here has been published. Before posting, re-read the venue's current rules
> (they change), check every number against `bench/results/` and the release notes
> ([docs/37](../37-RELEASE-v0.4.0.md)), and post from a personal account that says who you are.

Ground rules for every post (from the venues' self-promotion norms and LEGAL-01):

- **Say you made it.** "I'm one of the people building this" in the first lines.
- **Be honest about status:** early release, best-effort support, no production SLA; benchmarks
  ran on a developer laptop (Apple M4) in short form, not the reference machine.
- **Name other products only to identify them** (Notion, Miro, Etherpad, Coda, Jitsi, Nextcloud,
  Mattermost, Element). No logos, no implied affiliation or endorsement. Mattermost only as an
  adjective ("Mattermost plugin", "Mattermost channels"). Ask trademark@mattermost.com before any
  Mattermost Marketplace listing (LEGAL-01).
- **Don't ask for upvotes or stars**, don't post the same text to several venues on one day, and
  answer comments yourself.
- Links: demo https://canvas.casualoffice.org/app/#demo · site https://canvas.casualoffice.org ·
  repo https://github.com/CasualOffice/opencanvas · issues
  https://github.com/CasualOffice/opencanvas/issues (GitHub Discussions is not enabled; enable it
  first if posts point people there).

Facts every draft may use (sources in brackets):

- Release 0.4.0, 2026-11-28, Apache-2.0 [CHANGELOG.md, NOTICE].
- One canvas: rich-text blocks, Spreadsheet block on opencalc's engine (about 120 functions,
  `.xlsx`/`.ods` import, `.xlsx` export), linked charts, databases (table, board, calendar,
  gallery, Timeline/Gantt, Workload; formulas, relations, rollups), whiteboards and diagrams
  (draw.io and Excalidraw import) [docs/37, README].
- The host app owns users, permissions and files; OpenCanvas stores no documents [ADR-001].
- Rust server (tokio, axum), Yjs CRDT, formula engine in Rust compiled to WebAssembly in the
  editor; SQLite by default, MySQL/MariaDB + Redis for clusters [docs/03, ADR-078].
- Integrations: Jitsi Meet (Prosody plugin, Shared document slot), Nextcloud app with Talk,
  Mattermost plugin, Element / Matrix widget — all alpha [integrations/*/README.md].
- Benchmarks (laptop, short runs, SQLite): 10,000 WebSocket connections on one node over 500
  rooms (75% idle, 15% cursors at 2/s, 10% typing at 1 edit/s), p99 ≤ 64.2 ms outside the 60 s
  after a `kill -9` restart, 3,210 MB RSS, all clients back within 37.1 s; 1,000 people in one
  room, p99 ≤ 80.6 ms but memory still grew, so the default cap stays 550; 100,000 rows × 30
  fields in the browser at p95 16.7 ms frames [bench/results/, e2e/perf/results/].
- Not built: native desktop or mobile apps, sign-up/accounts, hosted service. AI assistant and
  MCP are experimental and off by default.

---

## 1. Jitsi Community forum (community.jitsi.org)

**Venue notes:** the forum is for Jitsi users and developers; post in the category for
third-party projects or "Show and tell" if one exists, otherwise ask a moderator first. Keep it
technical, explain the integration, don't cross-post.

**Title:** A shared canvas (notes, tasks, whiteboard) in the Jitsi "Shared document" slot — open-source Prosody plugin

**Body:**

Hi all — I'm one of the people building OpenCanvas, an Apache-2.0 collaborative canvas, and we
wrote a Jitsi Meet integration that I'd like feedback on from people who run Jitsi.

What it does: one Prosody module (`mod_opencanvas.lua`) plus a few `.env` lines puts an
OpenCanvas canvas in the slot Etherpad uses. Everyone in the meeting opens it from **Shared
document** and edits it live: notes and checklists, a task table, a whiteboard. No changes to
the Docker images or the compose file.

- The canvas is temporary: it starts blank or from a template (`template = "meeting"`) and is
  deleted when the meeting ends; people export PDF, Word, Markdown or the native file to keep it.
- Moderators edit; guests get the role you set (`opencanvas_guest_role`); role changes during
  the meeting apply live.
- Reloads, dropped networks and an OpenCanvas restart rejoin the same canvas.

Tested against a stock docker-jitsi-meet with two browsers. **Not tested yet:** Debian-package
installs and multi-shard deployments — if you run either, I'd really like to hear what breaks.

It's an early release with best-effort support. Etherpad is lighter and more mature; this is for
meetings where the notes need structure or a drawing.

Guide: https://canvas.casualoffice.org/docs/jitsi.html · Code: https://github.com/CasualOffice/opencanvas/tree/main/integrations/jitsi

OpenCanvas is an independent project, not affiliated with or endorsed by 8x8 or the Jitsi team.

---

## 2. Nextcloud

### 2a. Nextcloud App Store listing text (for `appinfo/info.xml`)

**Venue notes:** the App Store needs a signed release and a certificate registered for the app
id `opencanvas`. Keep the LEGAL-01 trademark line in the description. Name stays plain
"OpenCanvas" (Nextcloud trademark terms; LEGAL-01). Before any commercial use around Nextcloud,
ask Nextcloud GmbH.

**Name:** OpenCanvas

**Summary:** Collaborative canvases: documents, spreadsheets, databases and whiteboards in one file

**Description:**

Create `.ocanvas` files in Files and edit them together in real time with OpenCanvas, an
open-source (Apache-2.0) collaborative editor.

- One canvas holds rich text, an Excel-style spreadsheet, databases (table, board, calendar,
  Timeline and Workload views) and whiteboards side by side.
- Nextcloud keeps the files, shares, permissions and versions: OpenCanvas opens files as a WOPI
  client, the way Nextcloud Office does, and stores no documents.
- Talk: a Canvas panel beside the chat or call, canvas cards in conversations, Follow me, and a
  meeting canvas per call.
- Unified search finds text inside canvases.

Requires a running OpenCanvas server (Docker image `ghcr.io/casualoffice/opencanvas`). Status:
alpha, tested on Nextcloud 31; best-effort support.

Nextcloud is a registered trademark of Nextcloud GmbH. Mattermost is a trademark of Mattermost,
Inc. OpenCanvas is an independent open-source project, not affiliated with or endorsed by either
company.

### 2b. Nextcloud forum post (help.nextcloud.com, "Apps" / development category)

**Title:** OpenCanvas app: collaborative canvases (docs, spreadsheets, databases, whiteboards) as .ocanvas files, with Talk

**Body:**

Hi — I help build OpenCanvas and we've written a Nextcloud app for it. Sharing it here for
feedback from admins before we submit it to the App Store.

What it is: an app (id `opencanvas`, Nextcloud 30–32) that adds **New canvas** to Files. A
canvas is one file with rich text, a spreadsheet block, databases with board/calendar/Gantt
views and a whiteboard, edited live by everyone who has access.

How it fits: Nextcloud is the WOPI host, the same model as Nextcloud Office. Files, shares,
permissions and versions stay in Nextcloud; every WOPI call is proof-key signed; a removed share
cuts access at once. With Talk you get a Canvas panel beside the chat or call and a meeting
canvas per call that the moderator can save into their Talk folder.

Honest status: alpha. The scripted end-to-end run passes on Nextcloud 31 (SQLite); NC 30/32 and
some Talk paths (guests' link previews, the 10-minute auto-discard in a real server) are not
fully verified — the README lists them. You also need to run the OpenCanvas server (one Docker
container).

Docs: https://canvas.casualoffice.org/docs/nextcloud.html · Code:
https://github.com/CasualOffice/opencanvas/tree/main/integrations/nextcloud

Nextcloud is a registered trademark of Nextcloud GmbH. OpenCanvas is an independent open-source
project, not affiliated with or endorsed by Nextcloud GmbH.

---

## 3. Mattermost community (forum.mattermost.com, integrations category)

**Venue notes:** use "Mattermost" only as an adjective; no Mattermost logo; ask
trademark@mattermost.com before any Marketplace listing (LEGAL-01, Standard 1). The forum allows
sharing community integrations; don't post the same thing in the Community server channels too.

**Title:** Community plugin: collaborative canvases and meeting notes in Mattermost channels (open source)

**Body:**

Hi — I'm on the team building OpenCanvas (Apache-2.0) and we wrote a plugin that brings
collaborative canvases to Mattermost channels. Looking for feedback from admins.

- `/canvas new [title]` or the channel header button creates a canvas and posts a card in the
  channel; `/canvas notes [title]` starts meeting notes with Agenda, Notes, Decisions and Action
  items.
- Canvases open in the right-hand panel (expandable) and hold text, task databases, a
  spreadsheet and a whiteboard, edited live.
- Files live in the Mattermost file store; the plugin is the OpenCanvas host. Access follows the
  channel: leaving the channel removes access immediately, even with the canvas open.

Status: alpha, tested end to end on Mattermost server 12.1.0. Not tested: desktop and mobile
apps, high availability, a subpath Site URL. It needs a running OpenCanvas server.

Guide: https://canvas.casualoffice.org/docs/mattermost.html · Code:
https://github.com/CasualOffice/opencanvas/tree/main/integrations/mattermost

Mattermost is a trademark of Mattermost, Inc. OpenCanvas is an independent open-source project,
not affiliated with or endorsed by Mattermost, Inc.

---

## 4. r/selfhosted

**Venue notes:** r/selfhosted allows posts about your own project if you disclose it and engage;
check the current rules (some periods require self-promotion only on certain days, and new
projects may need a flair). One post, not repeated weekly.

**Title:** OpenCanvas – self-hosted collaborative docs, spreadsheets, databases, whiteboards and Gantt in one canvas (Apache-2.0, I'm the dev)

**Body:**

Disclosure: I'm one of the developers.

OpenCanvas is a real-time collaborative canvas you run yourself: documents, an Excel-style
spreadsheet, databases (board, calendar, Timeline/Gantt, Workload; formulas, relations,
rollups), and whiteboards/diagrams in the same document.

What's different from the usual Notion-style self-hosted apps: it's an *engine* that something
else hosts. It has no user accounts of its own — Nextcloud, Mattermost, Jitsi Meet, Element, or
your own app provides users, permissions and storage, and OpenCanvas edits and saves the file
back. It never keeps documents.

Running it: one container (`ghcr.io/casualoffice/opencanvas:0.4.0`) on SQLite; MySQL/MariaDB +
Redis if you want a cluster. Helm chart included. There's a browser demo with no server:
https://canvas.casualoffice.org/app/#demo

Things to know before you try it:
- It's early (0.4.0), best-effort support, no SLA.
- Without an existing host (Nextcloud etc.) you need the sample host or your own integration.
- No native mobile apps; the web editor has a phone layout.
- The AI assistant is off by default and only talks to a model server you configure (Ollama,
  vLLM, llama.cpp or a hosted API).

Repo: https://github.com/CasualOffice/opencanvas — bug reports welcome in Issues.

---

## 5. r/rust (the benchmarks angle)

**Venue notes:** r/rust welcomes project posts with technical substance; lead with the Rust and
the measurements, not the product pitch. Disclose authorship.

**Title:** Benchmarking a Yjs collaboration server in Rust: 10k WebSockets, kill -9 mid-run, and publishing every result with its load mix

**Body:**

I work on OpenCanvas, an Apache-2.0 collaborative editor whose server is Rust (tokio + axum)
speaking the Yjs protocol, with a Rust formula engine compiled to WASM for the browser. For 0.4
we built a benchmark harness and committed every result as JSON with the hardware and load mix
next to the numbers.

Short runs on one laptop (Apple M4, 10 cores, 16 GB, SQLite) — **not** the reference server, so
treat them as indicative:

- **10,000 connections, one node, 500 rooms**: 75% idle viewers, 15% moving cursors at 2/s, 10%
  typing at 1 edit/s; `kill -9` and restart at 2 min. p99 edit latency ≤ 64.2 ms in every bucket
  outside the 60 s after the restart, 3,210 MB RSS, all 10,000 clients back within 37.1 s. Two
  earlier runs of the same scenario *failed* the p99 rule (3.5 s and 11.3 s); those results are
  committed too.
- **1,000 people in one room**: p99 ≤ 80.6 ms with no drops, but RSS grew 62% over the run, so
  the default room cap stays at 550 until that's fixed.
- **100,000 rows × 30 fields** in a browser database view: p95 frame 16.7 ms after making a cell
  edit stop re-reading the whole table.

What made the difference was mostly boring: fewer allocations on fan-out, batching presence, and
not holding a load slot while waiting for a slow host.

Results: https://canvas.casualoffice.org/docs/benchmarks.html · raw JSON:
https://github.com/CasualOffice/opencanvas/tree/main/bench/results · harness: `scripts/bench/`

Happy to go into the room-ownership model for clustering or the WASM formula engine if anyone's
interested. Criticism of the methodology very welcome.

(Before posting: confirm the "what made the difference" paragraph against the tracker's
integration log for PERF and RLB items, and trim anything not recorded there.)

---

## 6. Show HN

**Venue notes:** Show HN is for things people can try; the demo qualifies. Plain title, no
superlatives, author comments first with context. Don't ask anyone to upvote.

**Title:** Show HN: OpenCanvas – an embeddable, self-hosted Notion/Miro-style canvas (Rust, Yjs)

**URL:** https://canvas.casualoffice.org

**First comment (by the author):**

Hi HN, I'm one of the builders. OpenCanvas is a collaborative canvas that other applications
embed, the way apps embed Collabora Online for office files: documents, an Excel-style
spreadsheet, databases with Gantt and workload views, whiteboards and diagrams in one live
document.

The design choice that shapes everything: the host application owns users, permissions and
files. Your backend signs a short-lived launch token (user, file, role); OpenCanvas runs the
session, enforces the role on every update server-side, and autosaves back to your storage
through a durable outbox. It never becomes the system of record. Nextcloud, Mattermost, Jitsi
Meet and Element integrations are built on the same contract.

Stack: Rust server (tokio/axum) on the Yjs protocol, Tiptap/ProseMirror editor, a Rust formula
engine compiled to WASM, SQLite by default and MySQL/MariaDB + Redis for clusters. Apache-2.0.

The demo runs entirely in your browser with simulated collaborators — no account, nothing sent:
https://canvas.casualoffice.org/app/#demo

Caveats: it's 0.4.0 with best-effort support; our benchmarks so far ran on a laptop (results and
load mixes are published, including the failed runs); no native apps. Notion, Miro and Coda are
far more complete as products — we've written up where on the site.

---

## 7. AlternativeTo listing

**Venue notes:** list as the developer; describe the product, not competitors; add it as an
alternative only where it genuinely overlaps (Notion, Miro, Etherpad, Coda). Use our own
screenshots only.

**Name:** OpenCanvas

**Tagline:** Open-source collaborative workspace engine you self-host and embed

**Description:**

OpenCanvas by CasualOffice is an open-source (Apache-2.0), self-hosted collaborative canvas.
One document holds rich text, an Excel-style spreadsheet with .xlsx import and export, linked
charts, databases with table, board, calendar, Timeline (Gantt) and Workload views, and
whiteboards and diagrams, all edited in real time with live cursors and comments.

It is built to be embedded: the host application (Nextcloud, Mattermost, Jitsi Meet, Element /
Matrix, or your own) keeps the users, permissions and files, and OpenCanvas does the editing.
Rust server, Yjs CRDT, SQLite or MySQL/MariaDB. Early release with best-effort support; web
only, no native apps.

**Platforms:** Self-hosted, Web, Linux (Docker). **License:** Open source (Apache-2.0). **Price:** Free.

**Tags:** collaborative-editing, self-hosted, wiki, whiteboard, spreadsheet, project-management, gantt, kanban.

---

## 8. LinkedIn

**Venue notes:** post from the founder's personal profile and share to the CasualOffice page;
one link, no engagement bait.

**Body:**

OpenCanvas 0.4.0 is out — the open-source collaborative workspace engine from CasualOffice.

It lets an application add documents, spreadsheets, databases, whiteboards and Gantt charts that
people edit together in real time, while the application keeps its own users, permissions and
data. Nothing is stored by OpenCanvas.

New in 0.4: a spreadsheet block with Excel import and export, charts linked to live data,
database formulas, relations and rollups, Timeline (Gantt) and Workload views, and a Canvas
panel in Nextcloud Talk.

It's Apache-2.0 and self-hosted, and still early, with best-effort support. If you build
software that needs collaborative editing, I'd value your feedback.

Try the demo in your browser: https://canvas.casualoffice.org/app/#demo

#opensource #selfhosted #rust #collaboration

---

## 9. Product Hunt

**Venue notes:** launch from the maker's account; Product Hunt forbids asking for upvotes and
vote rings. Gallery: our own screenshots from `site/assets/screens/` (light and dark), no other
products' logos. Mark it as open source.

**Name:** OpenCanvas

**Tagline (≤ 60 chars):** Self-hosted docs, sheets, databases and whiteboards

**Description (≤ 260 chars):** OpenCanvas is an open-source (Apache-2.0) collaborative canvas
you self-host and embed: documents, an Excel-style spreadsheet, databases with Gantt and
workload views, and whiteboards, edited live. Your app keeps the users and files.

**Maker's first comment:**

Hi Product Hunt — I'm one of the makers. We built OpenCanvas for teams and developers who want
Notion- or Miro-style collaboration inside their own tools, on their own servers. It plugs into
Nextcloud, Mattermost, Jitsi Meet and Element, or into your app through a signed launch token.

It's early (0.4.0) and honest about it: best-effort support, web only, and our benchmarks so far
ran on a laptop — every result is published with its load mix. The demo runs in your browser
with nothing to install. Feedback and bug reports are very welcome on GitHub.

*All product names are trademarks of their respective owners and are used only to identify
those products. OpenCanvas is an independent project, not affiliated with or endorsed by any of
them.*
