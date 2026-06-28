# ---- Stage 1: Prepare cargo-chef recipe ----
FROM rust:1.88-bookworm AS planner
WORKDIR /build
RUN cargo install cargo-chef --locked
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# ---- Stage 2: Build dependencies (cached layer) ----
FROM rust:1.88-bookworm AS cacher
WORKDIR /build
RUN cargo install cargo-chef --locked
COPY --from=planner /build/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# ---- Stage 3: Build web UI ----
FROM node:20-alpine AS web-builder
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# ---- Stage 4: Build Rust server with cached dependencies ----
FROM rust:1.88-bookworm AS server-builder
WORKDIR /build

# Copy cached dependencies from cacher stage
COPY --from=cacher /build/target target
COPY --from=cacher /build/.cargo .cargo

# Copy manifests to preserve cache
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/

# Copy source code (changes frequently, but dependencies are cached)
COPY . .

# Build the server binary
RUN cargo build --release --bin nession-server

# ---- Stage 5: Runtime ----
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
