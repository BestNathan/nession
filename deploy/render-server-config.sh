#!/bin/sh
# Render the Server's config.toml from the process environment (#2487 SC-08).
#
# This is the one owner of the deployment-variable → TOML projection. The
# image entrypoint calls it before exec'ing the Server; an acceptance Case
# calls it directly and then feeds the result to the real `ServerConfig`
# parser, so "the running Server reads these values" is proven without
# starting nginx or a listener.
#
# Values are deliberately written through unvalidated here. The canonical
# readers validate: `ServerConfig::apply_env_overrides` (environment) and the
# startup `validate` call reject an out-of-range or non-numeric value before
# the listener binds. An invalid `NESSION_TERMINAL_COLS` therefore fails the
# process, not a shell regex that could drift from the Rust rule.
set -eu
# Generated config includes the Server token; never write it world-readable.
umask 077

out="${1:?usage: render-server-config.sh <config.toml path>}"

SERVER_LISTEN="${SERVER_LISTEN:-0.0.0.0:18080}"
SERVER_AUTH_TOKEN="${SERVER_AUTH_TOKEN:-}"
SERVER_ALLOWED_ORIGINS="${SERVER_ALLOWED_ORIGINS:-}"
SERVER_ALLOW_INSECURE_REMOTE="${SERVER_ALLOW_INSECURE_REMOTE:-false}"
TLS_CERT_PATH="${TLS_CERT_PATH:-}"
TLS_KEY_PATH="${TLS_KEY_PATH:-}"
SERVER_HEARTBEAT_INTERVAL="${SERVER_HEARTBEAT_INTERVAL:-10}"
SERVER_HEARTBEAT_TIMEOUT="${SERVER_HEARTBEAT_TIMEOUT:-30}"
NESSION_TERMINAL_COLS="${NESSION_TERMINAL_COLS:-96}"
NESSION_TERMINAL_WEB_FONT_SIZE="${NESSION_TERMINAL_WEB_FONT_SIZE:-14}"

case "$SERVER_ALLOW_INSECURE_REMOTE" in
  true|false) ;;
  *) echo "SERVER_ALLOW_INSECURE_REMOTE must be true or false" >&2; exit 1 ;;
esac

# Project the comma-separated browser-origin allowance into a TOML array.
# Entries are written unvalidated, like every value in this projection: the
# canonical `ServerConfig::validate` rejects an entry that is not `http(s)://`
# or `"null"` before the listener binds (#4066).
allowed_origins=""
set -f
old_ifs=$IFS
IFS=,
for origin in $SERVER_ALLOWED_ORIGINS; do
  [ -n "$origin" ] || continue
  allowed_origins="${allowed_origins}${allowed_origins:+, }\"${origin}\""
done
IFS=$old_ifs
set +f

mkdir -p "$(dirname "$out")"

# db_path intentionally omitted: the binary resolves it from NESSION_HOME (or
# $HOME/.nession as fallback).
cat > "$out" <<TOML
listen_address = "${SERVER_LISTEN}"
auth_token = "${SERVER_AUTH_TOKEN}"
allowed_origins = [${allowed_origins}]
allow_insecure_remote = ${SERVER_ALLOW_INSECURE_REMOTE}
tls_cert_path = "${TLS_CERT_PATH}"
tls_key_path = "${TLS_KEY_PATH}"
heartbeat_interval_secs = ${SERVER_HEARTBEAT_INTERVAL}
heartbeat_timeout_secs = ${SERVER_HEARTBEAT_TIMEOUT}
terminal_cols = ${NESSION_TERMINAL_COLS}
terminal_web_font_size = ${NESSION_TERMINAL_WEB_FONT_SIZE}
TOML

# One image-only default and fail-closed credential check shared with Agent.
export SERVER_AUTH_TOKEN
"$(dirname "$0")/render-mcp-config.sh" server >> "$out"
