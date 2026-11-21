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
    "$BIN" > "$WORK/server-$port.log" 2>&1 &
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
    *) echo "unknown scenario $1"; exit 2 ;;
  esac
}

machine | tee "$OUT/machine.txt"
case $WHAT in
  all) for s in A B C D mA mB mD; do scenario "$s"; done ;;
  *) for s in ${WHAT//,/ }; do scenario "$s"; done ;;
esac
echo; echo "results in $OUT"
