#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# OPS-01 quick-start load: OpenCanvas (built from this checkout) on :8791 with SQLite, two
# clients editing one room through crates/oc-bench (its mock host on :8792 takes the saves),
# a host `broken` whose saves answer 500 (:8793), exports and refused launches
# (demo-load.py). Run deploy/monitoring/docker-compose.yml next to it and watch Grafana.
#
#   cargo build -p oc-server -p oc-bench
#   deploy/monitoring/demo-load.sh [seconds, default 600]
#
# LINUX_BIN=<path to a Linux opencanvas binary> runs the server in a Docker container
# (rust:1.98-slim-bookworm, port 8791) instead, so the Linux-only process_* metrics are
# exported; callbacks then reach the mock hosts through host.docker.internal.
#
# Stops everything it started on exit. Logs in $WORK (printed).
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SECS=${1:-600}
TARGET=${CARGO_TARGET_DIR:-$ROOT/target}
BIN=${BIN:-$TARGET/debug/opencanvas}
LG=${LG:-$TARGET/debug/oc-bench}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/oc-monitoring.XXXXXX")
SECRET=demo-secret-0123456789abcdef0123456789
PIDS=()
LINUX_BIN=${LINUX_BIN:-}
CB=127.0.0.1; [ -n "$LINUX_BIN" ] && CB=host.docker.internal
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  [ -n "$LINUX_BIN" ] && docker rm -f oc-monitoring-server > /dev/null 2>&1
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

cat > "$WORK/hosts.toml" <<EOF
[[host]]
id            = "bench"
name          = "Bench host"
mode          = "jwt"
jwt_alg       = "HS256"
jwt_secret    = "$SECRET"
api_key       = "bench-api-key"
callback_base = "http://$CB:8792/api"
[host.flags]
export_formats = ["md", "docx", "pdf"]

[[host]]
id            = "broken"
name          = "Host whose callbacks fail"
mode          = "jwt"
jwt_alg       = "HS256"
jwt_secret    = "$SECRET"
api_key       = "broken-key"
callback_base = "http://$CB:8793/api"
EOF

# The broken host: files are missing (404, the room starts empty), every save answers 500.
python3 - > "$WORK/broken-host.log" 2>&1 <<'EOF' &
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def _answer(self, code):
        self.send_response(code); self.send_header("content-length", "0"); self.end_headers()
    def do_GET(self): self._answer(404)
    def do_PUT(self): self._answer(500)
    def do_POST(self): self._answer(500)
http.server.ThreadingHTTPServer(("127.0.0.1", 8793), H).serve_forever()
EOF
PIDS+=($!)

if [ -n "$LINUX_BIN" ]; then
  docker run --rm --name oc-monitoring-server -p 127.0.0.1:8791:8791 \
    --add-host host.docker.internal:host-gateway -v "$WORK":/work -v "$LINUX_BIN":/opencanvas:ro \
    -e DATABASE_URL="sqlite:///work/oc.db?mode=rwc" -e OC_KEK="$(openssl rand -base64 32)" \
    -e OC_HOSTS_FILE=/work/hosts.toml -e OC_BIND=0.0.0.0:8791 -e OC_PUBLIC_URL=http://127.0.0.1:8791 \
    -e OC_LOG=info rust:1.98-slim-bookworm /opencanvas > "$WORK/server.log" 2>&1 &
else
  env -u OC_DEV DATABASE_URL="sqlite://$WORK/oc.db?mode=rwc" OC_KEK="$(openssl rand -base64 32)" \
    OC_HOSTS_FILE="$WORK/hosts.toml" OC_BIND=127.0.0.1:8791 OC_PUBLIC_URL=http://127.0.0.1:8791 \
    OC_LOG=info "$BIN" > "$WORK/server.log" 2>&1 &
fi
SERVER=$!; PIDS+=("$SERVER")
for _ in $(seq 1 150); do curl -sf http://127.0.0.1:8791/readyz > /dev/null && break; sleep 0.2; done
curl -sf http://127.0.0.1:8791/readyz > /dev/null || { echo "server not ready"; tail -20 "$WORK/server.log"; exit 1; }
echo "OpenCanvas pid $SERVER on :8791; logs in $WORK"

# Two editors in one room, typing with pauses, autosaving to the mock host on :8792.
"$LG" run --label demo --run-id demo --doc demo --server http://127.0.0.1:8791 --server-pid "$SERVER" \
  --host-port 8792 --secret "$SECRET" --rooms 1 --per-room 2 --editors 1 --steps 2 \
  --step-secs "$SECS" --out "$WORK/bench.json" > "$WORK/bench.log" 2>&1 &
PIDS+=($!)
# Two editors on host `broken`: its files load empty (404) and every save gets a 500, so the
# saves stay in the outbox and are retried (its own mock host on :8794 is not used).
"$LG" run --label broken --run-id broken --doc empty --host-id broken --server http://127.0.0.1:8791 \
  --server-pid "$SERVER" --host-port 8794 --secret "$SECRET" --rooms 1 --per-room 2 --editors 1 \
  --steps 2 --step-secs "$SECS" --out "$WORK/broken.json" > "$WORK/broken.log" 2>&1 &
PIDS+=($!)
sleep 5
python3 "$ROOT/deploy/monitoring/demo-load.py" --server http://127.0.0.1:8791 --secret "$SECRET" \
  --bench-file demo_demo_0 --secs "$SECS"
