#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# RLB-01: single-node crash drills (docs/36 §5.1, docs/13 "Crash drills"). Three `kill -9`s:
#
#   edits      kill -9 while every client types; restart on the same database; every edit
#              another client had received (acknowledged) is in the recovered state, every room
#              converges and the host's last save holds every edit (`oc-bench verify --crash-at`).
#   save       the same with a slow host (every save callback waits 1.5-2.5 s), so the kill
#              lands while saves are in flight: the commit outbox resumes after the restart.
#   migration  start on an empty database and kill -9 after D ms, for several D (inside the
#              migrations); the next start must become ready on the same database, then the
#              edits drill runs on it.
#
#   scripts/crash-drill.sh [--reduced] [edits|save|migration ...]
#
# Store: SQLite in a temp dir, or DATABASE_URL=mysql://user:pass@host:port/db (MySQL 8.4,
# MariaDB 10.11). The migration drill needs fresh MySQL databases: it runs SQL with the `mysql`
# client, or with DRILL_MYSQL_EXEC (e.g. "docker exec oc-mysql mysql -uroot -proot -e").
# DRILL_DURABILITY: wal (default; every edit in the WAL before fan-out) or memory (ADR-029).
# --reduced: 100 rooms x 2 for 30 s (the nightly); default 200 x 2 for 45 s.
# Ports: DRILL_PORT (default 9301), DRILL_HOST_PORT (9302), both shifted by E2E_PORT_SHIFT.
# Only the processes this script starts are stopped. Exit 0 when every drill passed.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
ROOMS=200; SECS=45; CRASH_AT=25; DRILLS=()
for a in "$@"; do
  case $a in
    --reduced) ROOMS=100; SECS=30; CRASH_AT=15 ;;
    edits|save|migration) DRILLS+=("$a") ;;
    *) sed -n '5,25p' "$0"; exit 2 ;;
  esac
