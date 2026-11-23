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

### 2.5 Browser frame times

Measured in Phase 2 (DGM-10): §6. Network bytes per collaboration update are the "update per move" column only
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
| Renderers learn ports (web `resolveArrow` and Rust `resolve_arrow`, parity fixture) | 2, done (§6.3) |
| Wire `SpatialIndex` into culling, `snapTarget` and marquee; profile in a browser (DGM-10) | 2, done (§6.1, §6.2) |
| Obstacle-aware orthogonal routing (ADR-047) | 2, minimal (§6.4); worker, Rust port / stored-`pts` export rule, narrower commit set: 3 |
| Per-board budget warning; per-board diagram mode, stencils, inspector, editor placeholder for unknown types: prototypes first (ADR-011) | 2 (prototypes in progress elsewhere) |
| O(n) per change left: projection and resolver copy the full list (10k `drag20` 20 ms); scene layer separate from React and level-of-detail for the fit view (10k pan 68 ms) | 3 |
| `syncBoundArrows` reads the whole board on each commit; use the projection and `EdgeIndex` | 2, done (`syncArrows`, §6.2) |
| Layout (Dagre first; ELK only after a licence review and as a lazy worker chunk), Mermaid import through FC-10 | 3 (draw.io and Excalidraw import: done, §7) |
| 5k/10k browser stress, multi-client fuzz with diagram fields | 4 |

## 6. Phase 2 (engine only, built 2026-11-24)

No UI change (ADR-011): no new controls; nothing sets `routing: "avoid"` but the model API.

### 6.1 Browser frame times (DGM-10)

**Harness.** `e2e/perf/board-frames.perf.ts`, own config, not in the e2e suite:
`cd e2e && npx playwright test -c perf/playwright.config.ts` (`E2E_SKIP_BUILD=1` reuses
`web/packages/editor/dist`; `PERF_DIST=<dir>` serves another build; `PERF_SIZES`, `PERF_LABEL`,
`PERF_TRACE=1` saves a Chromium trace per scenario). It serves the production editor bundle and opens
`/app/#demo&sim=quiet` (the real editor with a local Y.Doc, no server), fills the demo board with the
`bench/fixtures.ts` board in one transaction and opens it full screen (1280 × 900, headless
Chromium 159). Scenarios: `pan` (120 wheel events, 8 ms apart, 100 % zoom), `zoom` (30 Ctrl+wheel
steps to ~25 % and back), `drag1` (one node, 120 pointer moves 8 ms apart, release), `drag20` (20
selected nodes, same), `remote` (another peer's transaction every 16 ms for 2 s, each moving 5 random
nodes; same doc, foreign origin, so no network), `panFit` / `drag1Fit` (the whole board on screen).

**Metrics.** rAF interval p50/p95/p99; *latency*: each pointermove / wheel (from its `timeStamp`) or
remote transaction to the first task after the next frame (its work plus the wait for that frame;
headless Chromium keeps a 60 Hz rAF cadence while input queues, so latency is the number that
moves); long tasks (PerformanceObserver: none over 50 ms in any run); `release`: pointerup to after
the next frame (the commit). Heap after a forced GC.

**Machine and load.** Apple M4, 10 cores, 16 GB, macOS 26.3, Node 24.22.1, other agents building on
the same machine. "Before" = this branch's parent (`frames-before.json`, load average 4.2); "after" =
with DGM-11 (`frames-after-dgm11.json`, load 2.8). A final run with DGM-12/13 too
(`frames-after.json`) ran at load 7.0 and is noisier (10k `panFit` p50 146 ms; the other rows agree
with the table within a few ms); its numbers are not used for comparisons.

Latency in ms (input to the frame after it), before → after DGM-11; release = commit to next frame:

