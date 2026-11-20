# 02 — Product Requirements Document (PRD)

**Product:** OpenCanvas — an embeddable, real-time collaborative canvas
(rich document + board) built **for integration**.
**Status:** draft v0.1, 2026-11-21. Awaiting approval.
**Owner:** schnsrw1@gmail.com

---

## 1. Problem

Every product that wants a "Slack/Zoom/Loop-style canvas" today has two bad
options: build a collaborative editor from scratch (months of CRDT, cursor,
conflict and export work) or adopt a SaaS whose storage, users and permissions
are not theirs. Collabora Online solved this for office files: the host keeps
files, users and ACLs, the editor does editing. **Nobody offers that model for
a modern block canvas.**

## 2. Vision

> Drop one iframe (or one web component) into any app and its users get a
> live, multi-cursor canvas — text, tables, images, links, embeds and boards —
> while the app keeps full ownership of the file, the users and who can do what.

## 3. Principles (non-negotiable)

1. **Host owns identity, ACL and storage.** OpenCanvas never authenticates
   users, never decides permissions, never keeps the canonical file.
2. **We own editing.** Real-time merge, presence, cursors, preview, export,
   commit back to host.
3. **No document persistence beyond a live session.** Session state (CRDT
   snapshot + update tail) is kept only to survive node restarts and to let
   late joiners catch up; it is deleted after commit + idle TTL.
4. **Lightweight.** One server binary; SQLite by default; one JS bundle.
   Runs on a 1 vCPU / 512 MB box for a small team.
5. **Scalable.** Stateless HTTP, room-affine WebSocket nodes, MySQL/MariaDB +
   optional Redis for clusters. Add nodes, not rewrites.
6. **Lossless.** Anything we cannot render is preserved and round-tripped,
   never dropped silently.

## 4. Personas

| Persona | Need |
|---|---|
| **Integrator developer** (primary customer) | Embed a canvas in ≤ 1 day; implement 3–5 HTTP callbacks; no CRDT knowledge. |
| **End user — editor** | Write, paste, drag blocks, draw on a board, see others typing live. |
| **End user — viewer / commenter** | Fast preview, comments, no accidental edits. |
| **Host admin / ops** | Docker run, health checks, metrics, choose SQLite or MySQL/MariaDB. |
| **Automation / bots** | Create or patch a canvas with markdown/JSON over REST. |

## 5. Scope

### 5.1 In scope — v1 (MVP, Phases 0–2)

**Integration**
- Launch modes: **edit**, **comment**, **view (preview)**, **download/export**.
- Two auth handshakes: **Signed launch token (JWT, HS256/RS256/EdDSA)** and
  **WOPI-compatible** callbacks (CheckFileInfo / GetFile / PutFile).
- Host callbacks: load file, save (commit) file, upload/fetch asset, resolve
  users (mentions), optional token refresh.
- Embed SDK: `<iframe>` URL + `@opencanvas/embed` (web component + JS API +
  postMessage events).
- REST API: create session, export, server-side markdown/JSON patch, force
  commit, close session, health, metrics.
- Multi-tenant: many hosts, each with its own secret/keys and callback base URL.

**Content (block types)**
- Text: paragraph, heading 1–3, quote, callout, divider, code block (syntax
  highlight), inline marks (bold, italic, underline, strike, code, link,
  highlight, text colour), mentions (user, date), emoji.
- Lists: bullet, numbered, checklist (with assignee/due as optional attrs),
  toggle (collapsible).
- **Tables**: rows/cols, header row, column width, cell rich text, add/remove/
  move rows & columns.
- **Images**: upload, paste, drag-drop, URL; caption, width, alignment.
- **Files/attachments**: card with name/size/icon, download via host.
- **Links**: inline link + **link card (unfurl)** with title/desc/image via
  server-side fetcher (SSRF-safe).
- **Embeds**: allow-listed oEmbed/iframe providers (YouTube, Vimeo, Loom,
  Figma, Google Maps, Miro, generic iframe allow-list per host).
