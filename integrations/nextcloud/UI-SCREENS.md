<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Nextcloud app: screens and states to prototype (NC-01)

Nothing here is designed. The code has **unstyled placeholders only** (ADR-011): the
`templates/*.php` pages and `src/*.js` (not built). Each screen below needs an Artifact
prototype and owner approval before UI code. Everything should follow the Nextcloud look
(`@nextcloud/vue`, light and dark, phone width), use Lucide icons where ours, and use no emoji.

| # | Screen | States to cover | Placeholder in code |
|---|---|---|---|
| S1 | **Files "+ New" menu entries** | "New canvas" (server TemplateFileCreator), "New database", "New whiteboard": labels, icons, order next to Office/Whiteboard entries; the name dialog (default name, clash, invalid name, no create permission, read-only folder) | `RegisterTemplateCreator` label "New canvas", `icon-filetype-document`; `src/files.js` uses `window.prompt` |
| S2 | **`.ocanvas` file icon** | List and grid sizes, light/dark, a preview thumbnail later (preview provider not built) | Core `x-office-document` icon via the mimetype alias |
| S3 | **Template picker** | The Nextcloud picker for user templates in the Templates folder (preview images for `.ocanvas`), and the empty case | Stock Nextcloud picker |
| S4 | **Open view (Viewer modal)** | Loading, loaded, header (name, close, sidebar toggle), read-only badge, "no download" state (export hidden), file deleted or access removed mid-session, OpenCanvas unreachable, not configured (admin link vs. user message), token expired (relaunch), conflict copy created (link to the copy) | `src/viewer.js` iframe + "Loading" / error code text |
| S5 | **Open view (full page)** | Same as S4 plus the back-to-Files navigation and the browser tab title | `templates/editor.php` bare iframe |
| S6 | **Files action** | "Open in OpenCanvas" default action, and the action menu entry when Viewer is the default | `src/files.js` placeholder label and empty SVG |
| S7 | **Public link (guest)** | Name prompt before opening, password-protected link (Nextcloud's own password page first), view-only link, edit link, hide-download link, links disabled by admin | API exists (`api/v1/share/.../token`); no page |
| S8 | **Sharing / permissions** | What "Can edit" / "View only" mean for a canvas; the optional "Can comment" (share attribute `opencanvas`/`comment`, admin switch); a live downgrade while open (switches to read-only) | None (sharing sidebar is Nextcloud's) |
| S9 | **Talk: canvas card in chat** | File message for an `.ocanvas` shared into a conversation (icon, name, "Open" action); a reference/link preview card for `/apps/opencanvas/open/{id}` links; no-access state | Stock Talk file message |
| S10 | **Talk: open beside the call** | Canvas with the file's conversation in the sidebar (chat tab and call); from a conversation, "Open canvas beside the call" message action; split layout on desktop; phone layout (one at a time); a guest in a public conversation | None |
| S11 | **Talk: new canvas in a conversation** | Create from the conversation's "+" menu, where it is saved, who gets access | None |
| S12 | **Admin settings** | Empty (not configured), URLs entered, the WOPI base to copy into OpenCanvas's `wopi_allowlist`, connection check (OK, discovery unreachable, no `.ocanvas` action, no proof key, allow-list mismatch seen as 403 WOPISRC_NOT_ALLOWED), public links switch, comment role switch, rotate token secret (confirm: ends open sessions), saving and validation errors | `templates/admin.php` read-only values |
| S13 | **Errors (shared)** | Not configured; OpenCanvas down; proof rejected (admin hint: check discovery or keys); file too large (over 100 MB); file locked (423); no permission; file not found | JSON error codes only |
| S14 | **App store listing** | Screenshots and the positioning text (DESIGN.md §10) | Text only |