| nodes / edges | scenario | latency p50 / p95 / p99 ms, before → after | rAF p95 / p99 ms, before → after | frames > 25 ms | release (commit) ms |
|---|---|---|---|---|---|
| 1,000 / 1,500 | pan | 23.7 / 33.4 / 43.5 → 24.1 / 25.6 / 26.4 | 16.8 / 16.8 → 16.7 / 16.8 | 1 → 0 |  |
| 1,000 / 1,500 | zoom | 24.6 / 26 / 32.1 → 24.9 / 27 / 40.7 | 16.8 / 16.8 → 16.8 / 16.8 | 0 → 0 |  |
| 1,000 / 1,500 | drag1 | 5.7 / 14.1 / 18.5 → 6 / 7.5 / 17.6 | 16.8 / 16.8 → 16.8 / 16.8 | 0 → 0 | 5.4 → 4.8 |
| 1,000 / 1,500 | drag20 | 5.8 / 7.3 / 17.9 → 6.1 / 7.5 / 17.1 | 16.7 / 16.8 → 16.7 / 16.8 | 0 → 0 | 5.4 → 4.5 |
| 1,000 / 1,500 | remote | 9.3 / 18.1 / 18.8 → 9.7 / 17.7 / 18.4 | 16.7 / 16.8 → 16.7 / 16.8 | 0 → 0 |  |
| 1,000 / 1,500 | panFit | 21.9 / 25.7 / 26.4 → 23.4 / 25.9 / 33.8 | 16.7 / 16.8 → 16.8 / 16.8 | 0 → 0 |  |
| 1,000 / 1,500 | drag1Fit | 21.7 / 23.3 / 24.5 → 22.2 / 23.4 / 23.6 | 16.7 / 16.8 → 16.7 / 16.8 | 0 → 0 | 16.4 → 19.1 |
| 5,000 / 7,500 | pan | 25.6 / 27 / 27.6 → 24.5 / 25.9 / 26.4 | 16.8 / 16.8 → 16.8 / 16.8 | 0 → 0 |  |
| 5,000 / 7,500 | zoom | 26.1 / 44 / 59.3 → 25.3 / 42.7 / 44.2 | 16.8 / 16.8 → 16.7 / 16.8 | 0 → 0 |  |
| 5,000 / 7,500 | drag1 | 5.7 / 21.4 / 22.5 → 5.8 / 7.3 / 18.7 | 16.7 / 16.8 → 16.8 / 16.8 | 0 → 0 | 13.6 → 4.3 |
| 5,000 / 7,500 | drag20 | 22 / 23.1 / 23.9 → 5.9 / 17.8 / 20.3 | 16.7 / 16.8 → 16.8 / 16.8 | 0 → 0 | 16.8 → 3.8 |
| 5,000 / 7,500 | remote | 9.3 / 21.2 / 22 → 9.9 / 17.9 / 18.7 | 16.7 / 16.8 → 16.8 / 16.8 | 0 → 0 |  |
| 5,000 / 7,500 | panFit | 23.8 / 48.7 / 62.8 → 23.4 / 48.2 / 62.4 | 16.7 / 16.8 → 16.7 / 16.8 | 0 → 0 |  |
| 5,000 / 7,500 | drag1Fit | 21.5 / 23.5 / 37.8 → 21.9 / 24 / 25.1 | 16.7 / 16.8 → 16.7 / 16.8 | 0 → 0 | 35.6 → 33.4 |
| 10,000 / 15,000 | pan | 26.9 / 42.3 / 43.4 → 24.8 / 25.9 / 26.8 | 16.8 / 16.8 → 16.7 / 16.8 | 0 → 0 |  |
| 10,000 / 15,000 | zoom | 27.8 / 45.2 / 45.8 → 41.4 / 44.2 / 45.4 | 16.8 / 16.8 → 16.8 / 16.8 | 0 → 0 |  |
| 10,000 / 15,000 | drag1 | 22.1 / 23.6 / 24.2 → 5.5 / 20.7 / 21.8 | 16.8 / 16.8 → 16.8 / 16.8 | 0 → 0 | 24.8 → 5.7 |
| 10,000 / 15,000 | drag20 | 21.8 / 23.1 / 24.5 → 20 / 21.7 / 22.4 | 16.7 / 16.8 → 16.8 / 16.8 | 0 → 0 | 24.1 → 5.8 |
| 10,000 / 15,000 | remote | 9.9 / 24.5 / 26 → 9.4 / 18.7 / 19.9 | 16.8 / 16.8 → 16.8 / 16.8 | 0 → 0 |  |
| 10,000 / 15,000 | panFit | 67.7 / 86.8 / 103.2 → 68.8 / 102.1 / 124 | 16.8 / 16.8 → 16.8 / 33.3 | 3 → 8 |  |
| 10,000 / 15,000 | drag1Fit | 38.3 / 51.7 / 53.5 → 38.4 / 49.7 / 52.3 | 33.4 / 33.4 → 33.4 / 33.4 | 62 → 90 | 59.9 → 56.8 |

