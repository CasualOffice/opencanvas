<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Matrix widget: screens to prototype

The bridge's widget page (`bridge/public/widget.html`) is functional and **unstyled** on
purpose: plain text in one `<p id="status" data-state="…">`. No visual design until a
prototype is published as an Artifact and approved (ADR-011, AGENTS.md rule 2). This is the
list for the lead to prototype. Each screen must work in Element's narrow right panel
(about 320–420 px), maximised, popped out, light and dark (Element passes
`$org.matrix.msc2873.client_theme`), and keyboard and screen reader (status is `aria-live`).

| # | State (`data-state`) | When | Current plain text | Needs |
|---|---|---|---|---|
| S0 | (Element's own) | Widget added by someone else, first open | Element's "added by … / shared data" consent; encrypted-room warning | Nothing to build; the prototype should show it in context so S1–S2 read as one flow |
| S1 | `loading` | Page loaded, handshake running | "Loading canvas..." | Quiet loading state, no layout jump into the canvas |
| S2 | `permission` | `get_openid` pending: Element shows its "allow this widget to verify your identity" dialog | "Waiting for permission to confirm your Matrix identity..." | Explain why (only to check you are in the room; no messages are read), point at Element's dialog, suggest "Remember" |
| S3 | `denied` | Identity refused (`blocked`) | "The canvas needs to confirm your identity. Reload and allow it to continue." | Recovery action (reload the widget) |
| S4a | `error` NOT_MEMBER | Not joined to the room | "Only members of this room can open the canvas." | |
| S4b | `error` SERVER_NOT_ALLOWED | Homeserver not on the allow-list or resolves to a private address | "Your homeserver is not allowed to open this canvas." | Who to contact (the operator), without naming internals |
| S4c | `error` BOT_NOT_IN_ROOM | Bot left or was never invited | "The canvas bot is not in this room. Ask a room admin to invite it." | Show the bot's user id for admins |
| S4d | `error` WIDGET_UNKNOWN | Widget removed while open, or forged URL | "This canvas widget is no longer in the room." | |
| S4e | `error` OPENID_INVALID / HOMESERVER_UNREACHABLE / RATE_LIMITED / network | Transient failures | Per-code sentence, "Reload to try again" | One retry action |
| S4f | `error` | Page opened outside a Matrix client | "Open this page as a widget in a Matrix room." | |
| S5 | `open` | Canvas loaded, `storage = "ephemeral"` | "Temporary canvas: export to keep a copy." (outer page, under the frame) | **Temporary-canvas notice**: the editor already shows "Not saved · temporary"; decide whether the widget adds a first-open notice and where (a chat room is long-lived, so this matters more than in a meeting) |
| S6 | (editor) | Canvas ended: everyone left and the idle grace passed, or the session was closed | OpenCanvas editor's closed message | Wording for Matrix ("This canvas ended when everyone left. Open the widget again to start a new one.") and whether the widget offers "Start a new canvas" |
| S7b | (editor) | Left, kicked or banned while the canvas is popped out: the bot revokes access | Editor's "Your access to this canvas changed" | Matrix wording ("You left the room, so this canvas is closed") |
| S7 | (editor) | View-only member (`MX_MEMBER_ROLE=view`, power below `state_default`) | Editor read-only state | A line saying who can edit (room moderators) |
| S8 | (Element) | Adding the widget | `/addwidget <url>` or the add-widget script | Optional: an "Add canvas" entry point is Element's UI, not ours; document only |

Found in the Element run (2026-11-24, screenshots in `evidence/`): the editor's temporary
banner reads "This canvas is not saved anywhere. It is deleted when the meeting ends" and its
closed screen "This canvas ended with the meeting": meeting wording inside a chat room (S5, S6).
When someone leaves the room, Element removes the widget itself, so the editor's "Your access to
this canvas changed" screen is only seen in a popped-out widget (S7b). Wording changes in the
editor are UI changes: they wait for the prototype.

Not in v1: persistent canvas states (saving, saved, conflict) for phase 2 storage.
