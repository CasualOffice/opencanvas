<!--meta {"title": "Webhooks", "description": "OpenCanvas webhooks: configure [host.webhooks], the signed POST per change event, payloads, signature checks in shell, TypeScript, Rust and Python, and retries.", "lede": "OpenCanvas POSTs a file's change events to one URL of yours, so you can react without holding a stream open: index a saved file, notify on a comment. Deliveries are signed, retried, and survive restarts."} -->

## Turn them on

Webhooks are off unless the host's entry has a `[host.webhooks]` table:

```toml
[host.webhooks]
url          = "https://host.example.com/opencanvas/hooks"  # must be on your callback_base origin
events       = ["saved", "commented", "mentioned"]          # or ["*"]; the event types below
# secret     = "env:OC_WEBHOOK_SECRET"                      # default: callback_secret, else jwt_secret
# max_attempts = 12                                         # 1-20
```

| Setting | Meaning |
|---|---|
| `url` | Where to POST. It must be on the same origin (scheme, host and port) as your `callback_base`; anything else stops the server at start-up and is refused again before every delivery. To receive on another domain, relay from your callback origin. |
| `events` | The [event types](events.html#the-event) to send, or `["*"]` for all. |
| `secret` | The signing secret. Default: the host's callback secret, else its `jwt_secret`. |
| `max_attempts` | Attempts before an event is dropped, 1 to 20 (default 12, about a day). |

Webhooks need a database (SQLite, MySQL or MariaDB): with Redis-only storage the server refuses
to start with `[host.webhooks]`.

## The request

One `POST` per event. The body is the event, the same JSON as on the [events stream](events.html):
ids, user ids, versions and counts, never document text.

{{api:webhook-request}}

| Header | Meaning |
|---|---|
| `X-OpenCanvas-Event` | The event type. |
| `X-OpenCanvas-Event-Id` | The event id (`ev_<ulid>`). |
| `Idempotency-Key` | The event id again: deduplicate on it. |
| `X-OpenCanvas-Delivery-Attempt` | 1 for the first attempt, then 2, 3, ... |
| `X-OpenCanvas-Signature` | `t=<unix seconds>,v1=<hex>,v2=<hex>`. Verify `v2`. |

No bearer token is sent; the signature is the credential.

## Payloads

| `type` | Example `data` |
|---|---|
| `edited` | `{"blockIds": ["b_01m87jv4rtkdxymn93jwtx35sk"], "removedBlockIds": [], "databaseIds": ["db_01m87jv4sc2twxjhzzxzh7mene"], "by": ["u_42"]}` |
| `commented` | `{"threadId": "t_01m87jv4sqj5z6jz5q2n5zdtdw", "blockId": "b_01m87jv4rtkdxymn93jwtx35sk", "added": 1, "by": ["u_42"]}` |
| `mentioned` | `{"mentioned": ["u_7"], "by": "u_42", "blockId": "b_01m87jv4rtkdxymn93jwtx35sk"}` |
| `member.joined` | `{"userId": "u_42", "role": "edit"}` |
| `member.left` | `{"userId": "u_42"}` |
| `saved` | `{"version": "18"}` |
| `restored` | `{"restoreId": "01m87k0a2b3c4d5e6f7g8h9j0k", "from": "17", "by": "u_42"}` |
| `session.closed` | `{"reason": "host"}` or `{"reason": "idle"}` |

`resync` is never sent to webhooks; it only exists on streams.

## Verify the signature

`v2` is HMAC-SHA256 of `"<t>.POST.<path?query>.<body>"` with your secret, in lower-case hex:

1. Read the raw body bytes **before** any JSON parsing; a re-serialised body does not match.
2. Use the path and query **as your server received them** (behind a proxy that rewrites paths,
   the path OpenCanvas sent to).
3. Compare in constant time, and reject a `t` more than 5 minutes from your clock. `t` is the
   time of the attempt, so each retry has a new signature.

`v1` (timestamp and body only) is kept for old callback verifiers; do not use it for webhooks.

{{api:webhook-verify}}

### Test vector

Your verifier must accept this delivery (with the clock at `t`) and refuse it when any byte of
the body, the path or the signature changes:

{{api:webhook-vector}}

## Answer and retries

Answer any `2xx` **quickly** (10-second timeout) and do the work afterwards.

| Your answer | What OpenCanvas does |
|---|---|
| `2xx` | Delivered. |
| Network error, timeout, `408`, `425`, `429`, `5xx` | Retried after 10 s, 30 s, 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, 4 h, 8 h, then every 12 h, until `max_attempts`; then dropped. A longer `Retry-After` (seconds, up to 12 h) wins. |
| Any other `3xx` or `4xx` | Dropped at once. Redirects are never followed. |

- **At least once.** An event can arrive twice: deduplicate on `Idempotency-Key`.
- **Order is not guaranteed** across retries: order a file's events by `at` and the id (a ULID).
- **Durable.** Events are written to a database outbox (`webhook_outbox`) by the server that runs
  the file's live room before they are sent, so they survive restarts, and exactly one server of
  a cluster sends each. An event can be lost only if that server dies between the change and the
  outbox write.

## Metrics

`oc_webhook_deliveries_total{host,result}` (`ok`, `retry`, `rejected`, `gave_up`, `refused`) and
`oc_webhook_delivery_seconds{host}` (one attempt's time), on the operations dashboard's
"Webhooks" row.
