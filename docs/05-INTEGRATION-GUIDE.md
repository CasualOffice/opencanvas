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
# frame_ancestors = ["https://chat.example"] # optional: extra origins that may frame THIS host's editor (§4)
asset_origins   = ["https://cdn.acme.example"] # extra image origins for exports (unsigned GET);
                                           # your callback_base origin is always allowed
[host.flags]
embeds          = ["youtube", "vimeo", "loom", "figma", "maps"]
export_formats  = ["md", "html", "pdf", "ocanvas"]   # formats this host allows: md, html, json, docx, pdf, ocanvas, svg/png (board images); omit for all
import_formats  = ["md", "html", "csv"]    # formats editors may import (POST /v1/import); absent or empty = import OFF;
                                           # any other value is refused at start-up
autosave_secs   = 60
on_conflict     = "copy"                   # copy | reload
team_templates  = true                     # gallery "From your team" from GET /templates (§5, TPL-01); default off
temporary_wording = "meeting"              # storage = "ephemeral" only (§8a, ADR-049): "meeting" (default) or "room"
```

People (docs/21 revision 2): the @mention list is the people with access to the canvas, the same
for every viewer. Everyone with access sees real names and the `detail` second line. OpenCanvas
never shows or stores e-mail.

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
    "avatar": "https://…/a.png",    // http(s) only
    "color": "#7c3aed"              // optional; we derive one otherwise
  },
  "members": [                      // optional (docs/21): everyone with access to THIS canvas,
    { "id": "u_200", "name": "Ravi Menon", "detail": "Engineering" }   // ≤ 500; same user shape
  ],                                // (id, name, detail?, avatar?, color?); never e-mail
  "role": "edit",                   // view | comment | edit
  "perms": {
    "export": true,
    "download": true,
    "print": true,
    "commitMessage": true,          // may write "Save version" messages
    "mention": true
  },
  "mode": "edit",                   // edit | view | preview
  "callbackToken": "opaque-…",      // we send it back on every callback; you validate it
  "start": "page"                   // optional (ADR-048): open a new canvas straight into the page
}
```

**Skipping the start screen (`start`, ADR-048).** A new, empty canvas opens on the template
picker. When your own UI already asked what kind of canvas it is (a "Blank or Meeting notes"
dialog), put `"start": "page"` in the token: the canvas opens on its first line instead, and
templates stay available inside the editor. The server passes it on as `&start=page` after the
ticket in the editor URL fragment. Any other value is ignored, and servers up to 0.1.1 ignore the
claim (the picker shows). It changes nothing for a canvas that already has content.

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

**Nested embeds (`frame_ancestors`).** CSP `frame-ancestors` checks every ancestor, so when
your page is itself framed by another app (a Matrix widget inside a chat client, §8b), that
app's origins must be allowed too. List them in the host's `frame_ancestors`. They are not added
to the server-wide list: launches for this host redirect to `/app/?h=<host id>#t=…`, and only
that page is served with `frame-ancestors 'self' <every host's allowed_origins> <this host's
frame_ancestors>`. Hosts without the setting keep `/app/#t=…` and the shared list. The `h`
parameter only selects the policy; the session is still the ticket.

### postMessage API (iframe ↔ host page)
Messages are `{ "MessageId": "...", "SendTime": ms, "Values": {...} }`
(Collabora-compatible envelope).

| Direction | MessageId | Values |
|---|---|---|
| canvas → host | `App_LoadingStatus` | `{ Status: "Frame_Ready" \| "Document_Loaded" }` |
| canvas → host | `Doc_ModifiedStatus` | `{ Modified: bool }` |
| canvas → host | `Doc_Saved` | `{ commitId, hostVersion }` |
| canvas → host | `Presence_Changed` | `{ users: [{id,name,color,role,detail?}] }` (real names, the same for every viewer; never e-mail) |
| canvas → host | `Token_Expiring` | `{ inSeconds }` |
| canvas → host | `UI_Mention_Click` / `UI_Link_Click` | `{ id \| url }` (host decides navigation) |
| canvas → host | `UI_BlockLink` | `{ fileId, blockId }` ("Copy link to block": the host builds its own URL, e.g. `https://app/files/<fileId>#block=<blockId>`; ADR-023/027). The same values are also posted as `UI_Block_Link`, the earlier name; new hosts listen to `UI_BlockLink` only. |
| canvas → host | `Error` | `{ code, message }`. `code: "SESSION_CLOSED"` (message `revoked`, `host` or `other`) when the editor shows its closed screen, so your chrome can offer to reopen (ADR-048) |
| canvas → host | `UI_StartNew` | `{}`: "Start a new canvas" on the ended screen of a temporary canvas with room wording (§8a, ADR-049). Open a fresh canvas, for example by reloading your page |
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

