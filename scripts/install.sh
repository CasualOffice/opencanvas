#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
#
# Installs the OpenCanvas server from a GitHub release (Linux x86_64 and aarch64).
#
#   curl -fsSL https://github.com/CasualOffice/opencanvas/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version v0.4.3 --bin-dir ~/bin
#
# It picks the archive for this machine, checks it against the release's SHA256SUMS (or the
# archive's own .sha256 on releases before SHA256SUMS existed), and installs:
#   <share>/            the server binary, the editor bundle (web/), LICENSE, NOTICE
#   <bin>/opencanvas    a launcher that sets OC_WEB_DIR to <share>/web and runs the server
# <bin> is /usr/local/bin as root and ~/.local/bin otherwise; <share> is /usr/local/share/opencanvas
# as root and ${XDG_DATA_HOME:-~/.local/share}/opencanvas otherwise.
#
# macOS and Windows have no prebuilt binary: use the container image or build from source.
#
# Options (or environment variables):
#   --version TAG     OPENCANVAS_VERSION      a release tag (v0.4.3 or 0.4.3); default: the latest
#   --bin-dir DIR     OPENCANVAS_BIN_DIR      where the launcher goes
#   --share-dir DIR   OPENCANVAS_SHARE_DIR    where the binary and the editor bundle go
#   OPENCANVAS_OS, OPENCANVAS_ARCH            override detection (linux; x86_64 or aarch64)
set -eu

REPO="CasualOffice/opencanvas"
IMAGE="ghcr.io/casualoffice/opencanvas"
# The release workflow sets this in the copy it attaches to a release, so that copy installs
# its own release. Empty here: the latest release.
DEFAULT_VERSION=""

say() { printf '%s\n' "opencanvas-install: $*" >&2; }
die() { say "$*"; exit 1; }

version="${OPENCANVAS_VERSION:-$DEFAULT_VERSION}"
bin_dir="${OPENCANVAS_BIN_DIR:-}"
share_dir="${OPENCANVAS_SHARE_DIR:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a tag"; version="$2"; shift 2 ;;
    --version=*) version="${1#*=}"; shift ;;
    --bin-dir) [ $# -ge 2 ] || die "--bin-dir needs a directory"; bin_dir="$2"; shift 2 ;;
    --bin-dir=*) bin_dir="${1#*=}"; shift ;;
    --share-dir) [ $# -ge 2 ] || die "--share-dir needs a directory"; share_dir="$2"; shift 2 ;;
    --share-dir=*) share_dir="${1#*=}"; shift ;;
    -h|--help) echo "usage: install.sh [--version TAG] [--bin-dir DIR] [--share-dir DIR]  (https://github.com/$REPO/blob/main/scripts/install.sh)"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

os="${OPENCANVAS_OS:-$(uname -s)}"
case "$os" in
  Linux|linux) os=linux ;;
  Darwin|darwin)
    die "macOS has no prebuilt OpenCanvas binary (releases ship Linux x86_64 and aarch64 only).
  Use the container image:  docker run -p 8080:8080 -e OC_DEV=1 $IMAGE:latest
  or build from source:     https://github.com/$REPO#run-it" ;;
  *) die "no prebuilt binary for $os. Use the container image ($IMAGE) or build from source: https://github.com/$REPO#run-it" ;;
esac

arch="${OPENCANVAS_ARCH:-$(uname -m)}"
case "$arch" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) die "no prebuilt binary for linux/$arch (x86_64 and aarch64 only). Use the container image or build from source." ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
  final_url() { curl -fsSLI --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --https-only -O "$2" "$1"; }
  final_url() { wget -q --https-only --max-redirect=5 -S --spider "$1" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tail -n1 | tr -d '\r'; }
else
  die "needs curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "needs sha256sum or shasum to check the download"
fi

if [ -z "$version" ]; then
  url=$(final_url "https://github.com/$REPO/releases/latest") || die "could not reach GitHub to find the latest release"
  version="${url##*/tag/}"
  case "$version" in v[0-9]*) ;; *) die "could not find the latest release (got $url)" ;; esac
fi
case "$version" in v*) ;; *) version="v$version" ;; esac

name="opencanvas-$version-linux-$arch"
base="https://github.com/$REPO/releases/download/$version"
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t opencanvas)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $name.tar.gz ($version)"
fetch "$base/$name.tar.gz" "$tmp/$name.tar.gz" || die "no $name.tar.gz in release $version ($base)"

# The checksum: SHA256SUMS from the release, else the archive's own .sha256 (older releases).
if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
  want=$(awk -v f="$name.tar.gz" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  src=SHA256SUMS
else
  fetch "$base/$name.tar.gz.sha256" "$tmp/one.sha256" || die "release $version has no checksum for $name.tar.gz; not installing"
  want=$(cut -d' ' -f1 "$tmp/one.sha256")
  src="$name.tar.gz.sha256"
fi
[ -n "$want" ] || die "$src lists no checksum for $name.tar.gz; not installing"
got=$(sha256 "$tmp/$name.tar.gz")
[ "$got" = "$want" ] || die "checksum mismatch for $name.tar.gz: expected $want, got $got; not installing"
say "checksum OK ($src)"

tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
[ -x "$tmp/$name/opencanvas" ] || die "the archive has no $name/opencanvas"

if [ "$(id -u)" = 0 ]; then
  : "${bin_dir:=/usr/local/bin}"
  : "${share_dir:=/usr/local/share/opencanvas}"
else
  : "${bin_dir:=$HOME/.local/bin}"
  : "${share_dir:=${XDG_DATA_HOME:-$HOME/.local/share}/opencanvas}"
fi
mkdir -p "$bin_dir" "$share_dir" || die "cannot create $bin_dir or $share_dir (set --bin-dir/--share-dir, or run as root)"

# Replace the previous install as a whole, so no stale editor files remain.
rm -rf "$share_dir/web"
cp -R "$tmp/$name/web" "$share_dir/web"
for f in LICENSE NOTICE README.md RUN.txt; do
  [ -f "$tmp/$name/$f" ] && cp "$tmp/$name/$f" "$share_dir/$f"
done
cp "$tmp/$name/opencanvas" "$share_dir/opencanvas.new"
chmod 755 "$share_dir/opencanvas.new"
mv -f "$share_dir/opencanvas.new" "$share_dir/opencanvas"
printf '%s\n' "$version" > "$share_dir/VERSION"

cat > "$bin_dir/opencanvas.new" <<EOF
#!/bin/sh
# OpenCanvas $version launcher, written by install.sh: the server with its editor bundle.
: "\${OC_WEB_DIR:=$share_dir/web}"
export OC_WEB_DIR
exec "$share_dir/opencanvas" "\$@"
EOF
chmod 755 "$bin_dir/opencanvas.new"
mv -f "$bin_dir/opencanvas.new" "$bin_dir/opencanvas"

say "installed OpenCanvas $version: $bin_dir/opencanvas (files in $share_dir)"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) say "add $bin_dir to PATH, e.g.: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
say "run it: OC_HOSTS_FILE=./hosts.toml OC_KEK=\$(openssl rand -base64 32) opencanvas   (try it without a key: OC_DEV=1 opencanvas)"
say "settings: https://github.com/$REPO/blob/$version/docs/13-OPERATIONS-AND-DEPLOYMENT.md"
