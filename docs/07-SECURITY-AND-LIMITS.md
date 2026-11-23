# 07 — Security, privacy and limits

**Status:** v0.2, 2026-11-21 (after the security audit, [docs/18](18-SECURITY-AUDIT.md)). Target: OWASP ASVS Level 2.
Reporting a vulnerability: [SECURITY.md](../SECURITY.md).

## 1. Trust boundaries

```
[end-user browser] ──(untrusted input)──▶ [OpenCanvas] ──(signed calls)──▶ [host]
       ▲                                       │
       └── renders user content (XSS risk) ────┘
[OpenCanvas] ──(fetches arbitrary URLs: unfurl)──▶ [internet]  (SSRF risk)
```

## 2. Threats and controls

| Threat | Control |
|---|---|
| Forged launch token | Per-host key; verify `alg` from host config (never from header), `iss`, `aud`, `exp ≤ 10h`, `nbf`, `jti` single-use cache (DB/Redis). |
| Token leakage via URL | JWT posted in form body, not query; WS uses short (≤ 60 s to connect) single-room ticket; tickets never logged. |
| Privilege escalation (viewer edits) | Server filters every `sync update` by role; commenters restricted to `comments` subtree via scratch-doc diff. Client read-only is cosmetic. |
| Presence spoofing | Server overwrites `awareness.user` from grant. |
| XSS via paste/import/markdown | ProseMirror schema whitelist (paste is parsed by the schema, unknown tags dropped); server HTML import (`oc_model::html`) is a whitelist tree walk, not raw HTML; no raw HTML block; links restricted to `http(s):`, `mailto:`, `/`, `#` (import and export); the link mark re-checks `isAllowedUri` when rendering. |
| Malicious embeds | Provider allow-list per host; `<iframe sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-popups-to-escape-sandbox">` only for listed providers, rebuilt from the provider id (`resolveEmbed`), never the stored URL; `referrerpolicy=strict-origin-when-cross-origin` (YouTube refuses to play without a referrer); generic iframe not supported. CSP `frame-src https:`. |
| SSRF via image URL / WOPISrc / JWKS | No arbitrary fetches: export images only from the host's `callback_base` origin and `asset_origins` (exact origin match, no userinfo, no redirects, 10 MB, `image/*`); `WOPISrc` only when it matches a `wopi_allowlist` entry exactly (scheme, host, port, path prefix; userinfo, queries and encoded separators refused; no redirects); JWKS and Gotenberg URLs come from operator config. Link unfurl (`/v1/unfurl`, UNF-01) resolves DNS once and checks every answer, pins the connection to the checked IP, blocks private, loopback, link-local, CGNAT, multicast, reserved, documentation and metadata ranges (v4 and v6, incl. IPv4-mapped, NAT64, 6to4, Teredo), re-checks every redirect, sends no cookies or credentials and uses no env proxy; `OC_UNFURL_ALLOW_PRIVATE` can open private ranges, never metadata. |
| Clickjacking / embedding by strangers | CSP `frame-ancestors` = host `allowed_origins`; postMessage origin checks both ways. |
| Script injection into the SPA | Every response: `Content-Security-Policy` with `script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'` (+ `frame-ancestors`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Handler CSPs are kept: exports and room assets are served `sandbox; default-src 'none'`. Node views pass doc URLs through `safeHref` / `safeImageSrc` (`web/packages/editor/src/lib/urls.ts`). |
| Injection into exports | HTML/SVG/DOCX escape every text and attribute; link targets limited to `http(s):`, `mailto:`, `/`, `#`; Markdown escapes `<` and drops script/data link targets; CSV cells starting with `= + - @ TAB CR` get a leading `'`. |
| SQL injection | Every statement is a literal with `?` binds (guard test `sec05_every_sql_statement_is_a_literal`); no dynamic identifiers, no `LIKE`. |
| Callback replay | `X-OpenCanvas-Signature` `v2` binds method + path + query + body; the signed client never follows redirects. |
| Callback spoofing (someone pretends to be us) | HMAC `X-OpenCanvas-Signature` with timestamp (5 min skew). |
| DoS | Per-connection frame rate limits (per-IP limits belong in the reverse proxy); readers that stop reading are dropped (30 s send timeout, 4096-frame backlog); multipart boundaries ≤ 70 chars; frame ≤ 1 MB; doc ≤ 20 MB (block and shape counts are bounded by the doc cap only); room peers ≤ 550 (then close 1013), ≤ 8 awareness client ids per connection; decompression caps on zip import (ratio ≤ 100, total ≤ 100 MB, entries ≤ 1 000, no path traversal), enforced on the bytes actually inflated, never on the sizes the archive declares. |
| Secrets at rest | Host secrets AES-256-GCM encrypted with `OC_KEK`; host callback tokens in `sessions.grant_json` encrypted. |
| Data retention | Room state deleted after commit + TTL; no content in logs (only ids, sizes, timings); crash dumps disabled in prod. |
| Supply chain | `scripts/audit.sh` (`cargo audit`, `cargo deny` with `scripts/deny.toml`, `pnpm audit --prod`), lockfiles, pinned CDN-free bundle (self-hosted assets). |
| Ops endpoints | `/metrics` needs `Authorization: Bearer $OC_METRICS_TOKEN` when set; keep `/metrics`, `/readyz` and `/v1/internal/*` off the public listener. |

## 3. Limits (defaults, per host overridable)

| Limit | Default |
|---|---|
| Launch token TTL max | 10 h |
| WS ticket connect window | 60 s |
| Frame size | 1 MB |
| Frames/s per connection | 60 (burst 120) |
| Awareness size / rate | 2 KB / 20 Hz |
| CRDT doc soft / hard | 5 MB / 20 MB |
| Blocks per doc / shapes per board | bounded by the 20 MB doc cap (no separate count limit) |
| Image upload | 25 MB |
| Attachment upload | host-defined (default 100 MB) |
| Connections per room | 550 (`MAX_PEERS`, not split by role) |
| Unfurl fetch | HTML 512 KB (cut at `</head>`), images 2 MB; connect 3 s, total 5 s; 3 redirects; 60 requests per ticket and 300 fetches per node per minute |
| Awareness client ids / connection | 8 |
| `GET /v1/users` `q` | 200 bytes |

## 4. Privacy

- PII held in memory only: display name, avatar URL, user id — from the token.
- `sessions` rows hold user id + role until token expiry, then purged hourly.
- GDPR delete is the host's job (they hold the file); we purge on
  `DELETE /v1/files/{id}/session`.
