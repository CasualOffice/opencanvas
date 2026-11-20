# 05 — Integration Guide (host contract)

**Status:** draft v0.1, 2026-11-21. This is the contract an integrating
application implements. Modelled on Collabora Online's WOPI integration
([01 §4](01-RESEARCH-COMPETITIVE-ANALYSIS.md)).

> **Golden rule:** your application decides *who* may open *which* file with
> *what* role. OpenCanvas trusts that decision for the life of the token and
> enforces it on every edit. Your application stores the file.

## 1. Choose a handshake

| | **JWT launch** (recommended for new apps) | **WOPI-compatible** (for existing WOPI hosts) |
|---|---|---|
| Who verifies the user | You sign a JWT | OpenCanvas calls your CheckFileInfo |
| Callbacks you implement | `GET file`, `PUT file`, assets, users | WOPI: CheckFileInfo, GetFile, PutFile (+ assets/users optional) |
| Extra round-trip on open | none | CheckFileInfo |
| Good for | Any custom app | Nextcloud, ownCloud, Seafile-style hosts |

## 2. Register your host

`opencanvas.hosts.toml` (or `hosts` table):
```toml
[[host]]
id              = "Acme"
name            = "Acme"
mode            = "jwt"                    # jwt | wopi | both
jwt_alg         = "HS256"                  # or RS256 / EdDSA with jwks_url
jwt_secret      = "env:ACME_OC_SECRET"
api_key         = "env:ACME_OC_API_KEY"    # for server→server REST calls to us
callback_base   = "https://api.acme.example/opencanvas"
allowed_origins = ["https://app.acme.example"]
[host.flags]
embeds          = ["youtube", "vimeo", "loom", "figma", "maps"]
export_formats  = ["md", "html", "pdf", "ocanvas"]
autosave_secs   = 60
on_conflict     = "copy"                   # copy | reload
```

## 3. JWT launch token

Signed by your backend, short-lived (≤ 10 h; 5–15 min recommended — it is
exchanged for a session ticket on open).

```json
{
  "iss": "Acme",                    // = host id
  "aud": "opencanvas",
  "exp": 1763730000,
  "jti": "9f1c…",                   // single-use
  "file": {
    "id": "doc_8812",               // your stable id
    "name": "Sprint 42 notes",
    "version": "17",                // your current version/etag
    "context": { "type": "channel", "id": "c_55" }   // optional, for UI only
  },
  "user": {
    "id": "u_123",
    "name": "Asha Rao",
    "avatar": "https://…/a.png",
    "color": "#7c3aed"              // optional; we derive one otherwise
  },
  "role": "edit",                   // view | comment | edit
  "perms": {
    "export": true,
    "download": true,
    "print": true,
    "commitMessage": true,          // may write "Save version" messages
    "mention": true
  },
  "mode": "edit",                   // edit | view | preview
  "callbackToken": "opaque-…"       // we send it back on every callback; you validate it
}
```

## 4. Embed in your page

### Option A — iframe form POST (works everywhere, like Collabora)
```html
<form id="oc" target="oc-frame" method="post"
      action="https://canvas.example.com/v1/launch">
  <input type="hidden" name="token" value="{{ jwt }}">
</form>
<iframe name="oc-frame" style="width:100%;height:100%;border:0"
        allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<script>document.getElementById('oc').submit()</script>
```

### Option B — web component
```html
<script type="module" src="https://canvas.example.com/sdk/embed.js"></script>
<open-canvas server="https://canvas.example.com" token="{{ jwt }}"
             theme="auto" style="height:100vh"></open-canvas>
<script>
  const oc = document.querySelector('open-canvas');
  oc.addEventListener('oc:ready',  e => {});
  oc.addEventListener('oc:saved',  e => console.log(e.detail.commitId));
  oc.addEventListener('oc:presence', e => console.log(e.detail.users));
  oc.addEventListener('oc:error',  e => {});
  oc.addEventListener('oc:token-expiring', async e => oc.refresh(await myApi.newToken()));
  await oc.commit({ message: 'Final' });
  oc.setReadOnly(true);
</script>
```

### postMessage API (iframe ↔ host page)
Messages are `{ "MessageId": "...", "SendTime": ms, "Values": {...} }`
(Collabora-compatible envelope).

| Direction | MessageId | Values |
|---|---|---|
| canvas → host | `App_LoadingStatus` | `{ Status: "Frame_Ready" \| "Document_Loaded" }` |
| canvas → host | `Doc_ModifiedStatus` | `{ Modified: bool }` |
| canvas → host | `Doc_Saved` | `{ commitId, hostVersion }` |
| canvas → host | `Presence_Changed` | `{ users: [{id,name,color,role}] }` |
| canvas → host | `Token_Expiring` | `{ inSeconds }` |
| canvas → host | `UI_Mention_Click` / `UI_Link_Click` | `{ id \| url }` (host decides navigation) |
| canvas → host | `Error` | `{ code, message }` |
| host → canvas | `Host_PostmessageReady` | `{}` |
| host → canvas | `Action_Commit` | `{ message? }` |
| host → canvas | `Action_SetReadOnly` | `{ readOnly }` |
| host → canvas | `Action_RefreshToken` | `{ token }` |
| host → canvas | `Action_Export` | `{ format }` |
| host → canvas | `Action_Theme` | `{ theme: "light"\|"dark"\|tokens }` |

