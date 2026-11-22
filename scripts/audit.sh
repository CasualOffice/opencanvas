#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# Supply-chain checks (docs/07 §2, docs/18): RustSec advisories, licences, crate sources and bans, the
# SPDX headers (check-spdx.sh), and
# the npm dependencies (web production, e2e lockfile). The accepted advisories and their reasons are in
# scripts/deny.toml; anything new fails this script.
#
#   scripts/audit.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
IGNORES=$(grep -o 'RUSTSEC-[0-9]*-[0-9]*' scripts/deny.toml | sort -u | sed 's/^/--ignore /' | tr '\n' ' ')
# shellcheck disable=SC2086
cargo audit $IGNORES
cargo deny --config scripts/deny.toml check advisories bans licenses sources
(cd web && pnpm audit --prod)
(cd e2e && npm audit)
bash scripts/check-spdx.sh
echo "audit: ok"
