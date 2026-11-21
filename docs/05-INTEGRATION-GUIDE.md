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
| Callbacks you implement | `GET file`, `PUT file`, assets (people search and resolve optional) | WOPI: CheckFileInfo, GetFile, PutFile |
| Extra round-trip on open | none | CheckFileInfo |
| Good for | Any custom app | Nextcloud, ownCloud, Seafile-style hosts |

## 2. Register your host

`opencanvas.hosts.toml` (or `hosts` table):
```toml
[[host]]
id              = "acme"
name            = "Acme"
mode            = "jwt"                    # jwt | wopi | both
jwt_alg         = "HS256"                  # or RS256 / EdDSA: jwt_public_key (PEM) or jwt_jwks_url
jwt_secret      = "env:ACME_OC_SECRET"
api_key         = "env:ACME_OC_API_KEY"    # for server→server REST calls to us
callback_base   = "https://api.acme.example/opencanvas"
allowed_origins = ["https://app.acme.example"]
asset_origins   = ["https://cdn.acme.example"] # extra image origins for exports (unsigned GET);
                                           # your callback_base origin is always allowed
[host.flags]
embeds          = ["youtube", "vimeo", "loom", "figma", "maps"]
export_formats  = ["md", "html", "pdf", "ocanvas"]
autosave_secs   = 60
on_conflict     = "copy"                   # copy | reload

[host.directory]                           # people (docs/21)
coviewers       = "contacts"               # all | contacts | none
```

`directory.coviewers` decides whether people who opened the same canvas see each other in the
@mention list and by name in presence: `all` always, `none` never ("Someone"), `contacts` (default)
only when your `POST /users/resolve` says they are a `contact` or `member` of the viewer. Without
a resolve callback OpenCanvas can't tell contacts apart, and `contacts` behaves like `all`.

## 3. JWT launch token

Signed by your backend, short-lived (≤ 10 h; 5–15 min recommended — it is
exchanged for a session ticket on open).

```json
{
  "iss": "acme",                    // = host id
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
    "id": "u_123",                  // stable, opaque: the identity (names are display only)
    "name": "Asha Rao",
    "detail": "Design · Bengaluru", // optional second line that tells same-named people apart
    "email": "asha@acme.example",   // optional; shown only with perms.showEmail
    "avatar": "https://…/a.png",    // http(s) only
    "color": "#7c3aed"              // optional; we derive one otherwise
  },
  "participants": [                 // optional (tier 1, docs/21): people THIS user may mention,
    { "id": "u_200", "name": "Ravi Menon", "detail": "Engineering" }   // e.g. the channel; ≤ 200,
  ],                                // never shown to anyone else
  "role": "edit",                   // view | comment | edit
  "perms": {
    "export": true,
    "download": true,
    "print": true,
    "commitMessage": true,          // may write "Save version" messages
    "mention": true,
    "showEmail": false              // e-mails of people may be shown to (and stored for) this user
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

The SDK is served with CORS for the host's `allowed_origins` only, and the canvas sets
`frame-ancestors` to the same list: register every origin your pages embed from.

### postMessage API (iframe ↔ host page)
Messages are `{ "MessageId": "...", "SendTime": ms, "Values": {...} }`
(Collabora-compatible envelope).

| Direction | MessageId | Values |
|---|---|---|
| canvas → host | `App_LoadingStatus` | `{ Status: "Frame_Ready" \| "Document_Loaded" }` |
| canvas → host | `Doc_ModifiedStatus` | `{ Modified: bool }` |
| canvas → host | `Doc_Saved` | `{ commitId, hostVersion }` |
| canvas → host | `Presence_Changed` | `{ users: [{id,name,color,role,detail?}] }` (as this viewer sees them: a `hidden` person is `{id:"anon_…",name:"Someone"}`) |
| canvas → host | `Token_Expiring` | `{ inSeconds }` |
| canvas → host | `UI_Mention_Click` / `UI_Link_Click` | `{ id \| url }` (host decides navigation) |
| canvas → host | `UI_BlockLink` | `{ fileId, blockId }` ("Copy link to block": the host builds its own URL, e.g. `https://app/files/<fileId>#block=<blockId>`; ADR-023/027). The same values are also posted as `UI_Block_Link`, the earlier name; new hosts listen to `UI_BlockLink` only. |
| canvas → host | `Error` | `{ code, message }` |
| host → canvas | `Host_PostmessageReady` | `{}` |
| host → canvas | `Action_Commit` | `{ message? }` |
| host → canvas | `Action_SetReadOnly` | `{ readOnly }` |
| host → canvas | `Action_RefreshToken` | `{ token }` |
| host → canvas | `Action_Export` | `{ format }` |
| host → canvas | `Action_Theme` | `{ theme: "light"\|"dark"\|tokens }` |
| host → canvas | `Action_ScrollToBlock` | `{ blockId }`: scroll to the block and flash it (1.8 s; a steady outline with reduced motion). Unknown ids show "That block isn't in this canvas any more". |

