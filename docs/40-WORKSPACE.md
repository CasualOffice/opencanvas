# 40 — OpenCanvas Workspace (first-party host)

**Status:** Accepted 2026-11-28: the owner approved this plan, ADR-085 and the prototype
([docs/prototypes/workspace/workspace.html](prototypes/workspace/workspace.html)) with the changes in §0 (ADR-011). A parallel
track to v0.5; SSO is in the backlog. Tracker rows WS-01..WS-25.

**Product name.** *OpenCanvas Workspace*, by CasualOffice. In the app, on the first-run screen and in the docs the brand line is
"OpenCanvas Workspace · by CasualOffice"; marketing-facing places never say bare "OpenCanvas".

## 0. Owner decisions (2026-11-28)

The owner approved the prototype and ADR-085 with these changes:

1. **SSO (OIDC) moves to the backlog.** It is not in the MVP; WS-07 is backlog. Local accounts, passkeys and invite links are the MVP sign-in.
2. **UX first.** The Workspace must feel as polished as the editor: the prototype's flows are the bar, with no admin-tool look.
3. **Lightweight.** A small image, low idle memory and fast start; nothing runs that a small team does not need.
4. **Benchmarked on the user base.** A WS benchmark for many users and workspaces (sign-in, home and search latency, memory at rest) is published with the engine benchmarks, with the hardware and load mix stated.
5. **Large participation.** A canvas in the Workspace supports the engine's large rooms (cap 550 by default, configurable up to 1,000) without the Workspace becoming the bottleneck: launches, access checks and presence lookups must scale with it.
6. **Public links are supported and admin-configurable.** Admins choose whether public links are allowed, and which roles they may grant (view, comment, edit), with an expiry and an optional password.
8. **Files are typed** (owner, 2026-11-28, later the same day). *New* offers **Document**, **Spreadsheet**, **Whiteboard / Diagram**
   and **Database**, each with its own icon and file type in Home, search, trash and on the phone. A spreadsheet opens straight
   into the full-screen spreadsheet (grid, formula bar, sheet tabs) with no canvas around a block; a whiteboard or diagram opens
   straight into the full board; a database opens on its views; a document opens the canvas editor as today. Mixing blocks stays
   available inside documents, but the Workspace never shows a spreadsheet file as a canvas with a sheet block in it. The engine
   side is a contract feature for every host (docs/05 §2f, "file types and app mode", tracker FTY-01..08); the UI is prototype
   frames 13a–13j and waits for their approval (ADR-011).
7. The other recommendations in §9 are accepted as recommended: no PostgreSQL in the MVP; the setup code is skipped from the same machine; one organisation per deployment; the retention defaults; the image and binary names; the engine's version numbers; a Welcome workspace on by default; a parallel track to v0.5.

## 1. Why

OpenCanvas by CasualOffice is an embeddable engine: a host app owns users, access and files, and the engine edits, syncs,
previews, exports and commits (ADR-001). That suits products that already have users and files (Nextcloud, Mattermost, a SaaS),
but a team that just wants a self-hosted collaborative workspace has nothing to run: the only stand-alone option is
`examples/sample-host`, a demo with five fixed users. The owner sees this as a major gap.

**Goal.** People run one Docker image and start working: sign up the first admin, invite colleagues, create canvases from
templates, share them, find them again. No integration, no host app of their own.

**Non-goals.** No change to the engine's responsibility split; no multi-tenant SaaS (one deployment is one organisation);
no import from other products in the MVP (later, through the v0.5 plugin importers); no native desktop or mobile apps (the web
app works on phones).

## 2. Who it is for

| Person | Needs |
|---|---|
| **Operator** (runs the container) | One command; data in one volume; backups and upgrades that cannot lose work; works behind a reverse proxy; SSO when the company has one. |
| **Admin** (owns the organisation in the app) | Invite people, make teams and workspaces, set sign-in rules, branding, storage, e-mail, see usage. |
| **Member** | A home with recent and favourite canvases, folders, templates, sharing, search, trash, version history, on desktop and phone. |
| **Guest** | Invited to a few canvases or one workspace only; sees nothing else. |
| **Link visitor** | Opens a public link (view or comment) without an account, if the admin allows public links. |

## 3. Architecture

