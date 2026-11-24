# 18 — Security audit, 2026-11-21

**Scope.** `crates/oc-server`, `crates/oc-model`, `migrations/`, the web sanitisation code
(`web/packages/editor/src/lib`, `public/sdk/embed.js`, `web/packages/database/src/csv*`) and the
dependency trees. Target: OWASP Top 10 (2021) / ASVS L2, the threat model in
[docs/07](07-SECURITY-AND-LIMITS.md). Baseline: `main` at `1f149a1`. Branch `security-audit`.
Decisions: ADR-022 in [docs/08](08-ADR-REGISTER.md). Reporting: [SECURITY.md](../SECURITY.md).

Severity is CVSS-ish: **High** = exploitable by an ordinary session or anonymous user with real
impact; **Medium** = needs a role inside the canvas, or impact is limited by another control;
**Low** = defence in depth, information exposure or operator-config dependent.
Line numbers refer to `main` before the fix.

## 1. Findings

| ID | Sev | Area | Finding (evidence) | Status | Regression test |
|---|---|---|---|---|---|
| SEC-01 | Medium | Headers / CSP | `routes/mod.rs:159` set CSP with `SetResponseHeaderLayer::overriding`, **replacing** every handler's own CSP: room assets (`proxy.rs:218`, `default-src 'none'; sandbox`) and exports lost their sandbox. The SPA had no `script-src` at all, exports had no `nosniff`. | Fixed: one `security_headers` middleware; handler CSPs kept + `frame-ancestors` appended; SPA/API default CSP `script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`; exports `sandbox; default-src 'none'`; `nosniff` everywhere | `tests/security.rs` `sec01_responses_keep_their_own_csp_and_get_baseline_headers`; `http.rs` updated |
| SEC-02 | Low | Ops | `/metrics` (`ops.rs:34`) open to anyone on the public listener. | Fixed: `OC_METRICS_TOKEN` (Bearer, constant-time) | `sec02_metrics_need_the_token_when_one_is_configured` |
| SEC-03 | Medium | DoS | No per-room connection cap (`actor.rs:402`); docs/07 promised 550. | Fixed: `MAX_PEERS = 550`, then close 1013 `room full` | `sec03_a_full_room_refuses_more_peers` |
| SEC-04 | Medium | DoS | One socket could claim unlimited awareness client ids (`actor.rs:732`): unbounded awareness state and N× fan-out per frame. | Fixed: ≤ 8 ids per connection | `sec04_awareness_client_ids_per_connection_are_capped` |
| SEC-05 | Info | SQLi | All ~40 statements in `store.rs` are string literals with `?` binds through the sqlx `Any` driver; identical text for SQLite/MySQL (no dialect branches build SQL); no `LIKE`, no dynamic identifiers; `cluster/lease.rs` uses Redis commands with argument arrays. **No SQL injection found.** | Guarded | `sec05_every_sql_statement_is_a_literal`, `sec05_sql_metacharacters_in_a_ticket_are_just_an_unknown_ticket` |
| SEC-06 | Low | Cache poisoning | Without `OC_PUBLIC_URL`, `/hosting/discovery` echoes the `Host` header and was `public, max-age=3600` (`launch.rs:168`). | Fixed: `private, no-store` unless `OC_PUBLIC_URL` is set | `sec06_host_derived_discovery_is_not_publicly_cacheable` |
| SEC-07 | Medium | Callbacks | The signed callback client (`host_client.rs:112`) followed redirects: a redirecting `callback_base` replayed the signed request (signature, body) to the `Location`. | Fixed: `redirect::Policy::none()` | `sec07_signed_callbacks_do_not_follow_redirects` |
| SEC-08 | Low | Info leak | `HostError::Http(#[from] reqwest::Error)` (`host_client.rs:19`) kept the URL; `ApiError::host` returned it to browsers (internal callback hosts, ports, paths). | Fixed: `From` strips the URL | `sec08_host_errors_do_not_reveal_callback_urls` |
| SEC-09 | Low | Secrets in logs | `Grant` derived `Debug` (`grant.rs:67`) incl. `callback_token` (WOPI: the access token); one `?grant` in a log line would leak it. | Fixed: manual `Debug`, token redacted | `grant::tests::debug_output_redacts_the_callback_token` |
| SEC-10 | Low | Tenant isolation | Room id = sha256(`<hostId>:<fileId>`); host ids were free text (`hosts.rs:134`), so host `a:b` + file `c` = host `a` + file `b:c` (same room). Weak secrets were accepted silently. | Fixed: host ids `[A-Za-z0-9._-]{1,64}`; warning for secrets/API keys < 32 chars | `hosts::tests::host_ids_cannot_contain_separators` |
| SEC-11 | Low | WOPI SSRF | `check_src` (`wopi.rs:93`) relied on URL normalisation; `..%2F`, `%5C`, `%2e` survive it and climb out of an allowed path prefix on hosts that decode before routing. Userinfo, other ports/hosts, IPv6, decimal IPs and lookalike hosts were already refused (now tested). Redirects: never followed. | Fixed: encoded separators and `\` refused | `wopi::tests::wopisrc_with_encoded_separators_is_refused` |
| SEC-12 | Low | CSS injection | JWT `user.color` accepted any `#…` ≤ 9 chars (`jwt.rs:97`), copied into every peer's cursor CSS. | Fixed: `#rgb`/`#rrggbb`/`#rrggbbaa` only | `jwt::tests::user_color_must_be_plain_hex` |
| SEC-13 | Medium | DoS (WOPI) | `multipart_file` (`proxy.rs:105`) took any boundary length; a 8 KB boundary over a 25 MB body costs ~2·10¹¹ byte compares (edit role). | Fixed: boundary ≤ 70 (RFC 2046); `GET /v1/users` `q` ≤ 200 bytes | `routes::proxy::tests::overlong_boundaries_are_refused` |
| SEC-14 | High | Zip bomb | `.ocanvas` limits used the sizes the archive **declares** (`ocanvas.rs:116,125`): an entry claiming 1 KB inflated to 100 MB each (3 entries + assets), past the ratio and total caps, via `POST /v1/convert`, host files and WOPI GetFile. | Fixed: `read_capped` inflates at most min(declared, 100 × compressed) and counts actual bytes | `ocanvas::asset_tests::entries_that_inflate_past_their_declared_size_are_refused` |
| SEC-15 | Medium | XSS in exports | Markdown export (`export.rs:197-205,286`, bookmark/embed/file) wrote any `href`/`src` (`javascript:`, `data:text/html`) and raw `<…>` text; hosts that render Markdown got stored XSS. HTML/DOCX/SVG exporters were already escaping and scheme-checking (verified). | Fixed: `md_url` (http(s)/mailto/relative only, destination-breaking chars encoded), `<` escaped outside code | `export::tests::markdown_drops_script_urls_and_escapes_html` |
| SEC-16 | Low | Import | Markdown import (`import.rs:252`) kept `javascript:` link and image targets in the doc. | Fixed: unsafe targets become plain text | `import::tests::markdown_import_drops_script_links_and_images` |
| SEC-17 | Medium | DoS | Outbound frames per socket go through an unbounded channel (`collab.rs:103,143`); a client that stops reading made the server queue every room update for it indefinitely. Same in the cluster relay pump. | Fixed: `write_frames` with 30 s send timeout and 4096-frame backlog, then close 1013 | `routes::collab::tests::a_client_that_does_not_read_is_dropped` |
| SEC-18 | Medium | Callback auth | `X-OpenCanvas-Signature` `v1` = HMAC(`t.body`) (`host_client.rs:94`) does not bind method or path: an empty-body GET signature is valid for every GET path for 5 min (matters for host-API calls with no callback token). | Fixed (additive): `v2` = HMAC(`t.METHOD.path?query.body`); sample host verifies `v2`; `v1` kept | `host_client::tests::signature_v2_binds_method_and_path`; e2e |
| SEC-19 | Medium | CSV injection | Database CSV export (`csv.ts:71`) wrote `=`, `+`, `-`, `@` cells verbatim (`=HYPERLINK(…)`, DDE). | Fixed: leading `'` unless a plain number | `database/src/csv.test.ts` |
| SEC-20 | Low | XSS in editor | Node views pass doc attributes straight to `href`/`src`: bookmark `href={url}` (`nodes.tsx:206`), file `href={resolveAsset(url)}` (`:385`), image `src` (`:468`). Any editor can write `javascript:` there with a crafted Y update. React 19 replaces `javascript:` URLs, and the new CSP blocks inline script, so impact is limited; `data:` / odd schemes still pass. | Helper added (`lib/urls.ts` `safeHref`, `safeImageSrc`); **component patch pending** (§3) | `editor/src/lib/urls.test.ts` |
| SEC-21 | High → Low | Dependencies | `zip` 2.6.1: RUSTSEC-2026-0367/0368/0369/0429/0545/0548 (extract-path symlinks/permissions, AES MAC, name confusion). OpenCanvas never calls `extract`, but the crate was unmaintained on that line. | Fixed: `zip` 9.8 | `cargo audit` clean |
| SEC-22 | Low | Dependencies | `rsa` 0.9 (RUSTSEC-2023-0071, Marvin) and `crypto-bigint` 0.5 (RUSTSEC-2026-0387) via `jsonwebtoken`; `rustybuzz`, `smallstr`, `ttf-parser` unmaintained (via resvg). Only public-key RS256 verification runs; ECDSA is never accepted; fonts are bundled. | Accepted, reasons in `scripts/deny.toml` | `scripts/audit.sh` |
| SEC-23 | Low | DoS | Comment-role updates are checked by re-encoding the whole doc into a scratch copy (`filter.rs`), O(doc) per frame, ≤ 60 frames/s. | Accepted (rate limit + 20 MB cap bound it) | — |
| SEC-24 | Low | Transport | No slowloris / header-read timeout or per-IP limits in the binary; WS upgrade has no `Origin` check (a ticket is required, so no CSWSH). | Accepted: run behind a reverse proxy (docs/13) | — |
| SEC-25 | Low | Tokens in URLs | `GET /v1/launch?token=` and `?ticket=` on WS/export/asset URLs. Paths only are logged (`TraceLayer` span uses `uri().path()`), `Referrer-Policy: no-referrer`, tickets are 80-bit-random ULIDs. | Accepted (documented in docs/15 §2) | existing `http.rs` |
| SEC-26 | Info | AuthZ review | Every route checked: launch (JWT alg pinned per host via `Validation::new`, `iss`/`aud`/`exp`/`nbf`/30 s leeway/10 h cap, `jti` single-use, `kid` only selects among the host's JWKS keys of the pinned type), sessions, collab (ticket room must equal path room), export (`perms.export`, `download` for ocanvas, `print` for pdf, board SVG/PNG), assets (edit role for upload; WOPI assets scoped to the ticket's room, ids validated), users, host API (`api_key` constant-time, rooms derived from the authenticated host id), cluster (`OC_CLUSTER_SECRET` HMAC over room + payload + time, constant-time verify), view role drops writes, comment role limited to `comments`, REST patch only via host API key. No IDOR or role bypass found. | Guarded | `sec_guard_export_needs_the_permission_for_every_format` (+ existing `rooms.rs`, `hardening.rs`) |
| SEC-27 | Info | Secrets | `OC_KEK` AES-256-GCM with row-id AAD; server refuses to start without it (e2e checks); API key, metrics token and cluster HMAC compared in constant time; WOPI errors strip URLs (access token in query). | No change | e2e |
| SEC-28 | Info | Web | `embed.js` checks `e.source` and `e.origin` and posts to the server origin only; editor `host.ts` pins the parent origin (ancestorOrigins / referrer / first message from `window.parent`) and only sends the content-free `Frame_Ready` with `*`. Embeds are rebuilt from a provider allow-list. Link mark re-checks `isAllowedUri`. | No change | — |

