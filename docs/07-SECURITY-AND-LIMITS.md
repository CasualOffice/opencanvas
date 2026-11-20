# 07 — Security, privacy and limits

**Status:** draft v0.1, 2026-11-21. Target: OWASP ASVS Level 2.

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
| XSS via paste/import/markdown | ProseMirror schema whitelist; HTML import through sanitizer (ammonia on server, DOMPurify on client); no raw HTML block; links restricted to `http(s):`, `mailto:`, host-allowed schemes. |
| Malicious embeds | Provider allow-list per host; `<iframe sandbox="allow-scripts allow-same-origin allow-popups allow-presentation">` only for listed providers, `referrerpolicy=no-referrer`; generic iframe disabled by default. |
| SSRF via unfurl / image URL | Resolve DNS once, pin IP, block private/link-local/loopback/metadata ranges (v4+v6), HTTPS-only by default, 3 redirects max (re-checked), 2 MB / 5 s caps, content-type check. |
| Clickjacking / embedding by strangers | CSP `frame-ancestors` = host `allowed_origins`; postMessage origin checks both ways. |
| Callback spoofing (someone pretends to be us) | HMAC `X-OpenCanvas-Signature` with timestamp (5 min skew). |
| DoS | Per-IP and per-connection rate limits; frame ≤ 1 MB; doc ≤ 20 MB; ≤ 10 000 blocks; ≤ 5 000 shapes/board; room peers ≤ 550; decompression caps on zip import (ratio ≤ 100, total ≤ 100 MB, entries ≤ 1 000, no path traversal). |
| Secrets at rest | Host secrets AES-256-GCM encrypted with `OC_KEK`; host callback tokens in `sessions.grant_json` encrypted. |
| Data retention | Room state deleted after commit + TTL; no content in logs (only ids, sizes, timings); crash dumps disabled in prod. |
| Supply chain | `cargo deny`, `pnpm audit`, lockfiles, pinned CDN-free bundle (self-hosted assets). |

## 3. Limits (defaults, per host overridable)

| Limit | Default |
|---|---|
| Launch token TTL max | 10 h |
| WS ticket connect window | 60 s |
| Frame size | 1 MB |
| Frames/s per connection | 60 (burst 120) |
| Awareness size / rate | 2 KB / 20 Hz |
| CRDT doc soft / hard | 5 MB / 20 MB |
| Blocks per doc | 10 000 |
| Shapes per board | 5 000 |
| Image upload | 25 MB |
| Attachment upload | host-defined (default 100 MB) |
| Editors per room / viewers | 50 / 500 |
| Unfurl fetch | 2 MB, 5 s, 3 redirects |

## 4. Privacy

- PII held in memory only: display name, avatar URL, user id — from the token.
- `sessions` rows hold user id + role until token expiry, then purged hourly.
- GDPR delete is the host's job (they hold the file); we purge on
  `DELETE /v1/files/{id}/session`.
