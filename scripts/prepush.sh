#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# The fast CI gates, run locally before every push to main: formatting, lint, licence headers,
# units, types and the site. (Tests run separately; this catches the checks that fail in seconds.)
set -euo pipefail
# No unresolved merge conflict markers anywhere in the tree.
if git grep -nI -e "^<<<<<<< " -e "^>>>>>>> " -- . ":!*.lock" >/dev/null; then echo "prepush: conflict markers in the tree"; git grep -nI -e "^<<<<<<< " -e "^>>>>>>> " -- . | head; exit 1; fi
cd "$(dirname "$0")/.."
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
# The Rust client's generated models must match openapi.json, as the TS client's must.
cargo test -q -p opencanvas-client --test models >/dev/null
bash scripts/check-spdx.sh
node tools/px-to-rem.mjs --check >/dev/null
(cd web && node ../tools/check-px.mjs && node packages/client/scripts/gen.mjs --check >/dev/null && pnpm -r --if-present typecheck)
# ADR-079 START: the editor's initial JS within bench/budgets.toml, no advanced module in it.
bash scripts/bench/check-fast.sh
python3 -I tools/test_sitelib.py
python3 -I tools/test_apilib.py && python3 -I tools/check-openapi.py >/dev/null
# One step per line: under `set -e` a failure inside an `a && b` chain does not stop the script.
python3 tools/build-site.py >/dev/null
python3 tools/check-site-links.py >/dev/null
python3 tools/check-site-claims.py >/dev/null
python3 -I tools/check-site-seo.py --self-test >/dev/null
python3 -I tools/check-site-seo.py >/dev/null
git diff --exit-code --quiet site || { echo "prepush: site/ is out of date; commit the rebuilt site"; exit 1; }
echo "prepush: all fast CI gates pass"
