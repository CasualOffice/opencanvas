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
| Obstacle-aware orthogonal routing (ADR-047) | 2, minimal (§6.4); stored-`pts` export rule: done (DGM-12b, §6.4); worker, Rust router port, narrower commit set: deferred |
| Per-board budget warning; per-board diagram mode, stencils, inspector, editor placeholder for unknown types: prototypes first (ADR-011) | 2 (prototypes in progress elsewhere) |
| O(n) per change left: projection and resolver copy the full list (10k `drag20` 20 ms) | 3 |
| Level of detail for the fit view (10k pan 68 ms) | done (DGM-19, §6.6): 10k pan at the harness floor, 55k → 23 board SVG elements |
| `syncBoundArrows` reads the whole board on each commit; use the projection and `EdgeIndex` | 2, done (`syncArrows`, §6.2) |
| Layout (Dagre first; ELK only after a licence review and as a lazy worker chunk), Mermaid import through FC-10 | 3 (draw.io and Excalidraw import: done, §7) |
| 5k/10k browser stress | 4 |
| Multi-client fuzz with diagram fields, 0.1.1 and current clients together | done (§6.5, DGM-18) |

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
router (0.1.x) draw the plain elbow.

**Export rule (DGM-12b, ADR-047 point 3).** Every exporter draws an `avoid` connector with its stored
`pts` while they start and end exactly where its plain elbow would (bound ports or anchors, after
sticky growth) and every leg is axis-aligned, else the plain elbow: Rust SVG/PNG/PDF/preview
(`board.rs` `stored_route`), web SVG/PNG (`connectors.ts` `exportResolvedArrows`; the screen keeps
routing live), draw.io (bends only for a current route, `board::current_routes`; a stale one is a
plain orthogonal edge draw.io routes itself; Mermaid has no geometry). Shared fixture
`crates/oc-model/tests/fixtures/board-avoid.json`: connector points (`board-avoid.resolved.json`)
and SVG (`board-avoid.web.svg`) byte-equal from both exporters (`export.test.ts`, `tests/diagram.rs`);
`tests/diagram_export.rs` checks a moved shape and a diagonal leg drop the draw.io bends. All seen
failing first (Rust drew `M100 30 L250 30 L250 230 L400 230` through the wall; draw.io kept stale
bends). Still deferred: the Rust router port (not needed while `pts` is current) and the route
worker (no measurement asks for it).

### 6.5 Mixed-version collaboration (DGM-18)

`src/mixed-version.test.ts` runs deployed 0.1.1 clients against current ones on shared Yjs
documents. The 0.1.1 `model.ts`, `ops.ts` and `connectors.ts` are vendored unchanged from tag
`v0.1.1` in `web/packages/board/test-fixtures/v011/` (test-only: outside the package tsconfig,
imported only by the test, in no bundle). Four peers (two 0.1.1, two current), 24 fixed seeds, 160
edits each on a 0.1.1 flowchart board plus 8 nodes and 6 bound connectors. 0.1.1 edits: move
(with connector sync), resize, text, delete, paste (`cloneShapes` + `insertShapes`), z-order,
connector sync. Current edits: kinds, `props` per field, ports, port bindings, `routing: "avoid"`,
containers (create, move with contents), icons, board name, connector sync. Updates go to random
peers in random order with gaps while editing, then everything is delivered in a shuffled order.
Asserted per seed: identical state on every peer (sorted-key JSON and paint order); every field a
current client wrote (`kind`, `kindVersion`, each `props` key, `ports`, `routing`, a binding's
`port`, the board name) is present with a value a current client wrote, unless a 0.1.1 client
deleted the shape; every binding has a legacy `anchor`; the 0.1.1 reader returns every shape with
one of its nine types and resolves every connector to finite points; `BoardProjection` equals
`readShapes` on every peer (also every 40 edits). A last test checks every edit kind ran more than
10 times across the seeds. Deterministic: seeded PRNG for edits and delivery, seeded
`Math.random`/`Date.now` for both versions' ids, no timers.

**Data-loss bug found and fixed.** Two clients giving a shape its first `props` field at the same
time (or both converting a plain-object `props` written by a 0.1.1 copy) each created the nested
`props` Y.Map; Yjs keeps one of two concurrent values of a key, so the other client's fields were
silently dropped (14 of the 24 seeds failed on it). This broke ADR-045's per-field merge condition for the first
edit of a shape. Fix (`model.ts` `mergeProps`/`watchProps`): the client whose map lost copies the
fields it wrote into the winning map when the remote update arrives (keys the winner has keep their
value; origin `PROPS_MERGE_ORIGIN`, not an undo step). It relies on the losing client receiving the
winner's update while it still has the document open; a client that closes before that keeps the
loss. Regression tests (both cases) seen failing first. Nothing else was lost: 0.1.1 edits keep
every diagram field; 0.1.1 connector sync rewrites an `avoid` connector's `pts` to the plain elbow,
which ADR-047 already allows (`pts` is a snapshot).

### 6.6 Level of detail when zoomed out (DGM-19)

**Measured first** (harness §6.1, `PERF_ONLY=fit`: the whole board on screen; new `zoomFit` scenario:
20 Ctrl+wheel steps in from the fit view and back; `domNodesFit` = every element in the board SVG).
The 10k fit-view pan was ~68 ms p50 in §6.1 and 134.6 ms in this run (higher machine load). A Chromium
trace of the 10k `panFit` with the first LOD cut (grouped paths inside the board SVG: 40 ms p50)
showed raster, not script: four raster threads busy ~2.35 s each over the 4 s pan (`RasterTask`),
main-thread script ~1.7 ms per wheel event. DOM size was the first cost, raster of the whole board
on every pan the second.

