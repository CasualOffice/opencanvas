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
