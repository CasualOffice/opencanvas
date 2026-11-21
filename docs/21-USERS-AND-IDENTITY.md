# 21 — Users and identity for integrators

**Status:** design, proposed 2026-11-21. It replaces the "Resolve users" row in
[docs/05](05-INTEGRATION-GUIDE.md) §5 once accepted. ADR-025.

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
- Callbacks: `GET /users` becomes optional; new optional `POST /users/resolve`.
- WOPI: `UserExtraInfo.detail` and `UserExtraInfo.avatar` feed the same fields; tier 0 works unchanged.
- File format: an optional `people` map in `document.json` and the Y.Doc (`people` root, a map keyed by id).
- postMessage: `Presence_Changed` users include `detail`.

## Sample host

The sample host gets a second "Asha Rao" on a different team, so duplicate handling is
demonstrated and covered by the e2e suite.

## Acceptance

- With only launch tokens, mentions list everyone who has opened the file. A test
  covers this with the users callback turned off.
- Two people with the same name are distinguishable in the picker, avatars, cursors
  and hover cards. There's an e2e test with the duplicate sample user.
- Renaming a user in the host is reflected in existing mentions after reload when
  `resolve` is implemented, and the snapshot label is used when it isn't.
- No email is shown unless `perms.showEmail`.