Doc-vs-code gaps corrected in docs/07: there is no server-side unfurl (bookmarks store the URL),
no ammonia/DOMPurify (schema-based parsing instead), no separate block/shape count limits, and the
embed referrer policy is `strict-origin-when-cross-origin`.

## 2. Verification (2026-11-21)

| Check | Result |
|---|---|
| New tests seen failing before their fix | `security.rs` 7/10 failed (3 guards passed); unit tests 8/8 failed; `csv.test.ts` 2/2 failed |
| `cargo test --workspace` | all pass |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `pnpm -r typecheck`, `pnpm -r test` | pass (database 140, board 42, editor 7) |
| `scripts/audit.sh` (`cargo audit`, `cargo deny … advisories bans sources`, `pnpm audit --prod`) | clean with the documented ignores; npm: no known vulnerabilities |
| `OC_PORT=8180 HOST_PORT=4100 scripts/e2e-db.sh sqlite` | PASS |

## 3. Patches left for other owners

**Editor node views** (`web/packages/editor/src/editor/nodes.tsx`, owned by the editor UX session):

```diff
+import { safeHref, safeImageSrc } from "../lib/urls";
@@ function BookmarkView
-        href={url}
+        href={safeHref(url)}
@@ FileView
-          <a className="ib" href={resolveAsset(url)} download={name} …>
+          <a className="ib" href={safeHref(resolveAsset(url))} download={name} …>
@@ ImageView
-          <img src={resolveAsset(shown)} alt={alt || caption || ""} draggable={false} />
+          <img src={safeImageSrc(resolveAsset(shown))} alt={alt || caption || ""} draggable={false} />
```

