<!--meta {"title": "Idempotency", "description": "Retry OpenCanvas API writes safely with the Idempotency-Key header: what is stored, replays, key reuse, requests still running, and the 24-hour window.", "lede": "Every POST under /api/v1/files takes an Idempotency-Key header. Send the same key on every retry of one request, and the change is applied once, even across nodes of a cluster."} -->

## How it works

Pick a key per logical request (a UUID, or an id from your own job) and send it on the first
try and on every retry:

```http
POST /api/v1/files/doc_1/comments
Idempotency-Key: remind-2026-11-25-doc_1
Content-Type: application/json

{"text": "Is Friday still right?", "blockId": "b_01m87jv4rtkdxymn93jwtx35sk"}
```

| Case | Answer |
|---|---|
| First request with the key | Runs, and its answer is stored for 24 hours. |
| The same request again (method, path and body) | The stored answer, with `Idempotency-Replayed: true`. Nothing runs again. |
| The same key with another request | `422 IDEMPOTENCY_KEY_REUSED`. |
| The same key while the first is still running, on any node | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`. Retry to get the first one's answer. |
| The first request failed (any error) | Not stored: a retry with the key runs again. |
| A malformed key | `400 IDEMPOTENCY_KEY_INVALID`. |

## The key

- 1 to 255 visible ASCII characters.
- Yours per caller: the host key with its `X-OpenCanvas-Author`, or a token's `sub`. Two users
  can use the same key without seeing each other's answers.
- Kept 24 hours. After that, the same key is a new request.

## Which operations

Every `POST` under `/api/v1/files/{fileId}/...` takes a key, except
`POST .../sync-token`: its answer is a credential, never stored, so the same key gets a fresh
ticket. `POST /api/v1/convert` changes nothing and takes no key. Reads and `DELETE .../session` (closing a session twice is harmless) take none.

## What is stored

The request's hash and the write's answer: ids, counts and revisions. Never document content.
Keys live in the database (`api_idempotency`, SQLite, MySQL or MariaDB) or, with Redis-only
storage, in Redis (`oc:idem:...`).

## In the clients

The TypeScript and Rust clients send a random key on every write and reuse it for each retry of
that call. Pass your own key when a retry may come from another process (a job queue that
re-runs a job after a crash):

:::samples Your own key
```bash
curl -s -X POST "https://canvas.example.com/api/v1/files/doc_1/comments" \
  -H "X-OpenCanvas-Host: acme" -H "X-OpenCanvas-Key: $OC_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: remind-2026-11-25-doc_1" \
  -d '{"text": "Is Friday still right?", "blockId": "b_01m87jv4rtkdxymn93jwtx35sk"}'
```
```ts
const res = await oc.call(
  "addComment",
  { fileId: "doc_1", body: { text: "Is Friday still right?", blockId: "b_01m87jv4rtkdxymn93jwtx35sk" } },
  { idempotencyKey: "remind-2026-11-25-doc_1" },
);
console.log(res.replayed); // true when the server answered from the stored result
```
```rust
use opencanvas_client::{CallOptions, Params};
use serde_json::json;

let res = oc
    .call(
        "addComment",
        &Params::file("doc_1").json(json!({"text": "Is Friday still right?", "blockId": "b_01m87jv4rtkdxymn93jwtx35sk"})),
        &CallOptions::key("remind-2026-11-25-doc_1"),
    )
    .await?;
println!("replayed: {}", res.replayed);
```
```python
r = api.post(
    f"{BASE}/files/doc_1/comments",
    json={"text": "Is Friday still right?", "blockId": "b_01m87jv4rtkdxymn93jwtx35sk"},
    headers={"Idempotency-Key": "remind-2026-11-25-doc_1"},
    timeout=30,
)
replayed = r.headers.get("Idempotency-Replayed") == "true"
```
:::
