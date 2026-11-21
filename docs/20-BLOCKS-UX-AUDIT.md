# 20 — Database and board blocks: UX audit

Date: 2026-11-21. Scope: `web/packages/database`, `web/packages/board` (React 19 + Yjs).
Bar: premium, production-grade collaborative tools. WCAG 2.2 AA, including 2.5.7 (a single-pointer
or keyboard alternative for every drag). Lucide icons only.

## Method

- A temporary Vite harness mounted both blocks twice, on two `Y.Doc`s synced in memory (with two
  `Awareness` instances), to act as two users. It was deleted before committing.
- Playwright (headless Chromium) at 1440 px and 390 px, light and dark: screenshots, scripted
  keyboard and pointer runs, and timings with 1,000 database rows and 2,000 board shapes.
- Every behavioural fix has a vitest test (`database/src/ux.test.tsx`, `board/src/ux.test.tsx`).
  The UI tests were run against the previous `DatabaseBlock.tsx` / `BoardBlock.tsx` and all failed.

### Measurements (headless Chromium, M-series laptop)

| Case | Before | After |
|---|---|---|
| Database, 1,000 rows: rows in the DOM | 1,007 | 38 (virtualised) |
| Database, 1,000 rows: 10 remote cell edits, one frame each | 8,630 ms | 165 ms |
| Board, 2,000 shapes: 30 pan moves | 1,211 ms | 640 ms (499 ms zoomed in) |
| Board, 2,000 shapes zoomed in: shapes in the DOM | 2,011 | 88 (culled) |

Severity: **Critical** blocks a task or a user group; **High** a core workflow missing or broken;
**Medium** clearly below the bar; **Low** polish. Status: Fixed, Open, By design.

## Database block

