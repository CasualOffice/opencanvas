# SKILLS.md — Competencies required to build OpenCanvas

These are the areas of knowledge an agent needs here. They are not tools.

## Working practice (per feature)
1. Define the outcome. 2. Write a design note in `docs/`, with an ADR if
needed. 3. Compare Slack/Zoom/Loop/Notion/Collabora, with sources and the date
checked. 4. Identify risks. 5. Set acceptance gates. 6. Add a tracker row.
7. For UI work, get the Artifact prototype approved. 8. Implement in small
steps. 9. Verify and update the docs.

## 1. Collaboration / CRDT
- Yjs data types (`Y.XmlFragment`, `Y.Map`, `Y.Array`, `Y.Text`), how
  transactions and origins work, state vectors, update v1 vs v2, GC and tombstones.
- y-protocols: sync step 1/2, updates, awareness. Wire compatibility with `yrs`.
- Relative positions for cursors; `Y.UndoManager` with tracked origins.
- Convergence testing: random op generation, out-of-order delivery, partitions.

## 2. Rich-text editing
- ProseMirror schema, transactions, plugins, node views, IME composition, and
  paste/clipboard handling.
- Tiptap extensions; y-prosemirror binding; collaboration cursor.
- Tables (prosemirror-tables), drag handles, slash menus, accessibility.

## 3. Board / graphics
- SVG vs Canvas2D trade-offs, pointer events and coalesced events, hit-testing
  with R-trees, transforms (pan/zoom/rotate), stroke smoothing, and keeping
  60 fps under load.

## 4. Integration protocols
- JWT (JWS algorithms, `alg` confusion, `kid`/JWKS, `jti` replay).
- WOPI: CheckFileInfo/GetFile/PutFile/PutRelative, discovery, and timestamp
  conflict detection as Collabora does it.
- postMessage security (origin checks), iframe sandboxing, CSP `frame-ancestors`.
- Webhook signing (HMAC with timestamp) and idempotency keys.

## 5. Rust server engineering
- tokio actors and back-pressure, axum WebSocket, graceful shutdown.
- sqlx `Any` driver across SQLite/MySQL/MariaDB, plus dialect quirks: BLOB
  sizes, upserts (`ON CONFLICT` vs `ON DUPLICATE KEY`), WAL mode.
- Redis leases (`SET NX PX`), pub/sub relay, failure detection.
- Prometheus metrics, OpenTelemetry, structured logging.

## 6. Security
- SSRF defence (DNS pinning, IP range blocks, redirect re-checks).
- XSS defence (schema whitelists, sanitisers), zip-bomb and path-traversal limits.
- Rate limiting, secrets encryption at rest.

## 7. Formats & rendering
- `.ocanvas` zip, Markdown (CommonMark + GFM tables and tasks), HTML, DOCX
  (WordprocessingML basics), PDF through headless Chromium, SVG/PNG.
