#!/usr/bin/env bash
# End-to-end check against one database: launch through the sample host, edit over
# the WebSocket with the smoke client, and confirm the autosave reached the host.
# Also checks: the server refuses to start without OC_KEK, callback tokens are stored
# encrypted, the commit outbox row is marked done, the host role API answers, and the
# patch / commit / convert API works (incl. a DOCX that unzips).
#
#   scripts/e2e-db.sh sqlite
#   scripts/e2e-db.sh mariadb mysql://root:root@127.0.0.1:33061/opencanvas
#   OC_PORT=8180 HOST_PORT=4100 scripts/e2e-db.sh sqlite      # other ports
#
# Only the processes this script starts are stopped (by PID); nothing else is killed.
set -u
LABEL=$1; DB=${2:-}
OC_PORT=${OC_PORT:-8080}; HOST_PORT=${HOST_PORT:-4000}; NOKEK_PORT=${NOKEK_PORT:-$((OC_PORT + 1))}
OC=http://localhost:$OC_PORT; HOST=http://localhost:$HOST_PORT
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
BIN=target/release/opencanvas; SMOKE=target/release/examples/smoke
cargo build -q --release -p oc-server --bins --examples || exit 1
WORK=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT

for port in "$OC_PORT" "$HOST_PORT" "$NOKEK_PORT"; do
  if curl -s -o /dev/null "localhost:$port" 2>/dev/null; then
    echo "FAIL [$LABEL]: port $port is in use (set OC_PORT / HOST_PORT)"; exit 1
  fi
done

DBURL="${DB:-sqlite://$WORK/oc.db?mode=rwc}"
env -u OC_KEK -u OC_DEV DATABASE_URL="$DBURL" OC_HOSTS_FILE=opencanvas.hosts.toml OC_BIND=127.0.0.1:$NOKEK_PORT \
  "$BIN" > "$WORK/nokek.log" 2>&1 &
NOKEK=$!; PIDS+=("$NOKEK"); sleep 2
if kill -0 "$NOKEK" 2>/dev/null; then echo "FAIL [$LABEL]: server started without OC_KEK"; exit 1; fi
grep -q "OC_KEK is required" "$WORK/nokek.log" || { echo "FAIL [$LABEL]: no OC_KEK error"; cat "$WORK/nokek.log"; exit 1; }

PORT=$HOST_PORT OC_SERVER=$OC DATA_DIR=$WORK/host node examples/sample-host/server.mjs > "$WORK/host.log" 2>&1 &
PIDS+=("$!")
env -u OC_DEV DATABASE_URL="$DBURL" OC_KEK="$(openssl rand -base64 32)" \
  OC_HOSTS_FILE=opencanvas.hosts.toml OC_BIND=127.0.0.1:$OC_PORT OC_PUBLIC_URL=$OC \
  OC_CALLBACK_BASE_OVERRIDE=$HOST/api/opencanvas \
  OC_AUTOSAVE_DEBOUNCE_MS=500 "$BIN" > "$WORK/oc.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 60); do curl -sf "$OC/readyz" >/dev/null && curl -sf "$HOST/healthz" >/dev/null && break; sleep 0.5; done

fail() { echo "FAIL [$LABEL]: $*"; sed -n '1,40p' "$WORK/oc.log"; exit 1; }
api() { curl -s -H 'x-opencanvas-host: sample' -H 'x-opencanvas-key: dev-api-key-change-me' "$@"; }
curl -sf "$OC/readyz" >/dev/null || fail "server not ready"
TOKEN=$(curl -s "$HOST/files/doc_welcome?as=u_asha" | grep -o 'name="token" value="[^"]*"' | sed 's/.*value="//;s/"$//')
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST --data-urlencode "token=$TOKEN" "$OC/v1/launch")
TICKET=${LOC##*#t=}; [ -n "$TICKET" ] || fail "launch did not redirect"
ROOM=$(curl -s "$OC/v1/sessions/$TICKET" | node -pe 'JSON.parse(require("fs").readFileSync(0)).room')
"$SMOKE" "ws://localhost:$OC_PORT/v1/collab" "$ROOM" "$TICKET" "Hello from $LABEL" > "$WORK/smoke.log" 2>&1 || fail "smoke client: $(tail -3 "$WORK/smoke.log")"
sleep 1
grep -q "saved doc_welcome" "$WORK/host.log" || fail "no autosave reached the host"
curl -s "$OC/v1/export/md?ticket=$TICKET" | grep -q "Hello from $LABEL" || fail "export missing the edit"
ROLE=$(api -o /dev/null -w '%{http_code}' -X POST "$OC/v1/files/doc_welcome/role" \
  -H 'content-type: application/json' -d '{"userId":"u_sam","role":"view"}')
[ "$ROLE" = 200 ] || fail "role API answered $ROLE"
BADKEY=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OC/v1/files/doc_welcome/role" \
  -H 'content-type: application/json' -H 'x-opencanvas-host: sample' -H 'x-opencanvas-key: wrong' -d '{"userId":"u_sam","role":"edit"}')
[ "$BADKEY" = 401 ] || fail "role API accepted a wrong key ($BADKEY)"

# Patch the live room as a bot, force a save, and read it back from the host's file.
PATCH=$(api -X POST "$OC/v1/files/doc_welcome/patch" -H 'content-type: application/json' \
  -d "{\"ops\":[{\"op\":\"append\",\"markdown\":\"- [ ] Bot task $LABEL\"}],\"author\":{\"id\":\"bot-1\",\"name\":\"Bot\"}}")
echo "$PATCH" | grep -q '"live":true' || fail "patch: $PATCH"
COMMIT=$(api -X POST "$OC/v1/files/doc_welcome/commit")
echo "$COMMIT" | grep -q '"version":"[0-9]*"' || fail "commit: $COMMIT"
curl -s "$OC/v1/export/md?ticket=$TICKET" | grep -q "\- \[ \] Bot task $LABEL" || fail "patched block missing from export"
printf '# Converted\n\nSome **bold** text\n' | api -X POST --data-binary @- "$OC/v1/convert?from=md&to=docx" -o "$WORK/out.docx"
unzip -p "$WORK/out.docx" word/document.xml | grep -q "Converted" || fail "convert to docx did not produce a readable document"

if [ -z "$DB" ]; then
  RAW=$(sqlite3 "$WORK/oc.db" "SELECT grant_json FROM sessions LIMIT 1" 2>/dev/null)
  echo "$RAW" | grep -q '"callback_token":"enc:v1:' || fail "callback token not sealed: ${RAW:-no session row}"
  OUT=$(sqlite3 "$WORK/oc.db" "SELECT count(*) FROM commit_outbox WHERE status = 'done'"),$(sqlite3 "$WORK/oc.db" "SELECT count(*) FROM commit_outbox WHERE status <> 'done'")
  case "$OUT" in [1-9]*,0) ;; *) fail "outbox rows (done,other) = $OUT";; esac
fi
cleanup; PIDS=()
grep -qiE 'panic' "$WORK/oc.log" && fail "server panicked"
echo "PASS [$LABEL]: $(grep -c 'saved doc_welcome' "$WORK/host.log") saves reached the host, export contains the edit and the bot's patch, DOCX converts"