done
[ ${#DRILLS[@]} -eq 0 ] && DRILLS=(edits save migration)
TGT=${CARGO_TARGET_DIR:-target}; case $TGT in /*) ;; *) TGT=$ROOT/$TGT ;; esac
BIN=$TGT/release/opencanvas; LG=$TGT/release/oc-bench
[ -n "${SKIP_BUILD:-}" ] || cargo build -q --release -p oc-server --bin opencanvas -p oc-bench --bin oc-bench || exit 1
SHIFT=${E2E_PORT_SHIFT:-0}
PORT=${DRILL_PORT:-$((9301 + SHIFT))}; HOST_PORT=${DRILL_HOST_PORT:-$((9302 + SHIFT))}
for p in "$PORT" "$HOST_PORT"; do
  if nc -z 127.0.0.1 "$p" 2>/dev/null; then echo "port $p is in use (set DRILL_PORT / DRILL_HOST_PORT)"; exit 1; fi
done
WORK=$(mktemp -d); OUT=${OUT:-$ROOT/bench/results}; mkdir -p "$OUT"
SECRET=bench-secret-0123456789abcdef0123456789
KEK=$(openssl rand -base64 32); DUR=${DRILL_DURABILITY:-wal}
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT
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
echo "crash drill: ${DRILLS[*]}; ${ROOMS} rooms x 2, ${SECS} s; store ${DATABASE_URL:+mysql}${DATABASE_URL:-sqlite}; work $WORK"

# mysql_sql <sql>: on the server of DATABASE_URL (no database selected).
mysql_sql() {
  if [ -n "${DRILL_MYSQL_EXEC:-}" ]; then $DRILL_MYSQL_EXEC "$1"; return; fi
  local u=${DATABASE_URL#mysql://}; local cred=${u%%@*} hp=${u#*@}; hp=${hp%%/*}
  mysql -h"${hp%%:*}" -P"${hp##*:}" -u"${cred%%:*}" -p"${cred#*:}" -e "$1" 2>/dev/null
}
# fresh_db <name>: prints a URL for a new, empty database.
fresh_db() {
  if [ -z "${DATABASE_URL:-}" ]; then echo "sqlite://$WORK/$1.db?mode=rwc"; return; fi
  mysql_sql "DROP DATABASE IF EXISTS $1; CREATE DATABASE $1" >/dev/null || { echo "cannot create database $1 (mysql client or DRILL_MYSQL_EXEC)" >&2; exit 1; }
  echo "${DATABASE_URL%/*}/$1"
}
SERVER_PID=""
# start <db> <log>: starts the server in the background (no wait).
start() {
  env -u OC_DEV OC_DURABILITY="$DUR" DATABASE_URL="$1" OC_KEK="$KEK" OC_HOSTS_FILE="$WORK/hosts.toml" OC_BIND=127.0.0.1:$PORT \
    OC_PUBLIC_URL=http://127.0.0.1:$PORT OC_LOG=info "$BIN" >> "$2" 2>&1 &
  SERVER_PID=$!; PIDS+=("$SERVER_PID")
}
ready() {
  for _ in $(seq 1 300); do
    curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}
FAIL=0
# verify_crash <label> <db> [oc-bench options]: the server must be running on <db>.
verify_crash() {
  local label=$1 db=$2; shift 2
  local restart="env -u OC_DEV OC_DURABILITY=$DUR DATABASE_URL='$db' OC_KEK='$KEK' OC_HOSTS_FILE='$WORK/hosts.toml' OC_BIND=127.0.0.1:$PORT OC_PUBLIC_URL=http://127.0.0.1:$PORT OC_LOG=info nohup $BIN >> '$WORK/$label.restart.log' 2>&1 & echo \$! > '$WORK/$label.pid'"
  echo; echo "== $label"
  nice "$LG" verify --label "$label" --server "http://127.0.0.1:$PORT" --host-port "$HOST_PORT" --secret "$SECRET" \
    --rooms "$ROOMS" --per-room 2 --secs "$SECS" --crash-at "$CRASH_AT" --kill-pid "$SERVER_PID" --restart "$restart" \
    --durability "$DUR" "$@" --out "$OUT/crash-drill-$label.json" | tee "$WORK/$label.md" | tail -15
  local rc=${PIPESTATUS[0]}
  local np; np=$(cat "$WORK/$label.pid" 2>/dev/null)
  if [ -n "$np" ]; then
    PIDS+=("$np"); kill "$np" 2>/dev/null
    # Not our child: wait until it has exited (graceful drain), up to 60 s.
    for _ in $(seq 1 120); do kill -0 "$np" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$np" 2>/dev/null
  fi
  echo "restart log errors: $(grep -ciE '"level":"ERROR"' "$WORK/$label.restart.log" 2>/dev/null)"
  if [ "$rc" -ne 0 ]; then echo "FAIL: $label"; FAIL=1; else echo "pass: $label"; fi
}

for d in "${DRILLS[@]}"; do
  case $d in
    edits|save)
      db=$(fresh_db "ocdrill_$d"); start "$db" "$WORK/$d.log"
      ready || { echo "FAIL: $d: server not ready"; tail -5 "$WORK/$d.log"; FAIL=1; continue; }
      if [ "$d" = save ]; then verify_crash "$d" "$db" --host-latency-ms 1500,2500
      else verify_crash "$d" "$db"; fi ;;
    migration)
      # Delays from "before the first statement" to "after the last migration".
      for ms in 20 60 120 250 500 1000; do
        db=$(fresh_db "ocdrill_mig$ms"); start "$db" "$WORK/mig$ms.log"
        sleep "$(awk "BEGIN{print $ms/1000}")"   # the fault's timing, not a wait for a condition
        kill -9 "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null
        start "$db" "$WORK/mig$ms.after.log"
        if ready; then echo "pass: migration kill at ${ms} ms, next start ready"
        else echo "FAIL: migration kill at ${ms} ms: the next start did not become ready"; grep -m3 -iE "error|partially" "$WORK/mig$ms.after.log"; FAIL=1; fi
        kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null
      done
      db=$(fresh_db ocdrill_migload); start "$db" "$WORK/migload.log"; sleep 0.1
      kill -9 "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null
      start "$db" "$WORK/migload.after.log"
      if ready; then verify_crash migration-then-edits "$db"; else echo "FAIL: migration-then-edits: not ready"; FAIL=1; fi ;;
  esac
done
echo; [ $FAIL -eq 0 ] && echo "crash drill: all passed" || echo "crash drill: FAILED (logs in $WORK)"
exit $FAIL
