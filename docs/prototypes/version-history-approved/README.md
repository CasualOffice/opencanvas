<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Version history screens (approved 2026-11-24)

Approved by the owner on 2026-11-24 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/Uxer4yCRTnWej2M9BNHMGi (version 1795471032-6230).

`VersionHistory.html`: VH-01 and VH-02, 23 frames (history panel, naming, preview, changes in
text, databases and boards, compare any two, restore, restore with others editing, view-only,
hosts without history, phone). Design: [docs/30](../../30-VERSION-HISTORY.md), ADR-051 and ADR-052.

Decisions taken with the approval (docs/30 §10, the recommended options): editors see history by
default (hosts can grant viewers); automatic saves fold into sessions split at 30-minute gaps;
naming with no changes still saves; no rename or delete of named versions in v0.2; the
`X-OpenCanvas-Checkpoint` hint; temporary canvases have no history; restoring from Nextcloud's own
Versions tab keeps today's conflict copy; restore keeps comments; 30-second Undo for the person who
restored.
