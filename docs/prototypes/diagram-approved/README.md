<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Diagram editing screens (approved 2026-11-24)

Approved by the owner on 2026-11-24 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/Fgvrue8vSqyuSbo8fTwKby (version 1795468627-f4a5).

`DiagramScreens.html`: DGM-14, 54 frames over 11 screens (entering diagram mode, shapes panel,
canvas, properties, outline/commands/keyboard, auto-layout, import/export, unknown shapes, size
budget, working together, phone), light and dark.

Decisions taken with the approval (the recommended options):

- A labelled "Diagram" button on the board block (1a); the menu entry and ⇧D as well (1b).
- Boards get an optional name (1d).
- BPMN is off until an administrator turns it on (2f).
- Esc with nothing selected leaves diagram mode (5d).
- Auto-layout's "Keep your bends" is off by default (6a).
- Import limit 5 MB and an "Undo import" button, as approved for FC-10.
- Soft board size limit: warn at 80 % and over 100 % of the per-board budget (25 % of the document
  limit); only the document limit stops saving (9b).
- Keep the faint outline of a deleted shape at an orphan connector's loose end (10b).
- Diagram mode is per person and never stored in the document; the size is measured by the client.

New UI follows the units rule (rem, see SCALE-01).
