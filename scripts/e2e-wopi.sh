#!/usr/bin/env bash
# End-to-end check of WOPI-compatible mode (docs/05 §6) against the reference WOPI host
# (examples/wopi-host/server.mjs): discovery, launch with access_token, CheckFileInfo roles,
# edit over the WebSocket with the smoke client → autosave PutFile, Markdown files saved as
# Markdown, an asset inlined into the saved .ocanvas, a LastModifiedTime conflict (409 / 1010)
# resolved with PutRelativeFile, an allowlist refusal, and no access token in the server log.
#
#   scripts/e2e-wopi.sh                              # OpenCanvas :8380, WOPI host :4300
#   scripts/e2e-wopi.sh mariadb mysql://root:root@127.0.0.1:33061/opencanvas
#
# Ports: OC_PORT / HOST_PORT; any HOST_PORT other than 4300 gets a temporary hosts file whose
# wopi-sample allow-list points at it. Honours CARGO_TARGET_DIR.
# Only the processes this script starts are stopped (by PID); nothing else is killed.
set -u
LABEL=${1:-sqlite}; DB=${2:-}
OC_PORT=${OC_PORT:-8380}; HOST_PORT=${HOST_PORT:-4300}
OC=http://localhost:$OC_PORT; HOST=http://localhost:$HOST_PORT
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
TARGET=${CARGO_TARGET_DIR:-target}
BIN=$TARGET/release/opencanvas; SMOKE=$TARGET/release/examples/smoke
cargo build -q --release -p oc-server --bins --examples || exit 1
WORK=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT

for port in "$OC_PORT" "$HOST_PORT"; do
  if curl -s -o /dev/null "localhost:$port" 2>/dev/null; then
    echo "FAIL [wopi/$LABEL]: port $port is in use (set OC_PORT / HOST_PORT)"; exit 1
  fi
done

DBURL="${DB:-sqlite://$WORK/oc.db?mode=rwc}"
# Another HOST_PORT: the same registry with the wopi-sample allow-list moved to that port.
HOSTS_FILE=opencanvas.hosts.toml
if [ "$HOST_PORT" != 4300 ]; then
  HOSTS_FILE=$WORK/hosts.toml; sed "s#localhost:4300#localhost:$HOST_PORT#g" opencanvas.hosts.toml > "$HOSTS_FILE"
fi
PORT=$HOST_PORT OC_SERVER=$OC DATA_DIR=$WORK/host WOPI_HOST_TEST=1 \
  node examples/wopi-host/server.mjs > "$WORK/host.log" 2>&1 &
PIDS+=("$!")
env -u OC_DEV -u OC_CALLBACK_BASE_OVERRIDE DATABASE_URL="$DBURL" OC_KEK="$(openssl rand -base64 32)" \
  OC_HOSTS_FILE="$HOSTS_FILE" OC_BIND=127.0.0.1:$OC_PORT OC_PUBLIC_URL=$OC \
  OC_AUTOSAVE_DEBOUNCE_MS=1500 OC_LOG=debug "$BIN" > "$WORK/oc.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 60); do curl -sf "$OC/readyz" >/dev/null && curl -sf "$HOST/healthz" >/dev/null && break; sleep 0.5; done

fail() { echo "FAIL [wopi/$LABEL]: $*"; echo "--- oc.log"; tail -20 "$WORK/oc.log"; echo "--- host.log"; tail -20 "$WORK/host.log"; exit 1; }
api() { curl -s -H 'x-opencanvas-host: wopi-sample' -H 'x-opencanvas-key: dev-wopi-api-key-change-me' "$@"; }
field() { grep -o "name=\"$1\" value=\"[^\"]*\"" | sed 's/.*value="//;s/"$//'; }
curl -sf "$OC/readyz" >/dev/null || fail "server not ready"

# Discovery: ocanvas + md actions pointing at /v1/launch.
DISC=$(curl -s "$OC/hosting/discovery")
echo "$DISC" | grep -q "<action name=\"edit\" ext=\"ocanvas\" default=\"true\" urlsrc=\"$OC/v1/launch?\"" || fail "discovery: $DISC"
echo "$DISC" | grep -q '<action name="convert" ext="md" targetext="ocanvas"' || fail "discovery lacks md convert"

# Launch like the host page does: POST access_token + ttl to the form action from discovery.
launch() { # $1 file id, $2 user → prints the ticket
  local page action token ttl loc
  page=$(curl -s "$HOST/open/$1?as=$2")
  action=$(echo "$page" | grep -o 'action="[^"]*"' | sed 's/action="//;s/"$//;s/&amp;/\&/g')
  token=$(echo "$page" | field access_token); ttl=$(echo "$page" | field access_token_ttl)
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST --data-urlencode "access_token=$token" \
    --data-urlencode "access_token_ttl=$ttl" "$action")
  echo "${loc##*#t=}"
}
session() { curl -s "$OC/v1/sessions/$1"; }
js() { node -pe "const v=JSON.parse(require('fs').readFileSync(0)); $1"; }

TICKET=$(launch board_1 u_asha); [ -n "$TICKET" ] || fail "launch did not redirect"
S=$(session "$TICKET")
[ "$(echo "$S" | js 'v.role')" = edit ] || fail "Asha should edit: $S"
[ "$(echo "$S" | js 'v.file.name')" = "Team board.ocanvas" ] || fail "BaseFileName: $S"
ROOM=$(echo "$S" | js 'v.room')
VIEW=$(launch board_1 u_sam); [ "$(session "$VIEW" | js 'v.role')" = view ] || fail "Sam should view"
COMM=$(launch board_1 u_ravi); [ "$(session "$COMM" | js 'v.role')" = comment ] || fail "Ravi should comment"

