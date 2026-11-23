#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# Prepares the e2e Mattermost (docker-compose.yml) for mm-e2e.mjs: users admin (system admin,
# "Priya Raman"), alice and bob, team acme, channel sprint-planning, and the plugin bundle
# installed, configured and enabled. The image has no shell, so every step is a docker exec.
#
#   OC_URL=http://localhost:8095 OC_API_URL=http://host.docker.internal:8095 \
#   OC_SECRET=<jwt_secret> OC_API_KEY=<api_key> integrations/mattermost/e2e/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
C=${MM_CONTAINER:-oc-mattermost-e2e-mattermost-1}
mm() { docker exec "$C" mmctl --local "$@"; }

until docker exec "$C" mmctl --local system status >/dev/null 2>&1; do sleep 3; done
mm user create --email admin@example.com --username admin --password 'Admin-pass-123!' --system-admin --firstname Priya --lastname Raman || true
mm user create --email alice@example.com --username alice --password 'Alice-pass-123!' --firstname Alice --lastname Doe || true
mm user create --email bob@example.com --username bob --password 'Bobby-pass-123!' --firstname Bob --lastname Roe || true
mm team create --name acme --display-name Acme || true
mm team users add acme admin alice bob
mm channel create --team acme --name sprint-planning --display-name sprint-planning || true
mm channel users add acme:sprint-planning admin alice bob

docker cp dist/com.casualoffice.opencanvas-0.1.0.tar.gz "$C:/tmp/oc.tar.gz"
mm plugin add --force /tmp/oc.tar.gz
P=$(mktemp)
cat > "$P" <<JSON
{"PluginSettings": {"Plugins": {"com.casualoffice.opencanvas": {
  "opencanvasurl": "${OC_URL}", "opencanvasapiurl": "${OC_API_URL}", "hostid": "mattermost",
  "sharedsecret": "${OC_SECRET}", "apikey": "${OC_API_KEY}", "guestrole": "none", "tokenttlminutes": 10}}}}
JSON
docker cp "$P" "$C:/tmp/patch.json"
rm -f "$P"
mm config patch /tmp/patch.json >/dev/null
mm plugin enable com.casualoffice.opencanvas
echo "setup: ok"
