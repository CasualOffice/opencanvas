#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# Builds the Spreadsheet block's engine (crates/oc-sheet on opencalc, ADR-080) for the editor: a
# plain wasm32 module with a JSON bridge (no bindgen), written to
# web/packages/sheet/src/engine/oc_sheet.wasm and committed. The editor fetches it only when a
# spreadsheet block comes within a screen. Rebuild after any change to crates/oc-sheet or the
# opencalc pin; engine.test.ts checks it against the native results.
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_PROFILE_RELEASE_OPT_LEVEL=z CARGO_PROFILE_RELEASE_LTO=true CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 CARGO_PROFILE_RELEASE_PANIC=abort CARGO_PROFILE_RELEASE_STRIP=true
# zip (opencalc's xlsx code) links wasm-bindgen on wasm32 (getrandom, time). This module has no
# JS glue; engine.ts supplies its four placeholder imports as stubs that throw if ever called.
cargo build -q --release -p oc-sheet --lib --target wasm32-unknown-unknown
target="${CARGO_TARGET_DIR:-target}"
out=web/packages/sheet/src/engine/oc_sheet.wasm
mkdir -p "$(dirname "$out")"
cp "$target/wasm32-unknown-unknown/release/oc_sheet.wasm" "$out"
if command -v wasm-opt >/dev/null; then wasm-opt -Oz --strip-debug "$out" -o "$out"; fi
echo "built $out ($(wc -c <"$out" | tr -d ' ') bytes, $(gzip -9 -c "$out" | wc -c | tr -d ' ') gzip)"
