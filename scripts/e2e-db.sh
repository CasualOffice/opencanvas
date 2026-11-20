#!/usr/bin/env bash
# End-to-end check against one database: launch through the sample host, edit over
# the WebSocket with the smoke client, and confirm the autosave reached the host.
#
#   scripts/e2e-db.sh sqlite
#   scripts/e2e-db.sh mariadb mysql://root:root@127.0.0.1:33061/opencanvas
set -u
LABEL=$1; DB=${2:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
BIN=target/release/opencanvas; SMOKE=target/release/examples/smoke
[ -x "$BIN" ] && [ -x "$SMOKE" ] || cargo build -q --release -p oc-server --bins --examples
WORK=$(mktemp -d)
pkill -f "$BIN" 2>/dev/null; pkill -f "sample-host/server.mjs" 2>/dev/null; sleep 0.5

DATA_DIR=$WORK/host node examples/sample-host/server.mjs > "$WORK/host.log" 2>&1 &
env ${DB:+DATABASE_URL=$DB} DATABASE_URL="${DB:-sqlite://$WORK/oc.db?mode=rwc}" \
  OC_HOSTS_FILE=opencanvas.hosts.toml OC_BIND=127.0.0.1:8080 OC_PUBLIC_URL=http://localhost:8080 \
  OC_AUTOSAVE_DEBOUNCE_MS=500 "$BIN" > "$WORK/oc.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf localhost:8080/readyz >/dev/null && curl -sf localhost:4000/healthz >/dev/null && break; sleep 0.5; done

fail() { echo "FAIL [$LABEL]: $*"; sed -n '1,40p' "$WORK/oc.log"; pkill -f "$BIN"; pkill -f sample-host/server.mjs; exit 1; }
curl -sf localhost:8080/readyz >/dev/null || fail "server not ready"
TOKEN=$(curl -s 'localhost:4000/files/doc_welcome?as=u_asha' | grep -o 'name="token" value="[^"]*"' | sed 's/.*value="//;s/"$//')
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST --data-urlencode "token=$TOKEN" localhost:8080/v1/launch)
TICKET=${LOC##*#t=}; [ -n "$TICKET" ] || fail "launch did not redirect"
ROOM=$(curl -s "localhost:8080/v1/sessions/$TICKET" | node -pe 'JSON.parse(require("fs").readFileSync(0)).room')
"$SMOKE" ws://localhost:8080/v1/collab "$ROOM" "$TICKET" "Hello from $LABEL" > "$WORK/smoke.log" 2>&1 || fail "smoke client: $(tail -3 "$WORK/smoke.log")"
sleep 1
grep -q "saved doc_welcome" "$WORK/host.log" || fail "no autosave reached the host"
curl -s "localhost:8080/v1/export/md?ticket=$TICKET" | grep -q "Hello from $LABEL" || fail "export missing the edit"
pkill -f "$BIN"; sleep 1; pkill -f sample-host/server.mjs
grep -qiE 'panic' "$WORK/oc.log" && fail "server panicked"
echo "PASS [$LABEL]: $(grep -c 'saved doc_welcome' "$WORK/host.log") saves reached the host, export contains the edit"
