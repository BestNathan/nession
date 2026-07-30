#!/bin/sh
set -e

# Agent entrypoint — starts nginx + nession-agent (with tmux)

LISTEN_PORT="${LISTEN_PORT:-10080}"
AGENT_LISTEN="${AGENT_LISTEN:-0.0.0.0:19090}"
SERVER_BACKEND="${SERVER_BACKEND:-127.0.0.1:19090}"
AGENT_ID="${AGENT_ID:-docker-agent}"
AGENT_SERVER_URL="${AGENT_SERVER_URL:-}"
AGENT_AUTH_TOKEN="${AGENT_AUTH_TOKEN:-}"
AGENT_CONNECT_URL="${AGENT_CONNECT_URL:-}"

export LISTEN_PORT SERVER_BACKEND

# Generate nginx config
envsubst '${LISTEN_PORT} ${SERVER_BACKEND}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

nginx -t
nginx -g 'daemon off;' &

# Generate agent config
cat > /etc/nession/agent-config.toml <<TOML
agent_id = "${AGENT_ID}"
listen_address = "${AGENT_LISTEN}"
server_url = "${AGENT_SERVER_URL}"
auth_token = "${AGENT_AUTH_TOKEN}"
heartbeat_interval_secs = 10
session_poll_interval_secs = 5
TOML

# Only add connect_url if explicitly set
if [ -n "${AGENT_CONNECT_URL}" ]; then
    echo "connect_url = \"${AGENT_CONNECT_URL}\"" >> /etc/nession/agent-config.toml
fi

# Initialize Claude Code settings (skip OAuth login for headless container).
CLAUDE_DIR="/root/.claude"
if [ ! -f "${CLAUDE_DIR}/settings.json" ]; then
    mkdir -p "${CLAUDE_DIR}"
    # If init container seeded settings on the shared volume, copy them in.
    if [ -f "/opt/claude-tools/home/.claude/settings.json" ]; then
        cp "/opt/claude-tools/home/.claude/settings.json" "${CLAUDE_DIR}/settings.json"
        echo "=== Claude Code settings (from seed) ==="
    else
        cat > "${CLAUDE_DIR}/settings.json" << 'SETTINGS'
{"hasOnboarded": true}
SETTINGS
        echo "=== Claude Code settings (default, skip login) ==="
    fi
fi

echo "=== nession-agent ==="
echo "  Agent ID:    $AGENT_ID"
echo "  Listen:      $AGENT_LISTEN"
echo "  Server URL:  ${AGENT_SERVER_URL:-<standalone>}"
echo "  Nginx:       :${LISTEN_PORT} -> $SERVER_BACKEND"
echo "  Connect URL: ${AGENT_CONNECT_URL:-<auto>}"
echo "  tmux:        $(tmux -V 2>/dev/null || echo 'not found')"

exec /usr/local/bin/nession-agent /etc/nession/agent-config.toml
