#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# RLB-04: runs Rust tests N times and lists every test that failed at least once (a flake
# hunt; docs/13 "Flaky tests"). The tests are built once, then the binaries run N times.
#
#   scripts/repeat-tests.sh [N] [cargo test args...]
#   scripts/repeat-tests.sh 20 -p oc-server --test automation
#
# Exit 0 when every run passed, 1 otherwise. Runs at background CPU priority (nice) like CI.
set -uo pipefail
N=${1:-10}
shift || true
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
ARGS=("$@")
[ ${#ARGS[@]} -eq 0 ] && ARGS=(--workspace)
LOG=$(mktemp -d)
nice cargo test "${ARGS[@]}" --no-run >"$LOG/build.log" 2>&1 || { tail -20 "$LOG/build.log"; exit 2; }
fails=0
for i in $(seq 1 "$N"); do
  if ! nice cargo test "${ARGS[@]}" -- --quiet >"$LOG/run-$i.log" 2>&1; then
    fails=$((fails + 1))
    echo "run $i: FAILED"
    # The panic line and the message under it: the log directory is gone when CI ends.
    grep -E -A4 "^test .* FAILED$|panicked at" "$LOG/run-$i.log" | head -40
  fi
done
echo "repeat-tests: $fails of $N runs failed (logs in $LOG)"
[ "$fails" -eq 0 ]
