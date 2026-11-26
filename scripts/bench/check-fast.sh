#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# The cheap benchmark gates (ADR-079 START), run by scripts/prepush.sh and CI: build the editor
# and check its initial JS against bench/budgets.toml ([start] initial_js_kb, and `forbid`: no
# advanced module in the initial graph). --no-build checks an existing dist.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${1:-}" != --no-build ]; then
  (cd web/packages/editor && pnpm exec vite build --logLevel error >/dev/null)
fi
node web/packages/editor/scripts/check-budget.mjs web/packages/editor/dist
