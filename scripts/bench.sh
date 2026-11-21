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
# R  crash recovery on SQLite: 200 rooms x 2 typing, kill -9 the server, restart, verify
# mR the same on MariaDB (Docker)
# K  cluster chaos: 3 nodes, load (300 rooms x 5 at 20 % + one 550 room), verified rooms spread
#    over nodes; kill -9 the owner, rolling restart, Redis restart, pause one node (SIGSTOP)
# K2 cluster: Redis kill and a 20 s SIGSTOP of one node inside the verified window
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
SECRET=bench-secret-0123456789abcdef0123456789
BIN=target/release/opencanvas; LG=target/release/oc-bench
mkdir -p "$OUT"
WORK=$(mktemp -d)
PIDS=(); CONTAINERS=()

# Sockets: the server and the load generator each hold one fd per connection.
ulimit -n "$(( $(sysctl -n kern.maxfilesperproc 2>/dev/null || echo 65536) ))" 2>/dev/null || ulimit -n 65536 2>/dev/null || true
echo "fd limit: $(ulimit -n)"

cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1; done
}
trap cleanup EXIT

cargo build -q --release -p oc-server --bin opencanvas -p oc-bench || exit 1
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
callback_base = "http://127.0.0.1:8742/api"

[[host]]
id            = "bench3"
name          = "Bench host 3"
mode          = "jwt"
jwt_alg       = "HS256"
jwt_secret    = "$SECRET"
api_key       = "bench-api-key-3"
callback_base = "http://127.0.0.1:8752/api"
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
      if [ "$db" = maria ]; then
        r=$(docker exec ocbench-mariadb mariadb -uroot -proot -N -e "SELECT (SELECT count(*) FROM room_updates),(SELECT coalesce(sum(length(data)),0) FROM room_updates),(SELECT count(*) FROM room_snapshots),(SELECT coalesce(sum(length(state)),0) FROM room_snapshots)" opencanvas 2>/dev/null | tr '\t' ' ')
      else
        r=$(sqlite3 "$db" "SELECT (SELECT count(*) FROM room_updates),(SELECT coalesce(sum(length(data)),0) FROM room_updates),(SELECT count(*) FROM room_snapshots),(SELECT coalesce(sum(length(state)),0) FROM room_snapshots)" 2>/dev/null | tr '|' ' ')
        r="$r $(stat -f %z "$db" 2>/dev/null || echo 0) $(stat -f %z "$db-wal" 2>/dev/null || echo 0)"
      fi
      echo "$(date +%s) $r"; sleep 30
    done ) > "$out" 2>&1 &
  PIDS+=($!)
}

sqlite_url() { echo "sqlite://$WORK/$1.db?mode=rwc"; }

mariadb_up() {
  docker rm -f ocbench-mariadb >/dev/null 2>&1
  docker run -d --name ocbench-mariadb -p 127.0.0.1:$MARIA_PORT:3306 -e MARIADB_ROOT_PASSWORD=root \
    -e MARIADB_DATABASE=opencanvas mariadb:10.11 --max-connections=500 >/dev/null || exit 1
  CONTAINERS+=(ocbench-mariadb)
  for _ in $(seq 1 90); do
    docker exec ocbench-mariadb mariadb -uroot -proot -e 'SELECT 1' opencanvas >/dev/null 2>&1 && return 0; sleep 1
  done
  echo "MariaDB did not start"; exit 1
}
mariadb_reset() {
  docker exec ocbench-mariadb mariadb -uroot -proot -e 'DROP DATABASE IF EXISTS opencanvas; CREATE DATABASE opencanvas' >/dev/null
}
MARIA_URL="mysql://root:root@127.0.0.1:$MARIA_PORT/opencanvas"
mariadb_bytes() {
  docker exec ocbench-mariadb mariadb -uroot -proot -N -e \
    "SELECT table_name, table_rows, data_length + index_length FROM information_schema.tables WHERE table_schema='opencanvas' ORDER BY 3 DESC" 2>/dev/null
}

A_ARGS=(--per-room 550 --editors 0.2 --probes 10 --doc demo --steps 10,50,100,200,350,550 --step-secs 60 --connect-rate 100)
B_ARGS=(--per-room 5 --editors 0.2 --probes 5 --doc demo --steps ${B_STEPS:-500,1000,2000,5000} --step-secs 60 --connect-rate 250)
D_ARGS=(--per-room 2 --editors 1 --probes 2 --doc demo --steps 400 --step-secs 120 --active 1 --connect-rate 200)

