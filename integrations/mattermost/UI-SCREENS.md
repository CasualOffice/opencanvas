<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# OpenCanvas for Mattermost: screens to prototype

**For the lead to prototype (ADR-011).** Nothing here is designed or styled yet; the webapp
renders plain placeholders. This lists every screen and state, with its content and behaviour.
Constraints: Lucide icons only, no emoji, autosave only (no Save button), Mattermost light and
dark themes (follow the user's theme), and keyboard access for everything.

**Seen in the real-host run (2026-11-24, Mattermost 12.1.0):** the placeholder card and panel
work end to end, so these screens only need design, not new behaviour. Two things the run
showed: on a new canvas the panel shows OpenCanvas's own template picker (already approved UI)
inside the narrow panel, and Mattermost's first-run "Welcome" checklist overlaps the bottom-left
of the post list, where the card's Open button sits on narrow windows.

Mattermost places: channel header buttons, post list (custom post type), right-hand sidebar
(RHS, about 400 px wide, can be expanded), and the Desktop app (same webapp). Mobile apps do not
run plugin UI.

## S1. Post card (`custom_opencanvas`)

- **Content:** Lucide icon for the kind (`file-text` canvas, `notebook-pen` meeting notes),
  title, "Canvas" or "Meeting notes", who created it and when (Mattermost already shows the
  poster), last edited (relative time), and optionally who is in it now.
- **Actions:** **Open** (opens S2 in the RHS), **Open expanded** (S2 wide), overflow menu:
  Copy link, Rename (creator and editors), Download `.ocanvas` (later).
- **States:** normal; **no access** (guest without access, or the user left the channel): title
  only, "You don't have access to this canvas", no Open; **deleted/unknown**: "This canvas is no
  longer available"; **loading** of live info.
- **Behaviour:** clicking the card body opens S2. A thread reply under the card behaves like any
  post. Narrow widths: actions collapse into the overflow menu.

## S2. Canvas panel (RHS) and expanded view

- **Content:** header with the canvas title, presence (avatars or initials of people in it),
  a close button and an expand/collapse toggle (`maximize-2` / `minimize-2`), "Open in new
  window" (Desktop opens the system browser; the decision on whether to offer this is open);
  body = the OpenCanvas iframe (editor chrome comes from OpenCanvas, already approved).
- **States:**
  - **Opening** (token request + iframe load, typically < 1 s): skeleton, no spinner flash under
    300 ms.
  - **Open:** the iframe; autosave status lives inside OpenCanvas.
  - **No access** (404 from launch): "You don't have access to this canvas. Ask someone in the
    channel to add you."
  - **Not configured** (503): for admins "OpenCanvas isn't set up. Open plugin settings"; for
    others "Canvases aren't available right now."
  - **OpenCanvas unreachable** (iframe fails / `Error` postMessage): "Can't reach the canvas
    server" + Retry.
  - **Session ended / access removed** (OpenCanvas closes the session after a role change):
    message from OpenCanvas, panel offers Reopen.
  - **Switching canvases** while one is open: replace the iframe; no confirmation (autosave).
- **Behaviour:** switching channels keeps the panel open on its canvas until closed. Expanded
  view uses Mattermost's RHS expand. Theme follows Mattermost (`Action_Theme`).

## S3. Create dialog

- **Entry points:** channel header button (`square-pen`, "Create canvas"), `/canvas new`
  (no dialog: creates directly with the given or default title), and an empty-state button in S4.
- **Content:** title field (optional, placeholder "Untitled canvas"), kind: **Blank canvas** or
  **Meeting notes** (Agenda, Notes, Decisions, Action items), note "Everyone in
  ~channel-name can open and edit it. It's saved in Mattermost." Buttons: Create, Cancel.
- **States:** idle; creating (button busy); **error** "Couldn't create the canvas. Try again.";
  **not allowed** (guest without edit): the entry point is hidden, and the slash command answers
  "You can't create a canvas in this channel."
- **Behaviour:** Enter submits; on success the card is posted and S2 opens on the new canvas.

## S4. Channel canvases list (RHS view)

- **Content:** list of the channel's canvases (title, kind icon, last edited), newest first;
  "Create canvas" button.
- **States:** **empty** ("No canvases in this channel yet" + Create); loading; error with Retry;
  no access (guest without access: hidden).
- **Behaviour:** click opens S2 on that canvas. Entry: a second header action or a tab in S2.

## S5. Slash-command feedback (ephemeral posts)

- `/canvas help`: the command list. Errors: not configured, not allowed, create failed.
  Plain text, no UI to design beyond wording.

## S6. Admin settings (System Console)

- Generated from `plugin.json`; only help-text wording to review. A "Test connection" button
  (custom setting) is a candidate for later.

## S7. Desktop app specifics

- Clipboard write and fullscreen from the iframe may be refused by the Desktop app unless the
  OpenCanvas origin is trusted; S2 needs a fallback message for "Copy" failures ("Copy isn't
  allowed here; use the browser").

## S8. Mobile

- No plugin UI. The card shows its text fallback. Proposed later: a link in the message that
  opens a plugin page in the system browser which launches the canvas full screen (phone
  layout of OpenCanvas, already approved). Needs a decision before design.
