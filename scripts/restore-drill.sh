#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# RLB-03: backup and restore drill (docs/13 "Backup and restore", RLB-A4).
#
#   1. start the server and put it under load (oc-bench verify: 50 rooms x 2 typing, 40 s);
#   2. take a backup while it runs (SQLite: `VACUUM INTO`; MySQL/MariaDB: `mysqldump
#      --single-transaction`);
#   3. after the backup, revoke a person's offline copies (generation g);
#   4. let the load finish (every edit converges and reaches the host), stop the server;
#   5. restore the backup into a new database and start with OC_RESTORED=1;
#   6. check: the server is ready, the database is intact, the restore epoch is set, the
#      revoked person's generation is above g (the revoked device stays revoked), and a new
#      load run on the restored database passes.
#
#   scripts/restore-drill.sh
#
# Store: SQLite in a temp dir, or DATABASE_URL=mysql://… with DRILL_MYSQL_EXEC (as in
# crash-drill.sh, with -i for the restore: "docker exec -i oc-mysql mysql -uroot -proot -N -e") and DRILL_MYSQL_DUMP
# (e.g. "docker exec oc-mysql mysqldump -uroot -proot"); without them the `mysql` and
# `mysqldump` clients are used. Ports DRILL_PORT/DRILL_HOST_PORT (9311/9312 + E2E_PORT_SHIFT).
# Only processes this script starts are stopped. Exit 0 when every check passes.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
TGT=${CARGO_TARGET_DIR:-target}; case $TGT in /*) ;; *) TGT=$ROOT/$TGT ;; esac
BIN=$TGT/release/opencanvas; LG=$TGT/release/oc-bench
[ -n "${SKIP_BUILD:-}" ] || cargo build -q --release -p oc-server --bin opencanvas -p oc-bench --bin oc-bench || exit 1
SHIFT=${E2E_PORT_SHIFT:-0}
PORT=${DRILL_PORT:-$((9311 + SHIFT))}; HOST_PORT=${DRILL_HOST_PORT:-$((9312 + SHIFT))}
for p in "$PORT" "$HOST_PORT"; do
  if nc -z 127.0.0.1 "$p" 2>/dev/null; then echo "port $p is in use"; exit 1; fi
done
WORK=$(mktemp -d)
SECRET=bench-secret-0123456789abcdef0123456789; KEY=bench-api-key-0123456789abcdef0123
KEK=$(openssl rand -base64 32)
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
api_key       = "$KEY"
callback_base = "http://127.0.0.1:$HOST_PORT/api"
EOF
MYSQL=${DATABASE_URL:-}
my_sql() {
  if [ -n "${DRILL_MYSQL_EXEC:-}" ]; then $DRILL_MYSQL_EXEC "$1" 2>/dev/null; return; fi
  local u=${MYSQL#mysql://}; local cred=${u%%@*} hp=${u#*@}; hp=${hp%%/*}
  mysql -h"${hp%%:*}" -P"${hp##*:}" -u"${cred%%:*}" -p"${cred#*:}" -N -e "$1" 2>/dev/null
}
my_dump() {
  if [ -n "${DRILL_MYSQL_DUMP:-}" ]; then $DRILL_MYSQL_DUMP --single-transaction "$1" 2>/dev/null; return; fi
  local u=${MYSQL#mysql://}; local cred=${u%%@*} hp=${u#*@}; hp=${hp%%/*}
  mysqldump -h"${hp%%:*}" -P"${hp##*:}" -u"${cred%%:*}" -p"${cred#*:}" --single-transaction "$1" 2>/dev/null
}
# sql <db name or sqlite path> <query>: one value per line.
sql() {
  if [ -z "$MYSQL" ]; then sqlite3 "$1" "$2"; else my_sql "USE $1; $2" | grep -v '^[a-z_]*$' ; fi
}
if [ -z "$MYSQL" ]; then
  LIVE=$WORK/live.db; RESTORED=$WORK/restored.db
  LIVE_URL="sqlite://$LIVE?mode=rwc"; RESTORED_URL="sqlite://$RESTORED?mode=rwc"
else
  LIVE=ocdrill_live; RESTORED=ocdrill_restored
  my_sql "DROP DATABASE IF EXISTS $LIVE; CREATE DATABASE $LIVE; DROP DATABASE IF EXISTS $RESTORED; CREATE DATABASE $RESTORED" >/dev/null
  LIVE_URL=${MYSQL%/*}/$LIVE; RESTORED_URL=${MYSQL%/*}/$RESTORED
fi
SERVER_PID=""
start() { # <db url> <log> [env…]
  local db=$1 log=$2; shift 2
  env -u OC_DEV OC_DURABILITY=wal DATABASE_URL="$db" OC_KEK="$KEK" OC_HOSTS_FILE="$WORK/hosts.toml" OC_BIND=127.0.0.1:$PORT \
    OC_PUBLIC_URL=http://127.0.0.1:$PORT OC_LOG=info "$@" "$BIN" >> "$log" 2>&1 &
  SERVER_PID=$!; PIDS+=("$SERVER_PID")
  for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null && return 0; sleep 0.5; done
  echo "FAIL: server not ready"; tail -5 "$log"; exit 1
}
stop() { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
revoke() {
  curl -sf -X POST "http://127.0.0.1:$PORT/api/v1/offline/revoke" -H "x-opencanvas-host: bench" \
    -H "x-opencanvas-key: $KEY" -H 'content-type: application/json' -d "{\"userId\":\"$1\"}" >/dev/null
}
FAIL=0
check() { if eval "$2"; then echo "pass: $1"; else echo "FAIL: $1"; FAIL=1; fi; }

echo "restore drill: store ${MYSQL:+mysql}${MYSQL:-sqlite}; work $WORK"
start "$LIVE_URL" "$WORK/live.log"
revoke u_before   # a revoke the backup holds
nice "$LG" verify --label restore-load --server "http://127.0.0.1:$PORT" --host-port "$HOST_PORT" --secret "$SECRET" \
  --rooms 50 --per-room 2 --secs 40 --out "$WORK/load.json" > "$WORK/load.md" 2>&1 &
LOAD=$!
# Take the backup once the load has written WAL rows (a condition, not a fixed wait).
for _ in $(seq 1 120); do
  n=$(sql "$LIVE" "SELECT COUNT(*) FROM room_updates" 2>/dev/null | tail -1)
  [ "${n:-0}" -gt 100 ] 2>/dev/null && break; sleep 0.5
done
echo "backup with ${n:-0} WAL rows"
if [ -z "$MYSQL" ]; then sqlite3 "$LIVE" "VACUUM INTO '$WORK/backup.db'"
else my_dump "$LIVE" > "$WORK/backup.sql"; fi
# After the backup: u_after is revoked for the first time, u_before again.
revoke u_after; revoke u_before
G_AFTER=$(sql "$LIVE" "SELECT MAX(gen) FROM offline_generation")
check "revokes recorded (highest generation ${G_AFTER:-none})" "[ \"${G_AFTER:-0}\" -ge 2 ]"
wait "$LOAD"; LOAD_RC=$?
check "load during the backup converged and reached the host" "[ $LOAD_RC -eq 0 ]"
stop

if [ -z "$MYSQL" ]; then cp "$WORK/backup.db" "$RESTORED"
else
  if [ -n "${DRILL_MYSQL_EXEC:-}" ]; then
    # DRILL_MYSQL_EXEC takes SQL as an argument: feed the dump through `source` is not possible
    # across containers, so replay it with the same client reading stdin.
    ${DRILL_MYSQL_EXEC% -e} "$RESTORED" < "$WORK/backup.sql" 2>/dev/null
  else my_sql "USE $RESTORED; source $WORK/backup.sql"; fi
fi
start "$RESTORED_URL" "$WORK/restored.log" OC_RESTORED=1
check "restored server is ready with OC_RESTORED=1" "true"
if [ -z "$MYSQL" ]; then
  check "integrity_check ok" "[ \"$(sqlite3 "$RESTORED" 'PRAGMA integrity_check')\" = ok ]"
fi
FLOOR=$(sql "$RESTORED" "SELECT gen_floor FROM restore_epoch WHERE id = 1" | tail -1)
check "restore epoch set (gen floor ${FLOOR:-none} > highest generation before the restore ${G_AFTER:-?})" "[ \"${FLOOR:-0}\" -gt \"${G_AFTER:-0}\" ]"
check "the backup does not hold the revoke made after it (u_after absent)" \
  "[ -z \"$(sql "$RESTORED" "SELECT gen FROM offline_generation WHERE user_id = 'u_after'" | tail -1)\" ]"
nice "$LG" verify --label restore-after --server "http://127.0.0.1:$PORT" --host-port "$HOST_PORT" --secret "$SECRET" \
  --rooms 20 --per-room 2 --secs 15 --out "$WORK/after.json" > "$WORK/after.md" 2>&1
check "load on the restored database converges and reaches the host" "[ $? -eq 0 ]"
stop
echo; [ $FAIL -eq 0 ] && echo "restore drill: all passed" || echo "restore drill: FAILED (logs in $WORK)"
exit $FAIL