(`shown` may be a `blob:` preview while uploading; `safeImageSrc` allows `blob:`.) Same for the
database URL cell (`web/packages/database/src/DatabaseBlock.tsx:159`): `safeUrl` prefixes
`https://` to anything without a scheme, so `javascript:x` becomes `https://javascript:x`, which
is safe; no change needed.

**Integration guide** (`docs/05-INTEGRATION-GUIDE.md` §5): document
`X-OpenCanvas-Signature: t=…,v1=…,v2=<HMAC-SHA256(secret, t + "." + METHOD + "." + path?query + "." + body)>`,
recommend verifying `v2`, and say callbacks are never redirected.

## 4. Operator checklist

`OC_KEK`, `OC_PUBLIC_URL`, `OC_METRICS_TOKEN` set; `/metrics`, `/readyz`, `/v1/internal/*` not
routed publicly; TLS and per-IP limits at the proxy; secrets ≥ 32 random characters; hosts verify
`v2`; `scripts/audit.sh` in CI.

## 5. Release audit, v0.1.0-alpha.1 (2026-11-23)

Baseline `main` at `c6eca7a`, branch `release-security-gate-alpha1`. Re-audited what changed
since §1: AI assistant and MCP, import (HTML, Markdown, CSV, zip), Redis storage and WAL,
access-expiry renewal, SDK CORS, `export_formats`, jemalloc `MALLOC_CONF`. For each: injection
(SQL/Lua/HTML), auth bypass, SSRF (model `base_url`, WOPI, asset fetch), secrets in logs, DoS
limits, CSRF on POST.

