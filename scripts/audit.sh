#!/usr/bin/env bash
# Supply-chain checks (docs/07 §2, docs/18): RustSec advisories, crate sources and bans, and
# the production npm dependencies. The accepted advisories and their reasons are in
# scripts/deny.toml; anything new fails this script.
#
#   scripts/audit.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
IGNORES=$(grep -o 'RUSTSEC-[0-9]*-[0-9]*' scripts/deny.toml | sort -u | sed 's/^/--ignore /' | tr '\n' ' ')
# shellcheck disable=SC2086
cargo audit $IGNORES
cargo deny --config scripts/deny.toml check advisories bans sources
(cd web && pnpm audit --prod)
echo "audit: ok"
