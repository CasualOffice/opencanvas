#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# Lists every tracked source file we wrote that lacks the SPDX licence identifier, and fails if
# there is any. Covered: Rust, Go, TypeScript, JavaScript, CSS, shell, Python, TOML, YAML, Helm
# templates, Dockerfiles, the nginx config, PHP (integrations/nextcloud). Left out: vendored and generated files (site output
# other than site/assets, site/_src/lucide), lockfiles, test fixtures and keys, JSON, Markdown
# and HTML pages.
#
#   scripts/check-spdx.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
ID='SPDX-License-Identifier: Apache-2.0'

files=$(git ls-files -- \
  '*.rs' '*.go' '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.css' '*.sh' '*.py' '*.toml' '*.yml' '*.yaml' \
  '*.tpl' '*.conf' '*Dockerfile' '*.dockerignore' '*.php' \
  | grep -Ev '(^|/)(node_modules|dist|target)/' \
  | grep -Ev '(^|/)(pnpm-lock\.yaml|Cargo\.lock|package-lock\.json)$' \
  | grep -Ev '/fixtures/[^/]*\.(rs|ts|js|css|py|toml|ya?ml)$' \
  | grep -Ev '^site/' ; git ls-files -- 'site/assets/*.css' 'site/assets/*.js')

missing=0; total=0
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  total=$((total + 1))
  if ! head -n 5 -- "$f" | grep -qF "$ID"; then
    echo "$f"
    missing=$((missing + 1))
  fi
done <<< "$files"

echo "check-spdx: $total files, $missing missing the identifier" >&2
[ "$missing" -eq 0 ]
