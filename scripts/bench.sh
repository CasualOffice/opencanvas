#!/usr/bin/env bash
# Capacity benchmark (docs/22-CAPACITY-AND-SIZING.md). One command on your own hardware:
#
#   scripts/bench.sh                    # quick check: small A + B on SQLite (~3 min)
#   scripts/bench.sh all                # A B C D on SQLite, then A B D on MariaDB (~45 min)
#   scripts/bench.sh A                  # one scenario: A B C D (SQLite) | mA mB mD (MariaDB) | E (cluster)
#   OUT=/tmp/oc-bench scripts/bench.sh B
#
# A  one big room: 10 → 550 clients (the room cap), 20 % editors, demo doc
# B  many small rooms: 5 users per room, 500 → 10,000 connections, 20 % editors, demo doc
# C  idle memory: rooms of empty / demo / big docs with one idle viewer, then idle viewers
#    over 100 rooms (MB per room and per connection)
# D  autosave/WAL pressure: 200 rooms × 2 editors typing for 120 s
# E  cluster mode: 3 nodes on this machine (MariaDB + Redis in Docker), B's load spread by room
#
# Resilience and worst case (docs/22 §8-§11):
# S1 sustained: one room of 550, 100 % editors typing with no pauses, 10 one-minute buckets
# S2 sustained: 1,000 rooms x 5, 100 % editors, no pauses, 10 one-minute buckets
#    (then typing stops and the server's RSS is sampled while rooms are evicted: S_IDLE_SECS,
#    default OC_ROOM_IDLE_MS + 60 s; S_IDLE_SECS=0 skips)
#    (S1/S2: S_DB=maria syncs to MariaDB in Docker; OC_WAL_REDIS_URL puts the hot WAL in Redis;
#    S_DB=redis: Redis-only storage, a one-node cluster on REDIS_PORT with no DATABASE_URL)
# R  crash recovery on SQLite: 200 rooms x 2 typing, kill -9 the server, restart, verify
# mR the same on MariaDB (Docker)
# K  cluster chaos: 3 nodes, load (300 rooms x 5 at 20 % + one 550 room), verified rooms spread
#    over nodes; kill -9 the owner, rolling restart, Redis restart, pause one node (SIGSTOP)
# K2 cluster: Redis kill and a 20 s SIGSTOP of one node inside the verified window
#    (K2_REDIS_KILL=0: the pause only; REDIS_ARGS="--appendonly yes --appendfsync always")
#    K, K2, T with CLUSTER_DB=none: Redis-only storage, no MariaDB and no DATABASE_URL (ADR-030)
#    REDIS_LOCAL=1: a local redis-server on REDIS_PORT instead of Docker (K, K2, S_DB=redis)
# KD cluster with node 2 in Docker (NODE2_IMAGE): docker pause 20 s, then a 25 s partition
# T  throughput 1 node vs 3 nodes, clients of a room on different nodes, host latency 20-50 ms
#    (T1 / T3: each half on a fresh MariaDB container; S2m: S2 on MariaDB for 3 minutes)
#
# Each scenario starts its own server (release build) on 127.0.0.1:8701 (E: 8711-8713) with a
# temporary hosts file whose only host is `bench`; the load generator (crates/oc-bench) serves
# that host's load/save callbacks itself on :8702. Results: $OUT/<scenario>.json + .md.
# Only processes and containers this script starts are stopped.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
WHAT=${1:-quick}
OUT=${OUT:-$ROOT/target/bench}
OC_PORT=${OC_PORT:-8701}; HOST_PORT=${HOST_PORT:-8702}; MARIA_PORT=${MARIA_PORT:-8733}; REDIS_PORT=${REDIS_PORT:-8734}
# Cluster nodes listen on NODE_BASE+1..3; the second and third mock hosts on HOST2_PORT, HOST3_PORT.
NODE_BASE=${NODE_BASE:-8710}; HOST2_PORT=${HOST2_PORT:-8742}; HOST3_PORT=${HOST3_PORT:-8752}
# Docker container name prefix (set it to run next to another bench without clashing).
CPFX=${CPFX:-ocbench}
SECRET=bench-secret-0123456789abcdef0123456789
TGT=${CARGO_TARGET_DIR:-target}; BIN=$TGT/release/opencanvas; LG=$TGT/release/oc-bench
case $BIN in /*) ;; *) BIN=$ROOT/$BIN; LG=$ROOT/$LG ;; esac
# OC_BIN / OC_LG: prebuilt binaries and no cargo build (e.g. copies taken off a shared target dir
# that another checkout may rebuild mid-run). WORK: keep node logs in a known directory.
if [ -n "${OC_BIN:-}" ]; then BIN=$OC_BIN; LG=${OC_LG:-$LG}; SKIP_BUILD=1; fi
mkdir -p "$OUT"
WORK=${WORK:-$(mktemp -d)}; mkdir -p "$WORK"; echo "work dir (node logs): $WORK"
PIDS=(); CONTAINERS=()
S_IDLE_SECS=${S_IDLE_SECS:-$(( ${OC_ROOM_IDLE_MS:-60000} / 1000 + 60 ))}

# Sockets: the server and the load generator each hold one fd per connection.
ulimit -n "$(( $(sysctl -n kern.maxfilesperproc 2>/dev/null || echo 65536) ))" 2>/dev/null || ulimit -n 65536 2>/dev/null || true
echo "fd limit: $(ulimit -n)"

cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  for c in "${CONTAINERS[@]}"; do docker rm -f -v "$c" >/dev/null 2>&1; done
}
trap cleanup EXIT

[ -n "${SKIP_BUILD:-}" ] || cargo build -q --release -p oc-server --bin opencanvas -p oc-bench --bin oc-bench || exit 1
for port in "$OC_PORT" "$HOST_PORT"; do
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then echo "port $port is in use (set OC_PORT / HOST_PORT)"; exit 1; fi
done

cat > "$WORK/hosts.toml" <<EOF
[[host]]
id            = "bench"
name          = "Bench host"
mode          = "jwt"
jwt_alg       = "HS256"
jwt_secret    = "$SECRET"
api_key       = "bench-api-key"
callback_base = "http://127.0.0.1:$HOST_PORT/api"

[[host]]
id            = "bench2"
name          = "Bench host 2"
mode          = "jwt"
jwt_alg       = "HS256"
jwt_secret    = "$SECRET"
api_key       = "bench-api-key-2"
callback_base = "http://127.0.0.1:$HOST2_PORT/api"

[[host]]
id            = "bench3"
name          = "Bench host 3"
mode          = "jwt"
jwt_alg       = "HS256"
jwt_secret    = "$SECRET"
api_key       = "bench-api-key-3"
callback_base = "http://127.0.0.1:$HOST3_PORT/api"
EOF

machine() {
  echo "machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), $(sysctl -n hw.ncpu 2>/dev/null || nproc) cores, $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB, $(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null || uname -sr)"
}

SERVER_PID=""
# start_server <db url> [port] [extra env…]
start_server() {
  local db=$1 port=${2:-$OC_PORT}; shift 2 || shift $#
  env -u OC_DEV DATABASE_URL="$db" OC_KEK="$(openssl rand -base64 32)" OC_HOSTS_FILE="$WORK/hosts.toml" \
    OC_BIND=127.0.0.1:$port OC_PUBLIC_URL=http://127.0.0.1:$port OC_LOG=${OC_LOG:-info} "$@" \
    "$BIN" >> "$WORK/server-$port.log" 2>&1 &
  SERVER_PID=$!; PIDS+=("$SERVER_PID")
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$port/readyz" >/dev/null && return 0; sleep 0.2; done
  echo "server on :$port did not become ready"; tail -20 "$WORK/server-$port.log"; exit 1
}
stop_server() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; }

# lg <name> <server pid(s)> <server url(s)> [oc-bench args…]
lg() {
  local name=$1 pids=$2 urls=$3; shift 3
  echo; echo "== $name"
  "$LG" run --label "$name" --server "$urls" --server-pid "$pids" --host-port "$HOST_PORT" \
    --secret "$SECRET" --out "$OUT/$name.json" "$@" | tee "$OUT/$name.md"
}

# wal_watch <db: sqlite path | maria> <out>: WAL rows/bytes every 30 s, in the background.
wal_watch() {
  local db=$1 out=$2
  ( while :; do
      if [ "$db" = redis ]; then
        r="$(redis DBSIZE 2>/dev/null) keys, $(redis INFO memory 2>/dev/null | grep '^used_memory:' | tr -d '\r')"
      elif [ "$db" = maria ]; then
        r=$(docker exec $CPFX-mariadb mariadb -uroot -proot -N -e "SELECT (SELECT count(*) FROM room_updates),(SELECT coalesce(sum(length(data)),0) FROM room_updates),(SELECT count(*) FROM room_snapshots),(SELECT coalesce(sum(length(state)),0) FROM room_snapshots)" opencanvas 2>/dev/null | tr '\t' ' ')
      else
        r=$(sqlite3 "$db" "SELECT (SELECT count(*) FROM room_updates),(SELECT coalesce(sum(length(data)),0) FROM room_updates),(SELECT count(*) FROM room_snapshots),(SELECT coalesce(sum(length(state)),0) FROM room_snapshots)" 2>/dev/null | tr '|' ' ')
        r="$r $(stat -f %z "$db" 2>/dev/null || echo 0) $(stat -f %z "$db-wal" 2>/dev/null || echo 0)"
      fi
      echo "$(date +%s) $r"; sleep 30
    done ) > "$out" 2>&1 &
  PIDS+=($!)
}

sqlite_url() { echo "sqlite://$WORK/$1.db?mode=rwc"; }
# s_db <name>: the sustained runs (S1, S2) on SQLite, or on MariaDB with S_DB=maria. Sets DBURL,
# WALDB (for wal_watch) and SQLARG (oc-bench --sqlite, SQLite only). With OC_WAL_REDIS_URL set the
# hot WAL is in Redis and the DB only gets snapshots (docs/22 §9.3).
S_ENV=()
s_db() {
  if [ "${S_DB:-sqlite}" = redis ]; then
    redis_up; DBURL=""; WALDB=redis; SQLARG=()
    S_ENV=(REDIS_URL="redis://127.0.0.1:$REDIS_PORT" OC_NODE_ID=bench-1 OC_CLUSTER_SECRET="bench-cluster-secret-0123456789abcdef"
      OC_CLUSTER_ADVERTISE="http://127.0.0.1:$OC_PORT")
  elif [ "${S_DB:-sqlite}" = maria ]; then
    [ -n "$(docker ps -q -f name=$CPFX-mariadb)" ] || mariadb_up
    mariadb_reset; DBURL=$MARIA_URL; WALDB=maria; SQLARG=()
  else
    DBURL=$(sqlite_url "$1"); WALDB=$WORK/$1.db; SQLARG=(--sqlite "$WORK/$1.db")
  fi
}

mariadb_up() {
  docker rm -f -v $CPFX-mariadb >/dev/null 2>&1
  docker run -d --name $CPFX-mariadb -p 127.0.0.1:$MARIA_PORT:3306 -e MARIADB_ROOT_PASSWORD=root \
    -e MARIADB_DATABASE=opencanvas mariadb:10.11 --max-connections=500 >/dev/null || exit 1
  CONTAINERS+=($CPFX-mariadb)
  for _ in $(seq 1 90); do
    docker exec $CPFX-mariadb mariadb -uroot -proot -e 'SELECT 1' opencanvas >/dev/null 2>&1 && return 0; sleep 1
  done
  echo "MariaDB did not start"; exit 1
}
# Redis in Docker on REDIS_PORT (REDIS_ARGS, e.g. "--appendonly yes --appendfsync always").
# REDIS_LOCAL=1: a local redis-server (no Docker) with its AOF/RDB under $WORK/redis.
REDIS_PID=""
redis_local_start() {
  mkdir -p "$WORK/redis"
  redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$WORK/redis" --save "" ${REDIS_ARGS:-} \
    >> "$WORK/redis.log" 2>&1 &
  REDIS_PID=$!; PIDS+=("$REDIS_PID")
  for _ in $(seq 1 50); do redis-cli -p "$REDIS_PORT" PING >/dev/null 2>&1 && return 0; sleep 0.2; done
  echo "redis-server did not start"; exit 1
}
redis_up() {
  if [ -n "${REDIS_LOCAL:-}" ]; then redis_local_start; return; fi
  docker rm -f $CPFX-redis >/dev/null 2>&1
  docker run -d --name $CPFX-redis -p 127.0.0.1:$REDIS_PORT:6379 redis:7-alpine redis-server ${REDIS_ARGS:-} >/dev/null || exit 1
  CONTAINERS+=($CPFX-redis); sleep 2
}
mariadb_reset() {
  docker exec $CPFX-mariadb mariadb -uroot -proot -e 'DROP DATABASE IF EXISTS opencanvas; CREATE DATABASE opencanvas' >/dev/null
}
MARIA_URL="mysql://root:root@127.0.0.1:$MARIA_PORT/opencanvas"
mariadb_bytes() {
  docker exec $CPFX-mariadb mariadb -uroot -proot -N -e \
    "SELECT table_name, table_rows, data_length + index_length FROM information_schema.tables WHERE table_schema='opencanvas' ORDER BY 3 DESC" 2>/dev/null
}

A_ARGS=(--per-room 550 --editors 0.2 --probes 10 --doc demo --steps 10,50,100,200,350,550 --step-secs 60 --connect-rate 100)
B_ARGS=(--per-room 5 --editors 0.2 --probes 5 --doc demo --steps ${B_STEPS:-500,1000,2000,5000} --step-secs 60 --connect-rate 250)
D_ARGS=(--per-room 2 --editors 1 --probes 2 --doc demo --steps 400 --step-secs 120 --active 1 --connect-rate 200)

# ---------- cluster helpers (K, T): 3 nodes on 8711-8713, MariaDB + Redis in Docker ----------
CL_SECRET="bench-cluster-secret-0123456789abcdef"
declare -a NODE_PID
# CLUSTER_DB=none: Redis-only storage (no DATABASE_URL, ADR-030).
CL_DB=$MARIA_URL; [ "${CLUSTER_DB:-maria}" = none ] && CL_DB=""
start_node() { # n
  local port=$((NODE_BASE + $1))
  start_server "$CL_DB" "$port" REDIS_URL="redis://127.0.0.1:$REDIS_PORT" OC_NODE_ID="bench-$1" \
    OC_CLUSTER_ADVERTISE="http://127.0.0.1:$port" OC_CLUSTER_SECRET="$CL_SECRET" OC_KEK="$CL_KEK"
  NODE_PID[$1]=$SERVER_PID
}
cluster_up() {
  if [ -n "$CL_DB" ]; then
    [ -n "$(docker ps -q -f name=$CPFX-mariadb)" ] || mariadb_up
    mariadb_reset
  fi
  # REDIS_ARGS, e.g. "--appendonly yes --appendfsync always" (the hot WAL's documented setting).
  redis_up
  CL_KEK=$(openssl rand -base64 32)
  for n in 1 2 3; do
    if [ -n "${NODE2_IMAGE:-}" ] && [ "$n" = 2 ]; then start_node_docker; else start_node "$n"; fi
  done
  CL_URLS="http://127.0.0.1:$((NODE_BASE + 1)),http://127.0.0.1:$((NODE_BASE + 2)),http://127.0.0.1:$((NODE_BASE + 3))"
  CL_PIDS="${NODE_PID[1]},${NODE_PID[2]},${NODE_PID[3]}"
}
cluster_down() {
  [ -n "${NODE2_IMAGE:-}" ] && docker stop -t 30 $CPFX-node2 >/dev/null 2>&1
  for n in 1 2 3; do stop_server "${NODE_PID[$n]}"; done
}
# KD: node 2 runs in Docker (NODE2_IMAGE, a Linux build of the server, e.g. `docker build -f
# deploy/Dockerfile --target server`). Its network namespace belongs to a socat container that
# forwards 127.0.0.1:<port> to the host for Redis, MariaDB, the other nodes and the mock hosts,
# and publishes node 2's own port. `docker pause` of node 2 freezes it; `docker pause` of the
# forwarder partitions it: node 2 keeps running and answering its own clients, but cannot
# reach Redis, the DB, the other nodes or the host.
start_node_docker() {
  local port=$((NODE_BASE + 2)) fw="" p
  docker rm -f $CPFX-node2 $CPFX-fwd >/dev/null 2>&1
  for p in $((NODE_BASE + 1)) $((NODE_BASE + 3)) $HOST_PORT $HOST2_PORT $HOST3_PORT $MARIA_PORT $REDIS_PORT; do
    fw="$fw socat TCP-LISTEN:$p,bind=127.0.0.1,fork,reuseaddr TCP:host.docker.internal:$p &"
  done
  CONTAINERS+=($CPFX-node2 $CPFX-fwd)
  docker run -d --name $CPFX-fwd -p 127.0.0.1:$port:$port --entrypoint sh alpine/socat -c "$fw wait" >/dev/null || exit 1
  docker run -d --name $CPFX-node2 --network container:$CPFX-fwd -v "$WORK:/work" --entrypoint /opencanvas \
    -e DATABASE_URL="$CL_DB" -e REDIS_URL="redis://127.0.0.1:$REDIS_PORT" -e OC_NODE_ID=bench-2 \
    -e OC_CLUSTER_ADVERTISE="http://127.0.0.1:$port" -e OC_CLUSTER_SECRET="$CL_SECRET" -e OC_KEK="$CL_KEK" \
    -e OC_HOSTS_FILE=/work/hosts.toml -e OC_BIND="0.0.0.0:$port" -e OC_PUBLIC_URL="http://127.0.0.1:$port" \
    -e OC_LOG="${OC_LOG:-info}" "$NODE2_IMAGE" >/dev/null || exit 1
  docker logs -f $CPFX-node2 >> "$WORK/server-$port.log" 2>&1 &
  NODE_PID[2]=$!; PIDS+=($!)
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$port/readyz" >/dev/null && return 0; sleep 0.2; done
  echo "node 2 (Docker) did not become ready"; tail -20 "$WORK/server-$port.log"; exit 1
}
docker_pause_node() {
  echo "bench-2 owns $(owners | grep -c ' bench-2@') rooms"
  echo "docker pause $CPFX-node2 for $1 s"; docker pause $CPFX-node2 >/dev/null; sleep "$1"; docker unpause $CPFX-node2 >/dev/null; echo "docker unpause $CPFX-node2"
}
partition_node() {
  echo "bench-2 owns $(owners | grep -c ' bench-2@') rooms"
  echo "partition bench-2 for $1 s (forwarder paused: no Redis, DB, peers or host; its own port still answers)"
  docker pause $CPFX-fwd >/dev/null; sleep "$1"; docker unpause $CPFX-fwd >/dev/null; echo "partition healed"
}
redis() {
  if [ -n "${REDIS_LOCAL:-}" ]; then redis-cli -p "$REDIS_PORT" "$@"; else docker exec $CPFX-redis redis-cli "$@"; fi
}
# "<room key> <node>@<token>" for every lease, in one round trip (a docker exec per key took
# about 18 s for 360 keys, which delayed the events and made the lease watch far slower than 1 s).
owners() {
  redis EVAL "local r = {} for _, k in ipairs(redis.call('KEYS', 'room:*:owner')) do r[#r + 1] = k .. ' ' .. (redis.call('GET', k) or '') end return r" 0 2>/dev/null
}
# Owner of each room key every second: "<unix> <room> <node>" (to see moves and leaseless gaps).
lease_watch() {
  ( while :; do
      t=$(date +%s)
      owners | sed "s/@.*//; s/^/$t /"
      sleep 1
    done ) > "$1" 2>&1 &
  PIDS+=($!)
}
k_event() { local what=$1; shift; echo "$(date +%s) EVENT $what" | tee -a "$OUT/K-events.txt"; "$@" > >(tee -a "$OUT/K-events.txt") 2>&1; }
kill_owner() {
  local n; n=$(owners | awk '{print $2}' | cut -d@ -f1 | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
  n=${n#bench-}; echo "owner with most rooms: bench-$n (pid ${NODE_PID[$n]})"
  kill -9 "${NODE_PID[$n]}"; sleep 5; start_node "$n"; echo "bench-$n restarted (pid ${NODE_PID[$n]})"
}
rolling_restart() {
  for n in 1 2 3; do
    local t0; t0=$(date +%s.%N 2>/dev/null || date +%s)
    kill "${NODE_PID[$n]}"; wait "${NODE_PID[$n]}" 2>/dev/null; start_node "$n"
    echo "bench-$n restarted (pid ${NODE_PID[$n]})"; sleep 8
  done
}
redis_crash() {
  if [ -n "${REDIS_LOCAL:-}" ]; then
    echo "kill -9 + start the local redis-server (AOF replayed on start)"
    kill -9 "$REDIS_PID" 2>/dev/null; wait "$REDIS_PID" 2>/dev/null; sleep 2; redis_local_start
    echo "keys after restart: $(redis DBSIZE)"; return
  fi
  echo "docker kill + start $CPFX-redis (no RDB save on SIGKILL: lease keys are lost)"
  docker kill $CPFX-redis >/dev/null; sleep 2; docker start $CPFX-redis >/dev/null; sleep 1
  echo "keys after restart: $(redis DBSIZE)"
}
pause_node() {
  echo "bench-2 owns $(owners | grep -c ' bench-2@') rooms"
  echo "SIGSTOP bench-2 (pid ${NODE_PID[2]}) for $1 s"; kill -STOP "${NODE_PID[2]}"; sleep "$1"; kill -CONT "${NODE_PID[2]}"; echo "SIGCONT bench-2"
}
# node_report <out.md>: per-node log counts (two writers show as duplicate entries, WALSEQ or a
# non-fenced WAL failure on the new owner) and the fencing epochs in the DB and in Redis.
node_report() {
  for n in 1 2 3; do
    f="$WORK/server-$((NODE_BASE + n)).log"
    echo "node $n: takeovers $(grep -c 'took the room over' "$f"), stepped down $(grep -c 'stepping down' "$f"), fenced $(grep -c 'a newer owner holds the room' "$f"), rooms closed for reconnect $(grep -c 'clients told to reconnect' "$f"), WAL append failed $(grep -c 'WAL append failed' "$f"), duplicate entry $(grep -ci 'duplicate entry' "$f"), WALSEQ $(grep -c 'WALSEQ' "$f"), deadlock errors $(grep '"level":"ERROR"' "$f" | grep -ci deadlock), transient retries $(grep -c 'transient database error' "$f"), drain-joins refused after upgrade $(grep -c 'server is draining' "$f"), errors $(grep -c '"level":"ERROR"' "$f"), panics $(grep -ci panicked "$f")"
  done
  if [ -z "$CL_DB" ]; then
    echo "Redis-only: epoch keys $(redis --scan --pattern 'oc:epoch:*' | wc -l | tr -d ' '), snapshot keys $(redis --scan --pattern 'oc:snap:*' | wc -l | tr -d ' '), WAL streams $(redis --scan --pattern 'oc:wal:*' | wc -l | tr -d ' '), pending commits $(redis ZCARD oc:obpending), wipes detected $(cat "$WORK"/server-$((NODE_BASE + 1)).log "$WORK"/server-$((NODE_BASE + 2)).log "$WORK"/server-$((NODE_BASE + 3)).log | grep -c 'REDIS LOST ITS DATA')"
    return
  fi
  echo "room_epochs rows: $(docker exec $CPFX-mariadb mariadb -uroot -proot -N -e 'SELECT count(*) FROM room_epochs' opencanvas 2>/dev/null)"
  echo "DB room_updates rows: $(docker exec $CPFX-mariadb mariadb -uroot -proot -N -e 'SELECT count(*) FROM room_updates' opencanvas 2>/dev/null)"
  echo "Redis epoch keys: $(redis --scan --pattern 'oc:epoch:*' | wc -l | tr -d ' '); epoch keys lower than room_epochs: $(docker exec $CPFX-mariadb mariadb -uroot -proot -N -e 'SELECT room_id, epoch FROM room_epochs' opencanvas 2>/dev/null | while read -r r e; do v=$(redis GET "oc:epoch:{$r}"); [ -n "$v" ] && [ "$v" -lt "$e" ] && echo "$r"; done | wc -l | tr -d ' ')"
}

scenario() {
  case $1 in
    quick)
      start_server "$(sqlite_url quick)"
      lg quick-A "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room 100 --editors 0.2 --probes 5 --doc demo --steps 20,100 --step-secs 10
      stop_server "$SERVER_PID"
      start_server "$(sqlite_url quick2)"
      lg quick-B "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room 5 --editors 0.2 --doc demo --steps 250,1000 --step-secs 10
      stop_server "$SERVER_PID" ;;
    A)
      start_server "$(sqlite_url A)"
      lg A-sqlite "$SERVER_PID" "http://127.0.0.1:$OC_PORT" "${A_ARGS[@]}"
      stop_server "$SERVER_PID" ;;
    B)
      start_server "$(sqlite_url B)"
      lg B-sqlite "$SERVER_PID" "http://127.0.0.1:$OC_PORT" "${B_ARGS[@]}"
      stop_server "$SERVER_PID" ;;
    C)
      for doc in empty demo big; do
        start_server "$(sqlite_url "C-$doc")"
        lg "C-rooms-$doc" "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room 1 --editors 0 --probes 0 --doc "$doc" \
          --steps 1,100,200,400 --step-secs 5 --settle-secs 5 --active 0
        stop_server "$SERVER_PID"
      done
      start_server "$(sqlite_url C-conns)"
      lg C-conns "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --rooms 100 --editors 0 --probes 0 --doc demo \
        --steps 100,1000,2000,4000 --step-secs 5 --settle-secs 5 --active 0 --connect-rate 400
      stop_server "$SERVER_PID" ;;
    D)
      start_server "$(sqlite_url D)"
      lg D-sqlite "$SERVER_PID" "http://127.0.0.1:$OC_PORT" "${D_ARGS[@]}" --sqlite "$WORK/D.db"
      sqlite3 "$WORK/D.db" "SELECT 'room_updates', count(*), sum(length(data)) FROM room_updates; SELECT 'room_snapshots', count(*), sum(length(state)) FROM room_snapshots; SELECT 'commit_outbox', status, count(*) FROM commit_outbox GROUP BY status;" 2>&1 | tee -a "$OUT/D-sqlite.md"
      ls -l "$WORK"/D.db* | tee -a "$OUT/D-sqlite.md"
      stop_server "$SERVER_PID"
      ls -l "$WORK"/D.db* | sed 's/^/after stop: /' | tee -a "$OUT/D-sqlite.md" ;;
    mA|mB|mD)
      [ -n "$(docker ps -q -f name=$CPFX-mariadb)" ] || mariadb_up
      mariadb_reset
      start_server "$MARIA_URL"
      case $1 in
        mA) lg A-mariadb "$SERVER_PID" "http://127.0.0.1:$OC_PORT" "${A_ARGS[@]}" ;;
        mB) lg B-mariadb "$SERVER_PID" "http://127.0.0.1:$OC_PORT" "${B_ARGS[@]}" ;;
        mD) lg D-mariadb "$SERVER_PID" "http://127.0.0.1:$OC_PORT" "${D_ARGS[@]}"
            mariadb_bytes | tee -a "$OUT/D-mariadb.md" ;;
      esac
      stop_server "$SERVER_PID" ;;
    E)
      [ -n "$(docker ps -q -f name=$CPFX-mariadb)" ] || mariadb_up
      mariadb_reset
      docker rm -f $CPFX-redis >/dev/null 2>&1
      docker run -d --name $CPFX-redis -p 127.0.0.1:$REDIS_PORT:6379 redis:7-alpine >/dev/null || exit 1
      CONTAINERS+=($CPFX-redis); sleep 2
      local pids="" urls=""
      for n in 1 2 3; do
        port=$((NODE_BASE + n))
        start_server "$MARIA_URL" "$port" REDIS_URL="redis://127.0.0.1:$REDIS_PORT" OC_NODE_ID="bench-$n" \
          OC_CLUSTER_ADVERTISE="http://127.0.0.1:$port" OC_CLUSTER_SECRET="bench-cluster-secret-0123456789abcdef"
        pids="$pids${pids:+,}$SERVER_PID"; urls="$urls${urls:+,}http://127.0.0.1:$port"
      done
      lg E-cluster3 "$pids" "$urls" "${B_ARGS[@]}" --affinity hash
      grep -c 'relaying connection' "$WORK"/server-$((NODE_BASE / 10))*.log | tee -a "$OUT/E-cluster3.md"
      for p in ${pids//,/ }; do stop_server "$p"; done ;;
    S1)
      s_db S1; start_server "$DBURL" "$OC_PORT" "${S_ENV[@]}"
      echo "# unix wal_rows wal_bytes snapshots snapshot_bytes db_bytes db_wal_bytes" > "$OUT/S1-wal.txt"
      wal_watch "$WALDB" "$OUT/S1-wal.raw"
      lg S1-sustained-550 "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room ${S1_PER_ROOM:-550} --editors 1.0 --no-pauses \
        --probes 10 --doc demo --steps ${S1_STEPS:-550,550,550,550,550,550,550,550,550,550} --step-secs 55 --settle-secs 5 \
        --connect-rate 100 --idle-secs "$S_IDLE_SECS" "${SQLARG[@]}"
      cat "$OUT/S1-wal.raw" >> "$OUT/S1-wal.txt"; grep -ciE '"level":"(ERROR|WARN)"' "$WORK/server-$OC_PORT.log" | sed 's/^/server warn+error lines: /' | tee -a "$OUT/S1-sustained-550.md"
      stop_server "$SERVER_PID" ;;
    S2)
      s_db S2; start_server "$DBURL" "$OC_PORT" "${S_ENV[@]}"
      echo "# unix wal_rows wal_bytes snapshots snapshot_bytes db_bytes db_wal_bytes" > "$OUT/S2-wal.txt"
      wal_watch "$WALDB" "$OUT/S2-wal.raw"
      lg S2-sustained-1000x5 "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room 5 --editors 1.0 --no-pauses \
        --probes 5 --doc demo --steps ${S2_STEPS:-5000,5000,5000,5000,5000,5000,5000,5000,5000,5000} --step-secs 55 --settle-secs 5 \
        --connect-rate 250 --idle-secs "$S_IDLE_SECS" "${SQLARG[@]}"
      cat "$OUT/S2-wal.raw" >> "$OUT/S2-wal.txt"; grep -ciE '"level":"(ERROR|WARN)"' "$WORK/server-$OC_PORT.log" | sed 's/^/server warn+error lines: /' | tee -a "$OUT/S2-sustained-1000x5.md"
      stop_server "$SERVER_PID" ;;
    R|mR)
      # The harness kill -9s the server it is given and runs RESTART, which starts a new one
      # (same database) and records its pid for cleanup.
      local db
      if [ "$1" = mR ]; then
        [ -n "$(docker ps -q -f name=$CPFX-mariadb)" ] || mariadb_up
        mariadb_reset; db=$MARIA_URL
      else db=$(sqlite_url R); fi
      local kek; kek=$(openssl rand -base64 32)
      start_server "$db" "$OC_PORT" OC_KEK="$kek"
      local restart="env -u OC_DEV DATABASE_URL='$db' OC_KEK='$kek' OC_HOSTS_FILE='$WORK/hosts.toml' OC_BIND=127.0.0.1:$OC_PORT OC_PUBLIC_URL=http://127.0.0.1:$OC_PORT OC_LOG=info nohup $BIN >> '$WORK/server-$OC_PORT.restart.log' 2>&1 & echo \$! > '$WORK/restarted.pid'"
      echo; echo "== $1-crash"
      "$LG" verify --label "$1-crash" --server "http://127.0.0.1:$OC_PORT" --host-port "$HOST_PORT" --secret "$SECRET" \
        --rooms 200 --per-room 2 --secs 45 --crash-at 25 --kill-pid "$SERVER_PID" --restart "$restart" --durability "${OC_DURABILITY:-memory}" \
        --out "$OUT/$1-crash.json" | tee "$OUT/$1-crash.md"
      local np; np=$(cat "$WORK/restarted.pid" 2>/dev/null); [ -n "$np" ] && PIDS+=("$np")
      { echo "recovery log lines: $(grep -c 'recovered unsaved room state' "$WORK/server-$OC_PORT.restart.log")";
        echo "restart log errors: $(grep -ciE '"level":"ERROR"' "$WORK/server-$OC_PORT.restart.log")";
        echo "restart log deadlock errors (not retried away): $(grep "\"level\":\"ERROR\"" "$WORK/server-$OC_PORT.restart.log" | grep -ciE "deadlock|lock wait")";
        echo "restart log transient retries: $(grep -c "transient database error" "$WORK/server-$OC_PORT.restart.log")";
        grep -m1 -E 'listening|ready' "$WORK/server-$OC_PORT.restart.log"; } | tee -a "$OUT/$1-crash.md"
      [ -n "$np" ] && stop_server "$np" ;;
    K)
      cluster_up
      # Background load: 300 rooms x 5 (20 % editors) and one room of 550, spread like an LB.
      "$LG" run --label K-load-small --server "$CL_URLS" --server-pid "$CL_PIDS" --host-port "$HOST_PORT" --secret "$SECRET" \
        --per-room 5 --editors 0.2 --probes 5 --doc demo --steps 1500 --step-secs 170 --connect-rate 250 --affinity rr \
        --out "$OUT/K-load-small.json" > "$OUT/K-load-small.md" 2>&1 &
      PIDS+=($!)
      "$LG" run --label K-load-550 --server "$CL_URLS" --server-pid "$CL_PIDS" --host-port "$HOST2_PORT" --host-id bench2 --secret "$SECRET" \
        --per-room 550 --editors 0.2 --probes 10 --doc demo --steps 550 --step-secs 170 --connect-rate 100 --affinity rr \
        --out "$OUT/K-load-550.json" > "$OUT/K-load-550.md" 2>&1 &
      PIDS+=($!)
      sleep 15
      # Verified rooms: 60 rooms x 3 typing clients, one per node (relay path).
      "$LG" verify --label K-chaos --server "$CL_URLS" --host-port "$HOST3_PORT" --host-id bench3 --secret "$SECRET" \
        --rooms 60 --per-room 3 --spread 1 --secs 150 --save-wait-secs 20 --out "$OUT/K-chaos.json" > "$OUT/K-chaos.md" 2>&1 &
      local vpid=$!; PIDS+=("$vpid")
      lease_watch "$OUT/K-leases.txt"
      sleep 25; k_event "kill -9 the owner of the most rooms" kill_owner
      sleep 25; k_event "rolling restart" rolling_restart
      sleep 10; k_event "redis restart" redis_crash
      sleep 20; k_event "pause one node 20 s (SIGSTOP)" pause_node 20
      wait "$vpid"; cat "$OUT/K-chaos.md"
      node_report | tee -a "$OUT/K-chaos.md"
      cluster_down ;;
    K2)
      # Redis loss and a frozen node, both inside the verified typing window.
      cluster_up
      "$LG" run --label K2-load-small --server "$CL_URLS" --server-pid "$CL_PIDS" --host-port "$HOST_PORT" --secret "$SECRET" \
        --per-room 5 --editors 0.2 --probes 5 --doc demo --steps 1500 --step-secs 120 --connect-rate 250 --affinity rr \
        --out "$OUT/K2-load-small.json" > "$OUT/K2-load-small.md" 2>&1 &
      PIDS+=($!)
      sleep 10
      "$LG" verify --label K2-chaos --server "$CL_URLS" --host-port "$HOST3_PORT" --host-id bench3 --secret "$SECRET" \
        --rooms 60 --per-room 3 --spread 1 --secs 100 --save-wait-secs 20 --out "$OUT/K2-chaos.json" > "$OUT/K2-chaos.md" 2>&1 &
      local vpid=$!; PIDS+=("$vpid")
      lease_watch "$OUT/K2-leases.txt"
      # K2_REDIS_KILL=0: the frozen node only.
      if [ "${K2_REDIS_KILL:-1}" = 1 ]; then sleep 20; k_event "redis restart" redis_crash; sleep 20; else sleep 30; fi
      k_event "pause one node 20 s (SIGSTOP)" pause_node 20
      wait "$vpid"; cat "$OUT/K2-chaos.md"
      node_report | tee -a "$OUT/K2-chaos.md"
      cluster_down ;;
    KD)
      # Node 2 in Docker: frozen container, then a network partition, inside the verified window.
      [ -n "${NODE2_IMAGE:-}" ] || { echo "KD needs NODE2_IMAGE"; exit 2; }
      cluster_up
      "$LG" run --label KD-load-small --server "$CL_URLS" --server-pid "$CL_PIDS" --host-port "$HOST_PORT" --secret "$SECRET" \
        --per-room 5 --editors 0.2 --probes 5 --doc demo --steps 1500 --step-secs 130 --connect-rate 250 --affinity rr \
        --out "$OUT/KD-load-small.json" > "$OUT/KD-load-small.md" 2>&1 &
      PIDS+=($!)
      sleep 10
      "$LG" verify --label KD-chaos --server "$CL_URLS" --host-port "$HOST3_PORT" --host-id bench3 --secret "$SECRET" \
        --rooms 60 --per-room 3 --spread 1 --secs 115 --save-wait-secs 20 --out "$OUT/KD-chaos.json" > "$OUT/KD-chaos.md" 2>&1 &
      local vpid=$!; PIDS+=("$vpid")
      lease_watch "$OUT/KD-leases.txt"
      sleep 20; k_event "docker pause node 2 for 20 s" docker_pause_node 20
      sleep 20; k_event "partition node 2 for 25 s" partition_node 25
      wait "$vpid"; cat "$OUT/KD-chaos.md"
      node_report | tee -a "$OUT/KD-chaos.md"
      cluster_down ;;
    S2m)
      # S2's worst case for 3 minutes on MariaDB: is the WAL ceiling SQLite's?
      [ -n "$(docker ps -q -f name=$CPFX-mariadb)" ] || mariadb_up
      mariadb_reset
      start_server "$MARIA_URL"
      lg S2m-sustained-1000x5 "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room 5 --editors 1.0 --no-pauses \
        --probes 5 --doc demo --steps 5000,5000,5000 --step-secs 55 --settle-secs 5 --connect-rate 250
      stop_server "$SERVER_PID" ;;
    T1)
      # T's single-node half again, on a fresh MariaDB container (nothing else running).
      mariadb_up
      start_server "$MARIA_URL"
      lg T1-1node-fresh "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room 5 --editors 0.2 --probes 5 --doc demo \
        --steps ${T_STEPS:-1000,2500,5000} --step-secs 40 --connect-rate 250 --host-latency-ms 20,50
      stop_server "$SERVER_PID" ;;
    T3)
      # T's three-node half again, on a fresh MariaDB container.
      mariadb_up
      cluster_up
      lg T3-3nodes-fresh "$CL_PIDS" "$CL_URLS" --per-room 5 --editors 0.2 --probes 5 --doc demo \
        --steps ${T_STEPS:-1000,2500,5000} --step-secs 40 --connect-rate 250 --host-latency-ms 20,50 --affinity rr
      echo "relayed connections: $(cat "$WORK"/server-$((NODE_BASE / 10))*.log | grep -c 'relaying connection')" | tee -a "$OUT/T3-3nodes-fresh.md"
      cluster_down ;;
    T)
      # Same load on 1 node, then on 3 (clients of a room on different nodes). Host 20-50 ms.
      local T_ARGS=(--per-room 5 --editors 0.2 --probes 5 --doc demo --steps ${T_STEPS:-1000,2500,5000} --step-secs 40 --connect-rate 250 --host-latency-ms 20,50)
      [ -n "$(docker ps -q -f name=$CPFX-mariadb)" ] || mariadb_up
      mariadb_reset
      start_server "$MARIA_URL"
      lg T-1node "$SERVER_PID" "http://127.0.0.1:$OC_PORT" "${T_ARGS[@]}"
      stop_server "$SERVER_PID"
      cluster_up
      lg T-3nodes "$CL_PIDS" "$CL_URLS" "${T_ARGS[@]}" --affinity rr
      echo "relayed connections: $(cat "$WORK"/server-$((NODE_BASE / 10))*.log | grep -c 'relaying connection')" | tee -a "$OUT/T-3nodes.md"
      cluster_down ;;
    *) echo "unknown scenario $1"; exit 2 ;;
  esac
}

machine | tee "$OUT/machine.txt"
case $WHAT in
  all) for s in A B C D mA mB mD; do scenario "$s"; done ;;
  *) for s in ${WHAT//,/ }; do scenario "$s"; done ;;
esac
echo; echo "results in $OUT"
