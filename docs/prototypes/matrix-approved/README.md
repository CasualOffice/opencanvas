<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Element / Matrix widget screens (approved 2026-11-24)

Approved by the owner on 2026-11-24 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/WKyr52AXRUCseJYSCxHBvm (version 1795467041-1f95).

`ElementWidgetScreens.html`: screens S0–S8 from `integrations/matrix/UI-SCREENS.md`, 27 frames,
light and dark, Element Web at desktop and phone width.

Decisions taken with the approval (the recommended options):

- Room wording for temporary canvases (S5, S6, S7b) instead of meeting wording. Needs a host-level
  wording option in the editor.
- "Start a new canvas" on the ended screen (S6a).
- "You're no longer in this room, so this canvas is closed." for leave, kick and ban (S7b).
- Widget title "Temporary: download to keep a copy" (S5c).
- No extra notice from the widget on open (S5).
- The bot's user ID is shown to everyone when the bot is missing (S4c).
- To check: whether Element's "Revoke permissions" clears a remembered Deny (S3).
