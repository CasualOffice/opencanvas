# v0.5 prototypes (draft, awaiting owner approval)

Drafts for V5UI-01 ([docs/38](../../38-ROADMAP-v0.5.md) §8). Nothing under them is built before the
owner approves them (ADR-011). Each page lists its "Decisions for the owner" at the top. Same
format as the approved v0.4 pages: sticky review bar, light and dark, fit to width or actual size,
real-size frames with notes; rem units, Lucide-style icons, no emoji, works at 320 px.

| Page | Rows | ADR |
|---|---|---|
| [links-backlinks.html](links-backlinks.html) | `[[` picker and block targets, Linked from, unlinked mentions, hover preview, link states, phone | ADR-081 (LINK-01..05) |
| [knowledge-graph.html](knowledge-graph.html) | full graph (interactive force layout, plain JS), local graph, filters, search, list fallback, keyboard, phone, empty and too-large states | ADR-082 (GRAPH-01..03) |
| [plugin-marketplace.html](plugin-marketplace.html) | browse, details with permissions and publisher, signatures, install, updates, manager, admin policy, requests, blocked states (unsigned, network, revoked, incompatible), phone | ADR-083 (PLUG-01..06) |
| [extension-points.html](extension-points.html) | a plugin database view, a plugin importer in the import dialog, a plugin automation action, commands, connections, fallbacks, phone | ADR-084 (EXT-01..08) |

Sample content is fictional (Acme Docs; publishers Northbeam Labs, Fieldnote Software, Kestrel Dev,
Relay Works, Typeset Co, Lingo Bridge). Product names such as Confluence, Obsidian and GitHub appear
only as the thing a plugin imports or connects to; no brand logos are used (icons policy).
