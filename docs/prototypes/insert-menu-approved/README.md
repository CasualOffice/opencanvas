# Block insert menu prototype (approved 2026-11-25)

Approved by the owner on 2026-11-25 (ADR-011 gate). `InsertMenu.html` is the approved page as
reviewed: 31 frames in 8 sections (1 the menu, 2 variants, 3 intent discovery, 4 Recent,
5 host profiles, 6 search, keyboard and focus, 7 phone, 8 gallery), drawn in the editor's tokens
with Lucide icons. Built as INS-01 (v0.2.1, ADR-062). The build must match these screens; any
change goes back through a prototype.

## Approved decisions

1. **Variant picking:** inline segmented for Heading, List, Callout and Columns; a second step for
   Database (view) and Diagram (type) (2a). Enter always inserts the shown (remembered) variant.
2. **Keys:** Tab and Shift+Tab change an inline variant; → goes deeper, ← back; arrows never
   change a variant (2a, 6b).
3. **Desktop categories open beside the menu** (flyout); the phone drills in (1b, 7b).
4. **Media is folded:** Image and Embed to Visual & diagrams; Link preview and File to Content;
   Toggle and Divider to Layout; Date to Data & planning (1b-1d).
5. **Diagram replaces nothing:** Whiteboard stays a separate block next to Diagram (1d). Diagram
   offers 8 types; BPMN only when the host turns it on (2c).
6. **SDK placement:** a block is filed in its manifest's category with the approved third-party
   tile, and every SDK block is also under Extensions, headed "From your organisation" (1b, 1e,
   3d). Optional intent phrases too.
7. **Intents are keyword matching only**, local, with a one-line "why" per result (3a-3d). Hosts
   can replace the chips or turn them off.
8. **Recent:** variant level, at most four shown, skips what is a quick tile, hidden on a first
   visit, localStorage only with a 24-entry cap; remembered variants only from the menu, not from
   markdown (2e, 4a, 4b).
9. **Profiles:** a profile with 8 or fewer blocks gets a flat list without bands (5a).
10. **Hidden blocks** are never offered (menu, phone, gallery, markdown) and nothing says they are
    hidden; existing ones render and edit normally and paste keeps them (5c). Nothing to insert
    means no menu and no "+" (5d).
11. **Focus appearance:** the active item is an `--accent-soft` fill plus a 1.5 px `--accent`
    inset ring, replacing the faint `--hover` for keyboard focus (6b).
12. **Phone:** variants are always a second step; "/" with the keyboard open docks results above
    it (7c-7e).
13. **Gallery** takes the same five categories and shows variants as chips (8a).

## How the build maps the proposal onto what already exists

- **No `[host.insert]`.** The prototype proposed `[host.insert] profile, quick_insert, hide,
  intents, chips` (5e). The owner's EDP-01 editor profiles (`[host.editor]`, docs/05 §2b) landed
  first, so the menu uses them: profiles, `quick_insert` and the enabled blocks come from the
  session's `editor`, and the two keys only this menu needs are `[host.editor] intents` and
  `chips`. EDP-01's profile names (`notebook`, `meeting`, `project`, `diagramming`, `document`,
  `full`) replace the prototype's `workspace`/`meeting`/`diagramming`.
- **No new manifest fields.** SDK blocks use the block SDK's existing `discovery.category`
  (`content`, `data-planning`, `visual`, `layout`, `extensions`), and their `discovery.keywords`
  (phrases allowed, such as `"plan sprint"`) serve as intent phrases (3d's `intents`).