### Findings

| ID | Sev | Area | Finding (evidence) | Status / decision | Regression test |
|---|---|---|---|---|---|
| SEC-29 | **High** | DoS (import) | The tree walks after `html::parse` (`blocks`/`block`/`inline`/`clone_node`, and drop) and Markdown `inline_into` recurse without a depth bound. 100 000 nested `<b>` (300 KB) or `***…` / `[[[…` overflowed a 2 MB worker stack: **the process aborts, every room on the node is lost.** Reached by an editor through `POST /v1/import` (html/md flag on), by the host API `/v1/convert`, and, with no flag at all, by any host `.md` file opened in a room (`actor.rs:322` → `apply_markdown`). | **Fixed** in `oc-model` (no `room/` change): HTML keeps ≤ 64 element levels (deeper start tags are dropped, their content kept); inline Markdown nests ≤ 16 marks/link labels, then stays literal | `html::tests::deeply_nested_markup_does_not_overflow_the_stack`, `deeply_nested_markdown_does_not_overflow_the_stack` (both seen aborting with "stack overflow" first) |
| SEC-30 | Medium | DoS (import) | Each `<script|style|template|noscript>` lowercased a copy of the rest of the input (`html.rs:198`): quadratic, ~30 s CPU on a tokio worker per 5 MB body. Edit role + html flag. | **Fixed**: case-insensitive search in place | `html::tests::many_raw_text_tags_are_linear` (seen failing: > 3 min in debug) |
| SEC-31 | Low | Dependencies | `url` 2.5.8, RUSTSEC-2026-0592 (stack overflow in `Url::origin()` on nested `blob:`). Our `origin()` calls run only after an http(s) scheme check (`assets.rs`), so not reachable from our code. | **Fixed**: `url` 2.5.9 | `scripts/audit.sh` |
| SEC-32 | Low | Dependencies | `paste` 1.0.15 unmaintained (RUSTSEC-2024-0436), compile-time proc-macro via `tikv-jemalloc-ctl`. | Accepted, reason in `scripts/deny.toml` | `scripts/audit.sh` |
| SEC-33 | Medium | MCP auth | Without `OC_PUBLIC_URL`, the MCP token audience is built from the request `Host` header (`routes/mcp.rs:33-42,288`): a token signed by the same host key for another resource (staging, another deployment) is accepted by sending that `Host`. Needs a valid host-signed token. | **Fixed** (v0.1.0-alpha.2): the audience base is `[host.ai] mcp_audience`, else `OC_PUBLIC_URL`, never a request header. With neither, `/mcp/{hostId}` and its metadata answer `404`, session `ai.mcp` is false, and start-up logs one warning | `mcp::without_a_public_url_a_token_matching_the_host_header_is_refused` (seen failing: 200 instead of 404); `mcp::unauthorized_carries_resource_metadata_and_bad_tokens_are_refused` (a `Host`-built audience is 401) |
| SEC-34 | Medium | MCP authZ | Without the host `/access` callback, the token's `role` applies to every file of the host when `files` is absent (`mcp.rs:131-134,225-230`). As designed (docs/24) but sharp. | **Fixed** (v0.1.0-alpha.2): without `/access`, a token without `files` is refused (`ROLE_FORBIDDEN`, `FILES_REQUIRED: …`) unless the host sets `[host.ai] mcp_all_files = true` (documented as broad, docs/05 §7a, docs/24 §7.1). With `/access`, the host's role decides, as before | `mcp::without_the_access_callback_a_token_without_files_is_refused` (seen failing: the write went through), `mcp::mcp_all_files_lets_a_token_without_files_cover_every_file`, `mcp::the_host_access_callback_decides_the_role_over_the_token_claim` |
| SEC-35 | Medium | WOPI session | WOPI `access_token_ttl` (form field) sets the session expiry with no upper bound (`launch.rs:163-180`), unlike the JWT 10 h cap. Needs a valid WOPI token; the host can still end the session. | **Fixed** (v0.1.0-alpha.2): the session expiry is `min(access_token_ttl, now + 10 h)` (`jwt::MAX_TTL_SECS`, the JWT cap); past it the host launches again | `wopi::a_far_future_access_token_ttl_is_clamped_to_the_session_cap` (seen failing: expiry 10 years out) |
| SEC-36 | Low | SSRF / secrets | Clients that follow redirects: AI provider (`ai/provider.rs:175`; reqwest forwards the Anthropic `x-api-key` header across hosts), cluster peer client (`cluster/mod.rs:199`), JWKS (`limited(3)`). Targets are operator config only. | Open, decision: `Policy::none()` with the next AI change | — |
| SEC-37 | Low | MCP scope | `canvas:write:direct` is never checked; direct writes follow the host's `default_mode` (`mcp.rs:155,496`). The user still needs the edit role. | Open, decision: enforce the scope before beta | — |
| SEC-38 | Low | Cluster | Tool-forward dedupe keys on the unsigned `x-oc-cluster-node` header; replay inside the 30 s MAC window by someone on the internal network (`ai/tools/forward.rs:181`). | Accepted for alpha (internal network, docs/13) | — |
| SEC-39 | Low | DoS (CSV) | `parse_csv` (`import.rs:228`) builds all fields before the 200-column check: a 5 MB row of commas is ~120 MB transient. | Accepted (bounded by the 5 MB body cap) | — |
| SEC-40 | Low | Redis | Keys are a fixed `oc:` prefix: two deployments sharing one Redis database collide. No cross-tenant collision inside one deployment (room = sha256 of a validated host id + file). | Accepted: one Redis database per deployment (docs/13) | — |
| SEC-41 | Low | Import links | `safe_href` accepts protocol-relative `//evil` links (no script). | Accepted | — |
| SEC-42 | Low | Prompt injection | Read content can steer an edit-mode run to write external links/images inside the user's own role (CSP allows `img-src https:`). Bounded: one file, no network tools, plan approval by default, undo. | Accepted (`inject.rs` flags only) | — |
| SEC-43 | Info | MCP | MCP `comment_add` always refused: grants use `Perms::default()` (`comment: false`). Fails closed. | Functional bug, open | — |
| SEC-44 | Medium | WOPI caller authenticity | WOPI hosts could not tell OpenCanvas from anyone holding an access token: no proof keys (docs/23 WOPI-13). | **Fixed** (v0.1.0): every WOPI call is signed with RSA proof keys (current + old, `OC_WOPI_PROOF_KEY[_OLD]`, PEM or sealed with `OC_KEK`), published in discovery; start-up refuses a WOPI host without keys. Signing uses `rsa` 0.10 (constant-time crypto-bigint), not 0.9 (RUSTSEC-2023-0071, still only used for public-key JWT verification) | `proof::tests::*`, `wopi::every_wopi_call_carries_a_valid_proof`, `scripts/e2e-wopi.sh` (tampered and stale proofs refused) |
| SEC-45 | Medium | DoS (validation) | The MOD-01 schema validator walked nested content without a depth bound: a 200 000-level document overflowed the stack and aborted the process. HTTP bodies were already capped by serde's 128-level parse limit, but documents built in memory (a loaded `.ocanvas`) were not. Found in the v0.1.0 re-audit of MOD-01. | **Fixed**: nesting deeper than 64 levels is a validation error (`MAX_NEST`, as `html::MAX_DEPTH`) | `validate::deeply_nested_content_is_an_error_not_a_crash` (seen aborting with "stack overflow" first) |