Base: `callback_base`. Every call carries `Authorization: Bearer <callbackToken>` (also sent
as `X-OpenCanvas-Callback-Token: <callbackToken>`, for hosts behind something that strips
`Authorization`, such as a Mattermost plugin; neither header is signed) and
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
| **Members** *(optional, docs/21)* `GET /files/{fileId}/members?q=&limit=` | signed like every callback, with the `callbackToken` of whoever asked; cached 60 s per file, dropped at once by a revoke (§7) or `POST /v1/files/{fileId}/members/invalidate` | `[{"id","name","detail","avatar","color"}]` (or `{"members":[…]}`, ≤ 500): everyone with access to this file whose name or detail matches `q` (empty = everyone). `404`/`405`/`410`/`501` = not implemented; any e-mail you send is ignored |
| **Access** *(optional, MCP, docs/24 §7.3)* `POST /access` | JSON `{fileId, userId}`, signed like every callback (v2), no bearer token | `{"role":"view"|"comment"|"edit"|"none"}`. Used for MCP calls (§7a) instead of the token's `role` claim; cached 30 s per (file, user), dropped by the role API and `members/invalidate` on the node that gets them. `404`/`405`/`501` = not implemented (the token's `role` claim is used, only for the files its `files` claim lists, §7a); other errors refuse the call (`INTERNAL`) |
| **Team templates** *(optional, `team_templates = true`, TPL-01)* `GET /templates` | signed like every callback, with the `callbackToken` of whoever opened the gallery; cached 60 s per host | `[{"id","name","description","category","icon","tone","updatedAt"}]` (or `{"templates":[…]}`, ≤ 512 KB, first 200 shown). `id` 1-128 of `[A-Za-z0-9_.-]`; entries without a valid id or a `name` are dropped; `icon` a Lucide name, `tone` one of gray blue green amber red pink purple. `404`/`405`/`410`/`501` = not implemented (no team section) |
| **Team template file** *(optional)* `GET /templates/{id}` | signed; asked only when an editor applies it (never for view/comment) | `.ocanvas` or Markdown bytes, ≤ 5 MB, checked like an import. It replaces the canvas content as one server edit that the person who applied it can undo from its toast. `404`/`410` = gone |
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
`mentioned` come from the canvas's member list (your token `members` or `GET /files/{fileId}/members`): **check that each person
can see the file before you notify them.** Delivery is fire-and-forget for the session: the call
is written to our notification outbox first, sent at once, and retried with backoff (10 s → 1 h,
8 attempts, same `Idempotency-Key`) when it fails with a network error, `429` or `5xx`. Any other
`4xx` drops it. Signed like every callback. `examples/sample-host` logs each call and lists them
on the file page. **WOPI hosts get no mention calls** (WOPI has no notification API); use JWT
mode, or `mode = "both"`, if you need them.

**People** (docs/21 revision 2, ADR-026). Every person is keyed by your stable `user.id`. The
@mention list is **the people with access to this canvas**, the same for every viewer. Tell
OpenCanvas who that is with `members` in the launch token (≤ 500) and/or the members callback
above (for large audiences). Without either, the list is everyone who has opened the canvas (the
`people` map in the `.ocanvas`: id, name, detail, avatar, last seen). Members merge by id:
**callback > token > the saved `people` map**. Everyone with access sees real names and the
`detail` second line; same-named people show `name · detail` (then "Last here …", then the id's
last 4 characters). E-mail is never shown or stored. A mention stores the id plus a label
snapshot: OpenCanvas shows the member's current name, and for someone who no longer has access
the snapshot with "No longer has access". Exports use the same names.

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
We answer `303 /app/#t=<ticket>`, like a JWT launch. The session expires at `access_token_ttl`,
capped at 10 h from the launch like a JWT session (SEC-35); after that, launch again (the editor's
`Action_RefreshToken` renewal is a fresh launch).
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

No `LOCK`/`UNLOCK` (we use timestamps, like Collabora).

**Proof keys (§6.4, WOPI-13).** Every call OpenCanvas makes to your WOPI host (CheckFileInfo,
GetFile, PutFile, PUT_RELATIVE, and any later override) carries the Microsoft proof headers:

- `X-WOPI-TimeStamp`: .NET ticks (100 ns since 0001-01-01 UTC) of the call.
- `X-WOPI-Proof`: base64 RSASSA-PKCS1-v1_5 / SHA-256 signature with the current key.
- `X-WOPI-ProofOld`: the same bytes signed with the old key.