DOM shapes drawn: 339 / 694 / 1,151 at 100 % (1k / 5k / 10k); 2,500 / 12,500 / 16,886 at the fit view.
Heap after load: 26.6 / 74.6 / 122.5 MB before, 27.6 / 80.1 / 133.7 MB after (scene and route indexes).

**Reading.** At 100 % zoom the board is not renderer-bound at any size: the remaining per-move cost
at 10k was O(board) work per change (a new `byId` map, the culling filter, a full re-read on commit),
which DGM-11 removes: drag one node 22 → 5.5 ms p50, commit 24.8 → 5.7 ms. `drag20` at 10k (20 ms)
is the next O(n) item: the resolver and projection still copy the 25k-entry list per change. With the
whole 10k board on screen (16,886 DOM shapes) a pan costs ~68 ms and a drag ~38 ms per frame, unchanged
by DGM-11 (it is DOM and React size). Per ADR-046 the next step is the scene layer separate from React
chrome and level-of-detail at low zoom; nothing here argues for Canvas2D/WebGL at 1k (every 1k
scenario is within one frame plus input alignment).

### 6.2 Spatial index wired in (DGM-11)

`src/scene.ts` `SceneIndex`: the drawn shapes (connectors resolved) in a `SpatialIndex`, updated by
object identity from one shapes array to the next. Culling (`visible`), marquee (`inBox`) and connector
end snapping (`snap`) query it; each gives exactly what the linear scan gave, in paint order (the index
is a pre-filter, candidates are checked with the original predicate; non-finite boxes live in a side
list). `byId` is kept in place. Commit: `syncArrows(doc, board, ids)` reads only the given connectors
and the shapes they bind; the board passes the changed shapes, `EdgeIndex.affectedBy` of them, and the
resolver's `stale` set (connectors whose stored `pts` already differ), which equals `syncBoundArrows`
while the view is current. Tests: `scene.test.tsx` (25-seed fuzz against the scans incl. odd boxes;
15-seed `syncArrows` vs `syncBoundArrows`; the board calls the index; a nudge on a 1,500-node board
reads < 100 shapes, was 3,754), `render-identity.test.tsx` (culled board after 90 local and remote edits
draws the same markup as a fresh mount at the same view).

### 6.3 Ports in both renderers (DGM-12)

A binding `{shapeId, anchor, port}` is drawn at the port when the bound shape *stores* that port
(`ports`), leaving from the port's side (else its nearest edge; ties top, right, bottom, left); a
missing port, an empty one or a legacy id in `port` draws at `anchor`, which is what 0.1.x clients
always do. Registry default ports are not visible to the Rust renderer, so `makeNode` now stores a
kind's default ports on the shape. Web `portEnd` (ports.ts), Rust `port_end` (board.rs); shared
fixture `crates/oc-model/tests/fixtures/board-ports.json` with the resolved points
(`board-ports.resolved.json`, Rust `board::resolved_points`) and the exported SVG
(`board-ports.web.svg`), both byte-equal. `board-diagram.web.svg` changed for its one port binding.

### 6.4 Obstacle routing (DGM-13, minimal)

Owner scope cut 2026-11-24: a minimal deterministic version, no worker, no Rust port.
`src/router.ts`: stubs of `CLEARANCE` (16) along each end's side, then A* on a sparse orthogonal grid
(stub coordinates, region border, obstacle edges grown by the clearance), cost = length + 30 per bend,
integer arithmetic, tie-break (f, h, state number). Region: stubs' box + 160, then + 640; more than 160
obstacles or no route gives `null` and the plain elbow. Waypoints (`via`) keep `elbowVia`.
`src/routing.ts` `AvoidRouter`: replaces the points of `route: "elbow"` + `routing: "avoid"`
connectors in the resolved list; re-routes only connectors whose ends changed (`EdgeIndex`) or whose
route region meets a changed obstacle's old or new box (region `SpatialIndex`); `budget` defers the
rest (plain elbow meanwhile), `RouteScheduler` routes them in main-thread chunks with job versions and
batch cancellation. `BoardBlock`: budget 64, 0 while dragging (scheduler throttled to 100 ms), a full
pass when the drag ends; the commit routes avoid connectors against the committed state and stores the
route in `pts`. Tests (`routing.test.tsx`): a box between two ends is avoided; 150-seed determinism in
shuffled obstacle order with no obstacle crossed; 10-seed × 15-edit incremental = from-scratch routing
(about half the routes recomputed); deferred results with stale versions dropped; the scheduler; the
board draws and commits the route (seen failing first: drew `M100 30 L400 30`). Readers without a
router (0.1.x, both exporters) draw the plain elbow.