Origins are checked against `allowed_origins` both ways.

**Links to a block.** Your link is your URL (OpenCanvas never shows one of its own inside a
host). To open the canvas at a block, either pass `block=<blockId>` to the launch (a form field
next to `token`, or `?block=` on `/v1/launch`; anything but `[A-Za-z0-9_-]{1,64}` is dropped) and
the editor opens with `#t=…&block=<id>`, or send `Action_ScrollToBlock` once the frame has loaded.
`examples/sample-host` does both: its file page reads `#block=` from its own URL into the launch
form, and its Mentions list sends `Action_ScrollToBlock`.

## 5. Callbacks you implement (JWT mode)

Base: `callback_base`. Every call carries `Authorization: Bearer <callbackToken>` and
`X-OpenCanvas-Signature: t=<ts>,v1=<hex>,v2=<hex>` so you can verify the call comes from
OpenCanvas:

- `v2` = hex HMAC-SHA256(secret, `"<ts>.<METHOD>.<path?query>.<body>"`). Verify this one. It
  binds the request method and path, so a captured signature can't be replayed against
  another endpoint.
- `v1` = hex HMAC-SHA256(secret, `"<ts>.<body>"`), kept for hosts written before v2.
- Reject timestamps more than 5 minutes off, and compare in constant time.
- OpenCanvas never follows redirects from your callbacks: answer directly.

`examples/sample-host/server.mjs` verifies `v2`.