Origins are checked against `allowed_origins` both ways.

## 5. Callbacks you implement (JWT mode)

Base: `callback_base`. Every call carries
`Authorization: Bearer <callbackToken>` and `X-OpenCanvas-Signature:
t=<ts>,v1=<HMAC-SHA256(secret, ts + "." + body)>` so you can verify it is us.

| Call | Request | Response |
|---|---|---|
| **Load file** `GET /files/{fileId}` | — | `200` body = `.ocanvas` / `.md` / `.html` bytes, headers `Content-Type`, `ETag: "<version>"`. `404` → new empty canvas. |
| **Save (commit)** `PUT /files/{fileId}` | body `.ocanvas`; headers `If-Match: "<version>"`, `Idempotency-Key: <commitId>`, `X-OpenCanvas-Commit-Message`, `X-OpenCanvas-Authors: <json>`, `X-OpenCanvas-Autosave: 0|1` | `200 {"version":"18"}`; `409 {"version":"19"}` if your file changed outside the session; `413` too large. |
| **Save as copy** `POST /files/{fileId}/copies` (conflict policy `copy`) | body `.ocanvas` | `201 {"fileId":"doc_9001","url":"…"}` |
| **Upload asset** `POST /files/{fileId}/assets` | multipart `file` | `201 {"assetId":"a_1","url":"https://…","mime":"image/png","size":1234}` |
| **Get asset** `GET /files/{fileId}/assets/{assetId}` | — | bytes or `302` to a signed URL |
| **Resolve users** `GET /users?q=as&fileId=` | — | `[{"id","name","avatar"}]` (for @mention; only users who can see the file) |
| **Refresh token** *(optional)* `POST /tokens/refresh` | `{fileId,userId}` | `{ "token": "<new jwt>" }` |

Timeouts: 10 s (load/save), 5 s (others). Retries with exponential backoff
for save (idempotent by `Idempotency-Key`).

## 6. WOPI mode

Host page POSTs `access_token`, `access_token_ttl` to
`/v1/launch?WOPISrc=<urlencoded https://host/wopi/files/<id>>`.

We call:
- `GET  {WOPISrc}?access_token=…` → CheckFileInfo. We read: `BaseFileName`,
  `Size`, `Version`, `LastModifiedTime`, `UserId`, `UserFriendlyName`,
  `UserCanWrite`, `ReadOnly`, `UserCanNotWriteRelative`, `DisableExport`,
  `DisablePrint`, `UserExtraInfo.avatar`, and our extensions
  `OpenCanvas_UserCanComment`, `OpenCanvas_AssetsUrl`, `OpenCanvas_UsersUrl`.
- `GET  {WOPISrc}/contents?access_token=…` → GetFile.
- `POST {WOPISrc}/contents?access_token=…` with `X-WOPI-Override: PUT`,
  `X-COOL-WOPI-Timestamp: <LastModifiedTime>` → PutFile; `409` with
  `{"COOLStatusCode":1010}` = conflict.
- `POST {WOPISrc}` with `X-WOPI-Override: PUT_RELATIVE` for save-as-copy.

Discovery: `GET /hosting/discovery` returns WOPI discovery XML advertising
`ocanvas` (edit/view) and `md` (edit/view, convert-on-save option).

## 7. Server-to-server REST (you → us)

Use `X-OpenCanvas-Key: <api_key>` + `X-OpenCanvas-Host: <host id>`.

- Revoke or downgrade a user live when you change ACLs:
  `POST /v1/files/{fileId}/role {"userId":"u_123","role":"view"}` — the
  user's open session switches to read-only immediately (or is closed with
  `"role":"none"`).
- Patch content from a bot: `POST /v1/files/{fileId}/patch` (see 04 §6).
- Force save before you snapshot/backup: `POST /v1/files/{fileId}/commit`.
- Close everything (file deleted/moved): `DELETE /v1/files/{fileId}/session`.
- Stateless conversion: `POST /v1/convert?from=md&to=ocanvas`.

## 8. Lifecycle & guarantees

- **One live room per (host, file).** Users who open the same file join the
  same room — there is no fork. The room loads your file once.
- **Your file is updated by commits only.** Autosave commits are flagged
  `X-OpenCanvas-Autosave: 1` so you can collapse them in version history.
- **At-least-once commit** with idempotency key; final commit before room
  close; on graceful shutdown all dirty rooms commit.
- **Nothing is retained** after the room closes and TTL passes.
- **Role changes** you make during a session take effect only when you call
  the role API or the token expires — tokens are the contract.

## 9. Checklist for integrators

- [ ] Register host, share secret/API key out of band.
- [ ] Backend endpoint that signs the launch JWT after *your* ACL check.
- [ ] Implement load / save (+ assets, users).
- [ ] Verify `X-OpenCanvas-Signature` on callbacks.
- [ ] Add OpenCanvas origin to your CSP `frame-src`; add your origin to our `allowed_origins`.
- [ ] Handle `409` (we save a copy or reload, per your policy).
- [ ] Call the role API when ACLs change.
- [ ] Try `examples/sample-host` end-to-end before going live.
