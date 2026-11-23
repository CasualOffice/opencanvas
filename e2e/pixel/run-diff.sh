#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# SCALE-01 pixel diff: baseline from an old editor build, then the current build against it.
#
#   e2e/pixel/run-diff.sh <dist-before> <snaps-dir> [runs] [projects...]
#
# dist-before: a copy of web/packages/editor/dist built from the old commit.
# Default projects: desktop-light phone-light. Each comparison run must report 0 failures.
set -euo pipefail
cd "$(dirname "$0")/.."
before="$1"; snaps="$2"; runs="${3:-3}"; shift $(( $# < 3 ? $# : 3 ))
projects=("${@:-desktop-light phone-light}")
args=()
for p in ${projects[@]}; do args+=(--project "$p"); done
PIXEL_DIST="$before" PIXEL_SNAPS="$snaps" npx playwright test -c pixel/pixel.config.ts "${args[@]}" --update-snapshots | tail -1
for i in $(seq 1 "$runs"); do
  echo "== compare run $i"
  PIXEL_DIST=../web/packages/editor/dist PIXEL_SNAPS="$snaps" npx playwright test -c pixel/pixel.config.ts "${args[@]}" --output "$snaps/../pixel-run-$i" | grep -E '✘|pixels \(ratio|passed|failed' | grep -v '^ *-' || true
done
