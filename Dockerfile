# ---- Stage 1: Build web UI ----
FROM node:20-alpine AS web-builder
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# ---- Stage 2: Build Rust server ----
FROM rust:1.87-bookworm AS server-builder
WORKDIR /build
# Cache dependency compilation: copy manifests first, then source
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release --bin nession-server

# ---- Stage 3: Runtime ----
FROM debian:bookworm-slim AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends nginx ca-certificates curl gettext-base && \
    rm -rf /var/lib/apt/lists/*

# Copy compiled binary
COPY --from=server-builder /build/target/release/nession-server /usr/local/bin/nession-server

# Copy web UI static assets
COPY --from=web-builder /build/dist /usr/share/nginx/html

# Copy nginx template and entrypoint
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create data and config directories
RUN mkdir -p /data /etc/nession && chown www-data:www-data /data

# Remove default nginx site to avoid port conflicts
RUN rm -f /etc/nginx/sites-enabled/default

WORKDIR /etc/nession
EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
