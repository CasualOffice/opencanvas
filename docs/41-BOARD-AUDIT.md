# 41 — Whiteboard and diagram audit, and opencanvas.studio

**Status:** Analysis, 2026-11-28. No product code changed. Owner request: "the whiteboard and diagram block has a lot of
issues", and check https://opencanvas.studio. Tracker rows BRD-05..BRD-22 (Todo). Fixes that change the UI wait for an
approved prototype (ADR-011); §5 splits the plan accordingly.

**Update 2026-11-28:** the §5.1 bug fixes BRD-05..16 are built (tracker rows; tests in
`web/packages/board/src/audit.test.tsx` and `e2e/diagram/board-audit.spec.ts`). D12 (new shapes
under the board's controls) and the demo's missing Import entry (by design: the demo host allows no
import format) stay open. BRD-17..22 wait for a prototype.

**How this was checked.** The live demo https://canvas.casualoffice.org/app/#demo (release v0.4.1) in Chrome at
1408 × 653 and 500 × 623 CSS px (500 px is the narrowest this Chrome window goes), dark and light theme, driven through
the browser automation tools (synthetic mouse and keyboard through the DevTools protocol). opencanvas.studio in the same
browser, signed out. The code read: `web/packages/board/src` (`BoardBlock.tsx`, `Dock.tsx`, `diagram/*`), docs/29. No
build, no test suite and no Rust build were run for this audit. Every defect below was seen in the browser unless it
says "code reading".

**Not verifiable here.** Two-person editing: the demo keeps each tab separate (a second tab of `#demo` showed the
original 8 shapes, not the first tab's edits), so it was not exercised; the e2e `w-two-user-board.spec.ts` covers it
(BRD-01) and was not run. Import (draw.io, Excalidraw): needs the canvas server, which `#demo` has none of, so the entry
is absent. Mermaid import is not built (docs/29 §7). Phone widths under 500 px and touch. Ctrl/⌘ + wheel zoom (the
synthetic wheel event did not carry the modifier; the code handles it, `BoardBlock.tsx` wheel effect). Pen stroke
smoothing (a synthetic drag has no middle points).

## 1. What opencanvas.studio is

Facts as observed on 2026-11-28; nothing here is a claim about intent.

| Question | Observed |
|---|---|
| Product | "Open Canvas", page title "Open Canvas - AI-Powered Whiteboard". Meta description: "Bring AI to your favorite whiteboard tool. Built on top of Excalidraw." |
| Technology | The page is Excalidraw: the DOM carries Excalidraw's own classes (`excalidraw`, `App-toolbar`, `ToolIcon`, `Island`), its tools and shortcuts 1-0, its context menus and its localStorage keys (`excalidraw`, `excalidraw-state`, `excalidraw-theme`). Excalidraw is MIT-licensed. Added on top: a Pricing dialog, a Log in button and an "Ask Anything..." AI prompt bar with an attach button. |
| Who runs it | No company name, imprint or repository link on the site. `twitter:site` meta is `@winzamark123`. The Terms of Service name the provider as "Open Canvas" and give a contact address at the domain `cerateam.com`. Sign-in is Clerk (Google or email). Served by Vercel behind Cloudflare; Simple Analytics script. The Terms page showed "Last Updated: November 28, 2026", the day of this check. |
| Business | Free $0 (basic drawing, limited image generations), Standard $5/month (60 image generations/edits), Pro $11/month (150, custom AI models, unlimited private projects). |
| Relation to us | None found. It is not a fork of this repository and does not mention CasualOffice. It is a commercial Excalidraw-based product with AI image generation, so it competes for "online whiteboard" users, not for the embeddable engine use (ADR-001). |
| Name overlap | Its name "Open Canvas" differs from ours ("OpenCanvas", "OpenCanvas by CasualOffice") only by a space. Its domain is opencanvas.studio; ours is canvas.casualoffice.org. A web search also found other unrelated projects called "Open Canvas" (for example a Peerlist listing of a design tool at opencanvas.aayushman.dev). No trademark notice for "Open Canvas" was seen on the site. Whether this matters legally is a question for the owner and counsel (compare LEGAL-01); this audit makes no claim. |

### 1.1 Whiteboard and diagram features (signed out, what is visible)

- **Tools:** Hand, Selection, Rectangle, Diamond, Ellipse, Arrow, Line, Draw, Text, Insert image, Eraser, each with a number
  shortcut shown in the button; "Recenter canvas". No sticky notes, no frames tool on the rail (the selection context
  menu has "Wrap selection in frame"), no diagram libraries beyond Excalidraw's "Add to library".
- **Drawing:** drag to size; a single click with the rectangle tool makes nothing. Text tool: click and type at once;
  Escape ends editing and keeps the text (both verified).
- **Connectors:** Excalidraw arrows (binding to shapes).
- **Selection context menu:** Cut, Copy, Paste, Wrap selection in frame, Copy to clipboard as PNG / SVG, Copy styles,
  Paste styles, Add to library, Send backward, Bring forward, Send to back, Bring to front, Flip horizontal / vertical,
  Add link, Copy link to object, Duplicate, Lock, Delete, every entry with its shortcut. Canvas menu: Paste, copy as
  PNG/SVG, Select all, Toggle grid, Snap to objects, Zen mode, View mode, Canvas & Shape properties.
- **Not visible on desktop:** Excalidraw's style panel (stroke, fill, width) when a shape is selected, and the main menu.
  At 500 px the hamburger menu appears with Open, Save to..., Export image..., Command palette, Find on canvas, Help,
  Reset the canvas, a language list and canvas background.
- **Collaboration and sharing:** no share or live-collaboration control is visible signed out. Not verified signed in.
- **Templates:** none visible.
- **AI:** the prompt bar ("Ask Anything...") with an attachment button; not submitted in this audit.
- **Persistence:** the drawing survives a reload in the same browser (localStorage).

### 1.2 UI and UX analysis

| Area | Does well | Does poorly | Adopt / avoid |
|---|---|---|---|
| Layout | Full-bleed canvas; a slim left tool rail, bottom-left undo/zoom island, bottom-centre prompt bar: the canvas gets almost all the space. | Two unrelated buttons (Pricing, Log in) float top right; no title or file name anywhere, so there is no sense of "which drawing". | Adopt the "chrome in islands at the edges" density. Avoid hiding the document's name. |
| Navigation | One screen; nothing to navigate. | Desktop has no menu at all; export is only "Copy to clipboard as PNG/SVG" in the right-click menu. | Avoid functions that live only in a context menu. |
| Typography | Excalidraw's UI font, small and quiet. | Tool shortcut digits are tiny and low contrast. | Adopt shortcut hints inside tool buttons only if they meet contrast. |
| Colour | Light grey canvas, near-black strokes, one violet accent for the active tool and selection. | — | Our tokens already do this. |
| Iconography | One consistent outline icon set. | — | Keep Lucide outline icons (memory: icons policy). |
| Density | Very low chrome. | Discoverability suffers: no style panel on desktop, so a new user cannot find how to colour a shape. | Avoid removing the properties surface; we keep the floating toolbar. |
| Motion | Instant; no decorative motion. | — | Same. |
| Dark mode | Alt+Shift+D switches the canvas cleanly. | The added parts do not follow: Pricing and Log in become low-contrast grey on grey, and the prompt field turns into a solid black box inside a grey island. | Avoid add-on UI outside the theme tokens; our dark mode is consistent (§2 found no dark-only defect). |
| Onboarding / first run | Lands straight on a canvas with a sample diamond and arrow; drawing needs no account. | No hint of what the AI does or what is free; the value proposition is a placeholder in a text field. | Adopt "draw first, sign in later". |
| Creating and opening | — | No list of drawings signed out; "Open" (file) only in the narrow-width menu. | — |
| Editor and toolbar | Number shortcuts 1-0, drag-to-size, text tool types immediately, Escape keeps text, a full right-click menu with shortcuts. | The tool returns to Selection after each shape (observed); no lock control is visible. | Adopt drag-to-size, immediate text entry, Escape commits, context menu (BRD-05, BRD-06, BRD-07, BRD-18). |
| Collaboration and sharing | — | Nothing visible signed out. | — |
| Settings | Language list, canvas background (narrow-width menu). | — | — |
| Empty states, errors | — | None observed. | — |
| Sign-in | Clean Clerk card, Google or email, terms line under it. | Third-party branding ("Secured by Clerk"). | — |
| Pricing | Three plain cards, quota per plan. | The modal covers the canvas with no way to see what the AI does first. | — |
| Mobile (500 px) | Excalidraw's mobile layout: tools in a bottom bar, menu top left. | The AI prompt bar and Pricing / Log in are gone at 500 px, so the product's headline feature is not reachable there (signed out). The hamburger's GitHub, Follow us and Discord links point at Excalidraw's own project accounts (github.com/excalidraw/excalidraw, x.com/excalidraw, Excalidraw's Discord). | Avoid dropping primary features at narrow widths; avoid upstream links that look like your own. |
| Accessibility | Tools are labelled radios with their shortcut ("Rectangle", "2"); the document has `lang="en"`. | The viewport meta sets `maximum-scale=1, user-scalable=no`, which blocks page zoom on phones (WCAG 1.4.4). Four Tab presses showed no visible focus indicator. | Avoid both; our editor allows zoom and shows focus (memory: scalable units). |
| Performance | One main script, about 570 KB as served (curl `size_download`), plus analytics; the canvas was interactive at once on this machine. | — | Our initial JS budget (ADR-079) is stricter. |

Screens were inspected, not saved: the material is a third party's, so it is described in words here and no
`docs/41-assets/` was created.

## 2. Defects in our board and diagram, ranked

Severity: **P0** a core flow is broken; **P1** a core flow loses work or misleads; **P2** visible defect with a
workaround; **P3** polish. "UI" in the last column means the fix changes what the user sees and needs a prototype.

| # | Sev | Defect | Steps → expected vs actual | Likely code | Fix type |
|---|---|---|---|---|---|
| D1 | P0 | **Sticky notes and text placed with the mouse cannot be typed into.** | Board, Sticky note tool (or Text), click on the canvas, type. Expected: the text goes into the new note. Actual: the editor closes at once; the typed letters run as tool shortcuts (the word "with" switched to the Pan tool); the note stays empty, and a Text shape is deleted because it is empty, so the Text tool appears to do nothing. Focus trace: `pointerdown` → textarea focused → `mousedown` default action → focus moves to the board root (`tabIndex=0`) → textarea `blur` → `commitEdit`. Keyboard placement (N, Enter) and double-click work. | `BoardBlock.tsx` `onPointerDown` (calls `createAt` without `preventDefault`), `createAt`, `TextEditor` `onBlur={() => onDone()}` | Bug |
| D2 | P1 | **Escape throws away the text being typed.** | Double-click a sticky, type "Edited sticky", press Escape. Expected (as Excalidraw does, verified on opencanvas.studio): the text is kept. Actual: the edit is discarded with no message. | `TextEditor` `onKeyDown`: Escape → `onDone(true)` (cancel) | Bug |
| D3 | P1 | **Auto-layout's preview bar sits half off the screen.** | Diagram mode, Auto-layout, Preview. Expected: a bar at the bottom with Cancel / Apply. Actual: the bar is inside the top bar at top −22 px; Cancel and Apply are half hidden. Cause: the class `.ocdg-pbar` is defined twice, in `AutoLayout.tsx` (absolute, bottom) and `Phone.tsx` (the phone tab bar, `position:relative`); the later rule wins. | `diagram/layout/AutoLayout.tsx:317`, `diagram/phone/Phone.tsx:48` | Bug |
| D4 | P1 | **Auto-layout wrecks a diagram drawn with a frame.** | `#demo` board "How a session flows" (dashed HOST APP frame around a sticky), Diagram → Auto-layout → Down, Normal, whole diagram, "Keep shapes in their containers" on → Apply. Expected: the frame keeps the sticky inside, connectors stay attached, nothing overlaps. Actual: all shapes go into one row; the frame moves away from the sticky it held, the connector bound to the frame ends inside the empty frame, the caption text lands under two stickies. Undo restores. The frame is a drawn dashed rectangle without `props.parent`, so layout does not see the containment the user sees. | `diagram/layout/compute.ts`, `apply.ts`; `isContainer` / `containedIn` | Bug |
| D5 | P1 | **Shapes cannot be sized by dragging.** | Rectangle tool, drag from (930,130) to (1080,230). Expected (as Excalidraw does, verified): a 150 × 100 rectangle where dragged. Actual: a fixed 140 × 80 shape centred on the press point; the drag is ignored. Same for ellipse, diamond and sticky. | `createAt` on pointer-down | Bug (no new UI) |
| D6 | P2 | **The shape toolbar covers the board's own controls.** | Select two shapes near the top right: the align toolbar sits over Undo, Redo, Diagram, More and Full screen. Paste near the bottom right: it covers the zoom pill. | `BoardBlock.tsx` floating `.ocbd-swatch` placement (`flip` only checks the top edge) | Bug |
| D7 | P2 | **Libraries chooser runs off the top of the window.** | Diagram mode, window 653 px high, Libraries. Expected: the whole list with its heading, scrolling if needed. Actual: the dialog's top is at −31 px; its heading is cut off. `.ocdg-chooser` has no max-height or overflow. | `diagram/styles.ts:110` | Bug |
| D8 | P2 | **New shapes land on top of existing ones.** | Diagram, click Cylinder in the shapes panel: it is placed at the view centre over two shapes and a connector. Same for keyboard placement (N, Enter). Expected: the nearest free spot in view. | `addKind(kind, viewCenter())`, `createAt` via Enter | Bug |
| D9 | P2 | **The command palette knows five commands.** | Diagram, Commands, type "align": "No matches". The list is Zoom to fit, Minimap, Show outline, Keyboard shortcuts, How connectors work. Missing: align, distribute, group, z-order, export, auto-layout, insert shape. | `diagram/Shell.tsx` command list | Bug (existing UI) |
| D10 | P2 | **Demo says "Saved" for edits that are not kept.** | `#demo`, draw, wait for "Saved", open `#demo` in a second tab or reload: the edits are gone. ADR-043 says a temporary canvas must never say "Saved". | `editor/src/lib/demo.ts` (`demoSession` storage), `App.tsx` `temporary` | Bug |
| D11 | P2 | **Diagram header at 500 px truncates the title to one letter.** | Diagram mode at 500 px: the title shows "H." while the Commands button keeps its ⌘K chip. | `diagram/Shell.tsx` top bar | UI |
| D12 | P3 | **New shapes can sit under the board's controls.** | Sticky placed near the top right of the inline board: its top is under the Diagram button. No inset keeps content clear of the corners on placement. | `createAt`, `Dock` / top actions | Bug |
| D13 | P3 | **Library shape names show as raw ids.** | Add Cylinder or Cloud: the properties panel heading says "cylinder", "cloud" (lower case id). | `diagram/props/Properties.tsx` heading | Bug |
| D14 | P3 | **Import is missing from the demo with no reason given.** | Diagram, More: Insert image, Export…, PNG, SVG; no Import. Export marks draw.io and Mermaid "Needs the canvas server", Import says nothing. The phone sheet lists "Import Mermaid or draw.io" though Mermaid import is not built. | Diagram options menu, `diagram/phone/Phone.tsx:350` | Bug |
| D15 | P3 | **Export is light only.** | Export dialog: "Drawn in light colours"; no dark or transparent background choice. | `export.ts`, `ExportDialog.tsx` | UI |

Checked and fine: undo / redo (two steps back and forward), connectors bind to shapes, bound connectors follow, align
left, group (⌘G), copy and paste of a group (offset copy), resize by handle, double-click empty canvas for text, Enter
then type for keyboard placement, drag a library shape onto the canvas, export dialog (PNG, SVG; draw.io and Mermaid
greyed without a server), the inline wheel scrolls the page (by design), dark and light themes, no console errors.

## 3. UX gaps (not defects)

- **No tool lock.** Every placement returns to Select (`createAt` → `setTool("select")`). opencanvas.studio also returned to Selection after a rectangle; upstream Excalidraw offers a lock, which is not visible there.
- **No right-click menu.** The board suppresses the browser menu only while dragging; there is no context menu for
  z-order, copy as image, lock, link or paste. opencanvas.studio (Excalidraw) shows a full one with shortcuts.
- **Dragging a bound connector's body detaches both ends** with no hint. Undo restores.
- **No rotation, stroke width or stroke colour separate from fill** (docs/20 B21, still open).
- **No line tool, no eraser, no frame tool**; frames are drawn dashed rectangles, which is what D4 trips on.
- **Templates for boards** (retro, flow, org chart) are not offered from the board itself.
- **Export:** no copy-to-clipboard as PNG/SVG, no dark export (D15).

## 4. Comparison (only what was verified)

| Behaviour | Ours | opencanvas.studio (Excalidraw) | tldraw, Miro |
|---|---|---|---|
| Click with a shape tool | Fixed-size shape | Nothing; drag to size | Not verified in this audit |
| Text tool, click then type | Broken (D1) | Works | Not verified |
| Escape while typing | Discards (D2) | Keeps text | Not verified |
| Sticky notes | Yes, 4 colours, auto-grow | No | Not verified |
| Diagram mode: shapes panel, libraries, ports, elbow routing, auto-layout, rulers, properties | Yes | No | Not verified |
| Right-click menu | No | Yes, full | Not verified |
| Number-key tools | Letters (V, N, P, T, R, A, O, D, H) | Digits 1-0 | Not verified |
| Embeddable in a document | Yes | No | Not verified |
| Page zoom on phones | Allowed | Blocked by viewport meta | Not verified |

tldraw and Miro were not opened in this audit; general knowledge about them is not used as evidence.

## 5. Fix plan

### 5.1 Bug fixes: no new UI, straight to code (each with a test seen failing first)

1. **BRD-05 (D1, P0).** Stop the pointer-down that creates a sticky or text from moving focus: `preventDefault` on that
   pointer-down (or focus the textarea after `pointerup`). Test: a Playwright test that clicks with the Sticky and Text
   tools and types (jsdom does not run the `mousedown` default, which is why unit tests pass).
2. **BRD-06 (D2, P1).** Escape commits the text, as Excalidraw does; an empty new Text shape is still removed.
3. **BRD-07 (D5, P1).** Drag to size for rect, ellipse, diamond and sticky; a click without a drag keeps today's default
   size. Shift keeps proportions.
4. **BRD-08 (D3, P1).** Rename the phone tab bar class (`.ocdg-ptabs`) so the preview bar is absolute again.
5. **BRD-09 (D4, P1).** Auto-layout treats a dashed rectangle that fully encloses shapes as their container (or the
   import of a drawn frame sets `props.parent`), keeps free text out of other shapes, and never leaves a connector
   end inside an empty frame. Test with the `#demo` board as a fixture.
6. **BRD-10 (D6, D12).** Place the floating toolbar clear of the board's top actions and zoom pill (both edges).
7. **BRD-11 (D7).** `max-height` and scroll for `.ocdg-chooser`.
8. **BRD-12 (D8).** Placement from the panel and the keyboard goes to the nearest free spot in view.
9. **BRD-13 (D9).** Add align, distribute, group, z-order, auto-layout, export and insert-shape commands to the
   existing palette.
10. **BRD-14 (D10).** The demo session counts as temporary (ADR-043): no "Saved".
11. **BRD-15 (D13).** Library shape headings use the library's display name.
12. **BRD-16 (D14).** Remove the Mermaid line from the phone sheet until Mermaid import exists; Import in the demo menu
    disabled with "Needs the canvas server", as Export does.

### 5.2 UX changes: need a prototype first (ADR-011)

Prototype for all six and the §3 gaps (approved by the owner 2026-11-28, all 14 decisions): [prototypes/board-ux-approved/board-ux.html](prototypes/board-ux-approved/board-ux.html), with "Decisions for the owner" at the top.

1. **BRD-17 (D11).** Diagram header at narrow widths: what collapses first.
2. **BRD-18.** A right-click menu for the board and diagram (Excalidraw's list is the reference).
3. **BRD-19.** Tool lock.
4. **BRD-20 (D15).** Export background choice (light, dark, transparent) and copy as PNG / SVG.
5. **BRD-21.** Frames as a real tool (named container with membership) instead of dashed rectangles.
6. **BRD-22.** Stroke width, stroke colour and rotation (docs/20 B21).

## 6. What to adopt

- From Excalidraw (via opencanvas.studio): drag to size, immediate typing with the Text tool, Escape keeps text, the
  context menu with shortcuts beside every entry, "draw first, sign in later".
- Avoid what opencanvas.studio does poorly: add-on UI outside the theme tokens (its dark mode), primary features that
  disappear at narrow widths, `user-scalable=no`, no visible keyboard focus, and links that send users to another
  project's accounts.
- Keep our lead: sticky notes, the embedded board in a document, diagram mode (libraries, ports, routing, rulers,
  properties), and accessible keyboard placement.

## 7. QA pass with a real mouse and keyboard (2026-11-28, after BRD-17..31)

**How this was checked.** `main` at 79efb4a, the production editor build served statically at `#demo`, in Chrome
(1409 × 802, dark) through the browser tools and in Playwright Chromium (real mouse and keyboard events, 1280 × 900,
853, 640, 390 and 320 px, Pixel 7 touch). Throwaway probe specs logged what the board stored in its Y.Doc after each
action; every defect below was then turned into a test that failed before its fix (`e2e/diagram/board-qa.spec.ts`,
`board-toolbar.spec.ts`, `web/packages/board/src/qa.test.ts`, `qa-ui.test.tsx`). Two people at once: the demo's
simulated collaborator (cursor, avatar, Follow, Go to cursor); two real browsers need the server stack (`w-two-user-board`).

Severity as in §2. Status: **Fixed** (commit in the tracker row), **Open** (with the reason).

| # | Sev | Defect | Steps → expected vs actual | Status |
|---|---|---|---|---|
| Q1 (BRD-32) | P0 | **Tool bar parked in the bottom-left corner** (owner). | Any board. Expected (owner): centred at the bottom, zoom pill bottom right. Actual: left-aligned (option A of the toolbar prototype). | Fixed: centred grid; the pill's width reserved on both sides. |
| Q2 (BRD-33) | P1 | **Entering or leaving full screen, or leaving Present, drops keyboard focus to the page.** | Click Full screen, press R. Expected: Rectangle tool. Actual: nothing; also Undo, Escape and every shortcut do nothing until the canvas is clicked. Same after Exit full screen, and after Escape out of Present (Undo then did nothing: the frame just drawn stayed). Cause: the board moves to or from a portal and the focused button is unmounted; Present gave focus back while it was still on screen. | Fixed |
| Q3 (BRD-34) | P2 | **Diagram opened from full screen is named after the wrong heading.** | Full screen, Diagram. Expected title: "How a session flows" (the heading above the board). Actual: "OpenCanvas owns", the last heading of the page: the heading is looked up from the board's portal at the end of `<body>`. | Fixed |
| Q4 (BRD-35) | P2 | **Rotated shapes: connectors and quick-connect ignore the rotation.** | Rotate a sticky with connectors. Expected: ends on the turned outline; the four + handles off the turned sides. Actual: anchors, ports and centre-bound ends stay on the unturned box (ends float off or sit inside the shape); the + handles stay axis-aligned, one on top of a corner resize handle (4 px apart at 90°), so that corner cannot be dragged. | Fixed |
| Q5 (D12) | P3 | **New shapes can sit under the board's controls.** | Sticky tool, click just under the top actions or by the zoom pill; Rectangle just above the tool bar. Expected: the shape lands clear of the controls. Actual: under them. | Fixed: a placed (not dragged) shape moves by the shortest distance that clears them. |
| Q6 (BRD-36) | P3 | **A collaborator's name label runs off the board's right edge.** | Phone (390 px), a peer's cursor near the right edge: "Ravi Me…" cut by the board's edge. Expected: the label flips to the left of the arrow. | Fixed |
| Q7 | P2 | **Auto-layout "Down" on the demo board does not lay out downwards.** | Diagram → Auto-layout → Down, Normal, whole diagram, keep containers → Preview → Apply. Expected: frame, then Room, then Autosave in layers top to bottom. Actual: the frame stays top left, Room and Autosave go to a column on the right, the caption lands on a connector, connectors become long diagonals. The preview's new positions are partly under the properties panel and the preview bar covers the tool bar and zoom pill. | Open: layout algorithm work in `diagram/layout/compute.ts` (a cycle back into a container); the preview needs a "fit the result" step. Next in this pass. |
| Q8 | P3 | **Shift+wheel pans vertically on Windows and Linux.** | Mouse wheel with Shift (Playwright, no trackpad). Expected: horizontal pan (browsers on macOS already turn Shift+wheel into a horizontal delta). Actual: vertical pan. | Open (small; next in this pass). |
| Q9 | — | Test harness: the e2e static server (`e2e/diagram/serve.ts`) serves `.mjs` and `.wasm` as `application/octet-stream`, so one module fails to load in every demo spec ("Failed to load module script"). | Console of any `e2e/diagram` spec. | Open (harness only; next in this pass). |

Checked and fine in this pass: every tool by drag (rect, ellipse, diamond, sticky, text, frame, connector binding to a
shape, pen with smoothing points); tool lock (Q, three placements, Escape releases); quick-connect click (same kind,
bound both ends, typing at once); text and sticky editing, Escape commits, undo restores the old text; copy, paste
(at the pointer), duplicate, delete, select all; paste of 10 shapes into another tab's board; undo and redo of 8 actions
back to the start and forward again; rotation handle (15° steps) and undo; multi-select resize; marquee (fully inside);
frames (F, membership of 3 shapes, Frames menu, Present, arrows through frames, Escape); export dialog (selection, PNG/SVG,
light/dark/none, 1-3×); context menu (shape and canvas, Arrange submenu); Ctrl/⌘+wheel zoom, wheel pan, Space-drag and
middle-drag pan, Shift+1 fit; Follow and Go to cursor with the simulated peer; phone: the board opens behind "Tap to
open board".

Not covered in this pass: import (draw.io, Excalidraw) and two real browsers need the canvas server; frame time at
2,000 shapes (`e2e/perf/board-frames.perf.ts` with `PERF_SIZES=2000`) was not run because the disk was under the 10 GB
floor set for this pass.