**Built** (`src/lod.ts`, `BoardBlock.tsx` `LodLayer`, `scene.ts` `hitAt`). Below **40 % zoom on a
board of more than 300 shapes** (`LOD.z`, `LOD.min`):
- every shape is drawn by `lodGroups`: one `<path>` per style group (fill + stroke), boxes as plain
  rects (core ellipses and diamonds keep their outline), connectors and pen strokes as single
  polylines, shapes under 2 screen pixels (`LOD.tiny`) collapsed into one path of dots. No text,
  labels, icons, arrow heads, shadows or hit-target overlays. Memoised on the shapes and a zoom
  bucket (quarter octaves), so a pan re-renders nothing;
- the layer is its own `<svg>` under the (then transparent) board SVG, drawn at the bucket zoom and
  moved by a CSS `transform` with `will-change`, so the compositor pans it without rastering the
  paths again (the board background moves to that underlay while LOD is on);
- the selected and edited shapes keep their full views above it (handles, text editor);
- hit-testing is by position (`SceneIndex.hitAt`: the topmost box containing the point, else a
  connector within 6 px), for click, drag and double-click; marquee and snapping already used the
  index.
At 40 % and above nothing changes (render identity, below). Zooming back in brings the full views
and their text back.

**Visible below 40 % on boards over 300 shapes** (none at normal zoom): no text, labels, icons, arrow
heads or sticky shadows; rounded corners square; library kinds draw as plain rects; connectors draw
under the boxes (paint order is per style group); shapes under 2 px are dots; a zoom between two
buckets is the bucket's raster scaled by up to ±9 %, slightly soft until the next bucket; no
per-shape "move" cursor.

**Tests** (`lod.test.tsx`, seen failing first: `./lod` missing): at 100 %, 150 % and 200 % the board
SVG is byte-identical to a board with LOD switched off (1,200-node fixture), with no LOD layer; at
the fit view no `g[data-s]`, no `<text>`, under 60 elements in the board SVG and one subpath per
node and connector in the layer; zoom back to 50 % equals a fresh mount there with text; a click at
the fit view selects the node under it; tiny shapes collapse; `hitAt` prefers boxes.
Two existing tests looked at big boards zoomed out and now meet LOD: the DGM-11 culling identity
test zooms to ~80 % instead of ~37 % (culling is what the board does there), and the nudge-commit
test in `scene.test.tsx` switches LOD off (it clicks the node's own element; it is about the commit).

**Numbers** (`frames-before-lod.json` = `d51fbe9` build, load 9.3 / 18.4 / 15.6; `frames-after-lod.json`,
load 9.1 / 12.9 / 13.9; Apple M4, 10 cores, 16 GB, macOS 26.3, headless Chromium 159, 1280 × 900;
other agents building on the same machine). Latency p50 / p95 / p99 ms, before → after; rAF p95; frames
over 25 ms; long tasks:

| nodes / edges | scenario | latency p50 / p95 / p99 | rAF p95 | frames > 25 ms | long tasks |
|---|---|---|---|---|---|
| 1,000 / 1,500 | panFit | 24.8 / 26.4 / 27.1 → 23.5 / 24.7 / 25.5 | 16.7 → 16.8 | 0 → 0 | 0 → 0 |
| 1,000 / 1,500 | zoomFit | 41.2 / 42.7 / 43.3 → 23.5 / 25.6 / 34 | 16.7 → 16.7 | 0 → 0 | 0 → 0 |
| 1,000 / 1,500 | drag1Fit | 6.4 / 22.3 / 22.8 → 5.3 / 19.5 / 20.3 | 16.7 → 16.8 | 0 → 0 | 0 → 0 |
| 5,000 / 7,500 | panFit | 63.6 / 83.9 / 85.6 → 23.2 / 25.2 / 31.6 | 16.8 → 16.7 | 5 → 0 | 0 → 0 |
| 5,000 / 7,500 | zoomFit | 78.9 / 199.8 / 218.6 → 27.4 / 40.8 / 40.9 | 50.1 → 16.8 | 25 → 0 | 14 → 0 |
| 5,000 / 7,500 | drag1Fit | 53.6 / 60.6 / 62.5 → 20.8 / 22.8 / 23.2 | 33.4 → 16.7 | 121 → 0 | 1 → 0 |
| 10,000 / 15,000 | panFit | 134.6 / 162.7 / 168.6 → 23.6 / 25 / 25.6 | 33.4 → 16.8 | 99 → 0 | 1 → 0 |
| 10,000 / 15,000 | zoomFit | 66.3 / 197.8 / 228.9 → 27.8 / 41.4 / 41.7 | 50 → 16.8 | 19 → 0 | 8 → 0 |
| 10,000 / 15,000 | drag1Fit | 57.7 / 77.1 / 82.7 → 21.1 / 23.8 / 32.2 | 50 → 16.8 | 120 → 4 | 57 → 0 |

Board SVG elements at the fit view: 8,215 / 40,976 / 55,451 → 23 (1k / 5k / 10k; the LOD underlay
adds one `<svg>` with one path per style group). Heap after load 133.9 → 112.2 MB at 10k.
Commit after the drag (`release`): 39.9 → 28.9 ms at 10k.

**Reading.** The target was a 10k pan with the whole board in view under 16 ms p50. Frames: the rAF
interval is 16.7 ms p50 and p95 at every size, with no long task. Latency (input to the frame after
it) is 23.6 ms p50 at 10k, the same as 1k (23.5) and as the harness floor: with no board work the
metric still measures the wait for the next 60 Hz frame plus input alignment (§6.1), so it cannot
drop under ~23 ms here. The board adds no measurable time per pan at 10k. Not reached in the
latency sense; reached in frame time. Per ADR-046 no Canvas2D/WebGL: SVG paths in a composited
layer sufficed. The drag at the fit view still rebuilds the layer per move (O(n) path strings and a
re-raster), 21 ms p50 at 10k; splitting moving shapes out of the layer is the next step if needed.

## 7. Diagram import: draw.io and Excalidraw (DGM-15, built 2026-11-24)

Owner request 2026-11-24. Through the FC-10 pipeline (`POST /v1/import`, 5 MB `MAX_IMPORT_BYTES`,
SEC-39, host `import_formats`, `OC_IMPORT=off`): a **dry run** first (`dryRun=1`, the report of
approved frame 7b), then the import, then "Undo import" (7e). Converter:
`crates/oc-model/src/diagram_import/` (server only; the editor bundle only gains the dialog
states). Dependencies: ADR-053 (Proposed). Mermaid (frame 7c) is not built yet.

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

## 8. Diagram editing UI (DGM-14, built to the approved prototype)

Prototype: `docs/prototypes/diagram-approved/DiagramScreens.html` (approved 2026-11-24, recommended
options). Code: `web/packages/board/src/diagram/` (its own lazy chunk `diagram`, loaded the first time
someone opens a board as a diagram; nothing in the initial bundle). Browser specs:
`e2e/diagram/` (own config, production build in `#demo`, no server stack:
`cd e2e && npx playwright test -c diagram/playwright.config.ts`).

### 8.1 Entering and leaving (S1, DGM-14.1)

- The block's top cluster gets a labelled **Diagram** button between Redo and Options; under 560 px
  of board width it folds into the options menu. The menu always has **Open as diagram ⇧D**, and
  ⇧D works while the board has focus.
- The diagram window grows from the block's rectangle to the full window in 220 ms (`clip-path`
  animation), the side panels slide in last; with `prefers-reduced-motion: reduce` it switches at
  once. Leaving runs it in reverse. The document stays mounted under it (the block keeps a placeholder
  of its own height), so the scroll position is unchanged.
