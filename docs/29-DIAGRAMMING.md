# 29 — Structured diagramming: Phase 0 and Phase 1

**Status:** Phase 0 (benchmarks, ADRs) and Phase 1 (graph core) built 2026-11-24, owner approval of
the workstream 2026-11-24. ADR-045, ADR-046 and ADR-047 were **accepted by the owner on 2026-11-24**,
ADR-045 on one condition: `props` merges per field (DGM-16, §3).
Source: the owner's *OpenCanvas Structured Diagramming Extension* design (24 November 2026) and the
review points accepted with it, which override the design where they differ (§1).
Tracker: DGM-* rows in [docs/10](10-EXECUTION-TRACKER.md).

## 1. Review points that override the design

| # | Point | Where it lands |
|---|---|---|
| 1 | A board is a block inside a document, not a standalone file. Per-board size budget against `max_doc_bytes` (20 MB default, `crates/oc-server/src/config.rs`) | §4, ADR-045 |
| 2 | Server-side rendering: `export.rs` (`board_info`) and `preview.rs` render boards; every new shape type needs a Rust render path or a defined fallback | ADR-045, DGM-08 |
| 3 | Incremental projection first (v0.1.1: `observeDeep` → `readShapes` → `toJSON` on every change) | DGM-05, §3 |
| 4 | Bundle: initial JS 280 of 300 KB gzip. ELK lazy in a worker; ELK is EPL-2.0 (needs a licence check, we are Apache-2.0), Dagre is MIT. Phase 1 adds no layout dependency | ADR-047; Phase 1 adds no dependency at all |
| 5 | Imports reuse the FC-10 pipeline (5 MB limit, SEC-39). Out of scope for Phase 1 | Phase 3 |
| 6 | Diagram mode is per board (a board opening full-screen as a diagram), not editor-wide | ADR-045 |
| 7 | Test first: an older client editing a shape keeps fields it does not understand | DGM-07, done first |

UI gate (ADR-011): Phase 1 has no visual or UI change. Stencil panels, inspector, the diagram-mode
chrome and an editor placeholder for unknown types wait for prototypes.

## 2. Benchmarks (DGM-01, DGM-02)

**Fixtures.** `web/packages/board/bench/fixtures.ts`: deterministic boards of N nodes (rect, ellipse,
diamond, sticky in turn, on a 220 × 160 grid, short labels) and `round(N × edgeDensity)` bound
connectors (`edgeDensity` 1.5 by default; 80 % between grid neighbours, 20 % random; 50 % elbow;
10 % labelled). Same options, same document on every machine.

**Run.** `pnpm --filter @opencanvas/board bench` (both files) or one file:
`npx vitest run --config bench/vitest.config.ts bench/projection.measure.ts`. Variables:
`BENCH_SIZES` (default `1000,5000,10000`), `BENCH_EDITS` (200), `BENCH_RENDER_SIZES` (`1000,5000`),
`BENCH_LABEL` (result file suffix). Results: `web/packages/board/bench/results/*.json`.

**Machine.** Apple M4, 10 cores, 16 GB, macOS 26.3, Node 24.22.1. Other agents were compiling Rust
on the same machine during the runs (load average 9-13), so absolute times are noisy; each
before/after pair was measured in the same run (projection) or back to back (render, two rounds).

**Workload.** Remote transactions from a second Y.Doc, each moving one random node by 10 px (a
collaborator dragging, one committed step per update), applied to the measured doc. "Before" is the
v0.1.1 projection kept verbatim in `bench/legacy.ts` plus `withResolvedArrows`; "after" is
`BoardProjection` plus `createArrowResolver`.

### 2.1 Projection cost per edit (`projection.measure.ts`, 200 edits, ms)

| nodes / edges | before p50 / p95 | after p50 / p95 | shapes re-read per edit | connectors resolved per edit (arrow time p50 before → after) |
|---|---|---|---|---|
| 1,000 / 1,500 | 1.36 / 2.24 | 0.003 / 0.007 | 2,500 → 1 | 1,500 → 2.7 (0.44 → 0.012) |
| 5,000 / 7,500 | 8.32 / 10.32 | 0.012 / 0.020 | 12,500 → 1 | 7,500 → 2.6 (2.89 → 0.116) |
| 10,000 / 15,000 | 18.58 / 23.74 | 0.065 / 0.109 | 25,000 → 1 | 15,000 → 2.9 (6.07 → 0.268) |

