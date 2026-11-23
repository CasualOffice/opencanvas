# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# OpenCanvas server image. Build from the repo root:
#   docker build -f deploy/Dockerfile -t opencanvas .
# One binary + the built editor (/app/) + Noto fonts for board PNG / DOCX exports.
# SQLite under /data by default; set DATABASE_URL=mysql://… for MySQL / MariaDB.

# ---- server: release binary -------------------------------------------------------------
FROM rust:1.98-slim-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# Built-in diagram icons, shared by oc-model and the editor (DGM-17).
COPY icons icons
COPY migrations migrations
# jemalloc (the server's allocator, docs/22 §9.6) builds with make.
RUN apt-get update && apt-get install -y --no-install-recommends make && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p oc-server --bin opencanvas \
 && cp target/release/opencanvas /opencanvas

# ---- web: editor bundle (served at /app/) -----------------------------------------------
FROM node:24-slim AS web
WORKDIR /src/web
RUN corepack enable
# Manifests first so the dependency layer is cached across source changes.
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/tsconfig.base.json ./
COPY web/packages/board/package.json packages/board/
COPY web/packages/database/package.json packages/database/
COPY web/packages/editor/package.json packages/editor/
COPY web/packages/ui/package.json packages/ui/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY web/packages packages
COPY icons /src/icons
RUN pnpm --filter @opencanvas/editor build \
 && test -f packages/editor/dist/index.html

# ---- runtime ----------------------------------------------------------------------------
FROM debian:bookworm-slim
# Fonts for in-process rendering (oc_model::fonts): Noto for most scripts, Noto CJK for
# Chinese/Japanese/Korean. Serif CJK is dropped (the board renders sans only) to save ~100 MB.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fonts-noto-core fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* \
 && rm -f /usr/share/fonts/opentype/noto/NotoSerifCJK-* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin opencanvas \
 && mkdir -p /data /etc/opencanvas /opt/opencanvas/fonts \
 && chown opencanvas /data
COPY --from=server /opencanvas /usr/local/bin/opencanvas
COPY --from=web /src/web/packages/editor/dist /srv/web
COPY opencanvas.hosts.toml /etc/opencanvas/hosts.toml
# System fonts (/usr/share/fonts) load automatically; OC_FONT_DIRS adds operator fonts
# (mount a volume at /opt/opencanvas/fonts, or append more directories with ':').
ENV OC_BIND=0.0.0.0:8080 \
    OC_WEB_DIR=/srv/web \
    OC_HOSTS_FILE=/etc/opencanvas/hosts.toml \
    OC_FONT_DIRS=/opt/opencanvas/fonts \
    DATABASE_URL=sqlite:///data/opencanvas.db?mode=rwc \
    OC_LOG=info
USER 10001:10001
VOLUME /data
EXPOSE 8080
STOPSIGNAL SIGTERM
# No curl in the image: bash's /dev/tcp is enough for a liveness probe on the default port.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /healthz HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["/usr/local/bin/opencanvas"]