Checked and fine: AI master switch off by default (`OC_AI_CONFIG` + `[ai] enabled`, `OC_AI=off`
wins; MCP also needs `[host.ai] mcp = true`); MCP bearer-only auth with pinned alg, `iss`/`aud`/`exp`,
15 min TTL cap, launch tokens refused; effective permission = scope ∩ role, re-checked per tool and
before every write; assistant: viewers refused, commenters answer/comment only; prompt 32 KB,
selection 64 KB, per-run steps/writes/tokens/seconds, per-hour and monthly quotas; `Secret` redacts
in `Debug`. Import format flag off by default, enforced server-side on both routes; HTML scheme
allow-list; zip caps on actual inflated bytes; CSV 200 columns / 10 000 rows. Redis Lua: every
script takes KEYS/ARGV (no source concatenation), fencing compares the epoch inside the script.
Renewal re-launches with a fresh host JWT (jti single-use), JSON answer `no-store`, no cookies
(no CSRF). SDK CORS: explicit `allowed_origins`, GET/POST, `Content-Type` only, no credentials,
no reflection. `export_formats` enforced on `/v1/export/{fmt}` and board svg/png (the AI read
tool renders Markdown of content the session can already see). jemalloc static `MALLOC_CONF`:
`background_thread` and decay only, no profiling/dumps. SSRF: host, asset, WOPI and PDF clients
`redirect::Policy::none()`; WOPISrc allow-list; asset fetch exact-origin.