Re-run at 10k after DGM-16 (per-field `props`): 0.058 / 0.104 ms after, 18.40 / 20.90 ms before
(`bench/results/projection-10k-props.json`); the fixture has no `props`, so this checks the projection path.

First projection (cold) is unchanged: 2.4 / 11.1 / 22.0 ms before, 2.7 / 11.4 / 24.4 ms after.

### 2.2 Render commits per remote transaction (`render.measure.tsx`, jsdom, 40 edits)

jsdom has no layout, so the board is 0 × 0 and viewport culling is off: every shape renders (the
browser's worst case, and what it does for boards of up to 300 shapes). Times are React in jsdom,
not paint. "Before" ran with `src/BoardBlock.tsx` replaced by
`git show v0.1.1:web/packages/board/src/BoardBlock.tsx`, "after" with this branch's, back to back,
`BENCH_LABEL=before-r<n>` / `after-r<n>`. Round 2 shown (round 1 agrees within noise: 1k move
18.3 → 8.2 ms, 5k 86.1 → 25.5 ms).

| nodes / edges | workload | commits per edit before → after | React ms per edit before → after | wall p50 ms before → after |
|---|---|---|---|---|
| 1,000 / 1,500 | move one node | 1 → 1 | 14.98 → 7.95 | 21.5 → 4.8 |
| 1,000 / 1,500 | rewrite a node's text with the same value | 1 → 0 | 14.05 → 0 | 21.2 → 0.04 |
| 1,000 / 1,500 | edit another board / document text | 0 → 0 | 0 → 0 | 0.03 → 0.03 |
| 5,000 / 7,500 | move one node | 1 → 1 | 80.92 → 20.67 | 106.0 → 23.3 |
| 5,000 / 7,500 | rewrite a node's text with the same value | 1 → 0 | 75.54 → 0 | 101.8 → 0.04 |

The remaining per-move cost is React walking the full shape list (12,500 memoised elements at 5k);
culling and a scene graph separate from React (Phase 2/4, ADR-046) address that, not the projection.

### 2.3 Memory and serialized size (`projection.measure.ts`)

| nodes / edges | Yjs state | JSON | bytes per shape | share of 20 MB | update per move | doc heap | projection heap before → after |
|---|---|---|---|---|---|---|---|
| 1,000 / 1,500 | 0.40 MB | 0.34 MB | 161 | 2.0 % | 28 B | 6.2 MB | 1.4 → 2.2 MB |
| 5,000 / 7,500 | 2.16 MB | 1.72 MB | 173 | 10.3 % | 32 B | 29.2 MB | 6.2 → 10.4 MB |
| 10,000 / 15,000 | 4.44 MB | 3.55 MB | 178 | 21.2 % | 33 B | 57.8 MB | 10.9 → 20.8 MB |

"Projection heap" includes the arrow resolver's indexes (node → connectors, positions). The extra
~1 KB per shape at 10k is the price of O(1) updates; it is below the doc's own heap by a factor 3.

### 2.4 Spatial index (`SpatialIndex`, 1920 × 1080 viewport, 200 queries, ms p50)

| nodes / edges | build | viewport query: linear filter → index | one move update |
|---|---|---|---|
| 1,000 / 1,500 | 3.2 | 0.20 → 0.05 | 0.002 |
| 5,000 / 7,500 | 13.8 | 1.17 → 0.10 | 0.002 |
| 10,000 / 15,000 | 31.3 | 2.09 → 0.12 | 0.002 |

Not yet wired into culling or hit testing (DGM-11, Phase 2), so no editor behaviour depends on it.

### 2.5 Not measured yet

Browser frame times (p50/p95/p99 during pan, zoom and drag) need a Playwright trace on a fixed
machine: DGM-10. Network bytes per collaboration update are the "update per move" column only
(one move per transaction); drag throttling is unchanged from v0.1.1.

## 3. Phase 1: graph core (all in `web/packages/board/src`, non-visual)

| Module | What it does |
|---|---|
| `projection.ts` | `BoardProjection`: a `useSyncExternalStore` store; re-reads only the shapes a transaction touched (from `observeDeep` event paths), rebuilds paint order only when membership or `order` changed, keeps unchanged shapes and an unchanged list as the same objects. Equal to `readShapes` (25-seed fuzz with remote merges) |
| `edges.ts` | `edgeOf` / `edgePatch` (semantic edge ↔ legacy arrow fields), `EdgeIndex` (node → connectors), `orphanEnds`, `createArrowResolver` (re-resolves only connectors whose shape or bound shapes changed; equal to `withResolvedArrows`, 20-seed fuzz) |
| `registry.ts` | Declarative shape registry: `core:<type>` for the nine legacy types, `registerShape` (namespaced kinds on a box base type, frozen, no functions), `descriptorOf` (kind → base type → `core:unknown`), `makeNode` |
| `ports.ts` | Ports: the five legacy anchors as ports at exactly `anchorPoint`; custom ports as box fractions; `anchorFor` degrades a port to the side it is nearest; `bindingTo` writes `{shapeId, anchor, port}` |
| `spatial.ts` | `SpatialIndex`: uniform grid hash, O(1) moves, huge boxes in a side list; equal to a linear scan under inserts, moves and deletes |
| `BoardBlock.tsx` | `useShapes` uses `BoardProjection`; `Board` uses `createArrowResolver`. Nothing else changed: same markup (render-identity test) |
| `model.ts` | *(DGM-16, owner condition)* `props` stored as a nested Y.Map, one key per property; `addShape` converts a plain `props`, `updateShape`/`moveShapes` merge a `props` patch per field (`undefined` removes one) and convert a plain-form `props` first. Concurrent edits of different properties merge (`compat.test.ts`); the Rust readers accept both forms (`oc-model/tests/diagram.rs`) |
| `ops.ts` | Paste keeps every binding field (was rebuilt as `{shapeId, anchor}`, dropping `port`) |
| `export.ts`, `crates/oc-model/src/board.rs` | Unknown type with a box: drawn as a rect with its text in both exporters (shared fixture). Kinds draw as their base type. Existing output byte-identical (`board.web.svg` unchanged) |

Bundle: initial JS unchanged at 280.2 KB gzip; the lazy board chunk grows 28.2 → 29.8 KB gzip.

## 4. Per-board size budget (review point 1)

A board lives in a document capped at `max_doc_bytes` (20 MB default, `OC_MAX_DOC_MB`). The room
refuses an update past the cap. Budget (ADR-045): **one board up to 25 % of
`max_doc_bytes` (5 MB at the default)**, which holds the 10,000-node / 15,000-edge target with short
labels (4.44 MB measured) and leaves room for text, databases and history. Bytes per shape grow with
text and `props`; the budget is in bytes, not shapes. Enforcement is Phase 2 (a warning near the
budget needs UI; the server only knows the whole document's size). Each committed move adds ~30
bytes of update; Yjs garbage collection keeps deleted values as small ranges, but a long session of
drags grows the state, which is why drags stay throttled.

## 5. Phase 2 and later

| Item | Phase |
|---|---|
| Renderers learn ports (web `resolveArrow` and Rust `resolve_arrow`, parity fixture); until then every renderer draws a port binding at its `anchor` | 2 |
| Wire `SpatialIndex` into culling, `snapTarget` and marquee; profile in a browser (DGM-10) | 2 |
| Obstacle-aware orthogonal routing (ADR-047), worker with cancellation if measured cost needs it | 2 |
| Per-board budget warning; per-board diagram mode, stencils, inspector, editor placeholder for unknown types: prototypes first (ADR-011) | 2 |
| `syncBoundArrows` still reads the whole board on each commit; use the projection and `EdgeIndex` | 2 |
| Layout (Dagre first; ELK only after a licence review and as a lazy worker chunk), Mermaid and draw.io import through FC-10 | 3 |
| 5k/10k browser stress, multi-client fuzz with diagram fields | 4 |
