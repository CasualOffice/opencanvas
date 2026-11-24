# @opencanvas/client

TypeScript client of the OpenCanvas headless API (`/api/v1`, docs/05 §7b). Node 20+, browsers,
Deno and edge runtimes; no runtime dependencies beyond `fetch`.

```ts
import { OpenCanvas, StaleBlockError } from "@opencanvas/client";

const oc = new OpenCanvas({
  baseUrl: "https://canvas.example.com",
  auth: { hostId: "acme", key: process.env.OC_API_KEY! }, // or { token: () => mintUserToken() }
});

const doc = await oc.readFile({ fileId: "doc_1" });
await oc.batchBlocks(
  { fileId: "doc_1", body: { ops: [{ op: "append", markdown: "Shipped." }] } },
  { ifMatch: doc.rev }, // 412 StaleBlockError when someone changed the document meanwhile
);
for await (const block of oc.paginate("listBlocks", { fileId: "doc_1" })) console.log(block);
for await (const event of oc.events({ fileId: "doc_1", types: ["edited"] })) console.log(event);
```

Writes carry an `Idempotency-Key` (the same one on every retry); `429`, `503` and
`409 IDEMPOTENCY_IN_PROGRESS` are retried after `Retry-After`; errors are typed RFC 9457
problems. `verifyWebhook()` checks webhook signatures. The full guide, with the Rust client, is
docs/05 §7d.

The operation types and methods are generated from `crates/oc-server/api/openapi.json` by
`scripts/gen.mjs` (`--check` in CI). Licence: Apache-2.0.