The signed bytes are `be32(len token) ‖ access_token (UTF-8) ‖ be32(len URL) ‖ UPPERCASE(full
request URL, query and access_token included) ‖ be32(8) ‖ be64(timestamp)`. Discovery publishes
both public keys in the spec format, a CryptoAPI `PUBLICKEYBLOB` (base64) plus modulus and
exponent (base64, big-endian):

```xml
<proof-key oldvalue="BgIAAACkAABSU0Ex…" oldmodulus="…" oldexponent="AQAB"
           value="BgIAAACkAABSU0Ex…" modulus="…" exponent="AQAB"/>
```

A host accepts the call when `X-WOPI-Proof` verifies with the current key, or
`X-WOPI-ProofOld` with the current key, or `X-WOPI-Proof` with the old key; refuses a
timestamp older than 20 minutes; and answers `500` otherwise (after re-reading discovery once,
in case the keys rotated). `examples/wopi-host/server.mjs` does exactly this (`checkProof`);
`WOPI_PROOF=off` opts it out for servers without keys. Nextcloud, ownCloud and Seafile verify
these headers the same way they do for Collabora.

**Key configuration and rotation.** `OC_WOPI_PROOF_KEY` is the path of a 2048-bit (or larger)
RSA private key, PEM (PKCS#8 or PKCS#1), or the same PEM sealed with `OC_KEK`
(`opencanvas seal-proof-key < key.pem > key.sealed`). `OC_WOPI_PROOF_KEY_OLD` is the previous
key in the same forms; without it the current key is published and used as the old one.
With `OC_DEV=1` and no key, a pair is generated at start-up (it changes on every restart).
Start-up refuses a hosts file with a WOPI host when there is no key. Rotation: generate a new
key (`openssl genrsa -out new.pem 2048`), set `OC_WOPI_PROOF_KEY_OLD` to the current key and
`OC_WOPI_PROOF_KEY` to the new one, roll every node (they must share the keys); hosts accept
both while their cached discovery catches up. Drop the old key at the next rotation.

**Assets.** WOPI has no asset API, so uploads (`POST /v1/assets?ticket=`) are kept with the room
and answered `201 {"assetId":"a_…","url":"/v1/assets/a_…","mime","size"}`. They are served by
`GET /v1/assets/:id?ticket=` (images inline, anything else as a download, `nosniff`, sandboxed)
and inlined into the saved `.ocanvas` as `assets/<id>` (stored) plus `assets/index.json`
(`{"<id>":{"mime","size"}}`); only assets the document still references are written. On load
they are read back out of your file. Limits: **10 MB per asset, 50 MB of assets per file**
(`413 ASSET_TOO_LARGE`); the whole zip stays under the 100 MB `.ocanvas` read limit. DOCX, PDF
and `.ocanvas` exports include them too.

**Mentions.** The member list is the users who have opened the file (from CheckFileInfo, with
their `detail`) and the saved `people` map: the no-source case of §5 "People". Mention notifications (`POST /mentions`, §5) are not sent in WOPI mode.

## 6a. Nextcloud (the `opencanvas` app)

`integrations/nextcloud/opencanvas/` is a Nextcloud app (Nextcloud 30–32) that makes Nextcloud
the WOPI host of §6, the way Nextcloud Office does for Collabora. Install, configuration,
limits and what has been verified are in
[integrations/nextcloud/README.md](../integrations/nextcloud/README.md); the design and the
choice of WOPI over JWT are in [integrations/nextcloud/DESIGN.md](../integrations/nextcloud/DESIGN.md).

- **WOPISrc:** `{nextcloud}/index.php/apps/opencanvas/wopi/files/{fileId}`. Register
  `wopi_allowlist = ["{nextcloud}/index.php/apps/opencanvas/wopi"]` and give the host an
  `api_key`. Proof keys are required: the app refuses calls without a valid proof.
- **Roles:** "Can edit" maps to `edit` and read-only shares map to `view`. Without "Allow
  download" (or with a public link's "Hide download"), export, download and print are off.
- **Saves and versions:** every save is a normal Nextcloud write, so it shows in Versions under
  the editor's name. A file changed outside the canvas gets a `(conflict copy)` next to it.
- **Share changes:** the app re-checks access on every WOPI call. When a share is removed or
  changed, it also calls `POST /v1/files/{fileId}/role` (§7), so open canvases switch to
  read-only or close at once.
- **Limits:** WOPI mode only. The @mention list is the people who opened the canvas, and
  mentions send no notifications. The Nextcloud-side screens (New menu, Viewer, guests, Talk)
  wait for approved prototypes.

## 7. Server-to-server REST (you → us)

Use `X-OpenCanvas-Key: <api_key>` + `X-OpenCanvas-Host: <host id>`.

- Revoke or downgrade a user live when you change ACLs:
  `POST /v1/files/{fileId}/role {"userId":"u_123","role":"view"}` — the
  user's open session switches to read-only immediately (or is closed with
  `"role":"none"`). Roles: `view | comment | edit | none`. Answers
  `200 {"connections":1,"sessions":2}` (live connections switched, tickets updated);
  `401 API_KEY_INVALID` for a wrong host/key, `400 ROLE_INVALID`. The role also applies to launch tokens
  issued before the call (by their `iat`): an older token opens with this role, and with
  `"role":"none"` it is refused with `403 ROLE_REVOKED`. Tokens issued after it, or without
  `iat`, use their own role. `"role":"none"` also takes
  the user out of the canvas's member list at once (the cached members answer is dropped, open
  editors refetch it, and an older token's `members` no longer counts for them) until you grant
  access again or they open the canvas with a new token.
