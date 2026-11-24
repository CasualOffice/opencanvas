<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Block SDK screens (approved 2026-11-25)

Approved by the owner on 2026-11-25 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/8BJAqooJ1WoUwUBfuRZqXP (version 1795551832-74ea).

`BlockSdkScreens.html`: docs/27 §6.5 and §6.6, 26 frames (third-party block chrome, fallbacks,
permissions and read only, comments, phone, slash menu and insert gallery, operator view).

Decisions taken with the approval:

1. The third-party badge shows on hover, focus and selection only; fallback states always show it.
2. Focus inside a block: solid 2 px `--accent` ring with a 2 px gap (WCAG 2.2 focus appearance).
3. One reader-facing wording for "not installed", "not enabled for this host" and "refused by the
   integrity check".
4. Crash-loop guard: three crashes in a minute turn Reload block into "Try again later" for 30 s.
5. Comments anchor to the whole block; the block is never told about them.
6. The / menu group is "From your organisation" with no empty state; the gallery category has one.
7. Gallery previews: a sketch drawn from the manifest, or an optional `preview.png` (new optional
   manifest field).
8. Menu group labels and item descriptions move from `--fg-3` to `--fg-2` (contrast), in the
   editor's existing menus too.
9. Per-host permission narrowing (`[host.blocks.permissions."<type>"]`) and refused packages listed
   in `/healthz`.

Open in the design (docs/27 §3), to settle while building BSDK-03: layout of `content:
"inline"/"blocks"` children next to the frame; what a reader sees when a first-edit migration fails
server validation; where the last known height for the loading skeleton is kept.
