<!--meta {"title": "SDKs", "description": "The OpenCanvas API clients for TypeScript (@opencanvas/client) and Rust (opencanvas-client): install, credentials, typed calls, retries, idempotency, paging, events, typed errors and webhook checks.", "lede": "Two clients wrap the API with the same behaviour: typed operations generated from the OpenAPI document, an Idempotency-Key on every write, retries after Retry-After, cursor paging, resumable events, typed errors and the webhook signature check. Both are Apache-2.0 and versioned with the server."} -->

## Install

Both clients live in the OpenCanvas repository and are **not yet published** to npm or
crates.io.

| Client | Where | Runs on |
|---|---|---|
| TypeScript `@opencanvas/client` | [`web/packages/client`](../../../web/packages/client) | Node 20+, browsers, Deno, edge runtimes. No runtime dependency beyond `fetch`. |
| Rust `opencanvas-client` (library `opencanvas_client`) | [`crates/oc-client`](../../../crates/oc-client) | Tokio, `reqwest` and `serde`. |

:::samples Add the client
```sh
# TypeScript: build the package from a checkout, then depend on the folder.
git clone https://github.com/CasualOffice/opencanvas
cd opencanvas/web && pnpm install && pnpm --filter @opencanvas/client build
cd /path/to/your/app && npm install /path/to/opencanvas/web/packages/client

# Rust: a git dependency.
cargo add opencanvas-client --git https://github.com/CasualOffice/opencanvas
```
```ts
// package.json, after building web/packages/client in a checkout:
//   "dependencies": { "@opencanvas/client": "file:../opencanvas/web/packages/client" }
import { OpenCanvas } from "@opencanvas/client";
```
```rust
// Cargo.toml:
//   [dependencies]
//   opencanvas-client = { git = "https://github.com/CasualOffice/opencanvas" }
//   tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
use opencanvas_client::{Auth, Client};
```
```python
# No Python client yet: the samples on these pages use requests.
# pip install requests
import requests
```
:::

## Create a client

:::samples Host key or user token
```bash
# curl: send the headers yourself (see Authentication).
curl -s "https://canvas.example.com/api/v1/files/doc_1" \
  -H "X-OpenCanvas-Host: acme" -H "X-OpenCanvas-Key: $OC_API_KEY"
```
```ts
import { OpenCanvas } from "@opencanvas/client";

const oc = new OpenCanvas({
  baseUrl: "https://canvas.example.com",
  auth: { hostId: "acme", key: process.env.OC_API_KEY!, author: "u_42" },
  // or a user token, minted before every request so it never expires mid-job:
  // auth: { token: () => mintUserToken("u_42", "canvas:read canvas:write", ["doc_1"]) },
  maxRetries: 3,
});
```
```rust
use opencanvas_client::{Auth, Client};

let oc = Client::builder("https://canvas.example.com")
    .auth(Auth::host_key("acme", std::env::var("OC_API_KEY").expect("OC_API_KEY")))
    // or .auth(Auth::Token(token)), or Auth::TokenFn(...) to mint one per request
    .max_retries(3)
    .build();
```
```python
import os

import requests

api = requests.Session()
api.headers.update({"X-OpenCanvas-Host": "acme", "X-OpenCanvas-Key": os.environ["OC_API_KEY"]})
```
:::

## What both do

| Feature | Behaviour |
|---|---|
| Typed operations | One method per operation, with the types of its parameters, body and answer, generated from `openapi.json` (TypeScript `scripts/gen.mjs`, Rust `tests/models.rs`; CI fails when they drift). The generic `call(operationId, params, options)` answers status, headers, `etag`, `replayed` and `rateLimit` too. |
| Credentials | The host key (with optional `author` and callback token) or a user token; a token callback runs before every request. |
| Idempotency | Every write carries an `Idempotency-Key`: a random one per call, the same on each retry of that call. Pass your own to survive a process restart, or none. |
| Retries | `429`, `503` and `409 IDEMPOTENCY_IN_PROGRESS`, after `Retry-After` (else 500 ms doubling, at most 30 s), 3 times by default. Network errors are retried for reads and keyed writes only. The wait is injectable, so tests never sleep. |
| Errors | Problem details as typed errors, by `code` first, then status: stale block (412, with `fresh`), rate limited (`retryAfterSecs`), key reused, key in progress, cursor expired, bad request, unauthorized, forbidden, not found, conflict, gone, precondition failed, too large, unprocessable, unavailable, server. |
| Paging | `paginate` follows `next_cursor` through `listBlocks` and `queryRows`, item by item. |
| Events | The SSE stream of a file. A dropped stream (or close code 4008) reconnects with `Last-Event-ID` and gets what it missed, or a `resync` event; 4001 and 4003 end it with an error. |
| Webhooks | `verifyWebhook` / `verify_webhook`: the `v2` check, in constant time, with a 5-minute window. |

## Typed errors

:::samples Handle a stale write
```bash
# 412 with "code": "STALE_BLOCK": re-read, apply your change again, send it with the new rev.
curl -s -o answer.json -w '%{http_code}\n' -X POST \
  "https://canvas.example.com/api/v1/files/doc_1/blocks:batch" \
  -H "X-OpenCanvas-Host: acme" -H "X-OpenCanvas-Key: $OC_API_KEY" \
  -H "Content-Type: application/json" -H 'If-Match: "c465d27bcd7e"' \
  -d '{"ops": [{"op": "append", "markdown": "Shipped."}]}'
jq -r .code answer.json
```
```ts
import { RateLimitedError, StaleBlockError } from "@opencanvas/client";

try {
  await oc.batchBlocks(
    { fileId: "doc_1", body: { ops: [{ op: "append", markdown: "Shipped." }] } },
    { ifMatch: doc.rev },
  );
} catch (e) {
  if (e instanceof StaleBlockError) console.log("changed meanwhile", e.fresh);
  else if (e instanceof RateLimitedError) console.log("retry in", e.retryAfterSecs, "s");
  else throw e;
}
```
```rust
use opencanvas_client::ProblemKind;

match oc.batch_blocks("doc_1", &req, &CallOptions::if_match(rev)).await {
    Ok(result) => println!("{:?}", result.block_ids),
    Err(e) if e.kind() == Some(ProblemKind::StaleBlock) => {
        println!("changed meanwhile: {:?}", e.api().and_then(|a| a.fresh()));
    }
    Err(e) => return Err(e),
}
```
```python
r = api.post(f"{BASE}/files/doc_1/blocks:batch",
             json={"ops": [{"op": "append", "markdown": "Shipped."}]},
             headers={"If-Match": f'"{rev}"'}, timeout=30)
if r.status_code == 412 and r.json().get("code") == "STALE_BLOCK":
    print("changed meanwhile", r.json()["fresh"])
else:
    r.raise_for_status()
```
:::

## Paging, events and webhooks

See [pagination](pagination.html), [events](events.html) and [webhooks](webhooks.html): each
page has the client samples beside curl and Python.

## The conformance suite

`crates/oc-server/api/conformance.json` is one list of scenarios that both clients run against
a real server: a read, a block batch with `If-Match`, idempotent replay, paging, a rate limit, an
events resume and a webhook signature, plus offline webhook signature vectors. The server pins
its clock, so no scenario sleeps. A third-party client can run the same scenarios; the format is
in the [integration guide](../../../docs/05-INTEGRATION-GUIDE.md).