- Member list changed (someone added or removed outside a role call):
  `POST /v1/files/{fileId}/members/invalidate` → `200 {"invalidated":true}`. Drops the cached
  members answer; open editors refetch `/v1/members`. Same headers as every call here.
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
- Import into a canvas (docs/23 FC-10): `POST /v1/files/{fileId}/import?format=md|html|csv&author=<userId>[&authorName=][&blockId=][&name=]`
  with the file as the raw body (UTF-8, ≤ 5 MiB). Markdown and HTML become blocks; HTML keeps
  only `http(s)`, `mailto:`, relative and `#` links and `http(s)`/relative/`data:image/` image
  sources, and drops scripts, styles and event attributes. CSV becomes one database block
  (first column the title; other columns typed number, date `YYYY-MM-DD`, checkbox
  `true|false|yes|no`, select for ≤ 20 repeated values, else text), ≤ 10,000 rows and ≤ 200
  columns (`413 IMPORT_TOO_LARGE`). It lands after `blockId`, or at the end, as one change. Needs
  the format in `[host.flags] import_formats` (else `403 IMPORT_OFF`); the operator's
  `OC_IMPORT=off` refuses every import. Answers `{"format","blockIds",…,"live"}`, plus `version`
  when nobody had the file open (saved straight away, like `patch`). Editors use the same with a
  session: `POST /v1/import?format=&ticket=` (edit role only); the session response carries
  `import.formats` so the editor shows the entry only when allowed.
- Stateless conversion: `POST /v1/convert?from=md|html|ocanvas&to=ocanvas|md|html|json|docx|pdf`
  with the file as the raw body. DOCX and PDF embed images only from your `callback_base` origin
  (fetched signed) or an `asset_origins` entry (plain GET) — no redirects, ≤ 10 MB, `image/*`
  only; other images become links. Boards become pictures (PNG in DOCX, SVG in HTML/PDF).
  `to=pdf` needs the operator to run the Gotenberg sidecar (`OC_PDF_RENDERER`), else `501`.

## 7a. MCP endpoint (AI-01, ADR-032; off by default)

Turn it on per host with `[host.ai] mcp = true`, and give it a public URL: `OC_PUBLIC_URL`, or
`[host.ai] mcp_audience` for this host. Without one, MCP stays off (`404`) and the server logs a
start-up warning; the audience is never taken from the request's `Host` header. External MCP clients and your own agents call
`POST /mcp/{hostId}` (streamable HTTP, stateless, one JSON-RPC message per POST, JSON answers;
MCP `2026-07-28`, and `2025-11-25` by version negotiation). Methods: `initialize`
(`server/discover`), `ping`, `tools/list`, `tools/call`, `resources/templates/list`,
`resources/read` (`canvas://{hostId}/{fileId}` Markdown, `….json` document JSON). MCP and the
headless API (§7b) share one auth check: the same scope ceiling, `files` rule, `/access` role and
revocation; a `canvas:comment` token may comment.

**Tokens are yours.** OpenCanvas runs no OAuth server. You mint an access token (JWT) with the
same keys as launch tokens (HS256 secret, PEM or JWKS):

| claim | value |
|---|---|
| `iss` | your host id, or `[host.ai] mcp_issuer` |
| `aud` | `{mcp_audience or OC_PUBLIC_URL}/mcp/{hostId}` (a token for another host or a launch token is refused) |
| `sub` | the user id (`svc:<name>` for a backend job) |
| `exp` | at most 15 minutes ahead |
| `scope` | space-separated `canvas:read`, `canvas:comment`, `canvas:write`, `canvas:write:direct` |
| `role` | the user's role on the files (`view`/`comment`/`edit`; absent = `view`) |
| `files` | the file ids the token covers; **required** when you do not implement `POST /access` (see below) |
| `name`, `client_id` | optional display name; client id recorded in the edit origin `mcp:<clientId>` |

