# 01 — Research: how Zoom Canvas, Slack Canvas and Microsoft Loop work

**Status:** research, checked 2026-11-21. Sources are listed at the end; vendor
pages are marketing claims and are marked as such. Re-check before quoting
any feature as current.

The question this note answers: *what do the three "canvas" products actually
do, how are they built, and which of their decisions should OpenCanvas copy,
adapt or refuse?* A fourth product, **Collabora Online**, is studied not as a
canvas but as the **integration model** we are copying: an editor that owns
editing and collaboration while a host application owns files, users and ACLs.

---

## 1. Slack Canvas

### What it is
- A persistent rich document that lives **inside Slack**, either as a
  *channel canvas* (one per channel / DM, pinned as a tab) or a *standalone
  canvas* shared like a file.
- Lineage: built on **Quip** technology (Salesforce acquired both). Announced
  2022 as "Quip's collaborative tooling + Slack's communication layer".
- Content: headings, rich text, checklists, bullet/numbered lists, tables,
  images, files, links that unfurl into cards, @mentions of people/channels,
  emoji, embedded **Lists** (task tables), embedded **Workflow** buttons, up to
  **three-column layouts**, templates (bundles of canvas + lists + workflows).
- Collaboration: real-time co-editing, cursors, comments threaded into Slack
  messages, huddle notes written into a canvas.

### How it is built (observable)
- **API is markdown-only.** `canvases.create`, `canvases.edit`,
  `conversations.canvases.create` take a `document_content` object with
  `type: "markdown"` and a `markdown` string (≤ 1 MiB). Block Kit is *not*
  supported inside canvases. Edits are section-addressed operations
  (`insert_after`, `insert_before`, `replace`, `delete` on a `section_id`),
  found with `canvases.sections.lookup`.
- Access is set per canvas with `canvases.access.set` (read / write, to users
  or channels) — i.e. Slack owns the ACL, the canvas engine does not.
- One channel canvas per channel: creating a second returns
  `channel_canvas_already_exists`.
- Standalone canvases are not available on free plans.

### Lessons for OpenCanvas
| Take | Why |
|---|---|
| **Markdown as the public content API** | Easy for hosts and bots to create/patch a canvas without learning our CRDT. We do the same, plus a richer JSON block API. |
| **Section-addressed edits** (`insert_after section_id`) | Server-side patches that do not need a live client. We expose block-ID-addressed patches. |
| **Context-attached canvas** (channel canvas) | Our host decides the context (channel, meeting, ticket); we only need a stable `file_id`. |
| **ACL lives in the host** | Exactly our model. |
| Refuse: markdown-only fidelity | Markdown cannot carry boards, column layouts, embeds faithfully. Our native format is a block tree; markdown is an import/export view. |

---

## 2. Zoom Canvas (formerly Zoom Docs) + Zoom Whiteboard

### What it is
- Zoom renamed **Zoom Docs → Zoom Canvas**; it is an "AI-first workspace for
  docs, wikis, tables and forms" inside Zoom Workplace.
- **Block editor:** `+` or `/` inserts blocks — headings, lists, checklists,
  quotes, images, video, tables, web cards (link previews), embedded media,
  and **embedded Zoom Whiteboards**. Blocks are drag-and-drop reorderable.
- Collaboration: real-time co-editing, comments, @mentions, version history,
  suggested edits (announced). Sharing to Zoom Chat channels or people with
  **view / comment / edit** roles.
- Tight meeting integration: meeting summaries and notes flow into a Canvas;
  a Canvas can be opened inside a meeting side panel.
- AI features gated to paid plans.

### How it is built (observable)
- Block-structured document; each block is an independent, movable unit
  (drag handle per block) — the Notion pattern.
- Whiteboard is a **separate product embedded as a block** rather than a
  native block type: the doc stores a reference, the whiteboard has its own
  storage and collaboration session.
- Permissions are the three-level ladder view → comment → edit.

### Lessons for OpenCanvas
| Take | Why |
|---|---|
| **Block model with `/` command and drag handle** | Users now expect it from every modern canvas. |
| **Three-role ladder: view / comment / edit** | Maps 1:1 onto the permissions our host passes in. |
| **Board inside a doc** | Required. We make the board a *native* block that shares the document's CRDT, so one session, one commit, one file. |
| **Meeting-panel mode** | Our embed must work in a narrow side panel (≥ 320 px) — sibling service `meet` is the obvious first host. |
| Refuse: board as separate product | Two sessions, two files, two permission checks — expensive for a lightweight service. |

---

## 3. Microsoft Loop (+ Fluid Framework)

### What it is
- Three layers: **Loop components** (portable live blocks — a table, task
  list, checklist, paragraph — that can be pasted into Teams chat, Outlook
  mail, Whiteboard and stay live everywhere), **Loop pages** (canvases that
  hold components) and **Loop workspaces** (collections of pages).
