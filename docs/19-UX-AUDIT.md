# 19 — Editor UX audit (UX-01)

**Date:** 2026-11-21. **Scope:** `web/packages/editor` (database and board blocks belong to
their own session). **Bar:** premium, production-grade editing; WCAG 2.2 AA.

## Method

- Built the editor and drove it with Playwright (Chromium; WebKit for the phone) in two ways:
  `#demo` (vite preview) and the live stack: `oc-server` on :8580 (`OC_DEV=1`, temp SQLite and
  hosts file) plus `examples/sample-host` on :4580, with two people (Priya edit, Sam edit →
  view) in separate browser contexts.
- Viewports: desktop 1440×900, side panel 380×800, phone 390×844; light and dark.
- Flows walked: first open and template gallery, typing and every block, slash menu, markdown
  shortcuts, selection toolbar, block menu and reorder, undo/redo, links and paste, images and
  files, embeds, code, tables, toggles, columns, mentions, comments (create, reply, resolve,
  anchor highlight), presence and follow, autosave status, offline and reconnect, role change,
  conflict, exports, keyboard-only use, screen reader names, focus order, empty and error states.
- axe-core (WCAG 2.0/2.1/2.2 A + AA) on every viewport and theme; the approved prototype
  (`docs/prototypes/ui-02-approved.html`) screenshotted side by side.

Screenshots are in `docs/ux-audit/` (`before-*` from the audit, `after-*` from the fixed build).

## Summary

| Severity | Found | Fixed | Open |
|---|---|---|---|
| High (broken flow, data or a11y blocker) | 10 | 10 | 0 |
| Medium (rough edge, missing PRD behaviour) | 25 | 25 | 0 |
| Low (polish) | 11 | 10 | 1 |
| **Total** | **46** | **45** | **1** |