| Call | Request | Response |
|---|---|---|
| **Load file** `GET /files/{fileId}` | — | `200` body = `.ocanvas` / `.md` / `.html` bytes, headers `Content-Type`, `ETag: "<version>"`. `404` → new empty canvas. |
| **Save (commit)** `PUT /files/{fileId}` | body `.ocanvas`; headers `If-Match: "<version>"`, `Idempotency-Key: <commitId>`, `X-OpenCanvas-Commit-Message`, `X-OpenCanvas-Authors: <json>`, `X-OpenCanvas-Autosave: 0|1` | `200 {"version":"18"}`; `409 {"version":"19"}` if your file changed outside the session; `413` too large. |
| **Save as copy** `POST /files/{fileId}/copies` (conflict policy `copy`) | body `.ocanvas`; `Idempotency-Key` | `201 {"fileId":"doc_9001","url":"…"}` (create it with the original's ACL) |
| **Upload asset** `POST /files/{fileId}/assets` | multipart `file` | `201 {"assetId":"a_1","url":"https://…","mime":"image/png","size":1234}` |
| **Get asset** `GET /files/{fileId}/assets/{assetId}` | — | bytes or `302` to a signed URL |
| **Search people** *(optional, tier 2)* `GET /users?q=as&fileId=` | called with the **viewer's** `callbackToken`; cached 30 s per viewer | `[{"id","name","detail","email","avatar","access"}]` (or `{"users":[…]}`): the people *this viewer* may see. `access: false` = can't open the file (the picker warns "Ravi can't open this canvas"). `404`/`405`/`410`/`501` = not implemented |
| **Resolve people** *(optional, tier 3)* `POST /users/resolve` | JSON `{"ids":[…],"fileId"}` (≤ 200 per call), the **viewer's** `callbackToken`; cached 10 min per (file, viewer), refreshed when they reopen | `[{"id","name","detail","avatar","relation","deactivated"}]` (or `{"users":[…]}`): how *this viewer* sees each id. `relation`: `contact`, `member`, `external` (show only the `name` you return, e.g. "Asha R.") or `hidden` ("Someone"). `name` may be the viewer's own nickname. Ids you leave out fall back to tokens and the stored label |
| **Refresh token** *(optional)* `POST /tokens/refresh` | `{fileId,userId}` | `{ "token": "<new jwt>" }` |
| **Mentions** *(optional)* `POST /mentions` | JSON `{fileId, blockId?, threadId?, mentioned:[userId], by:userId, excerpt}`; header `Idempotency-Key` | any `2xx`. `404`/`405`/`410`/`501` = not implemented (never retried) |

**Mentions** (ADR-027). When someone @mentions people in a comment, or puts a mention chip in
the canvas text, we tell you so you can notify them (we never send mail or push ourselves).
One call per comment message, and one per block per edit for text mentions; `threadId` is set
for comments, `blockId` for text (the editor gives the block an id when the mention is
inserted, so you can link to it). `by` is the user whose connection wrote it (from the grant,
not from the document); the author is never in `mentioned`. `excerpt` is the message or block
text, at most 280 characters. A mention that was already in the file when the room loaded, or
one the editor re-creates when a paragraph is split or moved, is not sent again. The ids in
`mentioned` come from the editor's people list (your `GET /users`): **check that each person
can see the file before you notify them.** Delivery is fire-and-forget for the session: the call
is written to our notification outbox first, sent at once, and retried with backoff (10 s → 1 h,
8 attempts, same `Idempotency-Key`) when it fails with a network error, `429` or `5xx`. Any other
`4xx` drops it. Signed like every callback. `examples/sample-host` logs each call and lists them
on the file page. **WOPI hosts get no mention calls** (WOPI has no notification API); use JWT
mode, or `mode = "both"`, if you need them.

**People** (docs/21, ADR-026). Every person is keyed by your stable `user.id`. OpenCanvas learns
about people in four tiers, each optional beyond the first: (0) launch tokens only: everyone who
opened the file is remembered in the canvas (`people` in the `.ocanvas`: id, name, detail, avatar,
last seen; e-mail only with `perms.showEmail`); (1) `participants` in the token; (2) `GET /users`
search; (3) `POST /users/resolve`. Sources merge per id: **resolve > token > the document's stored
label**. Everything about other people is answered per viewer, with that viewer's token, so two
people on one canvas may see different names, or "Someone". Presence (avatars, cursors) is
rewritten per viewer by OpenCanvas, so a real name never reaches someone who mustn't see it.
Exports render people as the exporting viewer sees them. Mentions store the id plus the label
the author saw; each viewer sees their own name for the person.

Timeouts: 10 s (load/save), 5 s (others). Retries with exponential backoff
for save (idempotent by `Idempotency-Key`). A save is written to our commit outbox before
we call you, so it is retried with the same key even across a restart of OpenCanvas.

With `jwt_jwks_url` we fetch your JWKS (cached 10 min) and pick the key by the token's `kid`;
the algorithm is still pinned by `jwt_alg`, so a token signed with another algorithm is refused.

## 6. WOPI mode

For hosts that already open Collabora / Office Online through WOPI (Nextcloud, ownCloud,
Seafile, …). OpenCanvas is the WOPI *client*; you are the WOPI *host*. Reference host:
`examples/wopi-host/server.mjs`; end-to-end check: `scripts/e2e-wopi.sh`.

**Register** (no JWT key needed):
```toml
[[host]]
id              = "nextcloud"
name            = "Nextcloud"
mode            = "wopi"                    # or "both" (JWT launches + WOPI launches)
wopi_allowlist  = ["https://cloud.example.com/index.php/apps/richdocuments/wopi"]
allowed_origins = ["https://cloud.example.com"]
api_key         = "env:NC_OC_API_KEY"       # optional, for the §7 REST API
[host.flags]
on_conflict     = "copy"                    # copy = PUT_RELATIVE | reload
```
`wopi_allowlist` entries are `scheme://host[:port][/path]`. A `WOPISrc` is accepted only when
scheme, host and port match an entry exactly and the path starts with the entry's path at a
`/` boundary; URLs with userinfo, a query, a fragment, or longer than 255 characters are refused
(`403 WOPISRC_NOT_ALLOWED`) before anything is called. Write `localhost` and `127.0.0.1`
separately if you need both. Redirects are never followed.

**Discovery.** `GET /hosting/discovery` returns WOPI discovery XML (`net-zone`
`external-http(s)` from `OC_PUBLIC_URL`): app `application/vnd.opencanvas+zip` with `edit`
(default) and `view` for `ext="ocanvas"`, app `text/markdown` with `edit`, `view` and `convert`
(`targetext="ocanvas"`) for `ext="md"`, and `Capabilities` → `GET /hosting/capabilities`.
Every `urlsrc` is `{OC_PUBLIC_URL}/v1/launch?`; append `WOPISrc=<urlencoded>` (and any other
placeholders, which are ignored), Collabora style.

**Launch.** Your page form-POSTs `access_token` and `access_token_ttl` (ms since the epoch; 0 or
absent = 10 h) into an iframe at `/v1/launch?WOPISrc=<urlencoded https://host/wopi/files/<id>>`.
We answer `303 /app/#t=<ticket>`, like a JWT launch. The session expires at `access_token_ttl`.
`401 TOKEN_INVALID` when CheckFileInfo answers 4xx or the ttl has passed. The access token is
opaque to us, sealed at rest under `OC_KEK` like a callback token, sent only in the query string
of calls to `WOPISrc` (as WOPI requires), and never logged. The file id (room, REST API path) is
the normalized `WOPISrc`: URL-encode it in `/v1/files/{fileId}/…`.

**We call:**
- `GET  {WOPISrc}?access_token=…` → CheckFileInfo (at launch, on load, and before a save when the
  file name is not known). We read `BaseFileName`, `Size`, `Version`, `LastModifiedTime`, `UserId`,
  `UserFriendlyName`, `UserExtraInfo.avatar` (http(s) only), `UserExtraInfo.detail` (the
  person's second line, docs/21), `UserCanWrite`, `ReadOnly`,
  `UserCanNotWriteRelative`, `DisableExport`, `DisablePrint`, `HideExportOption` and our extension
  `OpenCanvas_UserCanComment`.
  Role: `UserCanWrite` and not `ReadOnly` → `edit`; else `OpenCanvas_UserCanComment` → `comment`;
  else `view`. Perms: `DisableExport` → no export, download or print; `HideExportOption` → no
  export; `DisablePrint` → no print (PDF). The tracked version is `LastModifiedTime`
  (`Version` is shown only when there is no `LastModifiedTime`, and then no timestamp is sent).
- `GET  {WOPISrc}/contents?access_token=…` → GetFile (≤ 100 MB). Empty body = new canvas.
  `.ocanvas` zip, or Markdown when `BaseFileName` ends in `.md`.
- `POST {WOPISrc}/contents?access_token=…` → PutFile, body `.ocanvas` (or Markdown for `.md` files —
  lossy for boards and databases), headers `X-WOPI-Override: PUT`,
  `X-COOL-WOPI-Timestamp: <LastModifiedTime we loaded / last saved>`, `X-COOL-WOPI-IsAutosave: true`,
  `X-COOL-WOPI-IsModifiedByUser: true`. Answer `200 {"LastModifiedTime":"…"}` (without it we ask
  CheckFileInfo). `409 {"COOLStatusCode":1010}` = the file changed elsewhere → your `on_conflict`
  policy runs (any other 409 is retried like an outage). Saves go through the same outbox,
  retries and autosave rules as JWT mode (docs/15 §7).
- `POST {WOPISrc}?access_token=…` with `X-WOPI-Override: PUT_RELATIVE`,
  `X-WOPI-SuggestedTarget: <UTF-7 "<name> (conflict copy).ocanvas">`, `X-WOPI-Size` → conflict copy
  (policy `copy`). Answer `{"Name","Url","HostEditUrl"|"HostViewUrl"}`; editors are told the
  `HostEditUrl` and `Url` without its token. Hosts that set `UserCanNotWriteRelative` should use
  `on_conflict = "reload"`.

No `LOCK`/`UNLOCK` (we use timestamps, like Collabora) and no proof keys yet.

**Assets.** WOPI has no asset API, so uploads (`POST /v1/assets?ticket=`) are kept with the room
and answered `201 {"assetId":"a_…","url":"/v1/assets/a_…","mime","size"}`. They are served by
`GET /v1/assets/:id?ticket=` (images inline, anything else as a download, `nosniff`, sandboxed)
and inlined into the saved `.ocanvas` as `assets/<id>` (stored) plus `assets/index.json`
(`{"<id>":{"mime","size"}}`); only assets the document still references are written. On load
they are read back out of your file. Limits: **10 MB per asset, 50 MB of assets per file**
(`413 ASSET_TOO_LARGE`); the whole zip stays under the 100 MB `.ocanvas` read limit. DOCX, PDF
and `.ocanvas` exports include them too.

**Mentions.** `GET /v1/users?ticket=&q=` lists the users who have opened the file (from
CheckFileInfo, with their `detail`), filtered by name or id: tier 0 of §5 "People", which works
unchanged. Mention notifications (`POST /mentions`, §5) are not sent in WOPI mode.

## 7. Server-to-server REST (you → us)

Use `X-OpenCanvas-Key: <api_key>` + `X-OpenCanvas-Host: <host id>`.

- Revoke or downgrade a user live when you change ACLs:
  `POST /v1/files/{fileId}/role {"userId":"u_123","role":"view"}` — the
  user's open session switches to read-only immediately (or is closed with
  `"role":"none"`). Roles: `view | comment | edit | none`. Answers
  `200 {"connections":1,"sessions":2}` (live connections switched, tickets updated);
  `401 API_KEY_INVALID` for a wrong host/key, `400 ROLE_INVALID`.
- Patch content from a bot: `POST /v1/files/{fileId}/patch` (see 04 §6) with
  `{"ops":[…],"author":{"id","name"}}`. Ops: `append`, `insertAfter{blockId}`,
  `replace{blockId}`, `delete{blockId}`, each with `markdown` or Tiptap `blocks`. Blocks are
  addressed by their `blockId` attribute; the answer lists the ids of the blocks you inserted
  (`{"applied":2,"blockIds":["b_…"],"live":true}`). If nobody has the file open we load it from
  you, apply and save straight away (the answer then carries `version`). Send
  `X-OpenCanvas-Callback-Token: <token>` if your callbacks need a bearer for that load/save.
- Force save before you snapshot/backup: `POST /v1/files/{fileId}/commit` →
  `200 {"live":true,"saved":true,"version":"18"}` once your `PUT` answered,
  `202 {"queued":true}` if it failed and will be retried from the outbox, `409` on a conflict.
- Close everything (file deleted/moved): `DELETE /v1/files/{fileId}/session` — a final
  save, then every connection is closed and every ticket for the file is dropped.
  `200 {"closed":true,"sessions":3}`.
- Stateless conversion: `POST /v1/convert?from=md|html|ocanvas&to=ocanvas|md|html|json|docx|pdf`
  with the file as the raw body. DOCX and PDF embed images only from your `callback_base` origin
  (fetched signed) or an `asset_origins` entry (plain GET) — no redirects, ≤ 10 MB, `image/*`
  only; other images become links. Boards become pictures (PNG in DOCX, SVG in HTML/PDF).
  `to=pdf` needs the operator to run the Gotenberg sidecar (`OC_PDF_RENDERER`), else `501`.

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
- [ ] Implement load / save (+ assets). People: give `user.detail` in the token; add
      `participants`, `GET /users` and `POST /users/resolve` as your directory needs (docs/21).
- [ ] Verify `X-OpenCanvas-Signature` on callbacks.
- [ ] Add OpenCanvas origin to your CSP `frame-src`; add your origin to our `allowed_origins`.
- [ ] Handle `409` (we save a copy or reload, per your policy). With `copy`, implement
      `POST /files/{id}/copies`; editors are told the new file's `url` and the session
      turns read-only. With `reload`, the session's unsaved changes are dropped and everyone
      reconnects onto your version.
- [ ] Call the role API when ACLs change.
- [ ] Try `examples/sample-host` end-to-end before going live (WOPI hosts:
      `examples/wopi-host` and `scripts/e2e-wopi.sh`).
