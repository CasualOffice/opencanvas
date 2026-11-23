#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# Points a real OpenCanvas server (WOPI mode, proof keys on) at tests/e2e/harness.php, which
# runs the app's token, proof, permission, conflict and starter-file code under `php -S`.
# Not a Nextcloud test: the Nextcloud glue (controllers, OCP calls) is not exercised here.
#
#   OC_BIN=/path/to/opencanvas integrations/nextcloud/opencanvas/tests/e2e/run.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OC_BIN=${OC_BIN:?set OC_BIN to an opencanvas binary}
OC_PORT=${OC_PORT:-8480}; HP=${HARNESS_PORT:-4400}
OC=http://localhost:$OC_PORT; SELF=http://localhost:$HP
WORK=$(mktemp -d); mkdir -p "$WORK/files"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; echo "--- harness.log"; tail -20 "$WORK/harness.log" 2>/dev/null; echo "--- oc.log"; tail -20 "$WORK/oc.log"; exit 1; }
pass() { echo "ok - $*"; }

echo '{"alice":31,"bob":1}' > "$WORK/acl.json"
cat > "$WORK/hosts.toml" <<EOF
[[host]]
id = "nextcloud-test"
name = "Nextcloud"
mode = "wopi"
wopi_allowlist = ["$SELF/wopi"]
allowed_origins = ["$SELF"]
api_key = "env:NC_TEST_API_KEY"
[host.flags]
on_conflict = "copy"
EOF
openssl genrsa -out "$WORK/proof.pem" 2048 2>/dev/null
HARNESS_DIR=$WORK HARNESS_SELF=$SELF HARNESS_OC=$OC php -S "127.0.0.1:$HP" "$HERE/harness.php" > "$WORK/php.log" 2>&1 &
PIDS+=("$!")
API_KEY=$(openssl rand -hex 24)
env -u OC_DEV NC_TEST_API_KEY="$API_KEY" DATABASE_URL="sqlite://$WORK/oc.db?mode=rwc" OC_KEK="$(openssl rand -base64 32)" \
  OC_WOPI_PROOF_KEY="$WORK/proof.pem" OC_HOSTS_FILE="$WORK/hosts.toml" OC_BIND=127.0.0.1:$OC_PORT \
  OC_PUBLIC_URL=$OC OC_AUTOSAVE_DEBOUNCE_MS=1000 "$OC_BIN" > "$WORK/oc.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 60); do curl -sf "$OC/readyz" >/dev/null && break; sleep 0.5; done
curl -sf "$OC/readyz" >/dev/null || fail "OpenCanvas did not start"

api() { curl -s -H 'x-opencanvas-host: nextcloud-test' -H "x-opencanvas-key: $API_KEY" "$@"; }
jf() { php -r '$v=json_decode(stream_get_contents(STDIN),true); $k=explode(".",$argv[1]); foreach($k as $p){$v=$v[$p]??null;} echo is_bool($v)?($v?"true":"false"):(string)$v;' "$1"; }
launch() { # $1 file id, $2 user -> ticket
  local m tok ttl loc
  m=$(curl -s "$SELF/__test/mint/$1/$2"); tok=$(echo "$m" | jf token); ttl=$(echo "$m" | jf ttl)
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST --data-urlencode "access_token=$tok" \
    --data-urlencode "access_token_ttl=$ttl" "$OC/v1/launch?WOPISrc=$(php -r 'echo rawurlencode($argv[1]);' "$SELF/wopi/files/$1")")
  echo "${loc##*#t=}"
}
enc() { php -r 'echo rawurlencode($argv[1]);' "$SELF/wopi/files/$1"; }