- A component edited in Teams updates instantly in the Outlook mail where the
  same component was pasted. That *portability of a live block* is Loop's
  signature feature.

### How it is built
- **Fluid Framework**: client libraries + a server-side **ordering service**
  (open-source reference: *Routerlicious*; hosted: *Azure Fluid Relay*,
  *SharePoint Embedded*).
- Model is a **total-order broadcast log**: clients send ops; the relay stamps
  each op with a **sequence number**; every client applies ops in that order
  and converges. The server does no merge logic — it orders and fans out.
  Periodically a client writes a **summary** (snapshot) so new joiners load
  summary + tail of ops instead of the full log.
- **Distributed Data Structures (DDS):** SharedMap, SharedString (sequence
  merge-tree), and in Fluid 2.x **SharedTree** — a hierarchical node tree with
  move semantics, which is what rich structured documents use.
- **Storage is the user's file store.** Loop components are backed by
  **`.loop` files** (formerly `.fluid`) stored in the creator's **OneDrive**, the
  channel's **SharePoint** site, or **SharePoint Embedded** containers for
  workspaces. Permissions, retention, eDiscovery and quota are SharePoint's.

### Lessons for OpenCanvas
| Take | Why |
|---|---|
| **The file lives in the host's store; the editor is a service.** | Identical to our "no document persistence" rule. Loop proves it scales. |
| **Ordering relay + snapshots (summary + op tail)** | Our room server orders updates, fans them out, and keeps a snapshot + update tail only while a session is live. |
| **Server holds no merge logic in the hot path** | We use a CRDT (Yjs) so the server can merge updates without understanding block semantics — cheap and horizontally scalable. |
| **Portable live components** | Phase 3: a single block can be embedded by ID into another host surface (chat message, mail) and stay live. Design the block ID scheme for it now. |
| Refuse: heavyweight client runtime / Azure dependency | Our client must be one script tag; our server one binary. |

---

## 4. Collabora Online (the integration model, not a canvas)

### How integration works
- Collabora is a **WOPI client**; the integrating app (Nextcloud, ownCloud,
  Moodle, your app) is the **WOPI host**.
- The host renders an `<iframe>` that POSTs `access_token` (+ TTL) to the
  editor's action URL with `WOPISrc=<host>/wopi/files/<id>`.
- The editor then calls the host:
  - `GET  /wopi/files/<id>` — **CheckFileInfo**: name, size, owner, user id,
    display name, `UserCanWrite`, `LastModifiedTime`, feature flags.
  - `GET  /wopi/files/<id>/contents` — **GetFile**.
  - `POST /wopi/files/<id>/contents` — **PutFile** (save).
- The `access_token` is **opaque to the editor** — only the host interprets it.
  Invalid/expired → 401/404. Microsoft recommends ~10 h token lifetime.
