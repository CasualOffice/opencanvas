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
  "detail": "Design · Bengaluru",      // optional second line, host-chosen (team, title, handle)
  "avatar": "https://…/a.png",         // optional
  "color": "#7a45f0"                   // optional; otherwise derived from id
}
```

- The token's `user` claim accepts this shape, so the current user gets their `detail` for free.
- The `detail` is what the host considers the most recognisable distinction, such as
  team, job title or handle. OpenCanvas never uses or shows e-mail.

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

## Implementation notes (revision 2, 2026-11-22)

The notes for the first version (relations, resolve caching, per-recipient presence) are
superseded; see ADR-026 for what was removed.

1. **Merge.** `GET /v1/members?ticket=&q=` merges by id: members callback > token `members` > the
   saved `people` map. The saved map decides membership only when the host gave neither (callback
   absent or 404/405/410/501/failed, and no token `members`); otherwise it only fills a missing
   `detail`/`avatar`. The viewer is always a member.
2. **Cache.** Callback answers are cached 60 s per (room, `q`), shared by every viewer of the room.
3. **Revocation is authoritative.** `POST /v1/files/:id/role` with `"role":"none"` drops the
   room's cached answers, leaves the person out of the list even where an older token or the saved
   map still names them (until access is granted again or they open with a new token), closes
   their sockets (1008) and sends `{"t":"members"}` to everyone else, whose editors refetch the
   list without a reload. `POST /v1/files/:id/members/invalidate` (host api key) drops the cache
   and sends the same control. `DELETE /v1/files/:id/session` drops the cache.
   **Cluster mode:** the cache and the revoke set are per node, so every revoke, restore and
   invalidate is also published on the Redis pub/sub channel `oc:members` (HMAC-signed with
   `OC_CLUSTER_SECRET`, ±30 s clock skew, own messages ignored) and applied by every other node
   as it arrives; the role API publishes before it tells the room, so editors that refetch on
   the `members` control see the new list on any node. The sockets close through the room's
   owner, which holds every connection including relayed ones. Pub/sub is fire-and-forget: a
   node whose subscription drops clears its whole members cache when it resubscribes; a
   revoke published while a node was unsubscribed is not replayed there (its cached answer
   still expires within 60 s, and the host's own list should already leave the person out).
   Test: `tests/cluster.rs` `revoke_on_one_node_reaches_every_node` (in-memory bus) and
   `…_over_redis` (real Redis when `OC_TEST_REDIS_URL` is set): node B drops the person
   within 1 s of a revoke on node A and B's relayed socket closes with 1008.
4. **Presence** is stamped from each sender's grant (`id, name, color, avatar, detail?`) and is
   the same for every recipient.
5. **Chips.** A mention whose id is a member shows the member's current name. Otherwise the
   stored label with "No longer has access" (struck through, `aria-label` says so). Exports use
   the same names; the `.ocanvas` download keeps the stored labels.
6. **No e-mail.** The server ignores any `email` in tokens, callback answers and old `people`
   entries, and strips it from exports.
