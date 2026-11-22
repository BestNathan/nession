#!/bin/sh
set -e

# Server entrypoint — starts nginx + nession-server

LISTEN_PORT="${LISTEN_PORT:-10080}"
SERVER_LISTEN="${SERVER_LISTEN:-0.0.0.0:18080}"
SERVER_BACKEND="${SERVER_BACKEND:-127.0.0.1:18080}"
SERVER_AUTH_TOKEN="${SERVER_AUTH_TOKEN:-}"
# Browser clients present an Origin and must be named here (#4066). The local
# Compose profile is served from SERVER_HTTP_PORT on the host; a deployment
# names its own Web origin. Empty refuses every browser origin.
SERVER_ALLOWED_ORIGINS="${SERVER_ALLOWED_ORIGINS:-}"
# Deliberately unsafe, and only for an intentionally open listener: permits a
# non-loopback listener with no Server Token.
SERVER_ALLOW_INSECURE_REMOTE="${SERVER_ALLOW_INSECURE_REMOTE:-false}"
SERVER_HEARTBEAT_INTERVAL="${SERVER_HEARTBEAT_INTERVAL:-10}"
SERVER_HEARTBEAT_TIMEOUT="${SERVER_HEARTBEAT_TIMEOUT:-30}"
NESSION_HOME="${NESSION_HOME:-}"

export LISTEN_PORT SERVER_BACKEND NESSION_HOME
export NESSION_TERMINAL_COLS NESSION_TERMINAL_WEB_FONT_SIZE

# The release-selected fixed terminal configuration (#2487). The image's ENV
# is set from the same build parameters that produced the Web bundle; Compose
# or a GitOps env patch may override them, and the Server validates the
# effective values at startup. They are written into config.toml below, which
# is the Server's canonical configuration reader.
NESSION_TERMINAL_COLS="${NESSION_TERMINAL_COLS:-96}"
NESSION_TERMINAL_WEB_FONT_SIZE="${NESSION_TERMINAL_WEB_FONT_SIZE:-14}"
# Configuration directory. Overridable so the entrypoint can be exercised
# without writing /etc (the acceptance Case does exactly that).
NESSON_CONFIG_DIR="${NESSON_CONFIG_DIR:-/etc/nession}"
mkdir -p "${NESSON_CONFIG_DIR}"

# Generate validated Server config before nginx starts; no anonymous MCP.
export SERVER_LISTEN SERVER_AUTH_TOKEN TLS_CERT_PATH TLS_KEY_PATH
export SERVER_ALLOWED_ORIGINS SERVER_ALLOW_INSECURE_REMOTE
export SERVER_HEARTBEAT_INTERVAL SERVER_HEARTBEAT_TIMEOUT
"$(dirname "$0")/render-server-config.sh" "${NESSON_CONFIG_DIR}/config.toml"

# Generate nginx config
envsubst '${LISTEN_PORT} ${SERVER_BACKEND}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

# Optional TLS
if [ -n "$TLS_CERT_PATH" ] && [ -n "$TLS_KEY_PATH" ]; then
  sed -i 's|server_name _;|server_name _;\n    return 301 https://\$host\$request_uri;|' \
    /etc/nginx/conf.d/default.conf
  cat >> /etc/nginx/conf.d/default.conf <<NGINX
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     ${TLS_CERT_PATH};
    ssl_certificate_key ${TLS_KEY_PATH};
    ssl_protocols       TLSv1.2 TLSv1.3;
    location /health { return 200 'ok'; add_header Content-Type text/plain; }
    location /ws {
        proxy_pass https://${SERVER_BACKEND};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
    location /api { proxy_pass https://${SERVER_BACKEND}; proxy_set_header Host \$host; }

    # MCP Streamable HTTP is never the Web SPA fallback. Keep the original
    # bearer, protocol, session and Origin headers; disable SSE buffering.
    location = /mcp {
        proxy_pass https://${SERVER_BACKEND};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header Authorization \$http_authorization;
        proxy_set_header MCP-Protocol-Version \$http_mcp_protocol_version;
        proxy_set_header Mcp-Session-Id \$http_mcp_session_id;
        proxy_set_header Origin \$http_origin;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
    }

    location / { root /usr/share/nginx/html; index index.html; try_files \$uri \$uri/ /index.html; }
}
NGINX
fi

nginx -t
nginx -g 'daemon off;' &

echo "=== nession-server ==="
echo "  Listen:       $SERVER_LISTEN"
echo "  Nession Home: ${NESSION_HOME:-$HOME/.nession}"
echo "  Terminal:     cols=$NESSION_TERMINAL_COLS web_max_font=${NESSION_TERMINAL_WEB_FONT_SIZE}px"
echo "  Config dir:   $NESSON_CONFIG_DIR"
echo "  Nginx:        :${LISTEN_PORT} -> $SERVER_BACKEND"

exec /usr/local/bin/nession-server