**No Critical or High finding is open.**

### Tool output

| Check | Result |
|---|---|
| `cargo audit` (1 560 advisories, 405 crates) | before: 1 vulnerability (RUSTSEC-2026-0592) + 1 unmaintained; after: 0 vulnerabilities, 6 documented ignores |
| `cargo deny … advisories bans licenses sources` | ok / ok / ok / ok (licence allow-list added: permissive only; our crates Apache-2.0) |
| `pnpm audit` (web, prod and full) | No known vulnerabilities |
| `npm audit` (e2e lockfile) | 0 vulnerabilities |
| `tests/security.rs`, `tests/hardening.rs` | 11 + 11 pass |
| `cargo test -p oc-model` | 30 + 39 pass (3 new) |
| Two-user Playwright specs `w-two-user-board`, `x-two-user-comments` | written; **not yet run** (see below) |
| Docker build (`deploy/Dockerfile`) | **skipped**: 11 GB free at start (< 12 GB rule) |

`scripts/audit.sh` now also checks licences and the e2e lockfile.

**Not completed in this pass (disk):** free space fell from 11 GB to 4 GB during the run (another
session building on the same volume), below the 6 GB stop rule, so the release builds for the
Playwright run, the full `cargo test`, and the full Playwright suite were stopped. The two
acceptance specs and the full regression run must be executed on the release commit before tagging.

## 6. Release audit, v0.2.0 (2026-11-25, REL-04)

**Baseline and scope.** Main at `2cf01ec`, branch `worktree-agent-a1106dbc1b8b0f9f0`. This pass
covers the surfaces added since §5: in v0.1.2 and in the v0.2 work, plus the
pieces of them that v0.1.2 already shipped (HAPI-01..05, version history, icons, diagram
import), which no earlier pass had covered. For each surface it lists the tests that cover it,
then the findings. Every fix comes with a test that was seen failing before the fix.

### Surfaces and their tests