# Edit → autosave PutFile.
"$SMOKE" "ws://localhost:$OC_PORT/v1/collab" "$ROOM" "$TICKET" "Hello over WOPI" > "$WORK/smoke.log" 2>&1 || fail "smoke client: $(tail -3 "$WORK/smoke.log")"
sleep 2
grep -q "saved board_1 .* by u_asha (autosave)" "$WORK/host.log" || fail "no autosave PutFile reached the WOPI host"
unzip -p "$WORK/host/files/board_1" document.json | grep -q "Hello over WOPI" || fail "host file lacks the edit"

# An asset: uploaded into the room, inlined into the file on the next save.
printf '\x89PNG\r\n\x1a\n0000IHDR' > "$WORK/dot.png"
UP=$(curl -s -F "file=@$WORK/dot.png;type=image/png" "$OC/v1/assets?ticket=$TICKET")
ASSET=$(echo "$UP" | js 'v.assetId'); [ -n "$ASSET" ] && [ "$ASSET" != undefined ] || fail "upload: $UP"
cmp -s "$WORK/dot.png" <(curl -s "$OC/v1/assets/$ASSET?ticket=$TICKET") || fail "asset not served back"
SRC_ENC=$(node -pe "encodeURIComponent('$HOST/wopi/files/board_1')")
PATCH=$(api -X POST "$OC/v1/files/$SRC_ENC/patch" -H 'content-type: application/json' \
  -d "{\"ops\":[{\"op\":\"append\",\"markdown\":\"![dot](/v1/assets/$ASSET)\"}],\"author\":{\"id\":\"bot\",\"name\":\"Bot\"}}")
echo "$PATCH" | grep -q '"live":true' || fail "patch: $PATCH"
COMMIT=$(api -X POST "$OC/v1/files/$SRC_ENC/commit")
echo "$COMMIT" | grep -q '"saved":true' || fail "commit: $COMMIT"
unzip -l "$WORK/host/files/board_1" | grep -q "assets/$ASSET" || fail "asset not inlined into the host file"

# Markdown files stay Markdown.
MDT=$(launch notes_1 u_priya); MDROOM=$(session "$MDT" | js 'v.room')
"$SMOKE" "ws://localhost:$OC_PORT/v1/collab" "$MDROOM" "$MDT" "Decision: ship it" > "$WORK/smoke2.log" 2>&1 || fail "smoke (md): $(tail -3 "$WORK/smoke2.log")"
sleep 2
grep -q "Decision: ship it" "$WORK/host/files/notes_1" || fail "markdown file not saved as markdown"
grep -q "# Meeting notes" "$WORK/host/files/notes_1" || fail "markdown file lost its content"

# Conflict: an out-of-band save on the host, then our next save gets 409 / 1010 → PUT_RELATIVE.
curl -s -X POST "$HOST/__test/files/board_1/bump" >/dev/null
PATCH=$(api -X POST "$OC/v1/files/$SRC_ENC/patch" -H 'content-type: application/json' \
  -d '{"ops":[{"op":"append","markdown":"After the bump"}],"author":{"id":"bot","name":"Bot"}}')
CODE=$(api -o /dev/null -w '%{http_code}' -X POST "$OC/v1/files/$SRC_ENC/commit")
[ "$CODE" = 409 ] || fail "commit after an out-of-band save answered $CODE, wanted 409"
for _ in $(seq 1 20); do grep -q "copied board_1 -> board_1_copy" "$WORK/host.log" && break; sleep 0.25; done
grep -q 'copied board_1 -> board_1_copy "Team board (conflict copy).ocanvas"' "$WORK/host.log" || fail "no PutRelativeFile conflict copy"
unzip -p "$WORK/host/files/board_1_copy" document.json | grep -q "After the bump" || fail "conflict copy lacks the edit"

# The allowlist refuses other origins (nothing is called).
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-urlencode "access_token=x" \
  "$OC/v1/launch?WOPISrc=$(node -pe "encodeURIComponent('http://localhost:$HOST_PORT@evil.example/wopi/files/board_1')")")
[ "$CODE" = 403 ] || fail "foreign WOPISrc answered $CODE"

if [ -z "$DB" ]; then
  RAW=$(sqlite3 "$WORK/oc.db" "SELECT grant_json FROM sessions LIMIT 1" 2>/dev/null)
  echo "$RAW" | grep -q '"callback_token":"enc:v1:' || fail "access token not sealed: ${RAW:-no session row}"
fi
cleanup; PIDS=()
grep -q "u_asha\.[0-9]*\." "$WORK/oc.log" && fail "an access token appears in the server log"
grep -q "access_token" "$WORK/oc.log" && fail "access_token appears in the server log"
grep -qiE 'panic' "$WORK/oc.log" && fail "server panicked"
echo "PASS [wopi/$LABEL]: $(grep -c '^saved ' "$WORK/host.log") PutFiles, roles edit/comment/view, asset inlined, md kept as md, 1010 → PutRelativeFile copy, allowlist refuses, no token in logs"
rm -rf "$WORK"