- Top bar: Back to document, the document title (its first heading 1) and the board name, people
  on this board, Undo, Redo, the board options menu. Esc with nothing selected leaves (5d); the canvas
  deselects first. Leaving puts focus back on the Diagram button and shows "Back in the document".
- Per person: diagram mode is React state in one view. Nothing about it is written to the document
  (`diagram.test.tsx` compares the encoded state before and after); other views of the same board
  keep the ordinary whiteboard.
- Board names (1d): optional `name` string on the board map (`boards/<id>.name`), set in the
  diagram's settings panel; additive, ignored by older clients and the exporters. Without a name
  the bar uses the heading above the block.

### 8.2 Canvas (S3, DGM-14.2, part 1)

- Grid: lines every *grid size* (20 by default, hidden when closer than 6 screen px) and major lines
  every 100 board units, instead of the whiteboard's dots. Rulers along the top and left in board
  units, labelled every 10/20/50/100/… so labels are at least 60 px apart; the selection's span is
  highlighted.
- Settings (right panel with nothing selected; per person, not stored): Show grid, Grid size, Show
  rulers, Snap to grid, Snap to other shapes ("Shows guides and equal gaps"), New connectors
  (Straight, Elbow, Avoid shapes).
- Moving: alignment to other shapes' edges and centres (as on the whiteboard) wins on its axis; then
  equal spacing between the two neighbours on an axis (`equalGapOffset`, pink marks with the gap);
  then the grid (`gridOffset`, top-left corner). ⌥ moves freely.