**Role source.** If you implement the optional `POST /access` callback (§5), OpenCanvas asks it
for the user's role on each file an MCP call touches (cached 30 s) and ignores the token's
`role` claim; `none` refuses every tool. Without it, the `role` claim is trusted, but only for
the files the token lists in `files`: a token without `files` is refused (`ROLE_FORBIDDEN`,
`FILES_REQUIRED: …`). Setting `[host.ai] mcp_all_files = true` lifts that and lets one token's
role apply to **every file of the host**; it is broad, so prefer `files` or `/access` (SEC-34).

The effective permission is `min(scope, role)`: `canvas:write` does not let a `view` user write,
and a `canvas:read` token does not let an editor write. A request without a valid token gets
`401` with `WWW-Authenticate: Bearer resource_metadata="https://<opencanvas>/.well-known/oauth-protected-resource/mcp/{hostId}"`;
that RFC 9728 document names your `mcp_issuer` as the authorization server. Tokens are never
forwarded to you; callbacks stay HMAC-signed. MCP calls take from the same per-user bucket as
the headless API (§7b; default 10 requests/s, burst 30, `[host.api] rate_per_sec` / `burst`;
`[host.ai] mcp_rate_per_min` still sets the rate when `[host.api]` does not), then `429` with
`Retry-After`.

**Tools** (each takes `fileId`): `canvas_read`, `canvas_find`, `db_describe`, `db_query`,
`board_read`, `comment_list`, `members_list` (read); `comment_add` (comment);
`canvas_patch`, `db_upsert_rows`, `db_create`, `db_add_field`, `board_add_shapes` (write). Edits
are live Yjs transactions, broadcast and autosaved like a person's. Canvas content comes back
wrapped as untrusted data. Changes to existing blocks carry `ifMatch` (the block `rev` from a
read; a mismatch returns `STALE_BLOCK` with the fresh block). By default new content lands
directly and changes to existing content become **suggestions** (stored in the file's
`suggestions` root for a person to accept in the editor); `[host.ai] default_mode = "direct"`
changes that. Deleting more than 5 blocks needs `confirm: true`. Member lists never carry
e-mail addresses. Errors are tool results with `isError: true` and a `code`.

## 7b. Headless API v1 (HAPI, ADR-041; `[host.flags] api_v1 = true`)

The supported API for programs: bots, integrations, back-office jobs. It is described by an
OpenAPI 3.1 document served at `GET /api/v1/openapi.json` (checked in as
`crates/oc-server/api/openapi.json`; a contract test keeps it and the router identical). Turn it on
per host with `[host.flags] api_v1 = true` (off by default in 0.2.0-alpha; otherwise every
`/api/v1` call answers `404 API_OFF`). The path major changes only for breaking changes; within
`v1` changes are additive.

**Auth, two kinds, one check** (shared with MCP, §7a):

1. **Host key**, server to server, as in §7: `X-OpenCanvas-Host` + `X-OpenCanvas-Key` (full
   access to your files, admin operations included). Optional `X-OpenCanvas-Author: <userId>`
   attributes changes to that user (edit origin `api:<userId>`; default `svc:<hostId>`);
   `X-OpenCanvas-Callback-Token` is passed on callbacks as in §7.
2. **User-scoped bearer token** (`Authorization: Bearer <jwt>`) for code acting for one of your
   users. **You mint it**; OpenCanvas never issues user tokens. Same keys as launch tokens
   (HS256 secret, PEM or JWKS), same claims as MCP tokens:

   | claim | value |
   |---|---|
   | `iss` | your host id, or `[host.api] issuer` (must be unique among hosts) |
   | `aud` | `{[host.api] audience or OC_PUBLIC_URL}/api/v1`. An MCP token (`…/mcp/{hostId}`) or a launch token is refused here, and an API token is refused by MCP |
   | `sub` | the user id (`svc:<name>` for a backend job) |
   | `exp` | at most 15 minutes ahead (`nbf` honoured) |
   | `scope` | space-separated `canvas:read`, `canvas:comment`, `canvas:write` (`canvas:write:direct` counts as write), `canvas:admin` |
   | `role`, `files` | as for MCP: the role on the listed files when you do not implement `POST /access` |
   | `name` | optional display name |

   Without a public base URL (`OC_PUBLIC_URL` or `[host.api] audience`) user tokens are off for
   the host (`401 TOKEN_INVALID`); the audience is never taken from the request.
   The effective permission is `min(scope, role)`, the role coming from your `POST /access`
   callback when you implement it (cached 30 s, dropped by the role API), else from the token's
   `role` claim, but only for the files in its `files` claim (`403 FILES_REQUIRED` otherwise,
   unless `[host.api] all_files = true`). Writes re-check revocation: after
   `POST …/role {"role":"none"}` the user's next call is refused. `canvas:admin` only works when
   `[host.api] token_admin = true`; by default the admin operations are the host key's.
   Errors: `401 UNAUTHENTICATED` (no credentials), `401 TOKEN_INVALID` (signature, issuer,
   audience, lifetime over 15 min, not yet valid), `401 TOKEN_EXPIRED`, `403 SCOPE_REQUIRED`
   (the operation needs a scope the token lacks), `403 ROLE_FORBIDDEN` (the host role is lower,
   or the file is not in `files`). The OpenAPI document marks each operation's scope
   (`x-opencanvas-scope`).

