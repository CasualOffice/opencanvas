# OpenCanvas server image. Build from the repo root:
#   docker build -f deploy/Dockerfile -t opencanvas .
# Single binary + the built editor; SQLite under /data by default.

FROM rust:1.98-slim AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY migrations migrations
RUN cargo build --release --locked -p oc-server --bin opencanvas

FROM node:24-slim AS web
WORKDIR /src/web
COPY web/ ./
# The editor is built when it exists in the workspace; otherwise the image serves the API only.
RUN mkdir -p packages/editor/dist \
 && if [ -f packages/editor/package.json ]; then \
      corepack enable && pnpm install --no-frozen-lockfile && pnpm --filter ./packages/editor build; \
    else echo "web/packages/editor not present: image serves the API only"; fi

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 opencanvas && mkdir -p /data /etc/opencanvas && chown opencanvas /data
COPY --from=server /src/target/release/opencanvas /usr/local/bin/opencanvas
COPY --from=web /src/web/packages/editor/dist /srv/web
COPY opencanvas.hosts.toml /etc/opencanvas/hosts.toml
ENV OC_BIND=0.0.0.0:8080 \
    OC_WEB_DIR=/srv/web \
    OC_HOSTS_FILE=/etc/opencanvas/hosts.toml \
    DATABASE_URL=sqlite:///data/opencanvas.db?mode=rwc \
    OC_LOG=info
USER opencanvas
VOLUME /data
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/opencanvas"]