- Collabora skips WOPI Lock and uses **`LastModifiedTime` timestamps** to
  detect conflicting saves (409 with the host's current timestamp).
- PostMessage API between host page and iframe: `App_LoadingStatus`,
  `UI_Save`, `Action_Save`, `Host_PostmessageReady`, etc.

### Lessons for OpenCanvas
This is **the** pattern the product brief asks for. We adopt it almost
verbatim (see [05-INTEGRATION-GUIDE.md](05-INTEGRATION-GUIDE.md)):
- Host owns authentication, users, ACL, files, versions, retention.
- We own the editor, presence, real-time merge, preview, export, and the
  commit back to the host.
- We add a **signed-JWT launch mode** for hosts that do not want to implement
  WOPI callbacks for every open (one fewer round-trip; easier for new apps),
  and keep **WOPI-compatible callbacks** for hosts (Nextcloud etc.) that
  already speak it.
- Sibling project OpenCalc already implements a WOPI client
  (`../opencalc/docs/74-WOPI-INTEGRATION.md`); we reuse its learnings.

---

## 5. Feature matrix

| Capability | Slack Canvas | Zoom Canvas | MS Loop | **OpenCanvas target** |
|---|---|---|---|---|
| Rich text (H1–H3, bold/italic/strike/code, colour) | ✓ | ✓ | ✓ | ✓ P1 |
| Lists / checklists | ✓ | ✓ | ✓ | ✓ P1 |
| Tables | ✓ (basic) | ✓ | ✓ (rich) | ✓ P1 basic, P2 typed columns |
| Images / files | ✓ | ✓ | ✓ | ✓ P1 (bytes stored in host via asset callbacks) |
| Links + unfurl cards | ✓ | ✓ web card | ✓ | ✓ P1 |
| Embeds (YouTube, Figma, Maps, iframes) | partial | ✓ | ✓ | ✓ P1 allow-listed oEmbed |
| Whiteboard / board | ✗ | embedded product | Whiteboard app | ✓ **native block** P2 |
| Column layouts | ✓ (3) | ✓ | ✓ | ✓ P2 |
| Callouts, dividers, quotes, code blocks | ✓ | ✓ | ✓ | ✓ P1 |
| Mentions | ✓ | ✓ | ✓ | ✓ P1 (resolved via host user lookup) |
| Comments | ✓ | ✓ | ✓ | ✓ P2 (stored in the file) |
| Live cursors + presence | ✓ | ✓ | ✓ | ✓ P1 |
| Version history | ✓ | ✓ | ✓ | host-owned; we create **commits** P1 |
| Portable live blocks | ✗ | ✗ | ✓ | P3 |
| Templates | ✓ | ✓ | ✓ | P2 (host supplies template files) |
| Public API to create/patch | markdown | ✓ | Graph | ✓ markdown + JSON block patches |
| Embeddable in 3rd-party apps | ✗ | ✗ | partially | ✓ **primary goal** |
| Self-hostable, single binary | ✗ | ✗ | ✗ | ✓ |

## 6. Technology research: CRDT choice

| Option | Notes | Verdict |
|---|---|---|
| **Yjs / yrs** | Most mature ecosystem; first-class ProseMirror/Tiptap binding (`y-prosemirror`), awareness protocol for cursors, Rust port `yrs` for the server. Fast on plain text; GC keeps docs small. | **Chosen** (ADR-002) |
| Automerge | Full history, good Rust core; weaker rich-text editor bindings. | Rejected for now |
| Loro | Peritext-style rich text, strong tree/move benchmarks (vendor-run 2024); ProseMirror binding early-stage. | Re-evaluate in P3 |
| OT (ShareDB-style) | Needs server-side transform logic per block type; opposite of "server knows nothing". | Rejected |
| Fluid Framework | Excellent model, heavy runtime, Azure-shaped. | Borrow ideas only |

## Sources

- Slack: [Canvases surface](https://docs.slack.dev/surfaces/canvases), [canvases.create](https://docs.slack.dev/reference/methods/canvases.create/), [canvases.edit](https://docs.slack.dev/reference/methods/canvases.edit/), [conversations.canvases.create](https://docs.slack.dev/reference/methods/conversations.canvases.create/), [Meet Slack canvas](https://slack.com/blog/news/meet-slack-canvas), [Discover ways to use canvases](https://slack.com/help/articles/19470130744595), [Slack templates](https://slack.com/help/articles/34237742189715/), [TechCrunch on Quip lineage](https://techcrunch.com/2022/09/20/slack-adds-persistent-information-layer-to-channels-with-new-quip-integration/amp/)
- Zoom: [Zoom Docs guide](https://www.zoom.com/en/blog/zoom-docs-guide/), [Document collaboration](https://www.zoom.com/en/products/collaborative-docs/features/document-collaboration/), [Document formatting](https://www.zoom.com/en/products/collaborative-docs/features/document-formatting/), [Zoom Canvas (formerly Zoom Docs)](https://www.zoom.com/sv/products/collaborative-docs/features/)
- Microsoft: [How SharedTree merges changes](https://devblogs.microsoft.com/microsoft365dev/fluid-framework-how-sharedtree-merges-changes), [Fluid Framework 2 production-ready](https://devblogs.microsoft.com/microsoft365dev/fluid-framework-2-is-now-production-ready/), [Loop components in OneDrive/SharePoint](https://learn.microsoft.com/microsoft-365/loop/loop-components-configuration), [Loop workspaces storage & permissions](https://learn.microsoft.com/en-us/microsoft-365/loop/loop-workspaces-storage-permission?view=o365-worldwide), [Getting started with Azure Fluid Relay](https://www.infoworld.com/article/3640727/getting-started-with-azure-fluid-relay.html)
- Collabora / WOPI: [How to integrate](https://sdk.collaboraonline.com/docs/How_to_integrate.html), [Advanced integration](https://sdk.collaboraonline.com/docs/advanced_integration.html), [Step-by-step tutorial](https://sdk.collaboraonline.com/docs/Step_by_step_tutorial.html), [WOPI key concepts](https://learn.microsoft.com/microsoft-365/cloud-storage-partner-program/rest/concepts), [CheckFileInfo](https://learn.microsoft.com/microsoft-365/cloud-storage-partner-program/rest/files/checkfileinfo)
- CRDT: [crdt-benchmarks](https://github.com/zxch3n/crdt-benchmarks), [Loro performance](https://loro.dev/docs/performance), [Yjs vs Loro discussion](https://discuss.yjs.dev/t/yjs-vs-loro-new-crdt-lib/2567)
