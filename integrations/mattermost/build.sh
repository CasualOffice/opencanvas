#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# Builds the plugin bundle dist/com.casualoffice.opencanvas-<version>.tar.gz: server binaries
# for Linux (amd64, arm64) and the webapp bundle. Tests first.
#
#   integrations/mattermost/build.sh            # server + webapp
#   SKIP_WEBAPP=1 integrations/mattermost/build.sh
set -euo pipefail
cd "$(dirname "$0")"
ID=com.casualoffice.opencanvas
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' plugin.json | head -n 1)

(cd server/canvas && go test ./...)
(cd server && go test ./... && for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -o dist/plugin-linux-$arch .
done)
if [ -z "${SKIP_WEBAPP:-}" ]; then
  (cd webapp && npm ci && npm run build)
fi

rm -rf dist && mkdir -p "dist/$ID/server" "dist/$ID/webapp"
cp plugin.json "dist/$ID/"
cp -r server/dist "dist/$ID/server/"
[ -d webapp/dist ] && cp -r webapp/dist "dist/$ID/webapp/"
COPYFILE_DISABLE=1 tar --format ustar --no-xattrs --no-mac-metadata -C dist -czf "dist/$ID-$VERSION.tar.gz" "$ID"
echo "dist/$ID-$VERSION.tar.gz"
