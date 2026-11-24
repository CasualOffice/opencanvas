<!--meta {"title": "Rate limits", "description": "OpenCanvas API rate limits: token buckets per caller and per file, the RateLimit-Policy and RateLimit headers, 429 with Retry-After, and per-host settings.", "lede": "Token buckets, announced on every answer. One bucket per caller, shared with MCP, and one per file for writes. With Redis the buckets are shared by every node of a cluster."} -->

## The buckets

| Bucket | Applies to | Default | Setting (`[host.api]`) |
|---|---|---|---|
| `subject` | Every request of one caller: the host key, or a token's `sub` | 10 requests a second, burst 30 | `rate_per_sec`, `burst` |
| `file-writes` | `POST` and `DELETE` on one file, from everyone | 5 a second, burst 10 | `file_writes_per_sec`, `file_burst` |

MCP calls take from the same `subject` bucket as the API. `[host.ai] mcp_rate_per_min` still
sets the rate when `[host.api]` does not.

## The headers

Every answer says where you stand (draft IETF RateLimit header fields):

```http
RateLimit-Policy: "subject";q=30;w=3, "file-writes";q=10;w=2
RateLimit: "subject";r=29;t=1
```

| Header | Meaning |
|---|---|
| `RateLimit-Policy` | The buckets that apply: `q` is the burst, `w` the seconds an empty bucket takes to refill. `file-writes` appears on writes only. |
| `RateLimit` | The bucket closest to empty: `r` requests remaining, `t` seconds until it is full again. |

## When a bucket is empty

The answer is `429 RATE_LIMITED` with `Retry-After` (seconds). Wait that long, then retry; keep
the same `Idempotency-Key` for a write.

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 1
RateLimit: "subject";r=0;t=3

{"type": "urn:opencanvas:problem:rate-limited", "title": "Too Many Requests", "status": 429,
 "detail": "too many requests (subject limit); retry later", "code": "RATE_LIMITED"}
```

The clients retry `429` and `503` after `Retry-After` (else 500 ms doubling, at most 30 seconds),
3 times by default. In your own code:

:::samples Retry after 429
```bash
for attempt in 1 2 3 4; do
  status=$(curl -s -o page.json -w '%{http_code}' -D headers.txt \
    "https://canvas.example.com/api/v1/files/doc_1" \
    -H "X-OpenCanvas-Host: acme" -H "X-OpenCanvas-Key: $OC_API_KEY")
  [ "$status" != 429 ] && break
  sleep "$(awk 'tolower($1) == "retry-after:" { print $2 + 0 }' headers.txt)"
done
```
```ts
// Retries are built in: maxRetries (default 3) per client or per call.
const oc = new OpenCanvas({ baseUrl: "https://canvas.example.com", auth, maxRetries: 5 });
const doc = await oc.readFile({ fileId: "doc_1" }, { maxRetries: 0 }); // or none for this call
```
```rust
// Retries are built in: max_retries (default 3) per client or per call.
let oc = Client::builder("https://canvas.example.com").auth(auth).max_retries(5).build();
```
```python
import time


def get_with_retry(api, url, **kw):
    for _ in range(4):
        r = api.get(url, timeout=30, **kw)
        if r.status_code not in (429, 503):
            return r
        time.sleep(float(r.headers.get("Retry-After", "1")))
    return r
```
:::

## Other limits

- At most 100 event streams per file on one server (`429 TOO_MANY_STREAMS`).
- At most 200 rows per `rows:upsert` and per page of `queryRows`; at most 100 blocks per page of
  `listBlocks`.
- Import files up to 5 MiB; CSV up to 10,000 rows and 200 columns (`413 IMPORT_TOO_LARGE`).
- A batch that deletes more than 5 blocks needs `"confirm": true`.
