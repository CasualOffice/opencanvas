# Security policy

Adapted from OpenSign's `SECURITY.md`.

## Reporting

Do not open a public issue for a suspected vulnerability, a working exploit, or a document or
token taken from a real deployment.

Use GitHub private vulnerability reporting for this repository ("Report a vulnerability" under
the Security tab). Include:

- the affected revision (commit or release),
- the subsystem: launch / JWT / WOPI, collaboration WebSocket, room roles, host API, exports
  (Markdown, HTML, DOCX, PDF, board SVG/PNG), `.ocanvas` import, assets, cluster relay, editor,
  embed SDK,
- the impact and a realistic attack path (who the attacker is: anonymous, viewer, commenter,
  editor, another host),
- a minimal reproduction **without personal data, real documents or live tokens**.

We acknowledge within 5 working days, assess, coordinate a fix and an advisory, and credit the
reporter if asked. Please give us 90 days (or until a fix ships, if sooner) before disclosure.

Treated as critical: anything that lets a session act on a file it was not launched for, a
viewer or commenter change content, a forged or replayed launch token or callback, script
execution in the editor origin from document content, and reading another tenant's data.

## Scope

In scope: `crates/` (the `opencanvas` server and `oc-model`), `web/packages/*`, the embed SDK
(`/sdk/embed.js`), the migrations and the reference deployment files. The example hosts in
`examples/` are reference code: report issues in them, but they are not meant for production.

Out of scope: denial of service by volume alone (put a reverse proxy with per-IP limits in front,
docs/13), findings that need a compromised host application or operator config, and the
deployment's own TLS and proxy settings.

## Supported versions

Fixes land on `main` and ship in the next 0.1.x patch release. The 0.1 line takes security fixes
of any severity and P0/P1 bug fixes only ([docs/26 §3](docs/26-RELEASE-v0.1.0-SCOPE.md)); there
are no other maintained release branches. Upgrade to the newest 0.1.x to get a fix.

| Version | Supported | Notes |
|---|---|---|
| `0.1.x` | Best effort | No SLA ([release notes](docs/28-RELEASE-v0.1.0.md)) |
| `0.1.0-alpha.1` | No | Upgrade to the newest `0.1.x` ([upgrade notes](docs/28-RELEASE-v0.1.0.md#upgrade-notes)) |
| Untagged builds of `main` | No | Reproduce on the newest `0.1.x` or current `main` before reporting |

## Response expectations

Best effort, by the maintainers, with no SLA:

- acknowledgement within 5 working days of a report through the channel above;
- an assessment of severity and affected versions once the report is reproduced;
- a fix on `main` and in the next 0.1.x release, with an advisory, for confirmed issues; critical
  issues (the list above) first;
- credit in the advisory if you ask for it;
- coordinated disclosure: 90 days, or until a fix ships if sooner.

There is no backporting to older lines: a fix ships in the next 0.1.x release.

## Hardening notes for operators

See [docs/07](docs/07-SECURITY-AND-LIMITS.md) and the audit in
[docs/18](docs/18-SECURITY-AUDIT.md). In short: set `OC_KEK`, `OC_PUBLIC_URL` and
`OC_METRICS_TOKEN`; keep `/metrics`, `/readyz` and `/v1/internal/*` off the public listener;
use long random `jwt_secret` / `callback_secret` / `api_key` values (32+ characters); verify the
`v2` part of `X-OpenCanvas-Signature` in your host; run `scripts/audit.sh` in CI.

## Dependencies

How dependencies are audited and updated, and how fast an advisory is fixed:
[docs/38](docs/39-DEPENDENCY-UPDATES.md). Each release carries CycloneDX SBOMs (Rust and npm)
with its binaries.