## 7. Diagram import: draw.io and Excalidraw (DGM-15, built 2026-11-24)

Owner request 2026-11-24. Through the FC-10 pipeline (`POST /v1/import`, 5 MB `MAX_IMPORT_BYTES`,
SEC-39, host `import_formats`, `OC_IMPORT=off`): a **dry run** first (`dryRun=1`, the report of
approved frame 7b), then the import, then "Undo import" (7e). Converter:
`crates/oc-model/src/diagram_import/` (server only; the editor bundle only gains the dialog
states). Dependencies: ADR-048 (Proposed). Mermaid (frame 7c) is not built yet.

**Result.** From a document: a new board block after the caret block (or at the end), shapes moved
so the top left is at (40, 40), relative positions kept. With `boardId`: added to that board, to
the right of its shapes (80 px gap). Every shape gets a new id; bindings, `group` and
`props.parent` follow. Each shape keeps `props.source` (`drawio`/`excalidraw`) and
`props.sourceId` (its id in the file); `props` is the per-field map of ADR-045.

**Report.** Counts (shapes, connectors, need a look = warning items), then one row per kind of
change, warnings first, with up to three examples by name and "and N more". Codes: `stencil`,
`shape_box`, `image_large`, `image_svg`, `image_type`, `image_link`, `link`, `embed` (warnings);
`page_other`, `curved`, `colour`, `dashed`, `stroke_width`, `font`, `text_style`, `rough`,
`fill_style`, `opacity`, `effects`, `rotation`, `arrowheads`, `nested_groups`, `layers`,
`pen_thinned`, `unbound`, `data` (approximations); `containers`, `groups`, `elbow`, `lines`,
`images` (kept). Nothing is dropped without a row (AGENTS.md rule 7).

### 7.1 Support matrix

