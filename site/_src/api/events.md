<!--meta {"title": "Events", "description": "Stream an OpenCanvas file's change events over Server-Sent Events or WebSocket: event types and payloads, resuming with Last-Event-ID, close codes, limits, and the CRDT sync ticket.", "lede": "GET /api/v1/files/{fileId}/events streams what happens to one file: edits, comments, mentions, people joining and leaving, saves, restores. Events carry ids, user ids, versions and counts, never document text."} -->

## Open a stream

The same URL serves **Server-Sent Events** and, when the request is a WebSocket upgrade, a
**WebSocket** with one JSON text message per event. It needs `canvas:read` and access to the
file, checked like every read. `?types=` keeps only the types you list.

:::samples Stream saves and comments
```bash
curl -s -N "https://canvas.example.com/api/v1/files/doc_1/events?types=saved,commented" \
  -H "X-OpenCanvas-Host: acme" \
  -H "X-OpenCanvas-Key: $OC_API_KEY" \
  -H "Accept: text/event-stream"
```
```ts
// Reconnects with Last-Event-ID when the stream drops, and resumes where it stopped.
const stream = oc.events({ fileId: "doc_1", types: ["saved", "commented"] });
for await (const event of stream) {
  console.log(event.id, event.type, event.data);
}
// stream.lastEventId: keep it to resume after a restart (lastEventId option).
```
```rust
use opencanvas_client::EventsOptions;

let mut opts = EventsOptions::new("doc_1");
opts.types = vec!["saved".into(), "commented".into()];
let mut stream = oc.events(opts);
while let Some(event) = stream.next().await {
    let event = event?;
    println!("{} {} {:?}", event.id, event.type_, event.data);
}
```
```python
import json
import os

import requests

r = requests.get(
    "https://canvas.example.com/api/v1/files/doc_1/events",
    params={"types": "saved,commented"},
    headers={
        "X-OpenCanvas-Host": "acme",
        "X-OpenCanvas-Key": os.environ["OC_API_KEY"],
        "Accept": "text/event-stream",
    },
    stream=True,
    timeout=(10, 60),
)
r.raise_for_status()
for line in r.iter_lines(decode_unicode=True):
    if line.startswith("data:"):
        event = json.loads(line[5:])
        print(event["id"], event["type"], event["data"])
```
:::

On the wire, each SSE event has an `id`, an `event` name (the type) and one `data` line; a
comment line keeps the connection alive every 15 seconds:

```text
id: ev_01m87jv4t3ggvh8n6d6nh38xc0
event: commented
data: {"at":1795550974787,"data":{"added":2,"blockId":"b_01m87jv4rtkdxymn93jwtx35sk","by":["svc:acme"],"threadId":"t_01m87jv4sqj5z6jz5q2n5zdtdw"},"fileId":"doc_1","id":"ev_01m87jv4t3ggvh8n6d6nh38xc0","type":"commented"}

:
```

## The event

Every event, on a stream, a WebSocket or a [webhook](webhooks.html), is the same JSON:

| Member | Meaning |
|---|---|
| `id` | `ev_<ulid>`: sorts by time. Pass the last one back to resume; webhooks send it as `Idempotency-Key`. |
| `type` | One of the types below. |
| `fileId` | Your file id. |
| `at` | Unix milliseconds. |
| `data` | The type's payload. |

| `type` | `data` | When |
|---|---|---|
| `edited` | `{blockIds, removedBlockIds, databaseIds?, boardIds?, by, truncated?, untracked?}` | Changes, debounced: once edits pause for `[host.api] events_coalesce_ms` (default 250) and at least every 2 seconds during a long burst. `blockIds` are the deepest blocks with a `blockId` that changed (at most 500; `truncated: true` beyond). `untracked: true` when something changed outside any identified block: re-read. `by` lists who sent the changes. |
| `commented` | `{threadId, blockId?, added, by}` | New comment messages in a thread. |
| `mentioned` | `{mentioned, by, blockId?, threadId?}` | New @mentions, as for the mentions callback, without the excerpt. |
| `member.joined` | `{userId, role}` | A person's first connection to the live room opened. |
| `member.left` | `{userId}` | Their last connection closed. |
| `saved` | `{version}` | Your application accepted a save. |
| `restored` | `{restoreId, from, by}` | A version was restored. |
| `session.closed` | `{reason: "host" \| "idle"}` | The live room ended: `DELETE .../session`, or everyone left. |
| `resync` | `{reason}` | Streams only: the resume point is gone; re-read the file. |

## Resume

Send the last id you handled as `Last-Event-ID` (or `?since=`; the header wins). The server keeps
the last 512 events of each file in memory and answers the ones after your id. When your id is
gone (evicted, the server restarted, or another node that was not listening), you get one
`resync` event, whose `id` is the newest the server has: re-read the file, then carry on from
there. In a cluster, the node that runs the file's live room publishes each event to the others,
so a stream on any node gets them.

## Close codes

| Code | SSE | Meaning | What to do |
|---|---|---|---|
| `4008` | a final `event: close` with `{"code": 4008, "reason": "..."}` | The stream fell 256 events behind. | Reconnect with your last id. |
| `4001` | the same | The user token expired. | Mint a new token and reconnect. |
| `4003` | the same | The host revoked the user (`role: none`). Nothing is sent after the revoke. | Stop. |

## Limits and proxies

- At most 100 streams per file on one server: `429 TOO_MANY_STREAMS`. Share one stream between
  your workers.
- Behind nginx the answer sets `X-Accel-Buffering: no`; keep proxy read timeouts above 15 seconds
  (the keep-alive interval).
- Events are a notification, not a log: when you need the content, read it with the API.

## Sync the document itself

A Yjs-native program (yrs, Yjs, y-crdt bindings) can hold the CRDT document instead of calling
the API per change: `POST /api/v1/files/{fileId}/sync-token` answers a ticket for the room
WebSocket.

```json
{"ticket": "01M87JV4T23GYQ773ZF1WN91VA", "room": "r_2whbv4nncveupmqu35cywoidfe", "role": "edit",
 "url": "/v1/collab/r_2whbv4nncveupmqu35cywoidfe?ticket=01M87JV4T23GYQ773ZF1WN91VA",
 "expiresAt": 1795551874, "connectWithinSecs": 60}
```

Connect a y-websocket client to `url` within 60 seconds. `role` is the effective one,
`min(scope, role)`: a `canvas:read` token gets `view`, and the room refuses its writes as it
would a viewer's. The session ends at `expiresAt` (at most 15 minutes, never after the token's
`exp`); ask for a new ticket to continue. The answer is a credential: `Cache-Control: no-store`,
and it is never stored for idempotent replays. See
[createSyncToken](reference/streams.html#createSyncToken).