```
            browser ──────────────► :8080  opencanvas-workspace (one process, one port)
                                     │
             /, /app/*, /api/ws/*    │   Workspace host (crates/oc-workspace)
                                     │     users · sessions · passkeys · OIDC · invites
                                     │     workspaces · teams · folders · ACL · links
                                     │     canvases (.ocanvas bytes) · assets · versions
                                     │     search index (FTS5 / FULLTEXT) · trash · backups
                                     │        │  ▲
                 JWT launch (docs/05 §3)      │  │ signed callbacks (docs/05 §5, §5a, search, members, access, templates)
                 REST §7, webhooks §7c        ▼  │ over loopback HTTP, real signatures
             /v1/*, /api/v1/*, editor ─────  Engine (crates/oc-server as a library)
                                               rooms · Yjs · WAL · commits · exports · MCP · AI
                                     │
                              /data  ├─ workspace.db   (Workspace metadata; SQLite default)
                                     ├─ engine.db      (engine transient state, ADR-004)
                                     ├─ files/         (canvas versions, assets, avatars; or S3)
                                     ├─ backups/
                                     └─ secrets/       (generated OC_KEK, host secrets; 0600)
```

- **Contract only.** The Workspace is registered as an ordinary `[[host]]` (`id = "workspace"`). Every engine feature it uses is
  one any host can use. If the Workspace needs something the contract lacks, the contract grows for everyone (docs/05 updated
  in the same change), never a private shortcut.
- **One image, two shapes.** `docker run` runs both halves in one process. The production compose file runs the same image twice
  (`--role workspace` and `--role engine`, the engine scaled with Redis as today), with MySQL/MariaDB and S3-compatible storage.
- **Same stack.** Rust (axum, sqlx, tokio) for the host; React 19 with `@opencanvas/ui` tokens and Lucide icons for the web app
  (`web/packages/workspace`). The editor itself is the engine's, framed by the Workspace chrome exactly like any host.

## 4. Product spec

### 4.1 First run and install
- `docker run -p 8080:8080 -v opencanvas:/data ghcr.io/casualoffice/opencanvas-workspace`. The log prints the URL and a
  one-time 6-word **setup code**. Opening the URL from the same machine (loopback) skips the code.
- Setup (prototype 1a–1c): organisation name; admin name, e-mail and password (or a passkey straight away); public URL
  (pre-filled from the request, needed for links, OIDC redirects and passkeys); first workspace name; optional sample content.
  Ends on Home with a checklist: invite people, choose sign-in methods, set up e-mail, set up backups.
- Configuration is in the app; every setting can also be fixed by environment (`WS_*`), which then shows as "Set by the
  operator" and read-only.

### 4.2 Sign-in and accounts
- E-mail and password (Argon2id; minimum 10 characters, checked against a bundled breached-password list; rate limits and a
  15-minute lockout after 10 failures per account and per IP).
- **Passkeys** (WebAuthn): add several, name them, use one instead of a password; "Sign in with a passkey" on the sign-in page
  (conditional UI, autofill).
- **TOTP** two-step (later, WS-L).
- **OIDC SSO** (optional, several providers): button on the sign-in page, allowed e-mail domains for just-in-time accounts,
  optional "SSO only" (passwords off except for a break-glass Owner), group claim to team mapping.
- **Invites:** to the organisation (role Member or Guest), to a workspace, or to a canvas. Always a copyable single-use link
  (7 days); also e-mailed when SMTP is set. Sign-up from an invite shows who invited you and to what (prototype 2b).
- Open sign-up: off by default; admin may allow it for listed e-mail domains.
- Password reset: e-mail link with SMTP; otherwise an admin creates a reset link, or the operator runs
  `opencanvas-workspace admin reset-password <email>`.
- Profile: name, avatar, colour (used for presence), language, theme, passkeys, sessions (sign out others).

### 4.3 Organisation, workspaces, teams and roles
- **Instance roles:** Owner (one or more; billing-free, can do everything and cannot be locked out), Admin (people, teams,
  settings except deleting the organisation), Member (can create workspaces if allowed), Guest (only what is shared with them;
  cannot see the member directory).
