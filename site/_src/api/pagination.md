<!--meta {"title": "Pagination", "description": "Page through OpenCanvas blocks and database rows with opaque, signed cursors that survive concurrent edits: limits, next_cursor, the Link header and expiry.", "lede": "Two operations answer pages: listBlocks (top-level blocks, up to 100 per page) and queryRows (database rows, up to 200). Cursors are opaque and signed, and a block walk stays correct while people edit the canvas."} -->

## How it works

Ask for the first page with an optional `limit`. Each page answers `has_more` and
`next_cursor`; when more follow, it also carries a `Link` header with the next page's URL. Pass
`next_cursor` back as `cursor`, unchanged, until `has_more` is `false`.

```http
GET /api/v1/files/doc_1/blocks?limit=2

HTTP/1.1 200 OK
ETag: "c465d27bcd7e"
Link: </api/v1/files/doc_1/blocks?cursor=eyJmIjoiZG9jXzEi...&limit=2>; rel="next"

{"blocks": [...], "rev": "c465d27bcd7e", "has_more": true, "next_cursor": "eyJmIjoiZG9jXzEi..."}
```

| Operation | Items | `limit` | Default |
|---|---|---|---|
| `GET /api/v1/files/{fileId}/blocks` | `blocks` | 1-100 | 100 |
| `GET /api/v1/files/{fileId}/databases/{dbId}/rows` | `rows` | 1-200 | 50 |

## Walk every page

:::samples Every block of a canvas
```bash
url="https://canvas.example.com/api/v1/files/doc_1/blocks?limit=100"
while [ -n "$url" ]; do
  page=$(curl -s "$url" -H "X-OpenCanvas-Host: acme" -H "X-OpenCanvas-Key: $OC_API_KEY")
  echo "$page" | jq -c '.blocks[]'
  cursor=$(echo "$page" | jq -r '.next_cursor // empty')
  url=${cursor:+"https://canvas.example.com/api/v1/files/doc_1/blocks?limit=100&cursor=$cursor"}
done
```
```ts
// paginate() follows next_cursor and yields each item.
for await (const block of oc.paginate("listBlocks", { fileId: "doc_1", query: { limit: 100 } })) {
  console.log(block);
}
```
```rust
use futures::StreamExt;
use opencanvas_client::{CallOptions, Params};

let mut blocks = Box::pin(oc.paginate("listBlocks", Params::file("doc_1").query("limit", 100), CallOptions::default()));
while let Some(block) = blocks.next().await {
    println!("{}", block?);
}
```
```python
def every_block(api, file_id):
    params = {"limit": 100}
    while True:
        r = api.get(f"{BASE}/files/{file_id}/blocks", params=params, timeout=30)
        r.raise_for_status()
        page = r.json()
        yield from page["blocks"]
        if not page["has_more"]:
            return
        params["cursor"] = page["next_cursor"]
```
:::

## Cursors

- **Opaque and signed.** Do not build or change them; a changed cursor answers
  `400 CURSOR_INVALID`.
- **Bound to the request.** A block cursor belongs to its file; a row cursor to its file,
  database, `filter`, `sort` and `fields`. Sending it with other values is `CURSOR_INVALID`.
- **Valid for an hour.** After that, `410 CURSOR_EXPIRED`: start again without one.
- **Stable under edits.** A block cursor is a position after the last block you got (a Yjs
  relative position), not an index. A block inserted or deleted before it does not shift the
  next page, and if that last block is deleted, the next page starts at its successor. Every
  block that exists for the whole walk is returned exactly once.

## Errors

| Status | Code | When |
|---|---|---|
| 400 | `CURSOR_INVALID` | Not a cursor this server signed for this file and query. |
| 410 | `CURSOR_EXPIRED` | Older than an hour. |
| 400 | `BAD_INPUT` | `filter` or `sort` is not a JSON array. |
