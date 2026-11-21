# 21 — Users and identity for integrators

**Status:** Accepted 2026-11-22 and implemented (ADR-026, tracker USR-01). It replaces the
"Resolve users" row in [docs/05](05-INTEGRATION-GUIDE.md) §5. The wire details are in
[docs/05](05-INTEGRATION-GUIDE.md) §3, §5 and §6 and [docs/15](15-BUILD-CONTRACT.md) §2-§6;
"Implementation notes" at the end records where the build settles or departs from this design.

## The problem

The host app owns its users, and OpenCanvas needs some of them in four places:

| Where | Today | What goes wrong |
|---|---|---|
| The person editing | from the launch token | Fine. |
| Presence (avatars, cursors) | from each viewer's token | Two people called "Asha Rao" look identical. |
| @mention picker | `GET /users?q=` callback the host must build | It's a whole search endpoint before mentions work at all. Results can't be told apart either. |
| Rendering an existing mention | the label saved in the document | It goes stale when someone is renamed or leaves. The id is kept, but nothing refreshes it. |

Every host has to build user search, think about ACL in it, and still ends up with
confusing duplicates. Integrations stall on this.

## Principles

1. **The id is the identity.** Names are display only. Everything is keyed by the
   host's stable `user.id`: presence, mentions, assignees, comments and colours.
2. **Zero required user endpoints.** Mentions work with nothing but launch tokens.
   Richer directories are optional upgrades.
3. **Every person has a second line.** Wherever a name appears in a list, OpenCanvas
   shows a disambiguator. Hosts supply it, and OpenCanvas falls back gracefully.
4. **Names refresh, ids don't.** A mention stores the id and a label snapshot. The
   snapshot is only a fallback for exports and for when the host can't be reached.

## The user object (everywhere)

```json
{
  "id": "u_123",                       // required, stable, opaque
  "name": "Asha Rao",                  // required, display name
  "detail": "Design · Bengaluru",      // optional second line, host-chosen (team, title, email, handle)
  "email": "asha@acme.example",        // optional; shown only if the host sets perms.showEmail
  "avatar": "https://…/a.png",         // optional
  "color": "#7a45f0"                   // optional; otherwise derived from id
}
```

- The token's `user` claim accepts this shape, so the current user gets their `detail` for free.
- The `detail` is what the host considers the most recognisable distinction, such as
  team, job title or handle. OpenCanvas never guesses it from email unless the host allows it.

## How OpenCanvas learns about people: four tiers

A host picks how far it goes. Each tier adds to the previous one.

| Tier | Host work | Mention picker shows |
|---|---|---|
| **0. Tokens only** | none beyond the launch token | Everyone who has opened this file, remembered per file in the transient room state while the room lives and saved in the `.ocanvas` as `people` (id, name, detail, avatar, last seen). Plus anyone already mentioned or assigned in the document. |
| **1. Participants in the token** | add `participants: [user…]` (up to 200) to the launch token, e.g. the channel members | Tier 0 plus everyone with access, even if they've never opened it. |
| **2. Search callback** | `GET /users?q=&fileId=&limit=` (existing, now optional) | Tier 1 plus live directory search for large orgs. |
| **3. Resolve callback** | `POST /users/resolve {ids:[…]}` → `[user…]` | Fresh names, details and avatars for every id in the document, batched and cached for 10 minutes per room. It also tells OpenCanvas who has left (`"deactivated": true`). |

The server merges all sources by `id`: host-resolved beats token beats document snapshot.

## Every viewer has their own network

Two people on the same canvas don't share one directory. Priya's contacts aren't Ravi's.
OpenCanvas therefore never builds a social graph or decides who knows whom. Everything
about *other people* is answered per viewer, by the host, with that viewer's credentials:

- **Search is per viewer.** `GET /users?q=` is always called with the *viewer's*
  `callbackToken`, so the host returns only the people that viewer may see. That means
  their contacts, their team, or whatever the host's own rules say. Two viewers typing
  "as" can get different lists. Results are cached per viewer, never per room.
- **Participants are per viewer.** The `participants` list in a launch token belongs to
  that token's user only. It is never merged into what other viewers see.
