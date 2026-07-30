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

# Generate server config — db_path intentionally omitted: the binary resolves
# it from NESSION_HOME (or $HOME/.nession as fallback).
cat > /etc/nession/config.toml <<TOML
listen_address = "${SERVER_LISTEN}"
auth_token = "${SERVER_AUTH_TOKEN}"
tls_cert_path = "${TLS_CERT_PATH:-}"
tls_key_path = "${TLS_KEY_PATH:-}"
heartbeat_interval_secs = ${SERVER_HEARTBEAT_INTERVAL}
heartbeat_timeout_secs = ${SERVER_HEARTBEAT_TIMEOUT}
TOML

echo "=== nession-server ==="
echo "  Listen:       $SERVER_LISTEN"
echo "  Nession Home: ${NESSIN_HOME:-$HOME/.nession}"
echo "  Nginx:        :${LISTEN_PORT} -> $SERVER_BACKEND"

exec /usr/local/bin/nession-server