| Surface | What was checked | Tests |
|---|---|---|
| API auth and scopes (HAPI-02, HAPI-08) | Covered: one `Principal` check for the API and MCP; the token `aud` built from config only, never from a request header; `exp` ≤ 15 min; effective role `min(scope, host role)`, re-checked per file; `files` / `/access` (SEC-34 rule); `canvas:admin` only with `token_admin`; an ambiguous issuer refused; API and MCP audiences distinct. **Finding (Low):** a host-minted token grant has `export`/`download`/`print` on (the token has no `perms` claim), so a `canvas:read` token can export what it can read. **Decision:** accepted and documented; a read scope already returns the content | `api_tokens.rs` (6), `mcp.rs` (10), `mcp_api_parity.rs` (4), `authz::tests` |
| Idempotency (HAPI-03) | Covered: key ≤ 255 visible ASCII; scoped to (host, subject); fingerprint = method + path + query + body; 60 s lease; only 2xx answers kept (ids and counts, never content; the sync token is never kept); failures free the key. **Finding (Info):** a replay after the caller lost access returns the stored ids. **Decision:** accepted; nothing is written and no content is returned | `api_idempotency.rs` (2), `storage_conformance.rs::idempotency_keys_claim_once_replay_and_expire` (SQLite, MySQL 8.4, MariaDB 10.11, Redis), `mcp_api_parity.rs::mcp_writes_use_the_api_idempotency_store` |
| Rate limits (HAPI-04) | Covered: subject and per-file write buckets on the server clock, shared by MCP and across nodes (Redis Lua with KEYS/ARGV); `429` + `Retry-After`; signed cursors bound to kind, file and query, 1 h | `api_paging_limits.rs` (5, incl. Redis) |
| Events stream (HAPI-05) | Covered: read scope; role through the grant; ids only, never content; `Last-Event-ID` ≤ 64 chars; ≤ subscribers per room (429); bounded queues (4008); close at token `exp` (4001) and on revoke (4003, checked before every event); `no-store` | `api_events.rs` (5), `cluster.rs::change_events_reach_streams_on_every_node`, `routes::v1::events` units |
| Sync token (HAPI-05) | Covered: a session ticket with the effective role; ≤ 15 min and ≤ the token's `exp`; `no-store`; never replayed by idempotency. **Finding (Low):** the documented "connect within 60 s" is counted from the ticket's first use on a node, not from when it was issued. This is the same as launch tickets. **Decision:** accepted for 0.2.0; the ticket still ends at `expiresAt` | `api_events.rs::sync_token_opens_the_room_websocket_with_the_effective_role` |
| Webhooks (WH-01) | Covered: SSRF (same origin as `callback_base`, checked at start-up and on every delivery; userinfo refused; no redirects; response body never read); signature v2 over method, path, query and body; ±300 s in both verifiers, constant-time; ids only; secret never logged | `webhooks.rs` (7), `webhooks::tests`, `cluster.rs::webhooks_are_sent_once_in_a_cluster`, `storage_conformance.rs::webhook_outbox_contract`, client `webhook_vectors` (Rust, TS) |
| History restore permissions (VH-01b) | Covered: list, preview and diff need history access; naming needs edit + `commitMessage`; restore and undo need edit + `restore`; the `restored` control is server-made (no client path); version ids are path-encoded in host URLs and ≤ 200 chars; diffs run in `spawn_blocking` under limits. **Finding (Info):** the version, list and diff caches are per room, so a host that filters versions per user is bypassed for up to 5 min. **Decision:** accepted for 0.2.0; history access is per file (`perms.history`), so a host must not rely on per-user version lists | `history_api.rs` (9), `history.rs` (9), `restore.rs` (2), `diff.rs` (18) |
| Icon upload (DGM-17) | Covered: edit role; 20 per minute per user; DTDs refused; ≤ 2,000 elements and 16 levels; usvg rewrites the file, then an allow-list (no script, handlers, foreignObject, external `href`/`url()`/`@import`, `style` attribute); PNG size from IHDR, re-encoded; output ≤ 64 KB; the server alone writes the `icons` root, and the allow-list runs again on read | `icon_clean.rs` (12), `icons.rs` (3) |
| draw.io / Excalidraw import (DGM) | Covered: edit role + format flag; DTD and entities refused; 200,000 nodes; depth without recursion; 16 MB inflate cap on real bytes; 20,000 shapes; labels become plain text; images sniffed, no SVG; links reported, never imported. **Finding (Low):** coordinates that are finite but huge (±1e308) overflow to `null` after placement. **Decision:** accepted; editors can write such values directly, and renderers treat `null` as 0 | `diagram_import.rs` (10), `import.rs::hostile_diagram_files_are_refused_with_a_reason` and the 3 diagram tests, `diagram_import::tests` |
| Block SDK manifest, integrity, schema (BSDK-01/02/05) | Covered: operator install only; manifest rules (`oc.` reserved, SemVer, safe `entry`, https permission origins); sha384 SRI checked at start, bad packages refused one by one; `OC_BLOCKS_ORIGIN` ≠ `OC_PUBLIC_URL`; schema subset with no remote `$ref`; templates logic-less and escaped; fallbacks sanitised; newer data never overwritten; the 4426 guard. No third-party code runs on the server | `ext.rs` (8), `blocks.rs` (4), `ext::{schema,manifest,template}` units, editor `src/ext` (9) |
| Block SDK sandbox (BSDK-03) | Not built yet | **pending BSDK-03/04**: audit the frame CSP, the origin checks on both ends of the bridge, and the rate limits when it lands (docs/23 SDK-A2) |
| Editor profiles (EDP-01) | Not built yet | **pending EDP-01**. Rule to audit when it lands: profile filtering hides blocks and features in the editor and **never strips content**. A document with blocks that the profile hides must round-trip byte-equal through load, edit and save, on the server and in the editor. The filter must not be an access control (the server enforces roles, not profiles) |

### Findings

