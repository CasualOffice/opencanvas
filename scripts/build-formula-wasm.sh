#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# Builds the formula engine (crates/oc-formula, ADR-078) for the editor: a plain wasm32 module
# with a JSON bridge (no bindgen), written to web/packages/database/src/formula/oc_formula.wasm
# and committed. The editor loads it lazily, only for a database with formula or rollup fields.
# Rebuild after any change to crates/oc-formula; engine.test.ts runs the shared vectors on it.
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_PROFILE_RELEASE_OPT_LEVEL=s CARGO_PROFILE_RELEASE_LTO=true CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 CARGO_PROFILE_RELEASE_PANIC=abort CARGO_PROFILE_RELEASE_STRIP=true
cargo build -q --release -p oc-formula --lib --target wasm32-unknown-unknown
target="${CARGO_TARGET_DIR:-target}"
out=web/packages/database/src/formula/oc_formula.wasm
mkdir -p "$(dirname "$out")"
cp "$target/wasm32-unknown-unknown/release/oc_formula.wasm" "$out"
if command -v wasm-opt >/dev/null; then wasm-opt -Os --strip-debug "$out" -o "$out"; fi
echo "built $out ($(wc -c <"$out" | tr -d ' ') bytes)"
