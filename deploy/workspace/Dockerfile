# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

# OpenCanvas Workspace by CasualOffice (ADR-085, docs/40): the Workspace and the engine in one
# image, one process, one port. Build from the repo root:
#   docker build -f deploy/workspace/Dockerfile -t ghcr.io/casualoffice/opencanvas-workspace .
#   docker run -p 8080:8080 -v opencanvas:/data ghcr.io/casualoffice/opencanvas-workspace
# Lightweight (owner decision 3): one binary, the two web apps, Noto core fonts for exports.
# CJK fonts are optional: --build-arg CJK_FONTS=1 adds them (about +100 MB).

FROM rust:1.98-slim-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY icons icons
COPY migrations migrations
RUN apt-get update && apt-get install -y --no-install-recommends make && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p oc-workspace --bin opencanvas-workspace \
 && cp target/release/opencanvas-workspace /opencanvas-workspace

FROM node:24-slim AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/tsconfig.base.json ./
COPY web/packages/board/package.json packages/board/
COPY web/packages/database/package.json packages/database/
COPY web/packages/editor/package.json packages/editor/
COPY web/packages/ui/package.json packages/ui/
COPY web/packages/workspace/package.json packages/workspace/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY web/packages packages
COPY icons /src/icons
RUN pnpm --filter @opencanvas/editor build \
 && pnpm --filter @opencanvas/workspace build \
 && test -f packages/editor/dist/index.html \
 && test -f packages/workspace/dist/index.html

FROM debian:bookworm-slim
ARG CJK_FONTS=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fonts-noto-core \
 && if [ "$CJK_FONTS" = "1" ]; then apt-get install -y --no-install-recommends fonts-noto-cjk && rm -f /usr/share/fonts/opentype/noto/NotoSerifCJK-*; fi \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin opencanvas \
 && mkdir -p /data /opt/opencanvas/fonts \
 && chown opencanvas /data
COPY --from=server /opencanvas-workspace /usr/local/bin/opencanvas-workspace
COPY --from=web /src/web/packages/editor/dist /srv/web
COPY --from=web /src/web/packages/workspace/dist /srv/workspace
ENV WS_BIND=0.0.0.0:8080 \
    WS_DATA_DIR=/data \
    WS_WEB_DIR=/srv/workspace \
    OC_WEB_DIR=/srv/web \
    OC_FONT_DIRS=/opt/opencanvas/fonts \
    WS_LOG=info
USER 10001:10001
VOLUME /data
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /api/ws/healthz HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["/usr/local/bin/opencanvas-workspace"]
