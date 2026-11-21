# 21 — Users and identity for integrators

**Status:** revision 2, 2026-11-22 (members model). Previously: Accepted 2026-11-22 and implemented (ADR-026, tracker USR-01). It replaces the
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
  "avatar": "https://…/a.png",         // optional
  "color": "#7a45f0"                   // optional; otherwise derived from id
}
```

- The token's `user` claim accepts this shape, so the current user gets their `detail` for free.
- The `detail` is what the host considers the most recognisable distinction, such as
  team, job title or handle. OpenCanvas never guesses it from email unless the host allows it.

## Revision 2 (2026-11-22): the people list is the canvas's members

The first version modelled each viewer's own network (contacts, external, hidden, per-viewer
nicknames). The owner simplified it, and this replaces that model:

- **Who appears in the mention list:** the people who have access to this canvas. Nobody
  else. Anyone with access can mention anyone else with access.
- **Everyone with access sees real names** and the second line that tells same-name people
  apart. There is no "Someone", no "Unknown", no hidden or external state, and no per-viewer
  nickname. The list is the same for every viewer of the canvas.
- **Email is never shown**, in any list, chip, card, cursor, export or postMessage. OpenCanvas
  doesn't even keep it: there's no `perms.showEmail`.

### Where the member list comes from

The host answers one question: *who has access to this canvas?* Two ways, use either or both:

| Source | When to use it | Host work |
|---|---|---|
| `members: [user…]` in the launch token (≤ 500) | Small or medium canvases, such as a channel or a project | Put the access list in the token you already sign |
| `GET {callback_base}/files/{fileId}/members?q=&limit=` → `[user…]` | Large audiences, such as a whole org | One endpoint returning people with access to that file, filtered by `q` |

If neither is provided, the list is everyone who has opened the canvas (the `people` map
saved in the file). Since opening it requires access, that list is always correct, just
incomplete. Members are merged by `id`: callback beats token beats the saved `people` map.

### Keeping names current

A mention stores the person's `id` and a label snapshot. On load, OpenCanvas shows the
member list's current name for that id. If the person is no longer a member, it shows the
snapshot with "No longer has access". The optional `POST /users/resolve` callback is
retired: the member list answers the same question.

### Same name

Unchanged from above: every list row, avatar tooltip, cursor label and hover card shows
`name · detail` when the name is shared. Without `detail` it falls back to "Last here …" and
then to the last 4 characters of the id. Email is never a fallback. Initials get a subscript,
and colours come from the id.

## Contract changes (revision 2)

- Launch token: `user.detail`, optional `members[]` (≤ 500, people with access to this canvas).
  Removed: `user.email`, `participants[]`, `perms.showEmail`.
- Callbacks: optional `GET /files/{fileId}/members?q=&limit=`. Removed: `GET /users`,
  `POST /users/resolve`.
- Host config: removed `[host.directory] coviewers`.
- WOPI: `UserExtraInfo.detail` and `UserExtraInfo.avatar` feed the same fields. The member list
  falls back to the saved `people` map.
- File format: the `people` map (id, name, detail, avatar; never email) stays.
- postMessage: `Presence_Changed` users include `detail`, never email.

## Sample host

The files page's access-control table is the member list. The sample host puts it in the
token for small files and serves `/files/:id/members` for all of them. A second "Asha Rao" on
another team shows same-name handling.

## Acceptance (revision 2)

- The mention list shows exactly the canvas's members: someone without access never appears,
  and a member who has never opened the canvas does.
- Everyone with access sees real names, with no "Someone" or "Unknown".
- Two people with the same name are distinguishable in the mention list, avatars, cursors
  and hover cards.
- No email appears anywhere in the DOM, exports, postMessage or the `.ocanvas`.
- Removing someone's access marks their existing mentions "No longer has access" after reload.
- With no members source at all, the list is the people who have opened the canvas.

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