```toml
[host.api]
issuer       = "acme"                        # default: the host id
audience     = "https://canvas.example.com"  # default: OC_PUBLIC_URL
default_mode = "direct"                      # or "suggest" for changes to existing blocks
all_files    = false                         # true: without /access, a token with no `files` covers every file
token_admin  = false                         # true: tokens with canvas:admin may commit, set roles, close sessions
```

**Operations** (all under `/api/v1/files/{fileId}` unless noted; each is a thin adapter over the
same tool layer as MCP, §7a):

| Operation | Method and path | Notes |
|---|---|---|
| Read | `GET …?format=json\|markdown\|outline` | JSON (default): `{title, rev, blocks:[{blockId, rev, node}]}`; `ETag: "<rev>"` |
| List blocks | `GET …/blocks?limit=` | top-level blocks, `limit` ≤ 100; `{blocks, has_more, next_cursor}` |
| One block | `GET …/blocks/{blockId}` | nested blocks too; `ETag` = block `rev` |
| Find | `GET …/blocks:find?q=&types=a,b&limit=` | case-insensitive text match |
| Change blocks | `POST …/blocks:batch {ops, mode?, confirm?}` | ops `append`, `insertAfter`, `replace`, `delete`, `editText`, each with optional `ifMatch` (block `rev`); `If-Match: "<doc rev>"` for the whole document. One transaction or none. Answer `{applied, mode, blockIds, rev}` |
| Databases | `GET …/databases`, `POST …/databases`, `GET …/databases/{dbId}`, `GET …/databases/{dbId}/rows?filter=&sort=&fields=&limit=`, `POST …/databases/{dbId}/rows:upsert`, `POST …/databases/{dbId}/fields` | `filter` / `sort` are JSON arrays (`[{"f","op","v"}]`, `[{"f","dir"}]`) |
| Boards | `GET` / `POST …/boards/{boardId}/shapes` | |
| Comments | `GET …/comments?resolved=`, `POST …/comments {text, blockId\|quote, threadId?}` | |
| Members | `GET …/members?q=&limit=` | never e-mail addresses |
| Export / import | `GET …/export/{md\|html\|json\|ocanvas\|docx\|pdf}`, `POST …/import?format=` | import as in §7 (raw body, `import_formats`) |
| Convert | `POST /api/v1/convert?from=&to=` | stateless, as in §7 |
| Admin | `POST …/commit`, `POST …/role {userId, role}`, `DELETE …/session`, `POST …/members:invalidate` | as the §7 routes |

Writes land in the live room as one Yjs transaction, broadcast to editors and autosaved to you
like any edit (open the file with `POST …/commit` when you need it saved now). Changes to
existing blocks land directly unless the call sends `"mode": "suggest"` or the host sets
`[host.api] default_mode = "suggest"`. Deleting more than 5 blocks needs `"confirm": true`.

**Paging.** `GET …/blocks` (≤ 100 per page) and `GET …/databases/{dbId}/rows` (≤ 200) answer
`{…, has_more, next_cursor}` and, when more follow, `Link: <…?cursor=…&limit=…>; rel="next"`.
Cursors are opaque and signed: pass them back unchanged. They are bound to the file (and, for
rows, the database, `filter`, `sort` and `fields`) and last an hour (`410 CURSOR_EXPIRED`;
anything else wrong is `400 CURSOR_INVALID`). A block cursor is a Yjs relative position after
the last block returned, so paging survives concurrent edits: a block inserted or deleted
before it does not shift the next page, and if that last block is deleted the next page starts
at its successor. Every block that exists for the whole walk is returned exactly once.

