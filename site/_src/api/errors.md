<!--meta {"title": "Errors", "description": "OpenCanvas API errors: the RFC 9457 problem details shape, how to handle each status, and every machine code with its status and meaning.", "lede": "Every error answer is RFC 9457 problem details, application/problem+json, with a machine code you can branch on. The code is stable; the human detail is not."} -->

## The shape

{{api:problem}}

| Member | Meaning |
|---|---|
| `type` | `urn:opencanvas:problem:<code in lower case, hyphens>`. A stable name, not a URL to fetch. |
| `title` | The HTTP reason phrase of `status`. |
| `status` | The HTTP status, repeated in the body. |
| `detail` | What went wrong, in words, for logs and people. It can change between releases; do not parse it. |
| `code` | The machine code: branch on this. The same codes the 0.1 routes use. |
| `fresh` | Only with `STALE_BLOCK`: the current state to retry against. |

Unknown members may be added later; ignore them. Even answers the router gives before an
operation runs (an unknown path, a wrong method) are problem details, so a client parses one
error format.

## Handling them

| Status | What to do |
|---|---|
| `400` | Fix the request; `detail` says what is wrong. Do not retry it unchanged. |
| `401` | Fix the credentials: the host key, or mint a new token. |
| `403` | The scope or the user's role does not allow it. Do not retry. |
| `404` | Unknown file part or operation, or the API is off (`API_OFF`). |
| `409` | `CONFIRMATION_REQUIRED`: send again with `"confirm": true`. `IDEMPOTENCY_IN_PROGRESS`: retry after `Retry-After`. `CONFLICT`: your save callback reported a conflict. |
| `410` | `CURSOR_EXPIRED`: start the walk again without a cursor. |
| `412` | `STALE_BLOCK`: re-read (or use `fresh`), apply your change again, send it with the new revision. |
| `413` | The body or the resulting document is too large. |
| `422` | `IDEMPOTENCY_KEY_REUSED`: a new request needs a new key. |
| `429` | Wait `Retry-After` seconds, then retry. |
| `5xx` | `503` and `502` are transient: retry after `Retry-After` with backoff. `501`: the server is not set up for it (PDF). |

The TypeScript and Rust clients turn these into typed errors and retry `429`, `503` and
`409 IDEMPOTENCY_IN_PROGRESS` for you; see [SDKs](sdks.html).

## Every code

{{api:errors}}

## The 0.1 routes

The deprecated `/v1/files/{fileId}/...` routes keep their old error shape,
`{"error": {"code": "...", "message": "..."}}`, with the same codes. Only `/api/v1` answers
problem details.
