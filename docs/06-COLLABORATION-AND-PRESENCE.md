# 06 — Collaboration, presence and cursors

**Status:** draft v0.1, 2026-11-21.

## 1. Merge semantics (what users see when they collide)

| Situation | Result |
|---|---|
| Two users type in the same paragraph | Both texts kept, interleaved by position (Yjs YATA). No lost characters. |
| Both bold overlapping ranges | Union of marks. One bolds, other unbolds same range → last writer per character. |
| One deletes a block while another types in it | Delete wins; the typing is lost **and the typer is notified** ("Block removed by Asha · Undo"). Their undo restores it. |
| Both move the same block | Last move wins (single final position, never duplicated). |
| Table: one adds a column, other adds a row | Both applied; new cells empty. |
| Board: two users drag the same shape | Last position wins per field; colour change by the other is kept. |
| Board: concurrent pen strokes | All strokes kept (append-only). |
| Task checkbox toggled by two users | Last writer wins. |
| Comment resolved while someone replies | Reply kept; thread re-opens with indicator. |

These are verified by the convergence fuzz harness (04 §9), and each row is a
named test case.

## 2. Presence model (awareness)

Each connection publishes a small state (≤ 2 KB, ≤ 20 Hz):
```json
{
  "user":   { "id": "u_123", "name": "Asha Rao", "color": "#7c3aed", "avatar": "…", "role": "edit" },
  "cursor": { "anchor": <RelativePosition>, "head": <RelativePosition> },
  "board":  { "id": "brd_1", "x": 412.5, "y": 80, "tool": "pen", "selection": ["s_9"] },
  "view":   { "blockId": "b_44" },          // what they are looking at, for "follow"
  "typing": true,
  "idle":   false
}
```
- `user` fields are **overwritten by the server** from the session grant —
  clients cannot spoof names/colours.
- Cursor positions are Yjs *relative positions*, so they stay correct while
  text around them changes.
- Colour: host-provided or derived from `hash(user.id)` into a 12-colour
  palette that passes 3:1 contrast in light and dark themes.

## 3. Cursor & selection rendering

- **Text:** caret = 2 px bar in user colour + name label (shown on move, fades
  after 2 s idle, shown on hover). Selection = 20 % tint of user colour.
  Labels collision-avoid (stack upward) when carets are on the same line.
- **Board:** pointer arrow + name tag in user colour, interpolated
  (60 fps lerp) between 20 Hz updates; selection outline in user colour;
  "laser" tool leaves a fading trail.
- **Off-screen collaborators:** avatar stack in the top bar; each avatar shows
  a ↑/↓ edge hint; clicking jumps to their position; long-press = **follow
  mode** (your viewport tracks theirs until you scroll).
- **Block-level presence:** a thin coloured bar in the left gutter of blocks
  someone is editing — cheap and readable on narrow embeds.
- **Typing indicator** in the avatar stack.
- Viewers are shown as presence (eye badge) but have no caret.

## 4. Undo/redo

- `Y.UndoManager` with `trackedOrigins = {localOrigin}` — undo only reverts
  *your* changes, never a collaborator's.
- Capture timeout 500 ms groups keystrokes into words.
- Undo stack is shared between text and boards so Ctrl+Z after drawing undoes
  the stroke.
- Undo stack resets on reload (it is not persisted).

## 5. Connectivity

| State | UI | Behaviour |
|---|---|---|
| Connected | none | — |
| Reconnecting (< 30 s) | subtle "Reconnecting…" pill | edits continue locally, buffered |
| Offline (> 30 s) | banner "Offline — changes will sync" | edits buffered (memory; IndexedDB if host enables) |
| Back online | "Synced" toast | Yjs sync step1/2 merges buffered changes |
| Role downgraded | banner "You now have view access" | editor switches to read-only, local unsynced edits shown as discarded diff |
| Token expiring | silent refresh via host; else banner | — |
| Session closed by host | modal "This canvas was closed by the app" | — |

Exponential backoff 0.5 s → 10 s with jitter. Server owner change in cluster
is invisible to users beyond a ≤ 5 s reconnect.

## 6. Save state indicator

`Saved · 2 min ago` → `Unsaved changes` → `Saving…` → `Saved` (or
`Save failed · retrying`). Click opens a small popover: last commit, authors,
"Save version…" (message input) if `perms.commitMessage`.

## 7. Comments (P2)

- Anchors: text range (relative positions start/end) or board shape id or
  whole block id.
- Stored in the `comments` Y.Map → travel inside the `.ocanvas` file.
- Commenters (role `comment`) can write only that subtree (enforced server-side).
- Mentions in comments trigger an `onMention` webhook to the host so the host
  can notify (we never send emails/notifications ourselves).
