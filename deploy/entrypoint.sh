#!/bin/sh
set -e

# --- Defaults (envsubst requires variables to be set) ---
LISTEN_PORT="${LISTEN_PORT:-80}"
SERVER_BACKEND="${SERVER_BACKEND:-127.0.0.1:8443}"
NESION_LISTEN_ADDRESS="${NESION_LISTEN_ADDRESS:-127.0.0.1:8443}"
NESION_DB_PATH="${NESION_DB_PATH:-/data/server.db}"
export LISTEN_PORT SERVER_BACKEND

# --- Generate nginx config from template ---
envsubst '${LISTEN_PORT} ${SERVER_BACKEND}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

# --- If TLS certs are provided, enable HTTPS ---
if [ -n "$TLS_CERT_PATH" ] && [ -n "$TLS_KEY_PATH" ]; then
  # Add HTTP→HTTPS redirect to the port 80 server block
  sed -i 's|server_name _;|server_name _;\n    return 301 https://\$host\$request_uri;|' \
    /etc/nginx/conf.d/default.conf

  # Append HTTPS server block (unquoted heredoc so shell vars expand; nginx vars escaped with \$)
  cat >> /etc/nginx/conf.d/default.conf <<NGINX
server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     ${TLS_CERT_PATH};
    ssl_certificate_key ${TLS_KEY_PATH};
    ssl_protocols       TLSv1.2 TLSv1.3;

    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    location /ws {
        proxy_pass http://${SERVER_BACKEND};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /api {
        proxy_pass http://${SERVER_BACKEND};
        proxy_set_header Host \$host;
    }

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX
fi

# --- Generate nession-server config.toml ---
cat > /etc/nession/config.toml <<TOML
listen_address = "${NESION_LISTEN_ADDRESS}"
auth_token = "${NESION_AUTH_TOKEN}"
db_path = "${NESION_DB_PATH}"
tls_cert_path = ""
tls_key_path = ""
heartbeat_timeout_secs = 30
TOML

# --- Validate nginx config ---
nginx -t

# --- Start nginx in background ---
nginx -g 'daemon off;' &

# --- Exec nession-server as PID 1 ---
exec /usr/local/bin/nession-server
