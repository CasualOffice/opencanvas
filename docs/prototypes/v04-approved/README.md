# v0.4 prototypes (approved)

Approved by the owner on 2026-11-26 with every "Decisions for the owner" item as written, plus:

- Formulas: spreadsheet-like syntax; function names accepted in any case and normalised to upper case.
- Board toolbar: option A (one row, priority overflow into More) everywhere; the left rail is a
  personal setting, off by default, including in diagram full screen.
- Nextcloud Talk: the moderator's "Follow me" is in scope for v0.4.

| Page | Rows |
|---|---|
| [databases.html](databases.html) | formulas, relations, rollups (ADR-078) |
| [large-tables.html](large-tables.html) | virtualized tables and boards, partial-sync placeholders, bulk edit |
| [nextcloud-talk.html](nextcloud-talk.html) | Nextcloud Talk integration |
| [board-toolbar.html](board-toolbar.html) | SCALE-02 board toolbar |

## Spreadsheet block (approved 2026-11-26)

[spreadsheet.html](spreadsheet.html): a new "Spreadsheet" block, like Google Sheets or Excel. Owner
decisions: per-cell Excel formulas (A1, ranges, `$`, `Sheet!A1`); Excel keyboard; paste adds new
dropdown options; "Open as spreadsheet" on a database offers both view live and convert to a copy;
about 120 common Excel functions at launch; a sheet's chart can be placed on the canvas as a linked
chart block in v0.4.

## Timeline and Workload (approved 2026-11-28)

[timeline.html](timeline.html): database Timeline (Gantt) view with dependencies ("Blocked by" self-relation), milestones, critical path, No dates tray, zoom; Workload view (hours per person per week against capacity); phone list by week; keyboard map. Approved by the owner 2026-11-28 for v0.4 ("advanced databases").
