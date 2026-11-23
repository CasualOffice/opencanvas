<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CasualOffice -->

# Diagram icons (approved 2026-11-24)

Approved by the owner on 2026-11-24 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/4UPRhiqoacTcDqayxYACSb (version 1795469545-10c0).

`DiagramIcons.html`: DGM-17, 26 frames (Icons library, Add icon with server cleaning, icons in
this document, icon shapes, team icons from the host, missing-icon fallback, phone).

Owner policy: OpenCanvas ships only icons it is clearly free to ship (Lucide, ISC/MIT, plus our own
drawn glyphs). No vendor or brand icons are bundled or offered as packs; people add the logos they
need themselves.

Decisions taken with the approval (the recommended options):

1. Added icons live in a server-written document root `icons` (exception to ADR-045 §1), so a
   document is self-contained and exports never fetch.
2. Product names are search keywords on generic icons ("s3", "redis", "kafka"); glyphs never
   imitate a logo.
3. Team icons from the host (`GET {callback_base}/icons`, like team templates), copied into the
   document on use.
4. "Suggest for the team library" is later; v1 offers "Download cleaned SVG".
5. Limits: input 256 KB, cleaned SVG 64 KB, PNG 256 KB and 1024 px, 2,000 elements, 200 icons and
   1 MB of icons per document.
6. The approved Network library uses the new drawn glyphs for load balancer, API gateway and queue.

To check separately (legal, not part of DGM-17): Nextcloud's and Mattermost's trademark terms as
they apply to our own integration apps.
