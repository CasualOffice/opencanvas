<!--meta {"title": "API overview", "description": "The OpenCanvas headless API: read and change canvases from programs. Base URL, versioning, the api_v1 switch, request conventions and a first call in curl, TypeScript, Rust and Python.", "lede": "Read and change OpenCanvas canvases from programs: bots, integrations and back-office jobs. Changes land in the live canvas as one transaction, show up for everyone editing it, and are saved to your application like any other edit."} -->

## Base URL

Every operation is under `/api/v1` on your OpenCanvas server. The examples on these pages use
`https://canvas.example.com`; use your own server's public address.

```text
https://canvas.example.com/api/v1/files/{fileId}
```

`fileId` is **your** file id, the one you use in launch tokens and callbacks. OpenCanvas keeps
no files of its own: your application owns users, permissions and files, and OpenCanvas loads
and saves through your callbacks ([integration guide](../../../docs/05-INTEGRATION-GUIDE.md)).

## Turn it on

The API is off until you turn it on for your host, in its entry of the hosts file:

```toml
[[host]]
id      = "acme"
api_key = "env:ACME_OC_API_KEY"   # the host key, for server-to-server calls

[host.flags]
api_v1 = true                     # off by default in 0.1.2
```

Without the flag, every `/api/v1` call for that host answers `404` with the code `API_OFF`.
User tokens also need a public base URL (`OC_PUBLIC_URL`, or `[host.api] audience`); see
[authentication](authentication.html).

## Versioning

- The path carries the major version. Within `v1` changes are **additive**: new operations,
  new optional parameters, new fields in answers. Ignore fields you do not know.
- A breaking change gets a new path (`/api/v2`), and `v1` keeps working alongside it.
- The OpenAPI 3.1 document is the contract. A running server serves it at
  `GET /api/v1/openapi.json`; it is checked in as
  [`crates/oc-server/api/openapi.json`](../../../crates/oc-server/api/openapi.json), and a
  test keeps it and the server's router identical. This reference is generated from it.
- The 0.1 routes (`/v1/files/{fileId}/patch` and the others) still work and carry
  `Deprecation` and a `Link` to their successor. They are retired in v0.3; see
  [0.1 routes](reference/legacy.html).

## Your first call

Read a canvas as Markdown, then append a paragraph, with the host key. The `If-Match` header
makes the change apply only if nobody changed the canvas since you read it.

:::samples Read, then append
```bash
curl -s "https://canvas.example.com/api/v1/files/doc_1?format=markdown" \
  -H "X-OpenCanvas-Host: acme" \
  -H "X-OpenCanvas-Key: $OC_API_KEY"

curl -s -X POST "https://canvas.example.com/api/v1/files/doc_1/blocks:batch" \
  -H "X-OpenCanvas-Host: acme" \
  -H "X-OpenCanvas-Key: $OC_API_KEY" \
  -H "Content-Type: application/json" \
  -H 'If-Match: "c465d27bcd7e"' \
  -H "Idempotency-Key: 5f0e7d4c-2b1a-4e8f-9c3d-6a7b8c9d0e1f" \
  -d '{"ops": [{"op": "append", "markdown": "Shipped on Friday."}]}'
```
```ts
import { OpenCanvas } from "@opencanvas/client";

const oc = new OpenCanvas({
  baseUrl: "https://canvas.example.com",
  auth: { hostId: "acme", key: process.env.OC_API_KEY! },
});

const doc = await oc.readFile({ fileId: "doc_1", query: { format: "markdown" } });
console.log(doc.markdown);

// The client sends an Idempotency-Key for you, the same one on every retry.
const result = await oc.batchBlocks(
  { fileId: "doc_1", body: { ops: [{ op: "append", markdown: "Shipped on Friday." }] } },
  { ifMatch: doc.rev },
);
console.log(result.blockIds);
```
```rust
use opencanvas_client::models::{BatchOp, BatchRequest};
use opencanvas_client::{Auth, CallOptions, Client};

let oc = Client::builder("https://canvas.example.com")
    .auth(Auth::host_key("acme", std::env::var("OC_API_KEY").expect("OC_API_KEY")))
    .build();

let doc = oc.read_file("doc_1", Some("markdown")).await?;
println!("{}", doc.markdown.clone().unwrap_or_default());

// The client sends an Idempotency-Key for you, the same one on every retry.
let req = BatchRequest {
    ops: vec![BatchOp { op: "append".into(), markdown: Some("Shipped on Friday.".into()), ..Default::default() }],
    ..Default::default()
};
let result = oc.batch_blocks("doc_1", &req, &CallOptions::if_match(doc.rev.unwrap_or_default())).await?;
println!("{:?}", result.block_ids);
```
```python
import os
import uuid

import requests

BASE = "https://canvas.example.com/api/v1"
api = requests.Session()
api.headers.update({"X-OpenCanvas-Host": "acme", "X-OpenCanvas-Key": os.environ["OC_API_KEY"]})

r = api.get(f"{BASE}/files/doc_1", params={"format": "markdown"}, timeout=30)
r.raise_for_status()
doc = r.json()
print(doc["markdown"])

r = api.post(
    f"{BASE}/files/doc_1/blocks:batch",
    json={"ops": [{"op": "append", "markdown": "Shipped on Friday."}]},
    headers={"If-Match": f'"{doc["rev"]}"', "Idempotency-Key": str(uuid.uuid4())},
    timeout=30,
)
r.raise_for_status()
print(r.json()["blockIds"])
```
:::

## Requests and answers

| Topic | How it works |
|---|---|
| Format | JSON in UTF-8, `Content-Type: application/json`. Import and convert take the file itself as the body; export and convert answer the file. |
| Credentials | The host key (`X-OpenCanvas-Host` and `X-OpenCanvas-Key`) or a user token you mint (`Authorization: Bearer`). See [authentication](authentication.html). |
| Errors | RFC 9457 problem details with a machine `code`. See [errors](errors.html). |
| Revisions | Reads answer `ETag: "<rev>"`. Send it back as `If-Match` on a batch, or a block's `rev` as `ifMatch` on one op, and a stale write fails with `412 STALE_BLOCK` instead of overwriting. |
| Lists | `listBlocks` and `queryRows` page with signed cursors. See [pagination](pagination.html). |
| Writes | Every `POST /api/v1/files/...` takes `Idempotency-Key`, so a retry never applies twice. See [idempotency](idempotency.html). |
| Limits | Token buckets per caller and per file, announced in `RateLimit` headers. See [rate limits](rate-limits.html). |
| Changes | Stream them per file ([events](events.html)) or receive them by POST ([webhooks](webhooks.html)). |

## How changes land

A write runs in the file's live room as **one transaction**: everyone editing the canvas sees
it at once, and it is saved to your application by the same autosave as a person's edit
(`POST .../commit` saves now). If nobody has the file open, OpenCanvas loads it from you,
applies the change and saves it straight away.

Changes to existing blocks land directly, unless the call sends `"mode": "suggest"` or the
host sets `[host.api] default_mode = "suggest"`: then they become suggestions that a person
accepts in the editor. A batch that deletes more than 5 blocks needs `"confirm": true`.

## Operations

{{api:operations}}

## No "try it" console

This reference has no console that sends requests from the page. The site is static (GitHub
Pages) with no OpenCanvas server behind it, and a console would mean pasting a host key or a
user token into a web page. Use the samples with your own server: every one of them can be
copied, and the language you pick is remembered on your device.