- **Workspaces** (like teamspaces): name, icon, colour, description; open (everyone in the organisation can join) or private
  (invite only). Workspace roles: Admin, Editor, Commenter, Viewer. Default workspace "General".
- **Teams:** named groups (Design, Engineering) used as share targets and workspace members; maintained by admins or mapped from
  OIDC groups.
- **My canvases:** a private space per person.

### 4.4 Folders, canvases and the home
- Folders nest (depth ≤ 8); canvases live in a workspace or folder; move, duplicate, rename, star (favourite), icon and colour.
- **Home** (prototype 3): sidebar with search, Home, Recent, Favourites, Shared with me, the workspaces and their folder tree,
  Templates, Trash, settings. Main area: "Continue where you left off", then the current location as a **grid** (thumbnail, title,
  who edited, when, presence dots when someone is in it) or a **list** (sortable: name, owner, edited, size).
- **New canvas:** blank or from a template (the engine's built-ins plus the organisation's own templates, served through the
  `templates` callback; any canvas can be "Saved as template" by an admin).
- Thumbnails: the engine's render endpoint at save (WS-12 checks whether a PNG preview needs a contract addition).

### 4.5 A canvas inside the Workspace
- Workspace chrome around the engine editor (prototype 4): breadcrumb (workspace › folder › canvas), star, presence avatars
  (from the engine's postMessage presence), Share, version history, more menu (move, duplicate, export, delete, copy link).
- The editor runs in an iframe launched with a JWT from the Workspace (docs/05 §3, §4 option A), one origin.
- Comments and @mentions: `members` callback lists everyone with access; the `mentions` callback creates an in-app notification
  (and an e-mail with SMTP).

### 4.6 Sharing and links
- Share dialog (prototype 5): add people, teams or e-mails (e-mail of someone without an account creates an invite);
  role per entry: Full access, Can edit, Can comment, Can view; inherited access shown with its source ("from Product workspace")
  and editable only there; General access: Only people added · Everyone in *organisation* · Anyone with the link (view or
  comment, optional expiry, admin can disable) · copy link.
- Mapping to the engine: Full access and Can edit → `edit`, Can comment → `comment`, Can view → `view`; "Full access" (share,
  move, delete) is enforced only by the Workspace.
- Effective access = highest of instance Owner/Admin, workspace role, folder shares, canvas shares, link. Revocation calls the
  engine's role API so open sessions drop at once (docs/05 §7).

### 4.7 Search
- One search box (⌘K) across canvases: title, text, database rows, board text, comments if enabled; filters (workspace, owner,
  edited, type); recent searches; results open at the block (`#block=`).
- Index from `search.json` in every save (ADR-065); SQLite FTS5 or MySQL FULLTEXT; filtered by access at query time; the
  Workspace implements `GET /search` so the editor's "Search all canvases" and MCP `canvas_search` work too.

### 4.8 Trash and version history
- Delete moves to Trash (canvases and folders, with what was inside). Kept 30 days (setting 1–365), restore to the original place
  (or Home if it is gone), delete forever (Full access). Admin sees the organisation's trash.
- Version history: the engine's history panel (docs/30) on the §5a callbacks. Kept: every save for 24 h, hourly for 7 days,
  daily for 90 days, named versions forever (settings). Restore makes a new version.

### 4.9 Admin and operations
- **Members** (prototype 8): list with role, teams, sign-in method, last active, status (active, invited, suspended); invite,
  change role, suspend, reset sign-in, transfer ownership of a leaver's private canvases. **Teams** tab.
- **Settings** (prototype 9): General (name, URL), Branding (logo, accent colour, sign-in page message), Sign-in (methods,
  open sign-up domains, passkeys, SSO providers with a test button), Storage (local or S3, usage by workspace, upload limits),
  E-mail (SMTP host, port, TLS, from, send test; off by default), Backups (schedule, target, retention, last result, "Back up
  now", restore instructions), Public links (on/off), AI (shows the engine's provider status; configured by the operator), About
  (version, update available, licence).
- **Backups:** `opencanvas-workspace backup` and the scheduler write one `.tar.zst` with a consistent SQLite snapshot (online
  backup API) or a `mysqldump`-equivalent export, the files, and the generated secrets (encrypted with a passphrase the admin
  sets; without it the secrets are left out and the admin is warned). `opencanvas-workspace restore <file>` into an empty `/data`.
- **Upgrades:** pull the new image; on start a pre-upgrade backup, then migrations; a downgrade onto a newer database refuses
  to start with a clear message. The image version equals the engine release.
- Health: `/healthz`, `/readyz`; Prometheus metrics behind a token like the engine's.

## 5. MVP and later

| Area | MVP (WS 0.1) | Later |
|---|---|---|
| Install | One image, one port, `/data` volume, generated secrets, setup code; compose file (MySQL/MariaDB, Redis, MinIO) | Helm chart; Postgres (if approved); multi-node Workspace half |
| Sign-in | Password, passkeys, invite links, admin reset link, OIDC (one provider) | Several OIDC providers, group mapping, TOTP, SAML, SCIM |
| Structure | Workspaces (open/private), folders, My canvases, favourites, recent, Shared with me | Nested workspace permissions per folder beyond sharing, archive |
| Roles | Instance and workspace roles, canvas and folder shares, teams | Custom roles, guest expiry, approval for external sharing |
| Links | Organisation links; public view links (if approved) | Public comment links, passwords on links, embed codes |
| Canvases | New, templates (built-in + org), move, duplicate, rename, export via engine | Bulk actions, import (v0.5 importers), offline (engine ADR-063 opt-in) |
| Search | Titles and text, filters, access-filtered, editor "Search all canvases" | Comments in search, saved searches, attachments' text |
| Trash and history | Trash 30 days; history with thinning | Per-workspace retention, legal hold |
| Admin | Members, teams, branding, sign-in, storage, SMTP, backups, about | Audit log UI, usage analytics, quotas |
| Notifications | In-app bell for mentions, invites, shares; e-mail with SMTP | Digests, per-person rules |

## 6. Acceptance criteria (MVP)

1. On a clean machine with Docker and a warm network, `docker run -p 8080:8080 ghcr.io/casualoffice/opencanvas-workspace`
   to a signed-in admin looking at Home in **under 2 minutes** (image pull excluded from the 2 minutes only if over 60 s; the image
   is ≤ 250 MB compressed). Measured in CI with a scripted browser.
2. Restarting the container with the same volume keeps everything; without a volume the log says loudly that data is ephemeral.
3. Two people invited by link, without SMTP, sign up (one with a passkey only), open the same canvas and see each other's
   cursors; a third person without access gets a 404, not a 403 that leaks the title.
4. Sharing with a team, revoking it while the editor is open: the session drops within 2 s (role API).
5. A save from the editor appears in search within 5 s; search never returns a canvas the searcher cannot open (property test
   over random ACLs).
6. Delete → Trash → Restore puts the canvas back with its history; purge after the retention removes the files from disk or S3.
7. Version history lists versions from the Workspace and restores one; thinning keeps named versions.
8. `opencanvas-workspace backup` then `restore` into a fresh volume gives the same canvases, users, shares and versions
   (byte-identical `.ocanvas`).
9. Upgrade from the previous image with data: migrations run, a pre-upgrade backup exists; a downgrade refuses to start.
10. Kill the container during an edit burst: on restart no acknowledged edit is lost (engine WAL + commit outbox, ADR-015).
11. Compose file: two engine replicas plus one Workspace, MySQL and MinIO; the same acceptance run passes.
12. UI: matches the approved prototype; light and dark; usable at 320 px, 200 % zoom and 24 px text; keyboard and screen
    reader paths for setup, sign-in, share and search; no emoji; Lucide icons.
13. Security audit of the Workspace (auth, sessions, CSRF, uploads, links, SSRF in OIDC discovery and S3 settings) with no open
    high findings; the shared host conformance suite passes against both the Workspace and the sample host.

## 7. Work breakdown

Sizes: S ≤ 2 days, M ≤ 1 week, L ≤ 3 weeks. UI rows wait for the prototype approval (WS-01).

| ID | Item | Size | Depends on |
|---|---|---|---|
| WS-01 | Prototype, ADR-085 and this plan approved by the owner | S | — |
| WS-02 | Contract gap spike: list every docs/05 call the Workspace needs, confirm thumbnails, presence counts, title on save, link visitors (guest identity in the JWT), role API on revoke; contract additions written into docs/05 | M | WS-01 |
| WS-03 | `crates/oc-workspace` skeleton, config (`WS_*`), migrations (SQLite, MySQL/MariaDB), single-binary launcher with the engine as a library, loopback host registration, generated secrets | L | WS-02 |
| WS-04 | Shared host conformance suite (from the sample host's checks), run against both hosts in CI | M | WS-03 |
| WS-05 | Accounts: passwords (Argon2id), sessions, CSRF, rate limits, lockout, reset links, CLI admin commands | M | WS-03 |
| WS-06 | Passkeys (WebAuthn registration, sign-in, conditional UI) | M | WS-05 |
| WS-07 | OIDC SSO (one provider, domains, JIT, SSO-only with break-glass Owner) | M | WS-05 |
| WS-08 | Invites (organisation, workspace, canvas), links without SMTP, optional SMTP sending | M | WS-05 |
| WS-09 | First-run setup with setup code, loopback exception, checklist | S | WS-05 |
| WS-10 | Model: organisation, workspaces, teams, folders, canvases, roles, effective-access resolver (property-tested) | L | WS-03 |
| WS-11 | Host callbacks: load, save (with `If-Match`), copies, assets, members, access, mentions, templates, create file; storage on disk and S3 | L | WS-10 |
| WS-12 | Thumbnails and presence on cards (per WS-02 result) | M | WS-11 |
| WS-13 | Sharing and links (people, teams, organisation link, public view link), revocation through the role API | M | WS-10, WS-11 |
| WS-14 | Search index from `search.json` (FTS5, FULLTEXT), access filter, `GET /search` callback | M | WS-11 |
| WS-15 | Trash with retention job; version history callbacks with thinning | M | WS-11 |
| WS-16 | Web app shell: sign-in, sign-up, setup, Home (grid, list, tree, favourites, recent), templates dialog | L | WS-01, WS-05, WS-10 |
| WS-17 | Canvas page chrome around the editor (breadcrumb, presence, share, history, more menu); phone layout | M | WS-16 |
| WS-18 | Share dialog, search page and ⌘K, trash page, notifications bell | M | WS-13, WS-14, WS-15 |
| WS-19 | Admin: members, teams, settings (branding, sign-in, SSO, storage, SMTP, backups, public links, about) | L | WS-16 |
| WS-20 | Backups and restore (CLI and schedule, encrypted secrets), pre-upgrade backup, downgrade refusal | M | WS-11 |
| WS-21 | Image (`deploy/workspace/Dockerfile`), compose file (MySQL, Redis, MinIO, nginx), docs/13 section, release pipeline to GHCR | M | WS-03 |
| WS-22 | Acceptance run (§6) in CI: 2-minute first run, restart, crash, backup/restore, upgrade, compose | M | WS-21 |
| WS-23 | Security audit of the Workspace surfaces and fixes | M | WS-18, WS-19 |
| WS-24 | Docs and site: quick start, operator guide, admin guide, release notes | S | WS-22 |

Rough total: 5 L + 16 M + 3 S ≈ 28–34 engineer-weeks; with two people about 4 months. A thinner first cut (no OIDC, no S3,
no public links, no teams) is ≈ 20 weeks.

## 8. Risks

| Risk | Mitigation |
|---|---|
| We own accounts, passwords and public links: a new attack surface | Proven crates (argon2, webauthn-rs, openidconnect), no custom crypto; audit row WS-23; public links off by default if the owner prefers |
| Contract gaps tempt a private shortcut, eroding ADR-001 | Rule in ADR-085 §1; conformance suite against both hosts; review checks for engine imports in `oc-workspace` outside the launcher |
| Route clashes between the Workspace and the engine on one port | Workspace confined to `/`, `/app/*`, `/api/ws/*`, `/auth/*`; a test fails on any overlap with the engine router |
| One process: an engine panic takes the Workspace down | Engine rooms already isolate tasks; compose splits roles for production; restart policy in the docs |
| Losing `/data/secrets` makes the engine's WAL unreadable and sessions invalid | Secrets included in encrypted backups; warning in setup and Backups settings when no passphrase is set |
| Scope creep into a full Notion/Confluence clone | The MVP column in §5 is the line; everything else waits for real users |
| SQLite under many writers | WAL mode, one writer task, measured at 200 active editors on one node before promising more; MySQL in compose for larger teams |
| Second UI to keep at the premium bar | Same tokens and components as the editor (`@opencanvas/ui`), same review process |

## 9. Questions for the owner

1. **PostgreSQL**: the Workspace could support it, but the engine does not (ADR-004). Leave it out of the MVP (recommended), add
   it to the Workspace only, or add it to both later?
2. **Public links** ("anyone with the link") in the MVP, view only, admin-switchable and off by default? Recommended: yes, off by
   default.
3. **Setup code**: require the one-time code from the log for every first-run (safest) or skip it from loopback (recommended,
   so a laptop trial needs no log reading)?
4. **One organisation per deployment** (recommended) or a multi-tenant mode for hosting many organisations?
5. **Retention defaults**: Trash 30 days; history all saves 24 h, hourly 7 days, daily 90 days, named forever. Accept?
6. **Image and binary names**: `ghcr.io/casualoffice/opencanvas-workspace`, binary `opencanvas-workspace`. Accept?
7. **Release cadence**: ship the Workspace with the engine's version numbers (recommended) or its own?
8. **Sample content** at setup (a "Welcome" workspace with three template canvases)? Recommended: offered, on by default.
9. **Schedule**: a parallel track to v0.5 with its own people, or after v0.5?

## 10. Prototype

[docs/prototypes/workspace/workspace.html](prototypes/workspace/workspace.html): first-run setup, sign in and sign-up from an
invite (passkey, SSO), Home (sidebar, grid and list, new from template), a canvas in the Workspace chrome with version history,
the share dialog, search, trash, members and teams, settings (branding, sign-in and SSO, storage, e-mail, backups), phone
layouts for Home and a canvas, and the empty states. Light and dark, rem units, works at 320 px, Lucide-style icons, no emoji.

## 11. Contract check (WS-02, 2026-11-28)

Every call the Workspace makes or answers, checked against docs/05 and run end to end in
`crates/oc-workspace/tests/engine.rs` (the Workspace and the engine in one process, real signatures):

| Need | Contract | Result |
|---|---|---|
| Open a canvas | JWT launch (§3), option A form post (§4) | Works; `file.type` (§2f) is sent for typed files |
| Load, save with `If-Match`, copies, assets | §5 callbacks | Works; saves are idempotent by key; a stale `If-Match` answers 409 |
| Version history | §5 list and get version, §5a | Works; thinning per docs/40 §4.8 |
| Members for @mentions | §5 `GET /files/{id}/members` and the token's `members` | Works; never e-mail |
| Live blocks, MCP access | §5 `POST /access`, `POST /files` (now with `type`) | Works |
| Search and "Search all canvases" | `search.json` in each save, §5 `GET /search` | Works (FTS5); the editor's search reaches our callback |
| Revocation | §7 role API, `members/invalidate`, `DELETE …/session` | Works; every (canvas, person) whose role changed is sent |
| Link visitors | Launch with a visitor id (`v_…`) and the link's role | Works without a contract change |
| Bot edits, forced commits | §7 patch and commit | Works |
| Images in exports | `asset_origins` (§7 convert) | The Workspace registers its public address as an asset origin |

**Gaps found, and what we did.**

1. *Hosts are read at start.* The engine reads `[[host]]` entries (and so `allowed_origins`) once. The Workspace's public
   address can be chosen at setup, after the engine started, so a new address applies after a restart (the launcher builds
   the host entry from the stored address on every start; `WS_PUBLIC_URL` and `WS_EXTRA_ORIGINS` avoid the restart). A
   contract addition for every host, "reload hosts" (SIGHUP or an operator endpoint), is proposed for WS-12.
2. *Presence on cards* (who is in a canvas now) has no host-facing call: hosts only see presence inside their own page
   (`Presence_Changed`). Proposed addition for every host, built with WS-12: `GET /v1/files/presence?ids=…` with the host's
   API key, answering per file the count and the people (id, name, colour), never more than the host could see in the editor.
3. *Thumbnails* use the engine's render endpoint (RND-01) after a save; whether a PNG preview call is needed for hosts is
   decided in WS-12.

None of these is a private shortcut: the Workspace uses only what any host can use.
