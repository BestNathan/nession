#!/usr/bin/env bash
# Bounded, credential-safe ACR login. Only retry transport failures; never
# replay a rejected credential or emit Docker's auth URL/secret-bearing output.
set -euo pipefail

if [[ "$#" -ne 1 || ! "$1" =~ ^[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "ERROR: ACR login requires one registry hostname" >&2
  exit 2
fi
registry="$1"
if [[ -z "${ACR_USERNAME:-}" || -z "${ACR_PASSWORD:-}" ]]; then
  echo "ERROR: ACR login credentials are not configured" >&2
  exit 2
fi
command -v timeout >/dev/null || { echo "ERROR: timeout is required for ACR login" >&2; exit 2; }

diagnostic="$(mktemp)"
chmod 600 "$diagnostic"
trap 'rm -f "$diagnostic"' EXIT

classify() {
  local status="$1"
  if grep -Eiq '(^|[^0-9])(401|403)([^0-9]|$)|unauthorized|incorrect.*password|authentication required|denied' "$diagnostic"; then
    printf 'credential_or_permission_rejected'
  elif [[ "$status" -eq 124 || "$status" -eq 137 ]]; then
    printf 'login_deadline'
  elif grep -Eiq 'TLS handshake timeout|TLS.*timeout' "$diagnostic"; then
    printf 'tls_handshake_timeout'
  elif grep -Eiq 'connection reset by peer|connection refused|EOF' "$diagnostic"; then
    printf 'connection_reset'
  elif grep -Eiq 'i/o timeout|network is unreachable|context deadline exceeded|dial tcp|no such host|temporary failure' "$diagnostic"; then
    printf 'network_transport'
  else
    printf 'non_transient_login_error'
  fi
}
for attempt in 1 2 3; do
  start="$(date +%s)"
  status=0
  # Do not print a raw auth response: it may contain URLs, usernames, or tokens.
  timeout --signal=TERM --kill-after=5s 30s docker login "$registry" \
    --username "$ACR_USERNAME" --password-stdin <<< "$ACR_PASSWORD" \
    > "$diagnostic" 2>&1 || status=$?
  elapsed="$(( $(date +%s) - start ))"
  if [[ "$status" -eq 0 ]]; then
    echo "ACR_LOGIN_ATTEMPT attempt=$attempt elapsed_s=$elapsed outcome=success"
    [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || printf -- '- ACR login: attempt %s, %ss, success\n' "$attempt" "$elapsed" >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  failure="$(classify "$status")"
  echo "ACR_LOGIN_ATTEMPT attempt=$attempt elapsed_s=$elapsed outcome=$failure exit_code=$status" >&2
  # Never mask credential/authorization failures with a transport retry.
  if [[ "$failure" == credential_or_permission_rejected || "$failure" == non_transient_login_error ]]; then
    echo "ERROR: ACR login failed permanently ($failure)" >&2
    exit 1
  fi
  if (( attempt < 3 )); then sleep "$((attempt * 5))"; fi
done
echo "ERROR: ACR login exhausted 3 bounded transport attempts" >&2
exit 1