# ---------- cluster helpers (K, T): 3 nodes on 8711-8713, MariaDB + Redis in Docker ----------
CL_SECRET="bench-cluster-secret-0123456789abcdef"
declare -a NODE_PID
start_node() { # n
  local port=$((8710 + $1))
  start_server "$MARIA_URL" "$port" REDIS_URL="redis://127.0.0.1:$REDIS_PORT" OC_NODE_ID="bench-$1" \
    OC_CLUSTER_ADVERTISE="http://127.0.0.1:$port" OC_CLUSTER_SECRET="$CL_SECRET" OC_KEK="$CL_KEK"
  NODE_PID[$1]=$SERVER_PID
}
cluster_up() {
  [ -n "$(docker ps -q -f name=ocbench-mariadb)" ] || mariadb_up
  mariadb_reset
  docker rm -f ocbench-redis >/dev/null 2>&1
  docker run -d --name ocbench-redis -p 127.0.0.1:$REDIS_PORT:6379 redis:7-alpine >/dev/null || exit 1
  CONTAINERS+=(ocbench-redis); sleep 2
  CL_KEK=$(openssl rand -base64 32)
  for n in 1 2 3; do start_node "$n"; done
  CL_URLS="http://127.0.0.1:8711,http://127.0.0.1:8712,http://127.0.0.1:8713"
  CL_PIDS="${NODE_PID[1]},${NODE_PID[2]},${NODE_PID[3]}"
}
cluster_down() { for n in 1 2 3; do stop_server "${NODE_PID[$n]}"; done; }
redis() { docker exec ocbench-redis redis-cli "$@"; }
# Owner of each room key every second: "<unix> <room> <node>" (to see moves and leaseless gaps).
lease_watch() {
  ( while :; do
      t=$(date +%s)
      for k in $(redis --scan --pattern 'room:*:owner' 2>/dev/null); do echo "$t $k $(redis GET "$k" | cut -d@ -f1)"; done
      sleep 1
    done ) > "$1" 2>&1 &
  PIDS+=($!)
}
k_event() { local what=$1; shift; echo "$(date +%s) EVENT $what" | tee -a "$OUT/K-events.txt"; "$@" > >(tee -a "$OUT/K-events.txt") 2>&1; }
kill_owner() {
  local n; n=$(redis --scan --pattern 'room:*:owner' | xargs -n1 docker exec ocbench-redis redis-cli GET | cut -d@ -f1 | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
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
  echo "docker kill + start ocbench-redis (no RDB save on SIGKILL: lease keys are lost)"
  docker kill ocbench-redis >/dev/null; sleep 2; docker start ocbench-redis >/dev/null; sleep 1
  echo "keys after restart: $(redis DBSIZE)"
}
pause_node() {
  echo "SIGSTOP bench-2 (pid ${NODE_PID[2]}) for $1 s"; kill -STOP "${NODE_PID[2]}"; sleep "$1"; kill -CONT "${NODE_PID[2]}"; echo "SIGCONT bench-2"
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
      [ -n "$(docker ps -q -f name=ocbench-mariadb)" ] || mariadb_up
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
      [ -n "$(docker ps -q -f name=ocbench-mariadb)" ] || mariadb_up
      mariadb_reset
      docker rm -f ocbench-redis >/dev/null 2>&1
      docker run -d --name ocbench-redis -p 127.0.0.1:$REDIS_PORT:6379 redis:7-alpine >/dev/null || exit 1
      CONTAINERS+=(ocbench-redis); sleep 2
      local pids="" urls=""
      for n in 1 2 3; do
        port=$((8710 + n))
        start_server "$MARIA_URL" "$port" REDIS_URL="redis://127.0.0.1:$REDIS_PORT" OC_NODE_ID="bench-$n" \
          OC_CLUSTER_ADVERTISE="http://127.0.0.1:$port" OC_CLUSTER_SECRET="bench-cluster-secret-0123456789abcdef"
        pids="$pids${pids:+,}$SERVER_PID"; urls="$urls${urls:+,}http://127.0.0.1:$port"
      done
      lg E-cluster3 "$pids" "$urls" "${B_ARGS[@]}" --affinity hash
      grep -c 'relaying connection' "$WORK"/server-871*.log | tee -a "$OUT/E-cluster3.md"
      for p in ${pids//,/ }; do stop_server "$p"; done ;;
    S1)
      start_server "$(sqlite_url S1)"
      echo "# unix wal_rows wal_bytes snapshots snapshot_bytes db_bytes db_wal_bytes" > "$OUT/S1-wal.txt"
      wal_watch "$WORK/S1.db" "$OUT/S1-wal.raw"
      lg S1-sustained-550 "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room 550 --editors 1.0 --no-pauses \
        --probes 10 --doc demo --steps 550,550,550,550,550,550,550,550,550,550 --step-secs 55 --settle-secs 5 \
        --connect-rate 100 --sqlite "$WORK/S1.db"
      cat "$OUT/S1-wal.raw" >> "$OUT/S1-wal.txt"; grep -ciE '"level":"(ERROR|WARN)"' "$WORK/server-$OC_PORT.log" | sed 's/^/server warn+error lines: /' | tee -a "$OUT/S1-sustained-550.md"
      stop_server "$SERVER_PID" ;;
    S2)
      start_server "$(sqlite_url S2)"
      echo "# unix wal_rows wal_bytes snapshots snapshot_bytes db_bytes db_wal_bytes" > "$OUT/S2-wal.txt"
      wal_watch "$WORK/S2.db" "$OUT/S2-wal.raw"
      lg S2-sustained-1000x5 "$SERVER_PID" "http://127.0.0.1:$OC_PORT" --per-room 5 --editors 1.0 --no-pauses \
        --probes 5 --doc demo --steps 5000,5000,5000,5000,5000,5000,5000,5000,5000,5000 --step-secs 55 --settle-secs 5 \
        --connect-rate 250 --sqlite "$WORK/S2.db"
      cat "$OUT/S2-wal.raw" >> "$OUT/S2-wal.txt"; grep -ciE '"level":"(ERROR|WARN)"' "$WORK/server-$OC_PORT.log" | sed 's/^/server warn+error lines: /' | tee -a "$OUT/S2-sustained-1000x5.md"
      stop_server "$SERVER_PID" ;;
    R|mR)
      # The harness kill -9s the server it is given and runs RESTART, which starts a new one
      # (same database) and records its pid for cleanup.
      local db
      if [ "$1" = mR ]; then
        [ -n "$(docker ps -q -f name=ocbench-mariadb)" ] || mariadb_up
        mariadb_reset; db=$MARIA_URL
      else db=$(sqlite_url R); fi
      local kek; kek=$(openssl rand -base64 32)
      start_server "$db" "$OC_PORT" OC_KEK="$kek"
      local restart="env -u OC_DEV DATABASE_URL='$db' OC_KEK='$kek' OC_HOSTS_FILE='$WORK/hosts.toml' OC_BIND=127.0.0.1:$OC_PORT OC_PUBLIC_URL=http://127.0.0.1:$OC_PORT OC_LOG=info nohup $ROOT/$BIN >> '$WORK/server-$OC_PORT.restart.log' 2>&1 & echo \$! > '$WORK/restarted.pid'"
      echo; echo "== $1-crash"
      "$LG" verify --label "$1-crash" --server "http://127.0.0.1:$OC_PORT" --host-port "$HOST_PORT" --secret "$SECRET" \
        --rooms 200 --per-room 2 --secs 45 --crash-at 25 --kill-pid "$SERVER_PID" --restart "$restart" \
        --out "$OUT/$1-crash.json" | tee "$OUT/$1-crash.md"
      local np; np=$(cat "$WORK/restarted.pid" 2>/dev/null); [ -n "$np" ] && PIDS+=("$np")
      { echo "recovery log lines: $(grep -c 'recovered unsaved room state' "$WORK/server-$OC_PORT.restart.log")";
        echo "restart log errors: $(grep -ciE '"level":"ERROR"' "$WORK/server-$OC_PORT.restart.log")";
        grep -m1 -E 'listening|ready' "$WORK/server-$OC_PORT.restart.log"; } | tee -a "$OUT/$1-crash.md"
      [ -n "$np" ] && stop_server "$np" ;;
    K)
      cluster_up
      # Background load: 300 rooms x 5 (20 % editors) and one room of 550, spread like an LB.
      "$LG" run --label K-load-small --server "$CL_URLS" --server-pid "$CL_PIDS" --host-port "$HOST_PORT" --secret "$SECRET" \
        --per-room 5 --editors 0.2 --probes 5 --doc demo --steps 1500 --step-secs 170 --connect-rate 250 --affinity rr \
        --out "$OUT/K-load-small.json" > "$OUT/K-load-small.md" 2>&1 &
      PIDS+=($!)
      "$LG" run --label K-load-550 --server "$CL_URLS" --server-pid "$CL_PIDS" --host-port 8742 --host-id bench2 --secret "$SECRET" \
        --per-room 550 --editors 0.2 --probes 10 --doc demo --steps 550 --step-secs 170 --connect-rate 100 --affinity rr \
        --out "$OUT/K-load-550.json" > "$OUT/K-load-550.md" 2>&1 &
      PIDS+=($!)
      sleep 15
      # Verified rooms: 60 rooms x 3 typing clients, one per node (relay path).
      "$LG" verify --label K-chaos --server "$CL_URLS" --host-port 8752 --host-id bench3 --secret "$SECRET" \
        --rooms 60 --per-room 3 --spread 1 --secs 150 --save-wait-secs 20 --out "$OUT/K-chaos.json" > "$OUT/K-chaos.md" 2>&1 &
      local vpid=$!; PIDS+=("$vpid")
      lease_watch "$OUT/K-leases.txt"
      sleep 25; k_event "kill -9 the owner of the most rooms" kill_owner
      sleep 25; k_event "rolling restart" rolling_restart
      sleep 10; k_event "redis restart" redis_crash
      sleep 20; k_event "pause one node 20 s (SIGSTOP)" pause_node 20
      wait "$vpid"; cat "$OUT/K-chaos.md"
      for n in 1 2 3; do
        f="$WORK/server-871$n.log"
        echo "node $n: takeovers $(grep -c 'took the room over' "$f"), lease lost $(grep -ciE 'lost the room|lease lost|belongs to' "$f"), duplicate WAL seq $(grep -ciE 'duplicate' "$f"), errors $(grep -c '"ERROR"' "$f"), panics $(grep -ci panicked "$f")"
      done | tee -a "$OUT/K-chaos.md"
      cluster_down ;;
    K2)
      # Redis loss and a frozen node, both inside the verified typing window.
      cluster_up
      "$LG" run --label K2-load-small --server "$CL_URLS" --server-pid "$CL_PIDS" --host-port "$HOST_PORT" --secret "$SECRET" \
        --per-room 5 --editors 0.2 --probes 5 --doc demo --steps 1500 --step-secs 120 --connect-rate 250 --affinity rr \
        --out "$OUT/K2-load-small.json" > "$OUT/K2-load-small.md" 2>&1 &
      PIDS+=($!)
      sleep 10
      "$LG" verify --label K2-chaos --server "$CL_URLS" --host-port 8752 --host-id bench3 --secret "$SECRET" \
        --rooms 60 --per-room 3 --spread 1 --secs 100 --save-wait-secs 20 --out "$OUT/K2-chaos.json" > "$OUT/K2-chaos.md" 2>&1 &
      local vpid=$!; PIDS+=("$vpid")
      lease_watch "$OUT/K2-leases.txt"
      sleep 20; k_event "redis restart" redis_crash
      sleep 20; k_event "pause one node 20 s (SIGSTOP)" pause_node 20
      wait "$vpid"; cat "$OUT/K2-chaos.md"
      for n in 1 2 3; do
        f="$WORK/server-871$n.log"
        echo "node $n: takeovers $(grep -c 'took the room over' "$f"), stepped down $(grep -c 'stepping down' "$f"), duplicate WAL seq $(grep -ci 'duplicate entry' "$f"), errors $(grep -c '"ERROR"' "$f"), panics $(grep -ci panicked "$f")"
      done | tee -a "$OUT/K2-chaos.md"
      cluster_down ;;
    S2m)
      # S2's worst case for 3 minutes on MariaDB: is the WAL ceiling SQLite's?
      [ -n "$(docker ps -q -f name=ocbench-mariadb)" ] || mariadb_up
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
      echo "relayed connections: $(cat "$WORK"/server-871*.log | grep -c 'relaying connection')" | tee -a "$OUT/T3-3nodes-fresh.md"
      cluster_down ;;
    T)
      # Same load on 1 node, then on 3 (clients of a room on different nodes). Host 20-50 ms.
      local T_ARGS=(--per-room 5 --editors 0.2 --probes 5 --doc demo --steps ${T_STEPS:-1000,2500,5000} --step-secs 40 --connect-rate 250 --host-latency-ms 20,50)
      [ -n "$(docker ps -q -f name=ocbench-mariadb)" ] || mariadb_up
      mariadb_reset
      start_server "$MARIA_URL"
      lg T-1node "$SERVER_PID" "http://127.0.0.1:$OC_PORT" "${T_ARGS[@]}"
      stop_server "$SERVER_PID"
      cluster_up
      lg T-3nodes "$CL_PIDS" "$CL_URLS" "${T_ARGS[@]}" --affinity rr
      echo "relayed connections: $(cat "$WORK"/server-871*.log | grep -c 'relaying connection')" | tee -a "$OUT/T-3nodes.md"
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