- **Board (whiteboard) block**: infinite pan/zoom surface inside the doc —
  freehand pen, shapes (rect, ellipse, diamond, arrow/line, text, sticky
  note), images, select/move/resize/rotate, connectors, z-order, colours.
- Columns layout (2–3 columns).

**Collaboration**
- Real-time co-editing, conflict-free (CRDT).
- Presence: avatars list, **live cursors and selections** in text, **live
  pointers** on boards, "following" a user, typing indicators.
- Role enforcement per connection (view / comment / edit) — server rejects
  writes from non-editors.
- Undo/redo per user (only your own changes).
- Offline tolerance: brief disconnects buffer locally and resync.

**Saving (autosave only — decided 2026-11-21, ADR-012)**
- There is **no Save button**. Every change autosaves to the host: on a short debounce, on idle, when the last user leaves, and on shutdown.
- Save state is shown as a quiet status (Saved / Saving / Offline / Retrying) with a popover; version history is the host's and is linked from it.
- Commit carries author list (who contributed since last commit).
- Conflict detection with host (`version`/`LastModifiedTime`) → 409 flow.
- Version history is host-owned; we expose "open version N read-only"
  when the host provides version URLs.

**Preview & download**
- Preview: read-only render, no WebSocket required (SSR'd HTML from file).
- Export: `.ocanvas` (native), Markdown, HTML, PDF, DOCX (P2), PNG/SVG (board).
- Import: Markdown, HTML, plain text (P1); DOCX (P3).

**Databases (P1, ADR-013)** — like Zoom Canvas data tables, Notion databases and Slack Lists
- A database block with typed fields: title, text, status, select, tags, person, date, number, checkbox, URL, progress.
- Views over the same rows: **table** (inline cell editing, sort, filter, search, count/sum/average footer), **board** (kanban grouped by status/select, drag between columns), **calendar** (month grid; agenda list on phones), **gallery**.
- Row detail panel (peek) with all properties and free-form notes.
- **CSV import** (paste or file, type detection, preview) and **CSV export**; copy as Markdown table.

**Templates (P1, ADR-014)**
- A "New canvas" gallery with blank starts (canvas, database, whiteboard, import) and **40 templates in 9 categories**: meetings, projects, product & engineering, design & research, team & HR, sales & success, planning, whiteboards, personal.
- Search, category filter, live thumbnails, and a preview before use. Hosts can add their own team templates.

**Mobile and narrow embeds**
- Under 720 px: editing toolbar above the keyboard, bottom sheets instead of popovers, a board that has to be tapped before it captures touch (and opens full screen), sticky first column in tables, agenda in calendar view, 16 px inputs (no iOS zoom), 38–44 px touch targets.

**Icons and type**: Lucide icons only (no emoji in UI chrome), Geist / Geist Mono.

**Comments (P2)**
- Anchored to text ranges or board shapes; threads; resolve; mentions.
- Stored inside the `.ocanvas` file so the host retains them.

### 5.2 Out of scope for v1
- User accounts, login, sharing dialogs, folder trees (host's job).
- Long-term storage, retention, backup of documents (host's job).
- AI features (P3, pluggable provider).
- Spreadsheets / slides as blocks (link to OpenCalc / OpenSlide via embed).
- Native mobile apps (responsive web only).

## 6. User stories (selected, with acceptance criteria)

| ID | Story | Acceptance |
|---|---|---|
| US-01 | As an integrator I open a canvas by POSTing a signed token to an iframe. | Canvas renders ≤ 1.5 s p75 for a 200-block doc; invalid token → error screen + `Error` postMessage. |
| US-02 | As two editors we type in the same paragraph. | Both see each other's characters ≤ 150 ms p95 same region; final docs identical. |
| US-03 | As a viewer I cannot edit, even with devtools. | Server drops update frames from view/comment roles; test proves it. |
| US-04 | As an editor I draw on a board while my colleague moves a sticky. | Both converge; pointers visible; no lost shapes. |
| US-05 | As an editor I never think about saving. | Every change reaches the host within `OC_AUTOSAVE_SECS`; status shows Saved; no Save button exists. |
| US-06 | As a host I get the file back when the last user leaves. | Final commit within `COMMIT_IDLE_SECS` (default 30 s); session state purged after TTL. |
| US-07 | As a bot I append a checklist via REST while users are editing. | Patch is merged live; users see it appear; next commit includes it. |
| US-08 | As a viewer I download as PDF/Markdown. | Export permission flag respected; file downloads. |
| US-09 | As a host I run with no DB config. | Service starts with SQLite at `./data/opencanvas.db`. |
| US-10 | As a host I set `DATABASE_URL=mysql://…`. | Migrations run on MySQL 8 / MariaDB 10.6+; cluster mode works with ≥ 2 nodes. |
| US-11 | As an editor I paste an image. | Image uploaded via host asset callback, inserted, visible to all; on failure, retry chip. |
| US-12 | As an editor I paste a YouTube link. | Offer "embed / card / link"; embed renders in sandboxed iframe. |

## 7. Non-functional requirements

| Area | Target |
|---|---|
| Latency | Local echo < 16 ms; remote update p95 < 150 ms same region. |
| Capacity per room | 50 concurrent editors, 500 viewers (viewers on fan-out only). |
| Capacity per node (2 vCPU / 2 GB) | 2 000 concurrent connections, 300 active rooms. |
| Document size | Soft 5 MB CRDT state, hard 20 MB; 10 000 blocks; 5 000 board shapes per board. |
| Cold open | p75 < 1.5 s (200 blocks, 4G); JS bundle < 350 KB gz for editor, < 60 KB gz for preview. |
| Server footprint | Idle RSS < 40 MB; single static binary. |
| Availability | Node loss → clients reconnect to new owner in < 5 s, no acknowledged edit lost. |
| Security | OWASP ASVS L2; sandboxed embeds; SSRF-safe unfurl; CSP; token scoping; no PII persisted beyond session. |
| Accessibility | WCAG 2.2 AA for editor chrome; keyboard-only operable; screen reader labels. |
| Browsers | Last 2 versions of Chrome, Edge, Firefox, Safari; iOS/Android Safari/Chrome. |
| i18n | RTL text, IME composition (CJK), UI strings externalised. |
| Observability | Prometheus metrics, structured JSON logs, OpenTelemetry traces. |

## 8. Success metrics

- Integrator time-to-first-embed ≤ 1 day (measured with the sample host).
- 0 divergence incidents (fuzz + soak harness: 10 000 random concurrent ops).
- Commit success rate ≥ 99.9 %; zero silent data loss.
- p95 remote latency < 150 ms at 50 editors in a room.

## 9. Release plan

See [09-ROADMAP.md](09-ROADMAP.md). Summary:
- **P0 Foundation** — docs, ADRs, UI approval on artifact, scaffold.
- **P1 MVP** — text/lists/tables/images/links/embeds, presence, JWT + WOPI,
  commits, preview, MD/HTML export, SQLite.
- **P2** — board block, columns, comments, PDF/DOCX export, MySQL/MariaDB
  cluster + Redis, templates.
- **P3** — portable live blocks, AI, DOCX import, Loro re-evaluation.

## 10. Open questions (for approval)

1. Server language: **Rust** (matches OpenCalc/OpenSign, lowest footprint) —
   proposed. Alternative Node + Hocuspocus is faster to start, heavier to run.
0. ~~Manual save~~ → autosave only (decided). Templates and databases added (decided).
2. Native file extension `.ocanvas` (zip). OK?
3. Board renderer: custom SVG/Canvas2D on Yjs (proposed, license-clean) vs
   embedding Excalidraw (MIT, heavier, separate data model).
4. First host to integrate: `meet` side panel? another internal service?
