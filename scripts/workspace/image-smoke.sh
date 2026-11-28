#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# OpenCanvas Workspace image check (WS-21, owner decision 3 "lightweight"): builds the image,
# records its size (uncompressed and gzip-compressed, the pull size), starts it on an empty
# volume, measures the time until the setup page answers and the memory at rest, and writes a
# result JSON for bench/results. Fails when the setup page never answers or a budget is broken.
#
#   scripts/workspace/image-smoke.sh [out.json]
#   IMAGE=ghcr.io/casualoffice/opencanvas-workspace:test SKIP_BUILD=1 scripts/workspace/image-smoke.sh
#
# Budgets (docs/40 §6.1): compressed image <= 250 MB, ready <= 10 s, idle memory <= 150 MB.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=${IMAGE:-opencanvas-workspace:smoke}
OUT=${1:-bench/results/$(date -u +%F)-workspace-image-${BENCH_MACHINE:-local}.json}
NAME=ws-smoke-$$
PORT=${PORT:-18080}
MAX_COMPRESSED_MB=${MAX_COMPRESSED_MB:-250}
MAX_READY_MS=${MAX_READY_MS:-10000}
MAX_IDLE_MB=${MAX_IDLE_MB:-150}

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  docker build -f deploy/workspace/Dockerfile -t "$IMAGE" .
fi
bytes=$(docker image inspect "$IMAGE" --format '{{.Size}}')
compressed=$(docker save "$IMAGE" | gzip -6 | wc -c | tr -d ' ')

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
start=$(date +%s%3N)
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "$NAME:/data" "$IMAGE" >/dev/null
ready=""
for _ in $(seq 1 600); do
  if curl -fsS "http://127.0.0.1:$PORT/api/ws/setup" 2>/dev/null | grep -q '"needsSetup":true'; then
    ready=$(( $(date +%s%3N) - start )); break
  fi
  sleep 0.05
done
if [ -z "$ready" ]; then
  echo "image-smoke: the setup page never answered"; docker logs "$NAME" | tail -50; exit 1
fi
# The page itself (the web app) and the engine's health behind the same port.
curl -fsS "http://127.0.0.1:$PORT/ws/" | grep -q "<div id=\"root\">"
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null
# The setup code is in the log (docs/40 §4.1).
docker logs "$NAME" 2>&1 | grep -q setup_code
# Memory at rest: 30 s after start, nothing open.
sleep 30
mem=$(docker stats --no-stream --format '{{.MemUsage}}' "$NAME" | awk '{print $1}')
idle_mb=$(python3 -c "import re,sys; v=sys.argv[1]; n=float(re.match(r'[\d.]+',v).group()); u=v[len(re.match(r'[\d.]+',v).group()):]; print(round(n*{'B':1/2**20,'KiB':1/1024,'MiB':1,'GiB':1024}.get(u,1),1))" "$mem")

mb() { python3 -c "print(round($1/1e6,1))"; }
pass=true
[ "$(python3 -c "print(int($compressed/1e6 <= $MAX_COMPRESSED_MB))")" = 1 ] || pass=false
[ "$ready" -le "$MAX_READY_MS" ] || pass=false
[ "$(python3 -c "print(int($idle_mb <= $MAX_IDLE_MB))")" = 1 ] || pass=false

mkdir -p "$(dirname "$OUT")"
python3 - "$OUT" <<EOF
import json, os, platform, subprocess, sys
json.dump({
  "scenario": "WS-IMAGE",
  "date": "$(date -u +%F)",
  "commit": subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip(),
  "machine": os.environ.get("BENCH_MACHINE", "local"),
  "hardware": {"cpu": platform.processor() or platform.machine(), "kernel": platform.platform(), "vcpu": os.cpu_count()},
  "store": "sqlite (empty volume)",
  "load": "none: a fresh container on an empty volume, nothing open",
  "image": {"bytes": $bytes, "compressedBytes": $compressed, "uncompressedMb": $(mb "$bytes"), "compressedMb": $(mb "$compressed")},
  "startToSetupMs": $ready,
  "idleMemoryMb": $idle_mb,
  "budgets": {"compressedMb": $MAX_COMPRESSED_MB, "readyMs": $MAX_READY_MS, "idleMb": $MAX_IDLE_MB},
  "passed": $( $pass && echo True || echo False ),
}, open(sys.argv[1], "w"), indent=2)
EOF
echo "image-smoke: $(mb "$compressed") MB compressed ($(mb "$bytes") MB), setup page in ${ready} ms, ${idle_mb} MB at rest -> $OUT"
$pass || { echo "image-smoke: over budget"; exit 1; }
