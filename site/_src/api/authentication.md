<!--meta {"title": "Authentication", "description": "Authenticate to the OpenCanvas API with the host key or a user token your app mints: claims, issuer, audience, scopes, roles, expiry and examples.", "lede": "Two kinds of credentials, one check. Your server uses the host key; code that acts for one of your users carries a short-lived token that your application mints. OpenCanvas never issues user tokens and runs no OAuth server."} -->

## Host key

Server to server, send your host id and the host's `api_key` (from the hosts file) on every
request. The host key has full access to your host's files, the admin operations included.

| Header | Value |
|---|---|
| `X-OpenCanvas-Host` | Your host id, for example `acme`. |
| `X-OpenCanvas-Key` | The host's `api_key`. Keep it on your server; never send it to a browser. |
| `X-OpenCanvas-Author` | Optional. The user id a change is attributed to: its edit origin becomes `api:<userId>`. Default `svc:<hostId>`. |
| `X-OpenCanvas-Callback-Token` | Optional. A bearer OpenCanvas passes on the callbacks this call causes (loading the file when nobody has it open, saving it). |

:::samples Host key
```bash
curl -s "https://canvas.example.com/api/v1/files/doc_1?format=outline" \
  -H "X-OpenCanvas-Host: acme" \
  -H "X-OpenCanvas-Key: $OC_API_KEY" \
  -H "X-OpenCanvas-Author: u_42"
```
```ts
import { OpenCanvas } from "@opencanvas/client";

const oc = new OpenCanvas({
  baseUrl: "https://canvas.example.com",
  auth: { hostId: "acme", key: process.env.OC_API_KEY!, author: "u_42" },
});
const outline = await oc.readFile({ fileId: "doc_1", query: { format: "outline" } });
```
```rust
use opencanvas_client::{Auth, Client};

let oc = Client::builder("https://canvas.example.com")
    .auth(Auth::HostKey {
        host_id: "acme".into(),
        key: std::env::var("OC_API_KEY").expect("OC_API_KEY"),
        author: Some("u_42".into()),
        callback_token: None,
    })
    .build();
let outline = oc.read_file("doc_1", Some("outline")).await?;
```
```python
import os

import requests

r = requests.get(
    "https://canvas.example.com/api/v1/files/doc_1",
    params={"format": "outline"},
    headers={
        "X-OpenCanvas-Host": "acme",
        "X-OpenCanvas-Key": os.environ["OC_API_KEY"],
        "X-OpenCanvas-Author": "u_42",
    },
    timeout=30,
)
r.raise_for_status()
```
:::

## User tokens

For code that acts for one of your users (an integration running as that user, a script a
user starts), mint a JWT for that user and send it as `Authorization: Bearer <token>`. You sign
it with the same keys as launch tokens: the host's `jwt_secret` (HS256), or your private key
when the host has `jwt_public_key` (RS256, EdDSA) or `jwt_jwks_url`.

| Claim | Value |
|---|---|
| `iss` | Your host id, or `[host.api] issuer`. It picks the host, so it must be unique among the server's hosts. |
| `aud` | `{[host.api] audience or OC_PUBLIC_URL}/api/v1`, for example `https://canvas.example.com/api/v1`. A launch token or an MCP token (audience `.../mcp/{hostId}`) is refused here. |
| `sub` | The user id, as in launch tokens. `svc:<name>` for a backend job. |
| `exp` | At most 15 minutes ahead of the server's clock (with 30 seconds of leeway). `nbf` is honoured. |
| `scope` | Space-separated: `canvas:read`, `canvas:comment`, `canvas:write`, `canvas:admin`. |
| `role` | The user's role on the files: `view`, `comment` or `edit` (absent: `view`). Used only when you do not implement `POST /access`. |
| `files` | The file ids the token covers. Required when you do not implement `POST /access`, unless the host sets `[host.api] all_files = true`. |
| `name` | Optional display name, shown with the user's changes. |

The audience is never taken from the request: without `OC_PUBLIC_URL` or
`[host.api] audience`, user tokens are off for the host and answer `401 TOKEN_INVALID`.

```toml
[host.api]
issuer      = "acme"                        # default: the host id
audience    = "https://canvas.example.com"  # default: OC_PUBLIC_URL
all_files   = false                         # true: without /access, a token with no `files` covers every file
token_admin = false                         # true: tokens with canvas:admin may use the admin operations
```

