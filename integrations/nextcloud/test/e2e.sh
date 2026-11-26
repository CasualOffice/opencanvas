#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# Full Nextcloud integration test (NC-03): a stock `nextcloud:31-apache` (SQLite) in Docker with
# this app installed, a real OpenCanvas server built from this checkout, and Playwright Chromium
# through Files: create a canvas from the New menu, open it, edit, see it saved, share it
# read-only, unified search (SRCH-05) and open the hit at its block, delete it and see it leave
# the search index; the LEGAL-01 line on the app's listing text. Removes its container at the end.
#
#   integrations/nextcloud/test/e2e.sh          # from the repository root
#
# Environment (all optional):
#   NC_IMAGE   nextcloud:31-apache      NC_PORT 8490 (Nextcloud)     OC_PORT 8680 (OpenCanvas)
#   OC_BIN     an opencanvas binary (default: cargo build --release -p oc-server)
#   PLAYWRIGHT path to the playwright package (default: e2e/node_modules/playwright, npm ci there)
#   OC_LISTEN  OpenCanvas listen address (127.0.0.1; 0.0.0.0 on Linux)
#   KEEP=1     leave the container running for a look afterwards (remove it with
#              `docker rm -f oc-nc-e2e`)
# Needs docker, node 20+, openssl, curl; the editor and the app front end are built if missing.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
APP="$ROOT/integrations/nextcloud/opencanvas"
NC_IMAGE=${NC_IMAGE:-nextcloud:31-apache}
NC_PORT=${NC_PORT:-8490}
OC_PORT=${OC_PORT:-8680}
NAME=${NC_CONTAINER:-oc-nc-e2e}
# The container reaches OpenCanvas through host-gateway: loopback on Docker Desktop, the bridge
# address on Linux (so OpenCanvas listens on every interface there).
if [ "$(uname)" = Linux ]; then OC_LISTEN=${OC_LISTEN:-0.0.0.0}; else OC_LISTEN=${OC_LISTEN:-127.0.0.1}; fi
NC=http://localhost:$NC_PORT
OC=http://localhost:$OC_PORT
WORK=$(mktemp -d)
OC_PID=
cleanup() {
  [ -n "$OC_PID" ] && kill "$OC_PID" 2>/dev/null || true
  if [ "${KEEP:-}" != 1 ]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
say() { echo "# $*"; }
die() { echo "FAIL: $*"; [ -f "$WORK/oc.log" ] && { echo "--- oc.log"; tail -30 "$WORK/oc.log"; }; exit 1; }
occ() { docker exec -u www-data "$NAME" php occ "$@"; }

# 1. Builds.
if [ -z "${OC_BIN:-}" ]; then
  say "building oc-server (release)"
  (cd "$ROOT" && cargo build -q --release -p oc-server --bins)
  OC_BIN="${CARGO_TARGET_DIR:-$ROOT/target}/release/opencanvas"
fi
[ -x "$OC_BIN" ] || die "no opencanvas binary at $OC_BIN"
if [ ! -f "$ROOT/web/packages/editor/dist/index.html" ]; then
  say "building the editor"
  (cd "$ROOT/web" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter @opencanvas/editor build >/dev/null)
fi
if [ ! -d "$APP/js" ]; then
  say "building the app front end"
  (cd "$APP" && npm ci --silent && npm run build >/dev/null)
fi
PLAYWRIGHT=${PLAYWRIGHT:-$ROOT/e2e/node_modules/playwright}
if [ ! -d "$PLAYWRIGHT" ]; then
  say "installing Playwright (e2e/)"
  (cd "$ROOT/e2e" && npm ci --silent && npx playwright install chromium >/dev/null)
fi

# 2. Nextcloud.
say "starting $NC_IMAGE on :$NC_PORT"
docker rm -f "$NAME" >/dev/null 2>&1 || true
ADMIN_PASS=$(openssl rand -hex 12)
docker run -d --name "$NAME" -p "$NC_PORT:80" --add-host host.docker.internal:host-gateway \
  -e SQLITE_DATABASE=nextcloud -e NEXTCLOUD_ADMIN_USER=admin -e NEXTCLOUD_ADMIN_PASSWORD="$ADMIN_PASS" \
  -e NEXTCLOUD_TRUSTED_DOMAINS="localhost host.docker.internal" \
  -v "$APP:/src/opencanvas:ro" "$NC_IMAGE" >/dev/null
for _ in $(seq 1 180); do
  curl -sf "$NC/status.php" 2>/dev/null | grep -q '"installed":true' && break
  sleep 1
done
curl -sf "$NC/status.php" | grep -q '"installed":true' || die "Nextcloud did not finish installing"
say "Nextcloud $(curl -s "$NC/status.php" | sed 's/.*"versionstring":"\([^"]*\)".*/\1/') installed"
occ app:disable firstrunwizard >/dev/null 2>&1 || true
occ config:system:set allow_local_remote_servers --value=true --type=boolean >/dev/null
for u in alice bob; do
  docker exec -u www-data -e OC_PASS="pw-$u-$ADMIN_PASS" "$NAME" php occ user:add --password-from-env "$u" >/dev/null
done
# The app is copied in (without node_modules) after the install: a bind mount into custom_apps
# leaves that directory unwritable and the installer refuses to run.
docker exec "$NAME" sh -c 'mkdir -p /var/www/html/custom_apps/opencanvas && tar -C /src/opencanvas --exclude=./node_modules -cf - . | tar -C /var/www/html/custom_apps/opencanvas -xf - && chown -R www-data: /var/www/html/custom_apps/opencanvas'
occ app:enable opencanvas >/dev/null
occ maintenance:mimetype:update-js >/dev/null

# 3. OpenCanvas, registered for this Nextcloud (README "Install").
WOPI_BASE="$NC/index.php/apps/opencanvas/wopi"
API_KEY=$(openssl rand -hex 24)
cat > "$WORK/hosts.toml" <<EOF
[[host]]
id              = "nextcloud"
name            = "Nextcloud"
mode            = "wopi"
wopi_allowlist  = ["$WOPI_BASE"]
allowed_origins = ["$NC"]
api_key         = "env:NC_OC_API_KEY"
[host.flags]
on_conflict     = "copy"
EOF
openssl genrsa -out "$WORK/proof.pem" 2048 2>/dev/null
say "starting OpenCanvas on :$OC_PORT"
env -u OC_DEV NC_OC_API_KEY="$API_KEY" DATABASE_URL="sqlite://$WORK/oc.db?mode=rwc" \
  OC_KEK="$(openssl rand -base64 32)" OC_WOPI_PROOF_KEY="$WORK/proof.pem" OC_HOSTS_FILE="$WORK/hosts.toml" \
  OC_BIND="$OC_LISTEN:$OC_PORT" OC_PUBLIC_URL="$OC" OC_WEB_DIR="$ROOT/web/packages/editor/dist" \
  OC_AUTOSAVE_DEBOUNCE_MS=1000 "$OC_BIN" > "$WORK/oc.log" 2>&1 &
OC_PID=$!
for _ in $(seq 1 60); do curl -sf "$OC/readyz" >/dev/null && break; sleep 0.5; done
curl -sf "$OC/readyz" >/dev/null || die "OpenCanvas did not start"
occ config:app:set opencanvas opencanvas_url --value="$OC" >/dev/null
occ config:app:set opencanvas opencanvas_internal_url --value="http://host.docker.internal:$OC_PORT" >/dev/null
occ config:app:set opencanvas wopi_base --value="$WOPI_BASE" >/dev/null
occ config:app:set opencanvas opencanvas_api_key --value="$API_KEY" --sensitive >/dev/null
CHECK=$(curl -s -u "admin:$ADMIN_PASS" -X POST -H 'OCS-APIREQUEST: true' "$NC/index.php/apps/opencanvas/settings/check")
echo "$CHECK" | grep -q '"ok":true' || die "connection check: $CHECK"
say "connection check: 4/4"

# 4. The browser run.
NC="$NC" NC_CONTAINER="$NAME" PLAYWRIGHT="$PLAYWRIGHT" \
  NC_PASS_ADMIN="$ADMIN_PASS" NC_PASS_ALICE="pw-alice-$ADMIN_PASS" NC_PASS_BOB="pw-bob-$ADMIN_PASS" \
  node "$APP/tests/browser/nextcloud-full.e2e.mjs" || die "browser run failed"
