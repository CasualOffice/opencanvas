#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# Real-host check of the conflict copy: a canvas saved in Nextcloud, the file changed outside
# the canvas (WebDAV PUT), the next save answers 409 and OpenCanvas writes
# "<name> (conflict copy).ocanvas" next to it through PUT_RELATIVE. Same setup as
# nextcloud.e2e.mjs (README.md "Verified").
#
#   NC=http://localhost:8090 OC=http://localhost:8480 NC_PASS_ALICE=… NC_OC_API_KEY=… tests/browser/conflict-copy.sh
set -u
NC=${NC:-http://localhost:8090}; OC=${OC:-http://localhost:8480}; HOST_ID=${HOST_ID:-nextcloud}
U=alice:${NC_PASS_ALICE:?}; K=${NC_OC_API_KEY:?}
fail() { echo "FAIL: $*"; exit 1; }
jget() { php -r '$v=json_decode(stream_get_contents(STDIN),true); echo $v[$argv[1]];' "$1"; }
NAME_IN="Conflict $(date +%s)"
C=$(curl -s -u "$U" -H 'OCS-APIREQUEST: true' -X POST -H 'content-type: application/json' \
  -d "{\"dir\":\"/\",\"name\":\"$NAME_IN\",\"kind\":\"database\"}" "$NC/index.php/apps/opencanvas/api/v1/create")
ID=$(echo "$C" | jget fileId); NAME=$(echo "$C" | jget name); [ -n "$ID" ] || fail "create: $C"
L=$(curl -s -u "$U" -H 'OCS-APIREQUEST: true' -X POST "$NC/index.php/apps/opencanvas/api/v1/token/$ID")
TOK=$(echo "$L" | jget access_token)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-urlencode "access_token=$TOK" \
  --data-urlencode "access_token_ttl=$(echo "$L" | jget access_token_ttl)" "$(echo "$L" | jget action)")
[ "$CODE" = 303 ] || fail "launch answered $CODE"
SRC=$(php -r 'echo rawurlencode($argv[1]);' "$NC/index.php/apps/opencanvas/wopi/files/$ID")
# With no live room, the host API loads and saves with the token given here (docs/05 §7).
api() { curl -s -H "x-opencanvas-host: $HOST_ID" -H "x-opencanvas-key: $K" -H "x-opencanvas-callback-token: $TOK" "$@"; }
patch() { api -X POST "$OC/v1/files/$SRC/patch" -H 'content-type: application/json' \
  -d "{\"ops\":[{\"op\":\"append\",\"markdown\":\"$1\"}],\"author\":{\"id\":\"bot\",\"name\":\"Bot\"}}"; }
P=$(patch "First edit"); echo "$P" | grep -q "\"applied\":1" || fail "first patch: $P"
api -X POST "$OC/v1/files/$SRC/commit" >/dev/null
sleep 2
ENC=$(php -r 'echo rawurlencode($argv[1]);' "$NAME")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -u "$U" --data-binary 'changed outside' -X PUT "$NC/remote.php/dav/files/alice/$ENC")
[ "$CODE" = 204 ] || fail "outside change answered $CODE"
patch "Edit after the outside change" >/dev/null
CODE=$(api -o /dev/null -w '%{http_code}' -X POST "$OC/v1/files/$SRC/commit")
[ "$CODE" = 409 ] || fail "commit after the outside change answered $CODE, wanted 409"
COPY=$(php -r 'echo rawurlencode($argv[1]);' "${NAME%.ocanvas} (conflict copy).ocanvas")
for _ in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -u "$U" "$NC/remote.php/dav/files/alice/$COPY")" = 200 ] && break; sleep 0.5
done
[ "$(curl -s -o /dev/null -w '%{http_code}' -u "$U" "$NC/remote.php/dav/files/alice/$COPY")" = 200 ] || fail "no conflict copy in Nextcloud"
curl -s -u "$U" "$NC/remote.php/dav/files/alice/$COPY" -o "${TMPDIR:-/tmp}/oc-copy.$$"
unzip -p "${TMPDIR:-/tmp}/oc-copy.$$" document.json | grep -q "Edit after the outside change" || fail "the copy lacks the edit"
rm -f "${TMPDIR:-/tmp}/oc-copy.$$"
echo "ok - 409 then PUT_RELATIVE: \"${NAME%.ocanvas} (conflict copy).ocanvas\" created in Nextcloud with the edit"
echo PASS