| # | Issue | Severity | Status |
|---|---|---|---|
| D1 | Every edit re-rendered every row; 1,000 rows took ~860 ms per edit and kept 1,000+ rows in the DOM. Now: table body is virtualised past 80 rows (spacer rows, `aria-rowcount`), rows are memoised and unchanged rows keep their objects between snapshots, `people` no longer changes on every edit. | Critical | Fixed |
| D2 | No spreadsheet keyboard model. Now: arrows move between cells (left/right leave a text cell only at the caret's edge), Enter commits and moves down, Home/End, Ctrl+arrows / Ctrl+Home/End jump to edges, PageUp/PageDown, typing on an option/person/date cell opens its editor. | High | Fixed |
| D3 | No cell ranges or clipboard. Now: Shift+arrows, Shift+click and click-drag select a range; Ctrl+C/X copy TSV + HTML (Excel/Sheets compatible); Ctrl+V pastes a block (types converted, unknown options added, rows added when needed) or fills a range with one value; Delete clears; Escape collapses. | High | Fixed |
| D4 | A field's type could not be changed. Now: header menu → Type; values are converted through their text form; title stays title. | High | Fixed |
| D5 | Status / select / tags options could only be created from a cell. Now: options editor (rename — cells follow, recolour, reorder with up/down buttons, delete — cells cleared, add). | High | Fixed |
| D6 | Ctrl+Z did nothing in the database (only delete toasts had Undo). Now: per-user `Y.UndoManager` on the database; text fields keep native undo while focused; remote edits are never undone. | High | Fixed |
| D7 | Column widths were fixed. Now: drag the column edge, or focus it (a `separator` with value) and use arrow keys; Home resets; double-click resets. Stored per view as `widths`. | High | Fixed |
| D8 | Columns could not be reordered. Now: drag a header (mouse), Alt+Shift+←/→ on a header, or Move left/right in its menu. | Medium | Fixed |
| D9 | Table rows could not be reordered (kanban only). Now: grip handle (drag, or arrow keys while focused) and Alt+Shift+↑/↓ from any cell; refused with a message while a sort is active. | Medium | Fixed |
| D10 | One sort key and one filter field only. Now: several sort keys (direction, reorder, remove), filters on several fields combined with AND, "Empty" as a filter value. `sort`/`filter` still mirror the first rule for older clients. | Medium | Fixed |
| D11 | Search had no highlight. Now: matches are marked in rendered values (pills, people, dates, numbers, URLs, gallery titles); editable text cells that match get an underline. | Medium | Fixed |
| D12 | Board view always grouped by the first status field, calendar always used the first date, gallery cover was fixed. Now: View settings — group by, date field, card cover (group colour, none, or an image from a URL field). | Medium | Fixed |
| D13 | Row peek: no previous/next, focus not moved in or restored, no dialog semantics. Now: "n of N" with previous/next buttons, J/K and Alt+↑/↓ (follow the view's filter/sort), focus moves into the panel and back to the opener, `role="dialog"`. | Medium | Fixed |
| D14 | A CSV import could not be undone. Now: the toast's Undo (and Ctrl+Z) removes the rows and any fields the import added. | Medium | Fixed |
| D15 | Empty states: "No rows yet" sat under the New row button; board/calendar said "Add a field" with no way to do it. Now: proper empty states with New row / Import CSV and one-click "Add a Status / Date field". | Medium | Fixed |
| D16 | The search button focused the field after a 30 ms timer, so the first keystrokes were lost. | Low | Fixed |
| D17 | On macOS, Home/End in a cell scrolled the whole page (found when the virtualised table jumped). Now they move the caret on every platform. | Low | Fixed |
| D18 | A focused cell kept a stale draft while a collaborator edited it, and blurring could write the stale value back without any typing. `CommitInput` now commits only real edits and follows the shared value while untouched. | Low | Fixed |
| D19 | Adding a field only toasted "Click its header to rename it". It now opens the new field's menu with the name selected. | Low | Fixed |
| D20 | Sort / filter chips could only be removed. They now open their popover to edit. | Low | Fixed |
| D21 | Filters only cover option-like fields (status, select, tags, person, checkbox): no "text contains", number ranges or date before/after. | Medium | Open |
| D22 | No per-view hide/show of fields. | Medium | Open |
| D23 | Calendar items can't be dragged to another day (the date is editable from the item's peek, which is also the keyboard path). | Medium | Open |
| D24 | `moveField` re-creates the field's Y.Map (Yjs can't move nested types): a rename by someone else at the same instant is lost. | Low | Open |
| D25 | Search highlight inside an editable input is an underline, not a mark on the matched text. | Low | Open |
| D26 | Header drag-to-reorder is mouse-only; touch uses the menu items. | Low | By design |
| D27 | Gallery image covers load the URL directly (referrer stripped, lazy). They should go through the server's SSRF-safe fetcher. | Low | Open |

## Board block

