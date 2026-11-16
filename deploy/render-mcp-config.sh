#!/bin/sh
# The one OCI-only MCP projection shared by Server and Agent images.
# Native Rust ServerConfig/AgentConfig remain opt-in.
set -eu

role="${1:?usage: render-mcp-config.sh server|agent}"
case "$role" in
  server|agent) ;;
  *) echo "MCP image config role must be server or agent" >&2; exit 1 ;;
esac
NESSION_MCP_ENABLED="${NESSION_MCP_ENABLED:-true}"
case "$NESSION_MCP_ENABLED" in
  true|false) ;;
  *) echo "NESSION_MCP_ENABLED must be true or false" >&2; exit 1 ;;
esac

# No token in generated [mcp] table. The Server owns its inbound token,
# while the Agent provisions its durable inbound token before MCP mount.
if [ "$role" = server ] && [ "$NESSION_MCP_ENABLED" = true ] &&
   [ -z "${SERVER_AUTH_TOKEN:-}" ]; then
  echo "MCP enabled in Server OCI image: set SERVER_AUTH_TOKEN or NESSION_MCP_ENABLED=false" >&2
  exit 1
fi
printf '\n[mcp]\nenabled = %s\npath = "/mcp"\n' "$NESSION_MCP_ENABLED"