**Rate limits.** One token bucket per caller (the host key, or a token's `sub`), shared with
MCP: default 10 requests/s, burst 30; and one per file for writes (POST/DELETE): default 5/s,
burst 10. Every answer carries `RateLimit-Policy: "subject";q=30;w=3` (plus
`"file-writes";q=10;w=2` on writes) and `RateLimit: "<bucket>";r=<remaining>;t=<seconds to
full>`; an empty bucket answers `429 RATE_LIMITED` with `Retry-After`. Set them per host in
`[host.api]`: `rate_per_sec`, `burst`, `file_writes_per_sec`, `file_burst`. With Redis (cluster,
hot WAL or Redis-only storage) the buckets are shared by every node.

**Idempotency.** Every `POST /api/v1/files/…` accepts `Idempotency-Key: <1-255 visible ASCII>`.
The key is yours per user (host key + `X-OpenCanvas-Author`, or the token's `sub`). A repeat of
the same request answers the stored result with `Idempotency-Replayed: true` for 24 h; the same
key with another body is `422 IDEMPOTENCY_KEY_REUSED`; a duplicate that arrives while the first
still runs, on any node, is `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`. Failed requests
are not stored, so a retry runs again. Keys live in the database (`api_idempotency`) or, in
Redis-only mode, in Redis (`oc:idem:…`), with request hashes and write answers (ids, counts,
revisions) only, never document content. `POST /api/v1/convert` returns a document and takes no
key (it changes nothing).

**Errors** are RFC 9457 `application/problem+json`:
`{"type":"urn:opencanvas:problem:stale-block","title":"Precondition Failed","status":412,"detail":"…","code":"STALE_BLOCK","fresh":{…}}`.
The `code` is the same machine code the 0.1 routes use (`BLOCK_NOT_FOUND`, `STALE_BLOCK`,
`ROLE_FORBIDDEN`, `PATCH_INVALID`, `DOC_TOO_LARGE`, `CONFLICT`, `CONFIRMATION_REQUIRED`, …).
Statuses: `400` bad input, `401` no or wrong credentials, `403` role or scope, `404` unknown file
part, operation or `API_OFF`, `409` conflict or confirmation, `412` a stale `ifMatch` / `If-Match`
(with `fresh`), `413` too large, `503` retry (`Retry-After`).

**The 0.1 routes** (`/v1/files/{id}/patch|commit|role|import|session|members/invalidate`,
`/v1/convert`) keep working unchanged through 0.x, with or without `api_v1`, and keep their
`{"error":{"code","message"}}` shape. They now carry `Deprecation: @1795478400` (RFC 9745,
2026-11-24) and `Link: </api/v1/…>; rel="successor-version"`; they are retired in v0.3.

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

## 8a. Ephemeral storage (no file storage of your own; ADR-043)

For hosts with nowhere to keep files, such as a meeting app:

```toml
[[host]]
id = "meet"
name = "Meeting"
jwt_secret = "env:MEET_JWT_SECRET"
api_key = "env:MEET_API_KEY"
storage = "ephemeral"          # default "host"
# template = "meeting"        # optional: a built-in template id, or a path to an .ocanvas or Markdown file
                               # unset: every canvas starts blank
# callback_base = "https://meet.example/api/opencanvas"   # optional: mentions and members only
```

- **No load and no save.** The room starts blank, or from `template`, applied once by the server
  (people joining together never get it twice); no
  `GET`/`PUT /files/{id}`, no commit outbox. The editor gets `session.storage = "ephemeral"` and
  the save status `{"t": "temporary"}`. The editor shows "Not saved · temporary", skips the
  template picker and shows no host name. The commit API answers `clean`.
- `template` ids: the 40 built-in templates (`meeting`, `standup`, `retro`, `oneonone`,
  `brainstorm`, `allhands`, …). An unknown id stops the server at startup and lists the valid ones.
- **Destroyed when the room closes**: the last person leaves and `OC_ROOM_IDLE_MS` passes, or
  you call `DELETE /v1/files/{fileId}/session`. The server then deletes the WAL,
  snapshots, outbox and notification rows, sessions, uploads, the epoch row and the Redis keys of
  the room. Nothing is kept. Tickets stop working.
- `DELETE /v1/files/{fileId}/session` closes the room at once: clients get
  `{"t": "closed", "reason": "This canvas ended with the meeting"}` and close 1000. Call it when
  the meeting ends.
- **A restart or deploy keeps it.** A draining node tells clients to reconnect and leaves the
  canvas in storage; it reopens as it was.
- A short reconnect **inside the idle grace** (a dropped network, a page reload) finds the
  canvas as it was. After the grace, launching the same `fileId` starts a new canvas.
- Uploads are kept with the room (as in WOPI mode) and destroyed with it.
- Export and download stay available, subject to `export_formats` and the token's `perms`.
- Mentions and the members callback are used only when `callback_base` is set.
- **Wording** (`[host.flags] temporary_wording`, ADR-049). `"meeting"` (default) says the canvas
  is deleted when the meeting ends and, at the end, "This canvas ended with the meeting". `"room"`
  is for a chat room that outlives each canvas: "This canvas isn't saved anywhere. It's deleted
  after everyone has closed it; download a copy to keep it.", the pill tooltip "Not saved
  anywhere. Deleted after everyone closes it.", the ended screen "This canvas ended when everyone
  left" with a **Start a new canvas** button (posts `UI_StartNew`; your page opens a fresh canvas),
  "You're no longer in this room, so this canvas is closed" when access is removed, and "You can
  view this canvas. Room moderators can edit." for viewers. The session answer carries
  `"wording"`. Other values stop the server at start-up.

**Your users must export to keep anything.** Tell them so in your UI.

## 8b. Matrix rooms (Element widget)

`integrations/matrix/` adds a canvas to Matrix rooms as a room widget, like Etherpad or Jitsi
widgets. A small bridge (Node 24, no dependencies) is the host:

- The widget asks the Matrix client for an OpenID token (`get_openid`), and the bridge
  verifies it with the user's homeserver (`/_matrix/federation/v1/openid/userinfo`). The
  homeserver is resolved by the Matrix server-name rules, and any private address is refused.
  URL template variables such as `$matrix_user_id` are never trusted.
- A bot account checks that the user is joined to the room and that the widget points at the
  bridge. Power level ≥ `state_default` gives `edit`; everyone else gets a configurable role.
- It mints a launch token (§3) for an `ephemeral` host (§8a): one canvas per widget. The canvas
  id is a hash of the room and widget ids. The user id is the Matrix id; the name is the room
  display name.
- When someone leaves or is banned, the bot calls the role API (§7, `role: "none"`).
- The host sets `frame_ancestors` to the Matrix client origins (§4) and
  `[host.flags] temporary_wording = "room"` (§8a); the widget page reloads itself on `UI_StartNew`.

Verified in Element Web against Synapse: OpenID, membership, a non-member refused, two people
co-editing, Matrix names, access closed on leave. Install, configuration and limits (not
end-to-end encrypted, temporary only): [integrations/matrix/README.md](../integrations/matrix/README.md).

## 8c. Mattermost (plugin as the host)

`integrations/mattermost/` is a Mattermost plugin (`com.casualoffice.opencanvas`) that is a full
JWT-mode host: canvases live in channels (`/canvas new`, `/canvas notes`, a card in the channel,
the editor in the right-hand panel), files go to Mattermost's file store, access follows channel
membership, and leaving a channel calls the role API with `none`. Install and settings:
[integrations/mattermost/README.md](../integrations/mattermost/README.md).

```toml
[[host]]
id              = "mattermost"
name            = "Mattermost"
mode            = "jwt"
jwt_alg         = "HS256"
jwt_secret      = "env:MM_OC_SECRET"
api_key         = "env:MM_OC_API_KEY"
callback_base   = "https://chat.acme.example/plugins/com.casualoffice.opencanvas/oc"
allowed_origins = ["https://chat.acme.example"]
```

What a plugin host must know about Mattermost:

- `ServeHTTP` receives the path without `{subpath}/plugins/{id}`, but `v2` signs the full path:
  the plugin puts the prefix back before checking.
- Mattermost removes `Authorization` before a plugin sees the request: read the callback token
  from `X-OpenCanvas-Callback-Token` (§5).
- Mattermost re-encodes the query string (keys sorted), so the `members` call arrives as
  `?limit=…&q=…` although `?q=…&limit=…` was signed: the plugin accepts the same pairs in any
  order.
- Mattermost sends no `frame-src`, so the canvas frame needs no CSP change there.
- The plugin puts `"start": "page"` in every launch token (§3): its create dialog already asked
  for the kind, so new canvases open on the page, not the template picker. Its panel listens for
  `Error` `SESSION_CLOSED` to offer Reopen.

Tested end to end against Mattermost 12.1.0 (README "Status").

## 9. Checklist for integrators

- [ ] Register host, share secret/API key out of band.
- [ ] Backend endpoint that signs the launch JWT after *your* ACL check.
- [ ] Implement load / save (+ assets). People: give `user.detail` in the token; add
      `members` (≤ 500) and/or `GET /files/{fileId}/members` (docs/21); call the role API or
      `members/invalidate` when access changes.
- [ ] Verify `X-OpenCanvas-Signature` on callbacks.
- [ ] Add OpenCanvas origin to your CSP `frame-src`; add your origin to our `allowed_origins`.
- [ ] Handle `409` (we save a copy or reload, per your policy). With `copy`, implement
      `POST /files/{id}/copies`; editors are told the new file's `url` and the session
      turns read-only. With `reload`, the session's unsaved changes are dropped and everyone
      reconnects onto your version.
- [ ] Call the role API when ACLs change.
- [ ] Try `examples/sample-host` end-to-end before going live (WOPI hosts:
      `examples/wopi-host` and `scripts/e2e-wopi.sh`).