- **Resolve is per viewer.** `POST /users/resolve` is called with the viewer's token and
  may answer differently for each viewer. The host returns each person with a `relation`:

  | `relation` | Meaning for this viewer | How OpenCanvas shows them |
  |---|---|---|
  | `contact` | someone the viewer is connected to | full name, detail, avatar; can be mentioned |
  | `member` | in the same org or space, not a direct contact | full name and detail; can be mentioned if the host allows |
  | `external` | outside the viewer's network but on this canvas | the name the host chooses to show (e.g. "Asha R."), no detail or avatar unless given; marked "Not in your contacts" |
  | `hidden` | the viewer must not see who this is | "Someone" with a neutral avatar; their cursor shows "Someone" too |

  The host can also return a **viewer-specific name** (a contact nickname), and that
  viewer sees it everywhere: chips, cursors and avatars.
- **People on the same canvas.** The host decides whether people who have opened the same
  canvas may appear in each other's mention list. Host flag
  `directory.coviewers = "all" | "contacts" | "none"` (default `"contacts"`: a co-viewer is
  listed only if `resolve` says they're a `contact` or `member` for this viewer). Presence
  itself (who is here right now) follows the same relation rules, so a `hidden` person is
  shown as "Someone".
- **The document stores only ids.** A mention or assignee stores the id plus a
  neutral snapshot label that the *author* saw. Every viewer re-renders it through their
  own resolve. An `external` or `hidden` person never leaks their real name to a viewer
  through the snapshot: when `resolve` exists, the snapshot is ignored for display.
  Exports run under the exporting viewer's view of people.
- **Without any callbacks (tier 0)**, the server can't tell contacts apart, so the host's
  `directory.coviewers` setting decides. `"all"` suits teams where everyone on a canvas
  may see each other, and `"none"` suits networks where they mustn't.

## Telling people apart

When two or more known people share a display name (case- and accent-insensitive):

- **Picker:** every row shows the avatar, the name and a muted second line with `detail`.
  If there's no `detail`, it shows the email when allowed, otherwise "Last here 3 days ago",
  otherwise the last 4 characters of the id ("ID …x7Q2"). Rows with the same name are grouped together.
- **Avatars and cursor labels:** the tooltip and cursor label become "Asha Rao · Design".
  Initials get a suffix when they collide ("AR", "AR₂") and colours differ, since they're
  derived from the id, not the name.
- **Mention chips:** the chip shows the name, and the hover card shows name, detail and avatar.
  A chip whose id resolves to a deactivated user shows the name struck through as "former member".
- **Assignee cells** in databases use the same hover card.

## Privacy and ACL

- OpenCanvas never lists people the host didn't give it. Tier 0 and 1 data come only from tokens.
- The `people` map in the `.ocanvas` keeps only id, name, detail and avatar URL, never email
  unless `perms.showEmail`. The host can strip it on save, since it owns the file.
- Mentioning someone without access to the file shows a clear warning in the picker
  ("Ravi can't open this canvas") when the host sets `access` on search results. The host
  decides whether to share.

## Contract changes

- Launch token: `user.detail`, `user.email`, optional `participants[]`, `perms.showEmail`.
- Callbacks: `GET /users` becomes optional and is always called per viewer; new optional `POST /users/resolve` (per viewer, returns `relation` and an optional viewer-specific name).
- Host config: `directory.coviewers = "all" | "contacts" | "none"`.
- WOPI: `UserExtraInfo.detail` and `UserExtraInfo.avatar` feed the same fields; tier 0 works unchanged.
- File format: an optional `people` map in `document.json` and the Y.Doc (`people` root, a map keyed by id).
- postMessage: `Presence_Changed` users include `detail`.

## Sample host

The sample host gets a second "Asha Rao" on a different team, so duplicate handling is
demonstrated and covered by the e2e suite.

As built (`examples/sample-host/server.mjs`): everyone has a `detail` ("Design · Bengaluru",
"Finance · Pune", …) and an e-mail; each file has a **Directory** control on the files page
(tier 0-3, "Contacts graph", "Show e-mail"; default tier 3, graph off). With the contacts graph
on, Priya and Sam are each other's `external` ("Priya S.", "Sam O."), Ravi and Sam are `hidden`
from each other, and Priya calls Ravi "Ravi (eng lead)". Search returns everyone the viewer may
see with `access` (false when they have no role on the file); resolve answers with `relation`,
the viewer's nickname and `deactivated`. Test hooks (`SAMPLE_HOST_TEST=1`):
`POST /__test/files/:id/directory` and `POST /__test/users/:id {name?, deactivated?}`.

## Acceptance

- With only launch tokens, mentions list everyone who has opened the file. A test
  covers this with the users callback turned off.
- Two people with the same name are distinguishable in the picker, avatars, cursors
  and hover cards. There's an e2e test with the duplicate sample user.
- Renaming a user in the host is reflected in existing mentions after reload when
  `resolve` is implemented, and the snapshot label is used when it isn't.
- No email is shown unless `perms.showEmail`.
- Per-viewer networks: with a sample host where Priya and Sam are not contacts, Sam's
  mention search never returns Priya, Priya's cursor shows Sam the host's `external` label,
  and a `hidden` user appears as "Someone" to that viewer. Each case gets its own e2e test.

All five are covered: `e2e/specs/p-people.spec.ts` (tier 0 with no user callbacks, duplicates in
picker/avatars/cursors/hover cards, rename via resolve and snapshot without it, Sam never finds
Priya, external label, hidden as "Someone" with no real name in Sam's DOM), and
`crates/oc-server/tests/people.rs` (per-viewer caches, awareness rewrite with no leak, e-mail
only with `perms.showEmail`, resolve > token > snapshot, tier 0 with no callbacks). Each was seen
failing against a mutated build.

## Implementation notes (2026-11-22)

Where the build settles details this design left open, or departs from it:

1. **`coviewers = "contacts"` without a resolve callback behaves like `"all"`.** Only `resolve`
   can say who is a contact. With tiers 0-2 the server can't tell, so co-viewers are listed and
   shown by name; a host whose people must not see each other sets `"none"`. This is what makes
   tier 0 work with the default setting.
2. **Ids a resolve answer leaves out fall back** to tokens and then the snapshot (the merge
   order). To hide someone the host answers `relation: "hidden"`; an omitted id is never treated
   as hidden. Presence of an omitted co-viewer follows `coviewers` (`all` shows them, otherwise
   "Someone").
3. **Resolve cache.** 10 minutes per (room, viewer), dropped when that viewer opens the file
   again (`GET /v1/sessions`), so a rename shows on reload. A 404/405/410/501 means "not
   implemented" and is remembered for 10 minutes; a failed call is retried after 30 s and the
   fallback rules apply meanwhile. Search answers are cached 30 s per (room, viewer, query).
4. **Presence.** The server stamps `user` from the grant (now with `detail`), then rewrites it per
   recipient: contacts and members get the viewer's name for them, `external` people only what
   the host returned, `hidden` people `{"id":"anon_<12 hex>","name":"Someone"}` with a neutral
   colour (the id is per viewer, so it can't be correlated). A person's state is not sent to a
   viewer until that viewer's resolve answer is in (one batched call per viewer when someone
   new arrives).
5. **`people` root.** Written by the server when someone joins (id, name, detail, avatar,
   `lastSeen`; e-mail only when their own token has `perms.showEmail`). It never makes the room
   dirty on its own, so it is saved with the next commit; `lastSeen` is refreshed at most hourly;
   nothing is written when `coviewers = "none"`.
6. **The Y.Doc is shared.** Everyone in a room receives the same document, so the `people` map
   and mention labels are data in every client. The editor never renders a snapshot for an id
   the viewer's resolve answered, and shows a placeholder ("…") while that answer is pending.
   Hosts with strict isolation use `coviewers = "none"` and `hidden`.
7. **Comment mentions** record the inserted label per id (`labels: {id: label}` on the message,
   docs/15 §4), so each viewer sees their own name for the person in the text, and two people
   with the same name stay apart.
8. **Exports.** Markdown, HTML, JSON, DOCX and PDF render mention labels and database person
   cells under the exporting viewer's view (resolve, then their own token, then the snapshot;
   hidden = "Someone"); person cells become names. The `.ocanvas` download is the file itself and
   keeps the stored labels. E-mails are dropped from the exported `people` map unless the viewer
   has `perms.showEmail`.
9. **Wire shapes.** `POST /users/resolve` gets `{"ids":[…],"fileId":…}` and may answer `[user…]`
   or `{"users":[…]}` (same for `GET /users`); `access` and `deactivated` pass through. The SPA
   asks `POST /v1/users/resolve?ticket=` and gets `{"resolve": bool, "users": [...]}`. The session
   gains `participants`, `directory {coviewers, callbacks}`, `user.detail`/`user.email` and
   `perms.showEmail` (e-mails stripped everywhere unless set).
10. **Hover cards** open on hover and on keyboard focus (read-only chips, assignee cells and
    comment authors are focusable; while editing, the caret right after a chip opens it), stay
    while hovered and close on Escape. Top-bar avatars keep their tooltip ("Asha Rao · Design ·
    Bengaluru"), with no card. Deactivated people are struck through with "Former member" and
    are not offered in the picker.
