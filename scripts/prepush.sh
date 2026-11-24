#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# The fast CI gates, run locally before every push to main: formatting, lint, licence headers,
# units, types and the site. (Tests run separately; this catches the checks that fail in seconds.)
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
bash scripts/check-spdx.sh
node tools/px-to-rem.mjs --check >/dev/null
(cd web && node ../tools/check-px.mjs && node packages/client/scripts/gen.mjs --check >/dev/null && pnpm -r --if-present typecheck)
python3 -I tools/test_sitelib.py
python3 -I tools/test_apilib.py && python3 -I tools/check-openapi.py >/dev/null
# One step per line: under `set -e` a failure inside an `a && b` chain does not stop the script.
python3 tools/build-site.py >/dev/null
python3 tools/check-site-links.py >/dev/null
python3 tools/check-site-claims.py >/dev/null
git diff --exit-code --quiet site || { echo "prepush: site/ is out of date; commit the rebuilt site"; exit 1; }
echo "prepush: all fast CI gates pass"
