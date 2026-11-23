<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Mattermost plugin screens (approved 2026-11-24)

Approved by the owner on 2026-11-24 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/PQ4XePT7yxcZvv7hq84wvV (version 1795467040-3aab).

`MattermostScreens.html`: screens S1–S8 from `integrations/mattermost/UI-SCREENS.md`, 41 frames,
light (Denim) and dark (Onyx), desktop, Desktop app and phone.

Decisions taken with the approval (the recommended options):

- New canvases open straight into the page, without the template picker (S2f). Needs a launch
  option in OpenCanvas to skip the start screen.
- The card's actions sit on the title row and the whole card is clickable, clear of the
  first-run checklist (S1i).
- Download .ocanvas shown greyed with "Later" until it ships (S1b).
- In the Desktop app the header button reads "Open in your browser" (S7b).
- The phone "Open in browser" link (S8b, S8c) and Test connection (S6b) are later candidates.