| Source | Becomes | Kept exactly | Approximated (reported) | Not imported (reported) |
|---|---|---|---|---|
| draw.io file structure | `mxfile` → `diagram` → `mxGraphModel`, inline or compressed (base64 → raw deflate → URL-decoding); a bare `mxGraphModel` (`.xml`) | One page per import, chosen in the report | Layers are flattened (paint order kept) | Other pages ("Page 2, “Sequence”, is not imported") |
| draw.io vertex, default / `rounded` / `process` | `rect` | Position (absolute, through parent groups), size, label, colour family | Fill colour → nearest board tone (`#dae8fc → Blue`) | — |
| `ellipse`, `doubleEllipse` / `rhombus` | `ellipse` / `diamond` | as above | as above | — |
| `text` | `text` | Text, font size | — | — |
| Group (`group`), `swimlane`, `container=1`, any vertex with children | Container: dashed `rect` with the name as `label`; children carry `props.parent` | Membership, position, size | Container fill | — |
| Vendor stencils `mxgraph.*` (AWS, Azure, Google Cloud, Kubernetes, Cisco, …) | Plain `rect` with the label (or the icon's name), `props.stencil` = the stencil id | Size, position, connections, label | — | The icon itself (never fetched or bundled; icons policy) |
| Other shapes (`cylinder3`, `hexagon`, `cloud`, `note`, …) | `rect` with `props.shape` | Text, size, connections | Outline shape ("Cylinder: orders-db") | — |
| Embedded image (`shape=image;image=data:…`) | `image` (re-encoded `data:` URL) | Bytes, size, position | — | SVG, non-PNG/JPEG/GIF/WebP bytes, over 2 MB: a dashed box keeps the place |
| Linked image (`image=https://…`) | Dashed box with the name | Position, size | — | The image (never fetched) |
| Edge with `source`/`target` | `arrow` bound to both shapes | Ends, label (incl. `edgeLabel` children), waypoints → `via`, exit/entry side → anchor | `curved=1` and other edge styles → elbow | Start arrowheads and arrowhead styles |
| `edgeStyle=orthogonalEdgeStyle` (and elbow/ER/segment styles) | `route: "elbow"` | Waypoints | — | — |
| Edge without ends | Free `arrow` from `sourcePoint` to `targetPoint` | Points | Ends to a missing shape → free connector | — |
| HTML labels (`html=1`) | Plain text; `<br>`, `div`, `p` → line breaks; entities decoded | Text | Bold, italic, colours, alignment | `script`, `style`, `svg`, `iframe` content; links |
| Style | `fill`, `dashed` (unfilled rects), `size` | — | `strokeWidth`, `fontFamily`, `fontStyle`, `rotation`, opacity, `sketch=1`, shadow/gradient, dashed outlines on filled shapes | — |
| `UserObject` / `object` | Its `label` and `id` | — | — | `link` (incl. `javascript:`), tooltips and custom data ("custom properties") |
| Excalidraw file | `{type: "excalidraw", elements, files}`, any version | — | — | `isDeleted` elements (skipped, they are deleted in the source) |
| `rectangle` / `ellipse` / `diamond` | `rect` / `ellipse` / `diamond` | Position, size, bound label | Background colour, else stroke colour → nearest tone; hachure/cross-hatch → solid | — |
| `text` with `containerId` | The container's label (shape or arrow) | Text, font size | — | — |
| `text` | `text` | Text, font size | Font → board font | — |
| `arrow` (and `line` with bindings) | `arrow`; `startBinding`/`endBinding` → bound ends (`center`) | Points (middle points → `via`), label | `elbowed` → elbow; arrowheads at the end only | — |
| `line` without bindings, `freedraw` | `pen` | Points (≤ 1,000 per stroke, longer strokes thinned) | Colour → accent | — |
| `image` (`files[fileId].dataURL`) | `image` | Bytes, size, position | — | SVG, wrong bytes, over 2 MB, missing file: a dashed box keeps the place |
| `frame` / `magicframe` | Container (dashed `rect`, name as `label`; children `props.parent`) | Membership | — | — |
| `groupIds` | `group` (the outermost group) | Membership | Groups inside groups become one group | — |
| `embeddable` / `iframe` | `rect` "Web embed" | Position, size | — | The page (never loaded) |
| Style | — | — | `roughness` (hand-drawn), `strokeWidth` > 2, `strokeStyle` on shapes that can't be dashed, `opacity`, `angle`, fonts | `link` |

### 7.2 Untrusted input

| Threat | Limit | Test |
|---|---|---|
| Large file | 5 MB before parsing (`MAX_IMPORT_BYTES`, browser and server) | `hostile_diagram_files_are_refused_with_a_reason`, e2e refusal |
| Decompression bomb | Inflated page ≤ 16 MB (`MAX_INFLATED`, read through `take`) | `decompression_bombs_and_node_floods_are_refused` (64 MB of zeros in ~64 KB) |
| Billion laughs, external entities | `roxmltree` with `allow_dtd: false`: any DTD is refused, entities never expand | `billion_laughs_and_external_entities_are_refused` (< 2 s), server and e2e |
| Deep nesting | XML depth ≤ 64 (checked without recursion); JSON nesting ≤ 128 (serde_json) | `deep_nesting_is_refused_without_overflowing_the_stack` (50,000 levels) |
| Node flood | ≤ 200,000 XML nodes; ≤ 20,000 shapes | `decompression_bombs_and_node_floods_are_refused` |
| Parent cycles | Walks bounded by a visited set | `deep_nesting_…` (cycle case) |
| Scripts in labels | Tags stripped; `script`, `style`, `svg`, `iframe`, `object` removed with their content | `labels_are_plain_text_and_scripts_links_and_svg_are_removed` |
| `javascript:` and other links | Never imported, reported | same, `drawio_vendor_stencils_…` |
| External URLs | Never fetched; linked images become boxes | same |
| Image data URLs | PNG, JPEG, GIF, WebP by signature (not the declared type), ≤ 2 MB decoded; SVG never | `image_data_urls_are_checked_for_type_and_size` |

### 7.3 Tests

`crates/oc-model/tests/diagram_import.rs` (10, golden on `tests/fixtures/import/`: flowchart,
architecture with vendor stencils and containers, compressed, bare `.xml`, multi-page, Excalidraw
with bound arrows, text in shapes, images and a frame; hostile files built in the tests), unit
tests in `diagram_import/mod.rs` (colours, HTML to text), `crates/oc-server/tests/import.rs`
(dry run adds nothing; board block with bound connectors placed at (40, 40); adding to an open
board to the right with new ids; refusals), `e2e/specs/v-import-diagram.spec.ts` (4: each format
through the dialog to a board, report, Undo import, page choice, compressed file, refusals, axe in
light and dark). Fixtures were written for these tests; no third-party diagram is copied.