- Ports: pointing at a shape shows its side ports (`portsOf`: the four sides, the kind's ports and the
  shape's own). Dragging from one draws a connector; over another shape the nearest side port snaps.
  The connector stores `bindingTo` (port plus the legacy `anchor`); Avoid shapes stores
  `route: "elbow"` + `routing: "avoid"` and is drawn by the existing router (ADR-047). View-only
  people get no ports (10c).
- Containers (3f, 3g): `diagram:container`, registered in `src/kinds.ts` (base `rect`, title in
  `label`, so 0.1.x clients and both exporters draw a frame). "Container" in the selection's action
  bar wraps the selection with a 24 px margin (36 on top for the title) and places it just behind
  the lowest selected shape. In diagram mode, moving a container moves every shape whose box is
  fully inside it, nested containers and their contents included (`containedIn`); membership is
  geometric, so nothing new is stored. The ordinary whiteboard moves a container on its own.
- Bends (3e): your own bends (`via`) are drawn as diamonds in diagram mode. Dragging a segment's
  handle still inserts one bend; moving the whole segment is left.


### 8.6 Auto-layout (S6, DGM-14.6)

- Engine: Dagre (`@dagrejs/dagre` 1.1.4, MIT, ADR-047 §5), loaded by dynamic import the first time
  Auto-layout opens (`diagram/layout/load.ts`), inside the lazy diagram chunk.
- `computeLayout(dagre, shapes, options)` is pure: direction (down, right), spacing (compact 24/40,
  normal 48/72, roomy 80/120: gap between shapes / between layers), scope (the whole diagram, the
  selected shapes, inside a container), keep containers (a container is a Dagre compound node and is
  resized around its children, 24 padding plus room for its label), keep your bends (off by
  default). Nodes, parents and edges are given to Dagre sorted by id, so the same board gives the
  same layout whatever the order of its shapes. Shapes keep their sizes; the arranged group keeps
  its top-left corner. Connectors bound at both ends to arranged shapes rank the layers.
- `applyLayout` writes every position, clears the bends of those connectors (unless kept) and
  refreshes their `pts` in one Yjs transaction: one Undo restores all of it.
- Tests: `web/packages/board/src/diagram-layout.test.ts`.
- UI (`diagram/layout/AutoLayout.tsx`, frames 6a–6c): an **Auto-layout** button in the top bar
  (editors only) and ⇧L open the options (Direction Down / Right, Spacing, Arrange: the whole
  diagram / selected shapes, two or more / inside a container, Keep shapes in their containers on,
  Keep your bends off). **Preview** draws dashed outlines where shapes are now and the proposed
  boxes in accent over the canvas, with a bar ("Preview · top to bottom", "3 shapes move, 1
  container resizes.", Cancel, Apply). Nothing is written, so others don't see it. Any change to
  the board during the preview works it out again and the bar says "The board changed. The preview
  was updated." Esc cancels, Enter applies. Apply writes one transaction and toasts "Layout applied
  to N shapes. Undo puts them all back." with Undo; ⌘Z does the same.
- Bundle: Dagre is its own chunk (14 KB gz), imported by the diagram chunk when the options open.


### 8.5 Keyboard and accessibility (S5, DGM-14.5)

- Outline (5a): ⌥O or the top-bar Outline button opens it on the left. A tree of containers (frames:
  rectangles with a corner label or a dashed border that hold other shapes entirely; the smallest one
  wins) and their shapes in board order, then connectors ("A → B" or their label). ↑↓ move, → opens
  a container or goes into it, ← closes or goes to the parent, Enter selects on the canvas (one
  shared selection), F2 renames, ⌥↑/⌥↓ moves the shape before/after its sibling in the board order
  (only that id is re-inserted, so concurrent edits merge). `keyboard.ts` `outlineTree`, `siblingOf`.
- Announcements go to one polite live region of the diagram window, e.g. "Payments service,
  Rectangle, in VPC, 1 connection, selected. 3 of 5." (`announce`).
- Go to (Commands, and Enter in the outline) selects the shape and moves the view so it is in the
  middle, zoom unchanged (`canvas.reveal`, BoardBlock `revealShape`).
- Commands ⌘K / Ctrl+K (5b): one search for actions (filtered by the selection: Duplicate, Delete,
  Group, Start a connector need an editor and a selection), shapes (Go to) and help. The best match
  is first; typing a shape's name jumps to it. Actions run as the canvas's own shortcuts, dispatched
  on the canvas, so there is one implementation of each.
- Keyboard connector (5c): C on the canvas with one shape selected. Targets in order of distance
  (Tab, ⇧Tab), arrows pick the target's side, Enter connects in the "New connectors" style, Esc
  cancels. The hint bar sits over the canvas while connecting.
- Shortcuts sheet (5d): ?; also from Commands.
- Focus: 2.5 px (`.15625rem`) accent ring with a 2 px offset everywhere in the window, the canvas
  included (the board's own ring uses `--accent-ring`, 28 % alpha). Chrome draws outline widths in
  whole device pixels: 2 px at DPR 1, 2.5 px at DPR 2. Browser spec:
  `e2e/diagram/s5-keyboard.spec.ts` (axe on the outline, Commands, connecting, shortcuts).



### 8.4 Properties panel, something selected (S4, DGM-14.4)

Code: `diagram/props/` (`Properties.tsx`, `fields.ts`, `styles.ts`), in the lazy diagram chunk. The
shell shows it in the right panel whenever the selection is not empty; with nothing selected the
diagram's settings stay. Every input writes **one key**: a shape key (`text`, `fill`, `kind`, `route`,
`routing`, `dashed`) or one `props` key through `updateShape`, which merges `props` per field
(ADR-045), so two people editing different fields of one shape both keep their change
(`properties.test.tsx` merges two docs). Text inputs write on blur or Enter; Esc restores.

| Selection | Sections | `props` keys |
|---|---|---|
| UML class (`uml:class`, `uml:interface`, `uml:enumeration`) | Class (Name = `text`, Stereotype, Abstract), Attributes, Methods | `stereotype`, `abstract`, `attributes`, `methods` (lists of `{vis, name, type}`) |
| ERD entity (`erd:entity`) | Entity (Name, Note), Columns (key – / PK / FK, name, type; FK asks for References; Can be empty), Relationships (from the connectors bound to it, "many to one" from their cardinality) | `note`, `columns` (list of `{key, name, type, ref?, nullable?}`) |
| Network node (`net:*`) | Text (Name, Detail), Shape (Kind, Colour), Connections (in / out) | `detail`; Kind writes only `kind`, so name, colour and connections (bindings by id) stay |
| Connector | Ends (shape · port), Label, Route (Straight / Elbow, Avoid shapes), Cardinality when an end is an ERD entity, else Line (start/end arrowhead, pattern) | `startCard`, `endCard`; `startArrow`, `endArrow`, `pattern` (also writes `dashed` for older readers) |
| Several shapes, or other shapes | Text (text size, colour); a value that differs shows "Mixed" and writes to all | — |

Lists reorder by dragging the grip or with ⌥↑ / ⌥↓ on a row (the list is one `props` key). View-only
people get the same sections read only, without add, remove or grips (10c). Not yet: the canvas
drawing of the new `props` (compartments, column rows, cardinality marks, arrowheads) is S2/S3's
renderer work; the panel writes the fields.

### 8.3 Shapes panel (S2, DGM-14.4, step 1)

- Libraries are registry data (`src/libraries.ts`, loaded with the board package so every client
  draws them): Flowchart (process, decision, start or end, document, input or output, stored data,
  subprocess), UML (class, interface, enumeration, package, note), Network (server, database, load
  balancer, service, API gateway, cloud, queue, cache, client). A kind is a legacy base type plus an
  optional `look` (outline path in a 100 × 100 box, default size, tone and text), a `library` and
  search `keywords` (ADR-045 §3). The canvas draws the outline stretched to the shape; the exporters
  and 0.1.x clients draw the base type with its text.
- The left panel (editors only, 10c): a search field (`/` focuses it), then each library as a
  collapsible section with its count; which are open is remembered per person (localStorage).
  Click a tile to add the shape in the middle of the view; drag it onto the canvas to drop it there
  (centred on the pointer, on the grid when Snap to grid is on).
- Search: label prefix first, then anywhere in the label, then keywords (the matched keyword is
  shown); results grouped by library in the order of their best match, so Enter adds the first
  tile. Arrow keys move between tiles. No results: one plain message and Clear search.
- Step 2 (DGM-14.5), panel UX for about 200 shapes (the library content is owned separately in
  `libraries.ts`; `src/panel.ts` adds what the panel needs on top of it):
  - Libraries are collapsible sections with counts; the first is open until the person chooses.
    A **Libraries** chooser in the footer shows or hides libraries per person (hidden ones are
    not searched). A library kept in its own chunk gives `count` and `load` and is loaded the
    first time it is opened or someone searches.
  - Search runs over a prebuilt lower-case index (label start, then anywhere in the label, then
    keywords). Tiles: 3 columns, 32 x 24 previews with non-scaling strokes, two-line labels.
  - Recent: your last six from any library, newest first (per person).
  - BPMN shows only when the host sets `BlockEnv.diagram.bpmn`, marked Beta with an explanation
    on hover or focus. Its kinds are registered regardless, so documents with BPMN draw.
  - The Icons library (DGM-17) joins with `registerLibrary(lib, before)`.
  - Rail (2h): the panel folds to a 3rem rail (expand, search, recent, each library, outline); a
    library opens as a flyout that closes on add, Esc or a click outside.
  - Shapes / Outline are tabs (arrow keys switch); the top-bar Outline button and Alt+O pick the
    Outline tab. View-only people get the outline alone.
- Connector presets: Flow line; UML inheritance, implements, association, aggregation,
  composition, dependency; ERD one to one, one to many, many to many, zero or many. A preset is
  plain fields and `props` (`startArrow`/`endArrow`, `startCard`/`endCard`, `pattern` + `dashed`),
  the keys the properties panel edits. Clicking one connects two selected shapes in that style, or
  arms the connector tool for the next connector. The canvas draws the ends (`src/heads.ts`) and
  dashed lines; exporters draw the plain connector.
- Bends (3e): on a routed elbow without bends, its inner segments get a handle; dragging one moves
  the segment and its corners become your bends (`via`, diamonds).

- Still to come (step 2): Recent, the collapsed rail, the Icons library slot (DGM-17), drawing the
  connector presets' end markers.

#### 8.3.1 Shape libraries (DGM-14.7)

One data module per library in `src/libraries/` (`geo.ts` holds the outline helpers); 408 kinds in
16 libraries. **Every outline is our own drawing.** No vendor or brand shapes (no AWS, Azure, GCP
or logos), and no draw.io stencils, whose licence forbids derivatives: nothing was converted, traced
or copied from them. Flowchart, UML, BPMN, ERD and electrical shapes follow the public notations
(ISO 5807, OMG UML and BPMN 2.0, Chen and crow's foot, IEC/ANSI symbols).

| Library (id) | Kinds | Contents |
|---|---:|---|
| Basic shapes (`basic`) | 45 | rectangles, ellipse, circle, triangles, diamond, parallelogram, trapezoid, pentagon, hexagon, octagon, stars, cross, cylinder, cube, cloud, heart, lightning, moon, document, folded corner, callouts (rectangle, rounded, thought), block arrows, chevron, step, brackets and braces, frame, plaque, donut, block arc, pie, tape, half circle, line |
| Flowchart (`flowchart`) | 30 | the standard set: process, alternate process, decision, data, predefined process, internal storage, document, multiple documents, terminator, preparation, manual input, manual operation, connector, off-page connector, card, punched tape, summing junction, or, collate, sort, extract, merge, stored data, delay, sequential, magnetic disk and direct access storage, display, loop limit and loop end |
| UML (`uml`) | 29 | class, abstract class, interface, enumeration, object, package, component, node, artifact, actor, use case, system boundary, note, lifeline, activation, state, initial and final state, choice, fork or join, history, action, decision or merge, swimlane, frames (sd, alt, loop), send and receive signal |
| Entity relationship (`erd`) | 10 + 8 presets | entity, weak entity, table with rows, attribute, key, multivalued and derived attribute, relationship, identifying relationship, associative entity; crow's-foot and Chen connector presets |
| Network and cloud (`network`) | 39 | the nine step-1 boxes plus generic glyphs: rack, storage, object storage, firewall, router, switch, hub, access point, internet, laptop, desktop, phone, tablet, printer, user, users, gateway, API, message queue, cache node, CDN, DNS, VPN, container, pod, cluster, function, monitoring, mail server, secrets |
| BPMN (`bpmn`, **off by default**) | 19 + 3 presets | task, sub-process, start / intermediate / end events (plain, message, timer), exclusive, parallel, inclusive and event-based gateways, data object, data store, pool, lane, group; sequence flow, message flow, association |
| Mind map (`mindmap`) | 6 + 3 presets | central, main, sub and floating topic, idea cloud, callout; branch, elbow branch, relation |
| Org chart (`org`) | 6 + 2 presets | person card, role, team, assistant, open position, department; reports-to, dotted line |
| Wireframe (`wireframe`) | 15 | browser window, phone and tablet frames, button, text field, checkbox, radio, toggle, dropdown, slider, image placeholder, navigation bar, tab bar, card, modal |
| UI controls (`mockup`) | 26 | status bar, list item, search bar, segmented control, stepper, badge, avatar, toast, tooltip, scrollbar, breadcrumb, pagination, table header and row, sidebar, menu, chip, text area, date picker, icon button, floating action button, accordion, alert banner, progress bar, spinner, divider |
| Arrows (`arrows`) | 49 | block, slim, notched, striped, chevron, callout and triangle arrows in four directions; pentagon, left-right, up-down, four-way, three-way, bent, bent-up, U-turn, circular, curved, return, diagonal, split, merge, zigzag, trend, two circular, dashed, line |
| Signs and symbols (`signs`) | 38 | warning, information, question, check, cross, stop, no entry, prohibited, flag, pin, bulb, gear, lock, unlocked, key, clock, calendar, mail, phone, home, search, star, heart, thumbs up and down, bell, bookmark, tag, shield, eye, chat, add, remove, download, upload, trophy, wi-fi, power |
| Floor plan (`floorplan`) | 25 | wall, wall corner, door, double and sliding door, window, opening, stairs, room, single and double bed, table, round table, chair, sofa, armchair, desk, sink, toilet, bath, shower, stove, fridge, wardrobe, plant |
| Electrical (`electrical`) | 22 | resistor, capacitor (plain, polarised), inductor, diode, LED, battery, voltage source, ground, switch, push button, lamp, fuse, NPN transistor, op-amp, AND, NAND, OR, NOR, XOR, NOT, buffer (gates have input and output ports) |
| Server rack (`rack`) | 12 | rack cabinet (a container), 1U/2U/4U servers, switch, patch panel, storage shelf, UPS, PDU, console drawer, blank panel, cable manager (240 wide, 24 per U) |
| Charts and infographics (`charts`) | 19 | column, bar, stacked column, line, area, scatter, pie, donut, gauge, progress bar, rating, timeline marker, numbered step, funnel, pyramid, Venn, KPI card, Harvey ball, sparkline |

- **Descriptor additions** (registry, still data only): `look.box` `[x, y, w, h]` in the 100 × 100
  box is where the text goes (wrapped to its width, centred in it; default the whole shape): the
  class name in the top compartment, an actor's name under the figure, a glyph's label under the
  glyph. `container: true` makes a kind behave like `diagram:container` (moving it moves what lies
  inside): pool, lane, group, swimlane, UML frames, system boundary, browser, phone, tablet, modal,
  room, rack cabinet, department. A container added from the panel goes behind everything.
- Outlines now draw for any box base (rect, ellipse, diamond), so events and gateways fall back to a
  circle or diamond in the exporters and 0.1.x clients. Each kind's text is drawn in every renderer;
  the outline only by clients that have the library (ADR-045 §5). Shared fixture
  `board-libraries.json` (two kinds from each library): web and Rust export it byte for byte, and
  identically to the same board with `kind` removed (`libraries.test.tsx`, `oc-model/tests/diagram.rs`).
- Outlines use a non-scaling 1.5 px stroke and the tone's fill and stroke tokens, so they follow both
  themes. Bare lines (wires, chart lines, wifi arcs) are drawn out and back so they enclose no fill.
- BPMN is listed only after `setLibraryEnabled("bpmn", true)` (host or admin setting; the kinds
  always draw). `LIBRARIES` is the list the panel reads, updated in place; `ALL_LIBRARIES` has them all.
- Connector presets (`CONNECTOR_PRESETS`, by library id) are data: route, dash and named end markers
  (`one`, `many`, `zero-or-one`, …). Drawing the markers is still to come; until then a preset draws
  as a plain connector with the same route and dash.
- Size: the library data is about 26 KB gzip in the lazy board chunk, not in the editor's initial
  JS (281.3 KB / 300 after this change, unchanged).
- The properties panel uses the same namespaces as the libraries (`network:`; `erd:table` opens the
  columns panel like `erd:entity`).

### 8.8 Shapes this app can't draw (S8, DGM-14.4)

Code: `diagram/Placeholder.tsx`. `unknownOf(shape)` says why a shape can't be drawn as itself:

- **Missing library** (8a): a registered-looking kind whose namespace isn't installed and isn't one of
  the bundled libraries (`core`, `diagram`, `uml`, `erd`, `net`, `flow`, `bpmn`, `general`; those draw
  through their own panels even before their kinds are registered). Drawn by the normal renderer
  as its base `type`, with a puzzle marker on the top-right corner (`KindMarks`, one layer after the
  shapes; no hit area).
- **Unknown type** (8b): a `type` that isn't one of the nine. `ShapeView` used to draw nothing; it now
  draws `UnknownShape`: a hatched, dashed box with a puzzle icon, its own first line of text and
  "Unknown shape". It keeps `data-s`, so it is selected, moved, resized, connected and deleted like a
  box (bbox from `x/y/w/h`).
- Panel: "From a library you don’t have" / "Unknown shape", one paragraph, Name, Position and size,
  "Kept as it is (read only)" (kind and version and each `props` key, or the type, the number of kept
  fields and each one), and **Copy details** (the shape as JSON, for a support question). Writers set
  only the keys they change, so every kept field survives (tested by moving an unknown shape).

### 8.9 Size budget (S9, DGM-14.4)

Code: `diagram/Budget.tsx` (`measureBoard`, `useBudget`). A board may use 25 % of `max_doc_bytes`.
**The session does not carry `max_doc_bytes` today** (server config `OC_MAX_DOC_MB`); the shell takes
an optional `maxDocBytes` prop and otherwise uses the server default, 20 MB (5 MB per board). Passing
the real limit needs a session field (server change), not done here.

- Measuring: the board's content (`boards/<id>` as JSON) encoded as one Yjs update in a scratch doc,
  so history and other boards don't count; re-measured 600 ms after edits settle. Parts (shapes,
  connectors, text and properties, images) are each part's share of the board's JSON, scaled to the
  encoded size. The whole document's size is its current state (`encodeStateAsUpdate`), no undo
  history.
- From 80 %: an amber banner under the top bar (`role="status"`, dismissible for this session) and an
  amber chip in the top bar. Over 100 %: a red banner (`role="alert"`, not dismissible) and a red chip.
  A soft limit: nothing is blocked; only the document limit stops saving.
- The diagram's settings get a Size section (a meter with `role="meter"`, shapes and connectors).
- "What uses space" (from the banner, the chip or the Size section): totals by part, the largest
  containers (rectangles with a label, counting the shapes inside) and images with Select, and the
  whole document's size.

### 8.10 Icons (DGM-17)

Prototype: `docs/prototypes/icons-approved/DiagramIcons.html` (approved 2026-11-24, decisions 1–6 in
its README). Owner policy: OpenCanvas ships only icons it is clearly free to ship; no vendor or
product logo is bundled or offered as a pack; people add the logos they need themselves. Nothing is
taken from, traced from or modelled on draw.io's stencils (their licence forbids derivatives).

**Built-in icons (part 1).**

- Data: `icons/generic.json` at the repo root, one file shared by the editor
  (`web/packages/board/src/icons.ts`, in the board chunk) and `oc-model` (`src/icons.rs`,
  `include_str!`; the Docker image copies `icons/` into both build stages). 59 generic icons in the
  nine groups of frames 1a/1b (Compute 8, Storage and data 7, Network 11, Messaging and events 6,
  Real-time and media 5, Security and identity 5, People and clients 7, Operations 4, General 6; the
  prototype's header said 53, its group counts add up to 59; the four folded groups were filled with
  Lucide icons plus our own vault and identity provider). Each icon: `id`, `name`, `category`,
  `keywords`, `paths` (SVG path data in a 24 × 24 box, stroked 2, round caps and joins) and `source`
  (`lucide`, ISC, or `opencanvas`, our own drawing in Lucide's style). Our own: object storage, API
  gateway, load balancer, reverse proxy, CDN, DNS, VPN tunnel, service mesh, queue, event bus, video
  bridge, relay, vault, data warehouse, cache, service, identity provider, pod, cluster. Product names
  are keywords only (decision 2: "s3", "redis", "kafka"); no glyph imitates a logo.
- Shape: kind `icon:node` on base `rect` (ADR-045), `props.icon` (the id), `props.labelPos`
  (`below` by default, `right`, `hidden`), `fill` the group's tone, `text` the label. Default box
  52 × 52 (the tile); the label sits outside it. The four side ports are the legacy anchors.
- Canvas: tinted tile, the glyph at half the shorter side, centred; the label 13 px semibold, below or
  10 px to the right. An id this build doesn't have draws the empty dashed icon frame with the label
  (6a).
- Exports and preview: `export.ts` and `oc-model::board` draw the same tile and the glyph as inline
  `<path>` elements (no `<image>`, no `href`), checked byte for byte against
  `crates/oc-model/tests/fixtures/board-icons.web.svg`; the label box counts towards the export
  bounds. An unknown icon id draws as the plain rect with its text, as 0.1.x clients do.
- Panel: the **Icons** library above the shape libraries, its groups folding (Compute and Storage
  open by default, remembered per person). Search covers icons too (placeholder "Search shapes and
  icons"): name prefix, then inside the name, then keywords; the Icons group comes first when its best
  match is as good as the best shape's (1d), so Enter adds it. A keyword hit says "… is a generic icon
  drawn by OpenCanvas, not a vendor logo. Need the real logo? Add your own icon" (1c). A product we
  ship no logo for ("jitsi") shows "No built-in icon for “jitsi”", **Add your own icon** and generic
  alternatives (`suggest` in the data file) (1e); any other miss keeps the plain "No shapes match".
- Network library (decision 6): load balancer, API gateway and queue draw the new glyphs
  (`look.icon`, a new declarative look field: the glyph left of the text). Exporters draw them as
  their base rect, as before.
- Tests: `icons.test.tsx`, `export.test.ts` (shared fixture), `oc-model/tests/diagram.rs`, the
  `oc-model::icons` unit test; browser `e2e/diagram/icons.spec.ts`.

**All icons: the full Lucide set (part 2, owner scope 2026-11-24).**

- Every Lucide icon of the version the editor ships (lucide-react 1.77.0: 2,098 icons in 45
  categories; Lucide 1.x has no brand logos, and the generator refuses brand names all the same).
  `tools/build-lucide-icons.py` writes `web/packages/board/src/lucide/index.json` (names, up to ten
  tags, categories: 42 KB gz) and `lucide/paths/<category>.json` (path data, each icon in its first
  category's file: 97 KB gz in all). Tags and path nodes come from `lucide-static@1.77.0`; categories
  only exist in the Lucide repository at the same tag, so the output is generated once and committed;
  `--check` verifies it matches the lucide-react version.
- Loading: neither is in the initial bundle nor the board chunk (`vite.config.ts` leaves
  `board/src/lucide/` out of the manual chunks): the index loads when All icons opens or someone
  searches; a category's paths load when its tiles scroll into view.
- Panel: **All icons** under Icons, a Category picker and a virtualised grid (fixed 4.5rem rows,
  three per row, only the visible rows plus three either side are in the DOM). Search covers the
  Lucide names (prefix, then anywhere) and tags, shown after shapes and built-in icons (first 30,
  "30 of N shown"); Enter adds the first Lucide hit when nothing else matches.
- Placing: `props.icon = "lucide:<name>"` and the icon's path data in `props.paths` (a few hundred
  bytes), so the Rust export, the preview and other clients draw it without the Lucide data. This is
  the smaller safe option: putting all of Lucide into `oc-model` would add about 450 KB to the server
  binary. Every reader checks `props.paths` (path syntax only, 1-32 entries); anything else draws the
  plain rect with its text (fixture shapes `l1`, `l2` in `board-icons.json`).
- Tests: `lucide.test.tsx` (the grid and search cases seen failing first), the shared fixture, and
  the All icons case in `e2e/diagram/icons.spec.ts`.

### 8.11 Phone (S11, DGM-14.11)

- Phone layout when the window is at most 30em wide (`usePhone`, `phone/Phone.tsx`): the diagram
  window gets `.ocdg-phone`: no side panels, rulers or the canvas's own toolbar, zoom and swatch bar;
  a two-line title (board name over the document title); a bottom bar **Select, Pan, Add, Outline,
  Undo** above the home indicator (`env(safe-area-inset-bottom)`). Opening fits the diagram (⇧1).
- 11a: the board block's cover says **Open diagram** and opens diagram mode when the board was made
  as a diagram (it has a name, or shapes with a diagram `kind`). Plain whiteboards keep "Tap to open
  board" (full-screen whiteboard with the pen, MOB-05); their options menu still has Open as diagram.
- 11c: one selected shape gets an action bar: Edit text, Name and colour (a small sheet: name field
  and the seven tones), Connect (a sheet of the other shapes, nearest first), Duplicate, Delete.
  The bar sits above the bottom bar rather than above the shape.
- 11d: Add opens a half-height sheet with search and the basic shapes (Process, Decision, Start or
  end, Sticky note, Text, Container). With a shape selected, "Connect it to ..." (on by default)
  places the new shape to its right (stepping past anything there, `placeNextTo`) and connects it.
- 11e: the options button opens a sheet: Outline, Zoom to fit, Export as PNG / SVG; Auto-layout,
  Import, Edit connector bends and Edit attributes are listed, disabled, tagged "Larger screen",
  with the reason below.
- Every control in the phone bar, action bar, top bar and sheets is at least 44 x 44 px (2.75rem),
  checked in the browser. Browser spec: `e2e/diagram/s11-phone.phone.spec.ts`, project `phone`
  (390 x 844, touch) in `e2e/diagram/playwright.config.ts`, axe on each sheet.

### 8.7 Export and import entries (S7, DGM-14.6)

- **Entries.** In diagram mode the board options menu gains **Import…** (editors, when the host
  allows a diagram import format) and **Export…**. Import opens the approved FC-10 dialog titled
  "Import into this diagram", diagram files only, and adds to the open board (`boardId`); its
  "Undo import" removes the added shapes in one transaction. Editor toasts and dialogs show above
  diagram mode.
- **Export dialog (7f, 7g).** PNG and SVG are the existing browser exports (a selection exports
  the selected shapes and the connectors between them). draw.io and Mermaid are converted by the
  server: `GET /v1/export/board/{boardId}.{drawio,mmd}?ticket=[&ids=][&report=1]`
  (`crates/oc-model/src/diagram_export/`); the dialog asks for `report=1` and lists "What changes
  in …", and shows the Mermaid text with Copy text. Without a server (`#demo`) draw.io and Mermaid
  are shown as "Needs the canvas server".
- **draw.io mapping** (the inverse of §7.1 on its subset; cell ids are the board's shape ids, so
  re-importing keeps them as `props.sourceId`): `rect` → `rounded=0` vertex (or `shape=<props.shape>`
  for imported outline shapes), `ellipse` → `ellipse`, `diamond` → `rhombus`, `text` → `text` with
  `fontSize`; tones → the draw.io fills that import back to the same tone (`#dae8fc` blue,
  `#d5e8d4` green, `#fff2cc` amber, `#f8cecc` red, `#e1d5e7` purple, `#f5f5f5` gray, `#fcc2d7`
  pink); containers (`props.parent`) → `container=1;dashed=1` cells holding their children with
  relative geometry; board groups → `group;ocGroup=1` cells (the importer turns these back into
  `group`; other draw.io groups still become containers); connectors keep bound ends,
  `exitX/entryX` from the side anchor, `via` → waypoints, `route: "elbow"` →
  `orthogonalEdgeStyle`, labels; free ends → `sourcePoint`/`targetPoint`. Reported: `avoid`
  (routes around shapes saved as fixed bends), `ports` (named ports → nearest side), `kind`
  (shapes from a library → plain boxes), `sticky` (→ boxes in their tone), `image_stored`
  (images stored with the canvas → dashed boxes; `data:` images are kept), `pen`, `swatch` (left
  out); `kept`, `containers`, `groups`.
- **Mermaid mapping:** `flowchart TB`; nodes named by their text's first line (`rect` `["…"]`,
  `ellipse` `(["…"])`, `diamond` `{"…"}`), ids from the shape ids (`[A-Za-z0-9_]`, `n_` before a
  digit or keyword, made unique); containers → nested `subgraph`; connectors bound at both ends →
  `-->` with `|"label"|`; tones → `classDef`. Reported: `positions`, `detail` (second lines,
  icons), `groups_lost`, `unbound`, `images_named`, `pen`, `swatch`; `containers`, `labels`,
  `colours`.
- **Tests:** `crates/oc-model/tests/diagram_export.rs` (golden round trip draw.io → import keeps
  ids, connectors, anchors, labels, waypoints, containers, groups, positions and tones; selection;
  `data:` images; Mermaid golden text and safe ids), `crates/oc-server/tests/exports.rs` (the
  endpoint), `web/packages/board/src/diagram-export.test.tsx` (dialog, report, preview, entries),
  `e2e/diagram/s6-layout.spec.ts` (S6 in the production build, axe light and dark).


- The limit: `GET /v1/sessions/{ticket}` answers `maxDocBytes` (`[rooms] max_doc_bytes`); the editor
  passes it as `BlockEnv.maxDocBytes`, the board to the shell. Without it (an older server, the demo)
  the shell uses 20 MB.

### 8.10 Working together (S10, DGM-14.4)

Code: `diagram/Presence.tsx`. Presence is awareness only, never document data.

- Others' selections: the board's existing rings in each person's colour, with their name (10a). The
  shell's peers now carry `sel`; when someone else has a selected shape selected, the panel says
  "Lea is editing this shape too. If you change different fields, both changes are kept."
  (`PeerNotice`). Not done: the per-field marker ("Lea" next to the Detail field), which needs the
  focused field in awareness.
- Orphan connector (10b): deleting a shape keeps the bindings that point at it (as before), so the
  end reattaches by itself when the shape comes back (undo; tested). In diagram mode such a
  connector is drawn red and dashed with a loose-end dot and a faint dashed outline, with the name, of
  the deleted shape where this view last saw it (`OrphanLayer`; the outline is local memory, not
  stored). The panel says "<name> was deleted…" with **Reconnect** (binds the loose end to the shape
  nearest its point, within 120 units; otherwise says to drag the end) and **Delete connector**.
  Who deleted it is not shown: Yjs doesn't record the deleting client.
- View only (10c): no Undo/Redo (S1), no ports (S3), properties read only (S4) and **Copy text**.
  The shapes panel and auto-layout are hidden by their owners' screens.
