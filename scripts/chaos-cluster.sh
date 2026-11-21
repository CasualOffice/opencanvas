#!/usr/bin/env bash
# Chaos test for cluster mode (CLU-02, ADR-006):
#   1. bring up docker-compose.cluster.yml (3 nodes, MariaDB, Redis, nginx, sample host)
#   2. connect two clients to the same room through nginx and type
#   3. `docker kill` the node that owns the room (read from its Redis lease)
#   4. assert both clients reconnect (≤ 5 s), converge, and that the host's saved file holds
#      every acknowledged edit
#   5. tear everything down (containers, volumes, network)
#
#   scripts/chaos-cluster.sh                 # TYPE_SECS=20 KILL_AFTER=7 by default
#   KEEP=1 scripts/chaos-cluster.sh          # leave the stack up for inspection
#   PREOPEN=oc1 scripts/chaos-cluster.sh     # node that opens the room first (default oc2)
#
# Ports: nginx 8580, sample host 4580. Only this compose project is touched.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
PROJECT=${PROJECT:-occhaos}
TYPE_SECS=${TYPE_SECS:-20}; KILL_AFTER=${KILL_AFTER:-7}
OC=http://localhost:8580; HOST=http://localhost:4580
DC=(docker compose -p "$PROJECT" -f docker-compose.cluster.yml)
WORK=$(mktemp -d)
CHAOS=target/release/examples/chaos
PIDS=()

cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  if [ -z "${KEEP:-}" ]; then
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
    echo "cluster removed"
  fi
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*"
  "${DC[@]}" logs --no-color --tail 40 oc1 oc2 oc3 2>/dev/null | grep -v '"level":"DEBUG"' | tail -60
  exit 1
}

for port in 8580 4580; do
  if curl -s -o /dev/null "localhost:$port" 2>/dev/null; then echo "FAIL: port $port is in use"; exit 1; fi
done

cargo build -q --release -p oc-server --example chaos || exit 1
echo "== building and starting the cluster"
"${DC[@]}" up -d --build >"$WORK/up.log" 2>&1 || { tail -30 "$WORK/up.log"; fail "compose up"; }
for _ in $(seq 1 120); do
  curl -sf "$OC/readyz" >/dev/null && curl -sf "$HOST/healthz" >/dev/null && break; sleep 1
done
curl -sf "$OC/readyz" >/dev/null || fail "cluster not ready"
for n in oc1 oc2 oc3; do
  "${DC[@]}" logs --no-color "$n" | grep -q 'cluster mode' || fail "$n is not in cluster mode"
done

launch() { # user → ticket
  local token loc
  token=$(curl -s "$HOST/files/doc_welcome?as=$1" | grep -o 'name="token" value="[^"]*"' | sed 's/.*value="//;s/"$//')
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST --data-urlencode "token=$token" "$OC/v1/launch")
  echo "${loc##*#t=}"
}
T1=$(launch u_asha); T2=$(launch u_priya)
[ -n "$T1" ] && [ -n "$T2" ] || fail "launch did not return tickets"
# The first session lookup opens the room. Do it directly on $PREOPEN (from inside the nginx
# container; nodes are not published) so the room usually starts on a node other than the one
# nginx hashes its sockets to: then the clients are relayed and the kill hits the relay path.
PREOPEN=${PREOPEN:-oc2}
ROOM=$("${DC[@]}" exec -T nginx wget -qO- "http://$PREOPEN:8080/v1/sessions/$T1" | node -pe 'JSON.parse(require("fs").readFileSync(0)).room')
[ -n "$ROOM" ] || fail "session lookup on $PREOPEN failed"
curl -s "$OC/v1/sessions/$T2" >/dev/null
echo "== room $ROOM; two clients typing for ${TYPE_SECS}s through nginx"

"$CHAOS" run "ws://localhost:8580/v1/collab" "$ROOM" "$TYPE_SECS" "$WORK/run.json" "A:$T1" "B:$T2" >"$WORK/chaos.log" 2>&1 &
CPID=$!; PIDS+=("$CPID")
sleep "$KILL_AFTER"
LEASE=$("${DC[@]}" exec -T redis redis-cli GET "room:$ROOM:owner" | tr -d '\r')
OWNER=${LEASE%%@*}
case "$OWNER" in oc1|oc2|oc3) ;; *) fail "no owner lease for $ROOM (got '$LEASE')";; esac
RELAYS_BEFORE=$("${DC[@]}" logs --no-color oc1 oc2 oc3 | grep -c 'relaying connection')
echo "== owner is $OWNER (relayed connections so far: $RELAYS_BEFORE); docker kill"
docker kill "$("${DC[@]}" ps -q "$OWNER")" >/dev/null || fail "docker kill $OWNER"

wait "$CPID"; STATUS=$?
cat "$WORK/chaos.log"
[ "$STATUS" = 0 ] || fail "chaos client exited $STATUS"
NEW=$("${DC[@]}" exec -T redis redis-cli GET "room:$ROOM:owner" | tr -d '\r'); NEW=${NEW%%@*}
[ -n "$NEW" ] && [ "$NEW" != "$OWNER" ] || fail "room did not move (owner '$NEW')"
GAP=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).maxGapSecs' "$WORK/run.json")
node -e 'process.exit(+process.argv[1] <= 5 ? 0 : 1)' "$GAP" || fail "a client needed ${GAP}s to resync (> 5 s)"
ACKED_BEFORE_KILL=$(node -pe 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));Object.values(r.acked).filter(t=>t<=+process.argv[2]).length' "$WORK/run.json" "$KILL_AFTER")

# Commit through nginx (round-robin: usually forwarded to the new owner) and read the host's file.
COMMIT=$(curl -s -X POST -H 'x-opencanvas-host: sample' -H 'x-opencanvas-key: dev-api-key-change-me' "$OC/v1/files/doc_welcome/commit")
echo "$COMMIT" | grep -q '"version"' || fail "commit: $COMMIT"
"${DC[@]}" cp sample-host:/data/files/doc_welcome.ocanvas "$WORK/final.ocanvas" >/dev/null 2>&1 || fail "could not copy the host's file"
"$CHAOS" verify "$WORK/final.ocanvas" "$WORK/run.json" || fail "host file is missing edits"

LOGS=$("${DC[@]}" logs --no-color oc1 oc2 oc3 2>/dev/null)
TAKEOVER=$(echo "$LOGS" | grep -c 'took the room over')
RECOVER=$(echo "$LOGS" | grep -c 'recovered unsaved room state')
RELAYS=$(echo "$LOGS" | grep -c 'relaying connection')
echo "$LOGS" | grep -qi 'panicked' && fail "a node panicked"
echo "PASS: owner $OWNER killed at +${KILL_AFTER}s, room moved to $NEW (takeovers: $TAKEOVER, WAL recoveries: $RECOVER, relayed connections: $RELAYS); max client resync ${GAP}s; $ACKED_BEFORE_KILL edits acknowledged before the kill; $(grep -o 'run: .*' "$WORK/chaos.log")"