| # | Issue | Severity | Status |
|---|---|---|---|
| B1 | The board root had `tabIndex=-1`: keyboard users could not reach the canvas or select anything. Now: focusable group with a description; Tab/Shift+Tab walk the shapes (and leave the board after the last); a live region announces the selection ("Rectangle: B. 2 of 13"). | Critical | Fixed |
| B2 | Single selection only. Now: box select on empty canvas (mouse/pen), Shift+click to add/remove, Shift+box to add, Ctrl+A; multi-shape move, nudge and delete. | High | Fixed |
| B3 | No copy/paste of shapes (Ctrl+D duplicated one shape). Now: Ctrl+C/X/V through the system clipboard (HTML payload, works across boards), pasted next to the originals or in the view's centre, connector bindings and groups remapped to the copies; pasting plain text makes a text shape or sticky; Ctrl+D duplicates the selection. | High | Fixed |
| B4 | No grouping. Now: Ctrl+G / Ctrl+Shift+G and toolbar buttons; clicking any member selects the group. | High | Fixed |
| B5 | No align / distribute. Now: align left/centre/right/top/middle/bottom and distribute horizontally/vertically (3+) from the selection toolbar; bound connectors follow. | High | Fixed |
| B6 | No snapping. Now: moving snaps the selection's edges and centres to other shapes with pink guides; Alt moves freely. | Medium | Fixed |
| B7 | Sticky text did not wrap and overflowed the note; notes never grew. Now: text wraps; the note grows while typing and keeps the new height on commit. Rectangle, ellipse and diamond text wraps too. | High | Fixed |
| B8 | Connectors had no labels. Now: Enter or double-click edits a label in place at the connector's midpoint. | Medium | Fixed |
| B9 | Rectangles, ellipses and diamonds had no fill colour; text size was fixed. Now: none + 7 tone fills (outline follows), text size cycle for text and shapes. | Medium | Fixed |
| B10 | Layer order couldn't be changed (`bringToFront` existed but was unused). Now: front/back buttons, Ctrl+] / Ctrl+[ (forward/backward), with Shift for front/back. | Medium | Fixed |
| B11 | No undo/redo buttons, so touch users had no undo. Now in the top bar, disabled when empty. | Medium | Fixed |
| B12 | Collaborators' selections were invisible. Now: awareness `board.sel`; their selection is outlined in their colour with a name tag. | Medium | Fixed |
| B13 | With 2,000 shapes every pointer move re-rendered every shape. Now: memoised shapes with stable objects and viewport culling above 300 shapes (see measurements). | Medium | Fixed |
| B14 | WCAG 2.5.7: drags had no alternative except moving. Now: Alt+arrows resize; tool key + Enter places a shape in the view's centre; Connect button (or arrow tool + Enter) joins two selected shapes; arrows nudge (Shift ×10). | High | Fixed |
| B15 | Zoom limited to 25–300 %, so large boards could not be fitted. Now 10–400 %; Shift+1 fit, Shift+2 zoom to selection, Shift+0 / Ctrl+0 100 % around the centre. | Low | Fixed |
| B16 | Dragging on empty canvas panned, leaving no way to box-select. Now box-select; pan with Space+drag, the hand tool, the middle button, or one finger on touch; two fingers pinch and pan. | Low | Fixed |
| B17 | Escape with a creation tool active did nothing; it now returns to Select. | Low | Fixed |
| B18 | PNG/SVG export (web `export.ts`, and the Rust port EXP-02) did not draw the new fills, connector labels, text wrapping or shape text sizes. Now both draw tone fills/outlines, text sizes, wrapped text, auto-grown stickies and connector label pills, byte-identical on the shared fixture (EXP-03). | Medium | Fixed |
| B19 | No minimap (the zoom indicator and fit are there). | Low | Open |
| B20 | Connectors route straight or elbow only; no manual waypoints. | Medium | Open |
| B21 | No rotation; no stroke colour or width separate from the fill. | Low | Open |
| B22 | Freehand pen has no keyboard alternative: the path is the content (2.5.7 "essential" exception). | Low | By design |
| B23 | Snapping is skipped above 1,500 shapes to keep moves smooth. | Low | Open |

## Contract notes (follow-up outside this session's files)

Done: recorded in docs/15 §4 and ADR-024. The changes are additive and old clients ignore them:

- Board shapes: `group` (string), arrow `text` (label), `fill` on rect/ellipse/diamond (a tone name),
  `size` on rect/ellipse/diamond (text size).
- Board awareness: `board.sel` (selected shape ids) next to `board.x`/`board.y`; `board` may carry
  only `sel` when the pointer is outside the board.
- Database view prefs: `sorts`, `filters` (with `sort`/`filter` mirroring the first rule), `widths`,
  `group`, `date`, `cover`.

## API additions

- `@opencanvas/database` (internal modules, not re-exported): `setFieldType`, `setOptions`,
  `moveField`, `pasteCells`, `clearCells`, `OPTION_TYPES` (model); `sortsOf`, `filtersOf`,
  `sortPatch`, `filterPatch`, `highlightParts` (query); `grid.ts` (range, TSV, navigation helpers).
  Types gain `SortRule`, `FilterRule` and the `ViewPrefs` keys above. `groupField`, `dateField` and
  `defaultMonth` take an optional prefs argument.
- `@opencanvas/board`: `ops.ts` (align, distribute, snap, clone, z-order, groups, wrap; not
  re-exported); `Shape.group`.
- No exported signature changed; `web/packages/ui` is untouched.