(Updated by UX-02, 2026-11-21: #39–#45 closed; #43's overlap was the editor's block handle on
wide blocks, see "UX-02" below. #46 stays a product decision.)

Tests: `src/lib/ux.test.ts`, `src/editor/blockops.test.ts` (unit, headless editor),
`e2e/specs/k-ux.spec.ts` (Chromium, `#demo` on the real server), `e2e/specs/l-ux-phone.spec.ts`
(WebKit phone). `i-exports` and `j-late-plugins` were updated for the new menu roles.

## Issues

| # | Sev | Issue | Screenshot | Status · test |
|---|---|---|---|---|
| 1 | High | Phone bar "+" typed "/" at the caret, in the middle of a word ("lea/ves"), and the block menu did not open. | `before-phone-plus.png` → `after-phone-plus.png` | Fixed: opens the menu on a new line below (`insertBelowCaret`); gutter "+" shares it · `blockops.test`, `l-ux-phone` |
| 2 | High | ⌘K was advertised in the toolbar tooltip and did nothing. | — → `after-link-modk.png` | Fixed: ⌘K opens the link field for the selection (or inserts the address) · `k-ux` links, `blockops.test` links |
| 3 | High | Editors could not open, edit, copy or remove an existing link: clicking one did nothing (`openOnClick` off). | — → `after-link-actions.png` | Fixed: clicking a link shows Open / Edit / Copy / Remove; ⌘-click opens; `UI_Link_Click` posted · `k-ux` |
| 4 | High | Duplicate mutated the original node: `toJSON()` shares the node's `attrs`, so duplicating a database/board re-pointed the original to the copy's data in memory, and `blockId` was copied (ids must be unique, docs/15 §4). | — | Fixed: deep copy, `blockId` cleared · `blockops.test` (seen failing) |
| 5 | High | Menus and popovers were mouse-only: focus stayed behind, no arrow keys, `role="menu"` with no menu items, Escape dropped focus on `<body>`. | `before-block-menu.png` → `after-block-menu-keyboard.png` | Fixed in `Popover`: focus moves in, ↑/↓/Home/End, Tab closes, focus returns to the opener; roles `menu`/`menuitem`, `listbox`/`option`, `dialog` · `k-ux` block menu |
| 6 | High | The block menu re-selected the block on every render, pulling focus back out of the menu. | — | Fixed: kind computed from the node (`kindOfNode`) · `k-ux` |
| 7 | High | No keyboard path to block actions (gutter is hover-only). | — | Fixed: ⌘/ block menu at the caret, ⌘D duplicate, ⌘⇧↑/↓ move · `k-ux` |
| 8 | High | Dialogs focused their close button, not the field (URL prompt, import), because a selector list picks DOM order; Tab could leave a modal. | — | Fixed: focus priority (autofocus, field, primary), Tab trapped, focus restored on close; "Replace this canvas?" focuses Cancel · `k-ux` |
| 9 | High | Phone link editing used `window.prompt` (blocked in many in-app webviews, no validation). | — | Fixed: link sheet · `l-ux-phone` |
| 10 | High | Typing `/table` picked Database (keyword match ranked above the title). | — | Fixed: ranking by title prefix, word, contains, then keywords · `ux.test`, `k-ux` |
| 11 | Med | Small text at 3.4:1 (`--fg-3`: breadcrumbs, status, doc meta, menu hints); placeholders and gutter icons at 2:1. | `before-desktop-light.png` → `after-desktop-light.png` | Fixed: editor raises `--fg-3` to ≥ 4.5:1 in both themes; placeholders and gutter use it · `k-ux` axe |
| 12 | Med | Avatars: white initials on green/orange (3.5:1); overlap left 21 px targets (2.5.8); names did not contain the visible text (2.5.3). | `before-desktop-light.png` | Fixed: `readableOn` text colour, 2 px overlap, initials `aria-hidden`, `aria-pressed` while following · `ux.test`, `k-ux` axe |
| 13 | Med | Caret labels and mention chips had the same contrast problem. | `before-phone-dark.png` | Fixed: `readableOn` · `ux.test` |
| 14 | Med | The selection toolbar stayed over the text after starting a comment. | `before-comment-mention.png` | Fixed: editor blurs when the comment box takes focus |
| 15 | Med | Tables had no row/column/header/merge/delete controls (PRD §5.1). | — → `after-table-menu.png` | Fixed: table handle (add row, add column) and Table menu · `k-ux` table |
| 16 | Med | Images had no width or alignment (PRD §5.1). | — → `after-image-controls.png` | Fixed: align left/centre/right, S/M/L, drag or arrow-key resize handle; `width`/`align` attrs (ADR-023) · `k-ux` |
| 17 | Med | Callout colour changed by blind click-cycling, icon by Shift-click; not keyboard reachable. | — → `after-callout-picker.png` | Fixed: colour + icon picker; colour row in the block menu · `k-ux` |
| 18 | Med | Toggle chevron not keyboard reachable. | — | Fixed: ⌘Enter opens/closes from anywhere in the toggle |
| 19 | Med | Columns: two only, no way to add or remove one. | — | Fixed: "Three columns" in the slash menu; Add / Remove column in the block menu (content folds into the previous column) |
| 20 | Med | Embed prompt gave no hint which links work until an error. | — | Fixed: provider chips that light up when the link is recognised |
| 21 | Med | Comments had no @mentions (PRD §5.1, docs/06 §7). | `before-comment-mention.png` → `after-comment-mention.png` | Fixed: @ autocomplete (combobox + listbox), mentions highlighted, ids stored as `mentions` · `ux.test`, `k-ux` |
| 22 | Med | Comment quote ("show in canvas") was a `div`; "show resolved" had no name. | — | Fixed: buttons with names |
| 23 | Med | No keyboard shortcuts help. | — → `after-shortcuts.png` | Fixed: `?` (outside text), ⌘⇧/ anywhere, More menu · `k-ux` |
| 24 | Med | A blank canvas offered nothing but the placeholder. | `before-blank.png` → `after-empty-dark.png` | Fixed: invitation with Templates / Database / Whiteboard / Import · checked in the audit run |
| 25 | Med | Status kept saying Saving/Saved after a conflict or closed session stopped saving. | `before-conflict-status.png` → `after-conflict-status.png` | Fixed: "Autosave paused" with an explanation |
| 26 | Med | Save problems were not announced to screen readers. | — | Fixed: polite live region for warning/error states only |
| 27 | Med | After a network error the error screen offered real users "Try the demo canvas". | — | Fixed: "Try again" (expired links keep the plain message) |
| 28 | Med | Clicking a mention did not post `UI_Mention_Click` (docs/05 §4). | — | Fixed |
| 29 | Med | "Copy link to block" copied "Name · block 3", not a link. | — | Fixed: block gets a `blockId`; `UI_Block_Link` to the host, `Action_ScrollToBlock` and `#…&block=` scroll + highlight (ADR-023) |
| 30 | Med | Undo did not cover database cells or the header (icon, colour, title). | — | Fixed: one undo scope for your own text, database and header changes · `k-ux` undo |
| 31 | Med | Applying a template left the page scrolled to where the old content was. | — | Fixed |
| 32 | Med | Inserting a table left the caret below it. | — | Fixed: caret in the first cell · `k-ux` |
| 33 | Low | Shortcut hints were Mac-only (⌘Z) on every platform. | — | Fixed: `keyLabel` (⌘⇧K / Ctrl+Shift+K) · `ux.test` |
| 34 | Low | Demo content named a real company's product. | — | Fixed: Acme placeholder |
| 35 | Low | Demo status flickered "Saving" on collaborators' typing. | — | Fixed (demo only) |
| 36 | Low | Long menus did not flip above the anchor or cap their height to the visible space. | `before-block-menu.png` | Fixed: `placePopover` · `ux.test` |
| 37 | Low | The "Type '/' for blocks" hint showed in every empty table cell. | — | Fixed |
| 38 | Low | Template images were SVG data URLs, which SEC-20 now refuses. | — | Fixed: rasterised to PNG at insert; refused images show a labelled placeholder · `k-ux` SEC-20 |
| 39 | Med | No text colour mark and no date mentions (PRD §5.1 inline marks). | — | Fixed (UX-02, ADR-027): `textColor` mark from the tone palette (AA in light and dark), `dateMention` chips via `@today`, `@tomorrow`, "Pick a date…" or `/date`; MD/HTML/DOCX in web and Rust · `inline.test`, `m-open-items`, `oc-model` export tests |
| 40 | Med | Silent network loss shows "Unsaved changes" until the socket closes (up to ~30 s) before "Reconnecting/Offline". | — | Fixed (UX-02): server `ping` every 10 s, 15 s of silence = lost, "Offline" within 20 s · `http.rs` heartbeat, `m-open-items` (Playwright `setOffline`, browser offline events suppressed) |
| 41 | Med | Comment mentions are stored but the host's `onMention` is not called yet. | — | Fixed (UX-02): `POST {callback_base}/mentions` for comment and text mentions, once per message, via `notify_outbox` with retries; sample host lists them · `tests/mentions.rs`, `m-open-items` |
| 42 | Low | Board undo is separate from the canvas undo (board package keeps its own stack). | — | Fixed (UX-02): the editor passes its `Y.UndoManager` as `BlockEnv.undoManager`; ⌘Z steps through a cell edit, a board move and typing in order · `m-open-items` (seen failing without it) |
| 43 | Low | Database block header shows "7 rows" with an overlapping glyph on hover. | `before-block-menu.png` → `after-gutter-wide-1440.png` | Fixed (UX-02): the glyph was the editor's block handle, placed at the text column's edge over wide (1100 px) blocks. It now sits at the wide block's own left edge, and wide blocks leave room for it · `m-open-items` at 1440 and 1100 px |
| 44 | Low | docs/06 §3 says click jumps and long-press follows; the editor follows on click and has no ↑/↓ edge hints on avatars. | — | Fixed (UX-02): click and long press both start following (a long press never stops it); docs/06 §3 rewritten to match, edge hints dropped from the spec · `m-open-items` |
| 45 | Low | In an embedded session "Copy link to block" copies a `#block=` fragment; the full URL depends on the host handling `UI_Block_Link`. | — | Fixed (UX-02): `UI_BlockLink {fileId, blockId}`, launch `block=`, `Action_ScrollToBlock`; the sample host builds `/files/<id>#block=<id>` and the link opens on the flashing block · `m-open-items` |
| 46 | Low | Embed providers are named in the UI (allow-list labels). Flagged against the naming rule; they are functional labels the PRD lists. | — | **Open**: product decision |

## PRD gaps closed (editor side)

Link editing popover, table menus, image width/alignment, callout picker, toggle and column
editing, embed provider picker, comment @mentions, keyboard shortcuts help, empty-canvas
invitations, per-user undo across text/database/header, "Version history in host" in both the
status popover and the More menu (verified, now with an external-link cue), block links.
Already present and verified: follow mode, block-level presence bar, typing indicator.

## UX-02 (2026-11-21): open items, file previews, columns

Besides #39–#45 above:

- **File previews (FILE-01).** `fileAttachment` cards get a first-page thumbnail (PDF) or
  image, the first 12 lines of text files, native media controls, and a ⋯ menu (Preview, Expand,
  Show as preview / card, Download if allowed, Copy link, Rename, Replace file, Comment, Delete
  with Undo; viewers: Preview, Expand, Download, Copy link). PDFs show inline by default as a page
  stack with page X/N, zoom and fit width, and a resizable height (drag or ↑/↓ on the handle).
  Expand / Preview / Enter / Space opens the full viewer (Fullscreen API when granted, else a
  viewport overlay): every page with a text layer, ←/→ pages, +/−/0 zoom, F full screen, Esc
  returns to the same page inline, focus trapped and returned, the canvas behind is inert,
  prev/next between attachments, swipe on phones. Images get the same lightbox (zoom, pan, pinch,
  prev/next). Host files are read through `GET /v1/assets/fetch` (same origin, allow-listed).
  `before-file-attachment.png` → `after-file-inline.png`, `after-file-viewer.png`,
  `after-file-viewer-phone-dark.png` · `tests/preview.rs`, `n-file-preview`.
- **Columns (LAY-01).** 2–4 columns; "+" between and after columns on hover; the new column gets
  the caret and the "/" hint; dashed outlines only on hover/focus; the active column is tinted;
  resize handles snap to quarters (←/→ on the focused handle); optional column titles from the
  block menu; an empty column offers "Remove column" (and Backspace removes it, with Undo);
  phones stack columns with a separator. `after-columns-hover.png`,
  `after-columns-phone-dark.png` · `o-columns` (incl. axe in light and dark), `inline.test`.

## Scaling: rem units, zoom and large text (SCALE-01, 2026-11-24)

ADR-050 (Proposed). Type, spacing, control sizes, radii and chrome widths are rem; breakpoints are
em (CSS and the JS compact breakpoint, 45em); the root keeps the reader's default font size.
At 16 px and 100 % the UI is pixel-identical to before (SCALE-01 pixel suite: 14 screens × desktop
1280 and phone 390, light, three runs, 0 px). Codemod `tools/px-to-rem.mjs`, guard
`tools/check-px.mjs` (CI).

One check on `#demo` at 200 % zoom (640×450 CSS px at DPR 2), a 24 px default font (Chromium
`Page.setFontSizes`, 1280×900) and 320 px wide; axe (WCAG 2.2 AA tags) at each. What breaks — not
fixed in SCALE-01, these are the follow-up (SCALE-02):

| # | Setting | Problem | Likely fix |
|---|---|---|---|
| S1 | 24 px font | Lucide icons keep their `size={n}` px, so icons look small beside 1.5× text (top bar, database toolbar and tabs, menus, board toolbar) | an icon size in em (`width:1em` on `svg.lucide` inside chrome, or a `size` in rem) — changes nothing at 16 px if mapped 1:1 |
| S2 | 24 px font | Database column widths are px stored in the document, so cells truncate early ("Launch-token …"); status pills clip without an ellipsis ("In progres") | scale stored widths by root font/16 at render; ellipsis on pills |
| S3 | 24 px font, side panel open | Board block narrows; its tool bar (rem) and the zoom pill (rem) overlap at the bottom | let the tool bar wrap or collapse tools into a menu below a width (UI change: prototype) |
| S4 | 24 px font | Board-space text (stickies, labels) stays its board size: board geometry, by design (ADR-050); readers zoom the board instead | none, or a "larger board text" preference later |
| S5 | 24 px font, side panel open | Comments panel is 1.5× wider (rem) and the document column gets narrow at 1280 px; the compact switch only happens below 1080 px | consider a panel `max-width` in % (UI change) |
| S6 | 200 % zoom | The document scroller scrolls sideways by 5 px: a collaborator's caret label at the right edge overflows | clip caret labels to the column, or `overflow-x:clip` on the scroller |
| S7 | all | axe `aria-allowed-attr` (1): `aria-multiselectable` on the database `<table>` — also at 100 %, not caused by scaling | move it to a `grid` role or drop it |
| S8 | not run | WCAG 1.4.12 text-spacing overrides; 400 % zoom; the reflow Playwright checks (no sideways scroll, key controls clickable) at 200 % / 24 px / 320 px | SCALE-02 |

SCALE-02 (2026-11-24, owner scope S1, S2 pills, S5, S6): S1 fixed (Lucide sizes map 1:1 to rem;
identical at 16 px), S2 pills fixed (ellipsis; stored column widths still px), S5 fixed (panel
`min(23.75rem, max(380px, 30vw))`), S6 fixed (labels clamped inside the column). S3 needs a
prototype; S7 and S8 open. Details in the tracker (SCALE-02).

At 320 px wide and at 200 % the top bar keeps every control visible and clickable (compact layout);
the more menu and comments open as sheets.

## Bundle

Initial JS 271.7 KB gz (budget 300; UX-01 was 263.3). pdf.js (98 KB gz) and its worker, the file
viewer, the column and date chrome beyond the schema load on first use.
