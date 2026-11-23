<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Nextcloud app screens (approved 2026-11-24)

Approved by the owner on 2026-11-24 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/JMvvYKBCwUVVU4G9YKGtvv (version 1795465727-86a4).

`NextcloudScreens.html`: all screens S1–S14 from `integrations/nextcloud/UI-SCREENS.md`, 88
frames, light and dark, desktop (1280 px) and phone (390 px).

Decisions taken with the approval:

- Clicking a canvas opens it in the Nextcloud Viewer (S6b); "Open in full page" is in the "…" menu.
- New-menu entries: "New canvas", "New database canvas", "New whiteboard canvas" (S1a).
- The new indigo `.ocanvas` file icon (S2).
- "Can comment in OpenCanvas" as a checkbox in the share's advanced settings, only when the admin
  enables it (S8b).
- Guests on edit links give a name first; view-only guests show as "Guest" (S7).

Before the app store listing (S14) is published, check its claims: supported Nextcloud versions
(only 31 is tested), the version shown on the admin page, and the 10-hour session limit.