| ID | Sev | Area | Finding (evidence) | Status | Regression test |
|---|---|---|---|---|---|
| SEC-46 | Medium | Block SDK schema | Room updates over the WebSocket were not checked against the installed package's schema. API, MCP and `.ocanvas` writes were checked. A forged or broken client with the edit role could write an out-of-range attr, a block missing a required attr, or data of the wrong type. The next save then wrote a file that MOD-01 refuses to open, so one editor could make the file unopenable. | **Fixed**. `room::filter::breaks_ext_schema`, called from the actor next to the 4426 guard, applies the update to a scratch copy and refuses it when an installed block has a schema finding it did not have before. Data that a newer or older package wrote stays editable around it, and types that are not installed are not checked. Cost: O(document) per frame, only when a package is installed and the document has SDK blocks (like SEC-23) | `blocks.rs::room_updates_are_checked_against_the_block_schema` (seen failing with the check off) |
| SEC-47 | Low | Availability | Nodes that start together on an empty database raced on the migrations. One failed with `Duplicate entry '1' for key 'PRIMARY'` (MariaDB 10.11) or `table sessions already exists` (SQLite), and that node stopped at start-up. Found when the first `storage_conformance` run on a fresh MariaDB failed. | **Fixed**. `Store::connect` runs the migrations again after a short wait, for up to about 30 s. By then the other node has applied them. | `storage_conformance.rs::nodes_starting_together_on_an_empty_database_all_start` (seen failing on SQLite, MySQL 8.4 and MariaDB 10.11) |
| SEC-48 | Low | Webhooks | A sweep claimed up to 100 rows for 60 s and sent them 8 at a time, each with a 10 s timeout. Against a slow receiver (about 13 rounds, 130 s) a claim ran out before the row was sent, so another node sent the same event again. The receiver still deduplicates by `Idempotency-Key`. | **Fixed**. A sweep claims at most 40 rows (5 rounds of 10 s, inside the 60 s claim). The worker sweeps again at once after a full sweep, so throughput is unchanged | `webhooks::tests::a_sweep_is_sent_before_its_claims_end` (seen failing: "13 rounds of 10s outlast a 60000 ms claim") |
| SEC-49 | Medium | DoS (diagram import) | draw.io and Excalidraw label cleaning (`diagram_import::html_to_text`) was quadratic, the same bug as SEC-30. Every `<svg>`, `<script>` or `<style>` lowercased a copy of the rest of the label, every lone `<` scanned the rest for `>`, and every unclosed `<!--` scanned for `-->`. A 5 MB Excalidraw file of `<svg></svg>` labels keeps an async worker busy for minutes. Needs the edit role and the format flag. | **Fixed**. The search is case-insensitive in place, a lone `<` makes the rest text, and an unclosed comment runs to the end | `diagram_import::tests::label_cleaning_is_linear` (seen failing: the old code did not finish within 5 minutes) |
| SEC-50 | Medium | DoS (icons) | An SVG with chained `<use>` references (about 70 elements in the file, 6 levels of 10) passed the 2,000-element pre-scan. usvg then expanded it towards its 1,000,000-node limit on the async worker, taking about 1 s of CPU and a burst of memory per upload, 20 times a minute per editor. | **Fixed**. The pre-scan counts elements as they are drawn, with each `<use>` replaced by its target. It refuses past 2,000, a use cycle, or a chain deeper than 32, before usvg sees the file | `icon_clean.rs::use_chains_that_expand_past_the_element_limit_are_refused` (seen failing: `invalid_svg` after 1.2 s instead of `too_many_elements`) |
| SEC-51 | Low | History | The restore undo entry was keyed `restore:{restoreId}:{author}`, and `restoreId` was only length-checked. Host user ids may contain `:`, so user `u_1` could undo the restore of user `acme:u_1` by sending `restoreId=<id>:acme` (every peer receives the id in the `restored` control). A restore by `u_1` also dropped `acme:u_1`'s undo entry (suffix match). Needs edit + restore. | **Fixed**. `restoreId` must be a lowercase ULID, and entries are matched exactly | `history_api.rs::a_restore_id_cannot_reach_another_users_undo` (seen failing: the attacker's undo answered 200) |
| SEC-52 | Low | Client SDK | `opencanvas_client::verify_webhook` computed `(now - t).abs()` on the unauthenticated `t` from the header. With overflow checks on (debug, or a release profile that keeps them) `t=-9223372036854775808` panicked the receiver. | **Fixed**: `abs_diff`. The TypeScript client uses floats and is not affected | `oc-client tests/unit.rs::webhook_timestamps_at_the_edges_are_refused_not_a_panic` (seen failing: "attempt to subtract with overflow") |
| SEC-53 | Low | History | One 404/405/501 from the host's list call marked the room "no host history" for the life of the process, for every user. A host that answered 404 for one user, or added the call later, lost host history in that room until a restart. The set also never shrank. | **Fixed**. The answer is remembered for 5 minutes on the server clock, and expired entries are dropped | `history_api.rs::a_host_without_the_list_call_falls_back_to_in_file_history` (extended; seen failing: still `source: file` after 6 min) |

Still open from §5: SEC-36 (redirects in operator-configured clients) and SEC-37
(`canvas:write:direct` not checked) remain Low and open, with their decisions. SEC-43 is fixed
(HAPI-02: grants carry `comment` by role; `mcp.rs::a_comment_scope_token_can_comment`).

**No Critical or High finding is open. No Medium finding is open.**

### Tool output (2026-11-25)

| Check | Result |
|---|---|
| `cargo audit` (1,566 advisories, 407 crates) | 0 vulnerabilities, with the ignores documented in `scripts/deny.toml` |
| `cargo deny --config scripts/deny.toml check advisories bans licenses sources` | advisories ok, bans ok, licenses ok, sources ok |
| `pnpm audit --prod` (web) | No known vulnerabilities found |
| `npm audit` (e2e) | 0 vulnerabilities |
| `scripts/check-spdx.sh` | ok (`scripts/audit.sh` exit 0) |
| `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check` | clean |
