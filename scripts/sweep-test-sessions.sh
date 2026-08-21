#!/usr/bin/env bash
# Kill tmux sessions left behind by aborted or panicking test runs.
#
# Every session the test suites create is named "nession-test-<something>"
# (see TEST_SESSION_PREFIX in crates/nession-agent/tests/integration/main.rs and
# the unique_session_name helpers in the unit tests). Nothing else uses that
# prefix, so matching on it can never touch a developer's own session.
#
# Usage:
#   ./scripts/sweep-test-sessions.sh            # list strays, kill nothing
#   ./scripts/sweep-test-sessions.sh --kill     # kill them

set -euo pipefail

PREFIX='nession-test-'

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

kill_mode=false
case "${1:-}" in
    --kill) kill_mode=true ;;
    "") ;;
    -h | --help)
        sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    *)
        echo -e "${RED}unknown argument: $1${NC}" >&2
        echo "usage: $0 [--kill]" >&2
        exit 2
        ;;
esac

if ! command -v tmux >/dev/null 2>&1; then
    echo -e "${YELLOW}tmux not installed — nothing to sweep${NC}"
    exit 0
fi

# No server running is a clean state, not an error.
if ! sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null); then
    echo -e "${GREEN}no tmux server running — nothing to sweep${NC}"
    exit 0
fi

strays=$(printf '%s\n' "$sessions" | grep "^${PREFIX}" || true)

if [[ -z $strays ]]; then
    echo -e "${GREEN}no stray ${PREFIX}* sessions${NC}"
    exit 0
fi

count=$(printf '%s\n' "$strays" | wc -l | tr -d ' ')

if [[ $kill_mode == false ]]; then
    echo -e "${YELLOW}${count} stray ${PREFIX}* session(s):${NC}"
    printf '%s\n' "$strays" | sed 's/^/  /'
    echo
    echo "run with --kill to remove them"
    exit 0
fi

while IFS= read -r session; do
    [[ -z $session ]] && continue
    if tmux kill-session -t "$session" 2>/dev/null; then
        echo -e "${GREEN}killed${NC} $session"
    else
        echo -e "${RED}failed${NC} $session" >&2
    fi
done <<<"$strays"

echo -e "${GREEN}swept ${count} session(s)${NC}"