:::samples Mint a user token and call the API
```bash
# HS256 with the host's jwt_secret, using only openssl.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
claims=$(printf '{"iss":"acme","aud":"https://canvas.example.com/api/v1","sub":"u_42","scope":"canvas:read canvas:comment","role":"edit","files":["doc_1"],"iat":%d,"exp":%d}' \
  "$now" "$((now + 600))" | b64url)
sig=$(printf '%s.%s' "$header" "$claims" | openssl dgst -sha256 -hmac "$ACME_OC_SECRET" -binary | b64url)
TOKEN="$header.$claims.$sig"

curl -s "https://canvas.example.com/api/v1/files/doc_1/comments" \
  -H "Authorization: Bearer $TOKEN"
```
```ts
// npm install jose
import { SignJWT } from "jose";
import { OpenCanvas } from "@opencanvas/client";

const secret = new TextEncoder().encode(process.env.ACME_OC_SECRET!);

async function mintUserToken(userId: string, scope: string, files: string[]): Promise<string> {
  return new SignJWT({ scope, role: "edit", files })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("acme")
    .setAudience("https://canvas.example.com/api/v1")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

// The token callback runs before every request, so a long job never sends an expired token.
const oc = new OpenCanvas({
  baseUrl: "https://canvas.example.com",
  auth: { token: () => mintUserToken("u_42", "canvas:read canvas:comment", ["doc_1"]) },
});
const { threads } = (await oc.listComments({ fileId: "doc_1" })) as { threads: unknown[] };
```
```rust
// jsonwebtoken = "9", serde_json = "1"
use jsonwebtoken::{encode, EncodingKey, Header};
use opencanvas_client::{Auth, Client};
use serde_json::json;

fn mint_user_token(secret: &[u8], user_id: &str, scope: &str, files: &[&str]) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let claims = json!({
        "iss": "acme",
        "aud": "https://canvas.example.com/api/v1",
        "sub": user_id,
        "scope": scope,
        "role": "edit",
        "files": files,
        "iat": now,
        "exp": now + 600,
    });
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret)).expect("signed")
}

let secret = std::env::var("ACME_OC_SECRET").expect("ACME_OC_SECRET");
let token = mint_user_token(secret.as_bytes(), "u_42", "canvas:read canvas:comment", &["doc_1"]);
let oc = Client::builder("https://canvas.example.com")
    .auth(Auth::Token(token))
    .build();
let threads = oc.list_comments("doc_1", None).await?;
```
```python
# pip install pyjwt requests
import os
import time

import jwt
import requests


def mint_user_token(user_id: str, scope: str, files: list[str]) -> str:
    now = int(time.time())
    claims = {
        "iss": "acme",
        "aud": "https://canvas.example.com/api/v1",
        "sub": user_id,
        "scope": scope,
        "role": "edit",
        "files": files,
        "iat": now,
        "exp": now + 600,
    }
    return jwt.encode(claims, os.environ["ACME_OC_SECRET"], algorithm="HS256")


token = mint_user_token("u_42", "canvas:read canvas:comment", ["doc_1"])
r = requests.get(
    "https://canvas.example.com/api/v1/files/doc_1/comments",
    headers={"Authorization": f"Bearer {token}"},
    timeout=30,
)
r.raise_for_status()
```
:::

## Scopes

A token's scope is a ceiling: the operation's `x-opencanvas-scope` in the OpenAPI document must
be within it, or the answer is `403 SCOPE_REQUIRED`. Each scope includes the ones above it.

{{api:scopes}}

## Roles

The **effective permission** is `min(scope, role)`. A `canvas:write` token does not let a `view`
user write, and a `canvas:read` token does not let an editor write.

- **Where the role comes from.** If you implement the optional `POST /access` callback,
  OpenCanvas asks it for the user's role on each file a call touches (cached 30 seconds, dropped
  by the role API) and ignores the token's `role` claim; `none` refuses every operation. Without
  it, the `role` claim counts, but only for the files listed in `files` (`403 FILES_REQUIRED`
  otherwise, unless `[host.api] all_files = true`).
- **Revocation.** After `POST /api/v1/files/{fileId}/role` with `"role": "none"`, the user's
  next call is refused, and their event streams close with code `4003`.
- **The host key** acts with the `edit` role on every file, plus the admin operations.

## Expiry

Tokens live at most 15 minutes: an `exp` further ahead than that is refused
(`401 TOKEN_INVALID`). An expired token answers `401 TOKEN_EXPIRED`; an event stream opened with
a token closes with code `4001` when it expires. Mint a fresh token per job or per request: the
clients take a token callback that runs before every request.

## Errors

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No credentials, an unknown host, or a wrong host key. |
| 401 | `TOKEN_INVALID` | Signature, issuer, audience, a lifetime over 15 minutes, not yet valid, or no public base URL for the host. |
| 401 | `TOKEN_EXPIRED` | The token's `exp` has passed. |
| 403 | `SCOPE_REQUIRED` | The operation needs a scope the token lacks (admin operations: `canvas:admin` and `token_admin`). |
| 403 | `ROLE_FORBIDDEN` | The user's role on the file is too low, the file is not in `files`, or access was revoked. |
| 403 | `FILES_REQUIRED` | No `POST /access` callback, and the token lists no `files`. |

401 answers carry `WWW-Authenticate: Bearer realm="opencanvas"` (with `error="invalid_token"` for
token problems). The MCP endpoint uses the same check with its own audience; see
[AI and MCP](../../../docs/24-AI-AND-MCP.md).