# 1. Blank file: an empty body opens as a new canvas; owner edits, read-only share views.
: > "$WORK/files/1"; echo -n "Team plan.ocanvas" > "$WORK/files/1.name"
T=$(launch 1 alice); [ -n "$T" ] && [ "$T" != "$OC/" ] || fail "launch (alice) did not redirect"
S=$(curl -s "$OC/v1/sessions/$T")
[ "$(echo "$S" | jf role)" = edit ] || fail "alice should edit: $S"
[ "$(echo "$S" | jf file.name)" = "Team plan.ocanvas" ] || fail "BaseFileName: $S"
pass "launch with a proof-checked CheckFileInfo; UPDATE permission -> edit"
B=$(launch 1 bob); [ "$(curl -s "$OC/v1/sessions/$B" | jf role)" = view ] || fail "bob should view"
pass "read-only permission -> view"
grep -q "proof rejected" "$WORK/harness.log" && fail "a real OpenCanvas call was refused"
pass "every OpenCanvas call carried a proof the PHP verifier accepted"

# 2. Save: patch + commit -> PutFile.
P=$(api -X POST "$OC/v1/files/$(enc 1)/patch" -H 'content-type: application/json' \
  -d '{"ops":[{"op":"append","markdown":"Hello from the Nextcloud harness"}],"author":{"id":"bot","name":"Bot"}}')
echo "$P" | grep -q '"live":true' || fail "patch: $P"
C=$(api -X POST "$OC/v1/files/$(enc 1)/commit") # saved:false when the autosave got there first
grep -q "saved 1 by alice" "$WORK/harness.log" || fail "not saved: $C"
unzip -p "$WORK/files/1" document.json | grep -q "Hello from the Nextcloud harness" || fail "saved file lacks the edit"
pass "PutFile wrote the .ocanvas (X-COOL-WOPI-Timestamp matched)"

# 3. Conflict: file changed outside the session -> 409 -> PUT_RELATIVE conflict copy.
touch -t 203001010000 "$WORK/files/1"
api -X POST "$OC/v1/files/$(enc 1)/patch" -H 'content-type: application/json' \
  -d '{"ops":[{"op":"append","markdown":"After the outside change"}],"author":{"id":"bot","name":"Bot"}}' >/dev/null
CODE=$(api -o /dev/null -w '%{http_code}' -X POST "$OC/v1/files/$(enc 1)/commit")
[ "$CODE" = 409 ] || fail "commit after an outside change answered $CODE, wanted 409"
for _ in $(seq 1 20); do grep -q "copied 1 -> 1001" "$WORK/harness.log" && break; sleep 0.25; done
grep -q 'copied 1 -> 1001 "Team plan (conflict copy).ocanvas"' "$WORK/harness.log" || fail "no PUT_RELATIVE conflict copy"
unzip -p "$WORK/files/1001" document.json | grep -q "After the outside change" || fail "conflict copy lacks the edit"
pass "409 COOLStatusCode 1010 -> PUT_RELATIVE copy with the UTF-7 name decoded"

# 4. Starter files load in OpenCanvas.
for kind in database whiteboard; do
  id=$([ $kind = database ] && echo 2 || echo 3)
  curl -s -o /dev/null "$SELF/__test/create/$id/$kind"
  T=$(launch $id alice); [ "$(curl -s "$OC/v1/sessions/$T" | jf role)" = edit ] || fail "$kind starter did not open"
  api -X POST "$OC/v1/files/$(enc $id)/patch" -H 'content-type: application/json' \
    -d '{"ops":[{"op":"append","markdown":"note"}],"author":{"id":"bot","name":"Bot"}}' >/dev/null
  C=$(api -X POST "$OC/v1/files/$(enc $id)/commit") # saved:false when the autosave got there first
  grep -q "saved $id by alice" "$WORK/harness.log" || fail "$kind not saved: $C"
  block=$([ $kind = database ] && echo '"type":"database"' || echo '"type":"board"')
  unzip -p "$WORK/files/$id" document.json | grep -q "$block" || fail "$kind block lost after a round trip"
  pass "$kind starter opens, saves and keeps its block"
done

# 5. A forged call without a proof is refused by the harness.
TOK=$(curl -s "$SELF/__test/mint/1/alice" | jf token)
[ "$(curl -s -o /dev/null -w '%{http_code}' "$SELF/wopi/files/1?access_token=$TOK")" = 500 ] || fail "call without proof accepted"
pass "call without a proof -> 500"
echo "PASS"
