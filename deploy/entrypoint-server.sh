#!/bin/sh
set -e

# Server entrypoint — starts nginx + nession-server

LISTEN_PORT="${LISTEN_PORT:-10080}"
SERVER_LISTEN="${SERVER_LISTEN:-0.0.0.0:18080}"
SERVER_BACKEND="${SERVER_BACKEND:-127.0.0.1:18080}"
SERVER_AUTH_TOKEN="${SERVER_AUTH_TOKEN:-}"
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
NESSION_TERMINAL_COLS="${NESSION_TERMINAL_COLS:-80}"
NESSION_TERMINAL_WEB_FONT_SIZE="${NESSION_TERMINAL_WEB_FONT_SIZE:-14}"
# Configuration directory. Overridable so the entrypoint can be exercised
# without writing /etc (the acceptance Case does exactly that).
NESSON_CONFIG_DIR="${NESSON_CONFIG_DIR:-/etc/nession}"
mkdir -p "${NESSON_CONFIG_DIR}"

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
        proxy_pass http://${SERVER_BACKEND};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
    location /api { proxy_pass http://${SERVER_BACKEND}; proxy_set_header Host \$host; }
    location / { root /usr/share/nginx/html; index index.html; try_files \$uri \$uri/ /index.html; }
}
NGINX
fi

nginx -t
nginx -g 'daemon off;' &

# Generate server config. The projection itself lives in the one renderer
# script so a Case can exercise it without nginx or a listener (#2487 SC-08).
export SERVER_LISTEN SERVER_AUTH_TOKEN TLS_CERT_PATH TLS_KEY_PATH
export SERVER_HEARTBEAT_INTERVAL SERVER_HEARTBEAT_TIMEOUT
"$(dirname "$0")/render-server-config.sh" "${NESSON_CONFIG_DIR}/config.toml"

echo "=== nession-server ==="
echo "  Listen:       $SERVER_LISTEN"
echo "  Nession Home: ${NESSIN_HOME:-$HOME/.nession}"
echo "  Terminal:     cols=$NESSION_TERMINAL_COLS web_max_font=${NESSION_TERMINAL_WEB_FONT_SIZE}px"
echo "  Config dir:   $NESSON_CONFIG_DIR"
echo "  Nginx:        :${LISTEN_PORT} -> $SERVER_BACKEND"

exec /usr/local/bin/nession-server
