#!/usr/bin/env bash
# Run cargo test and print failures + panic messages + summary.
# Preserves cargo test exit code.
set -o pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Private tmux socket for this run — tests create real tmux sessions, and two
# runs sharing a server sabotage each other. Defines nession_tmux_run_cleanup.
# shellcheck source=scripts/tmux-run-socket.sh
. "$(dirname "$0")/tmux-run-socket.sh"

tmp=$(mktemp)
trap 'rm -f "$tmp"; nession_tmux_run_cleanup' EXIT INT TERM

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"

if [ "${1:-}" = "--route" ]; then
    # Canonical workspace-wide selection (#4064). `scripts/rust-test-route.mjs`
    # owns which targets run; this script executes exactly that selection and
    # keeps the existing failure-reporting contract.
    if [ "$#" -lt 2 ]; then
        echo "usage: $0 --route <unit|integration> [--manifest-path <path>]" >&2
        exit 2
    fi
    route_mode="$2"
    shift 2
    case "$route_mode" in
        unit|integration) ;;
        *) echo "usage: $0 --route <unit|integration> [--manifest-path <path>]" >&2; exit 2 ;;
    esac
    if ! command -v node >/dev/null 2>&1; then
        echo "[ERROR] node is required to select the Rust test route" >&2
        exit 2
    fi
    args_file=$(mktemp)
    if ! node "$SCRIPT_DIR/rust-test-route.mjs" --cargo-args "$route_mode" "$@" >"$args_file"; then
        rm -f "$args_file"
        exit 2
    fi
    route_args=()
    while IFS= read -r route_arg; do
        [ -n "$route_arg" ] && route_args[${#route_args[@]}]="$route_arg"
    done <"$args_file"
    rm -f "$args_file"
    if ! inventory=$(node "$SCRIPT_DIR/rust-test-route.mjs" --inventory "$route_mode" "$@"); then
        exit 2
    fi
    # Machine-readable selection: the CI step log carries the exact target set.
    printf '%s\n' "$inventory"
    if [ -n "${NSESSION_RUST_TEST_INVENTORY:-}" ]; then
        mkdir -p "$(dirname "$NSESSION_RUST_TEST_INVENTORY")"
        printf '%s\n' "$inventory" >"$NSESSION_RUST_TEST_INVENTORY"
    fi
    cargo test --workspace --color=always "$@" "${route_args[@]}" >"$tmp" 2>&1
else
    cargo test --workspace --color=always "$@" >"$tmp" 2>&1
fi
rc=$?

# Show test output lines: test results, panics, errors.
# Drop compilation/checking/downloading noise.
grep -E '(FAILED|^test |^thread |panicked|^Error |^error\[|^error:)' "$tmp" || true

if [ $rc -ne 0 ]; then
    failures=$(grep -c 'FAILED' "$tmp" 2>/dev/null || echo 0)
    echo ""
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  ${failures} match(es) for FAILED — check above for details${NC}"
    echo ""
    echo -e "${YELLOW}  Debug tips:${NC}"
    echo -e "    1. Re-run a single test:  cargo test -p <crate> -- <test_name>"
    echo -e "    2. Show full output:       cargo test -p <crate> -- <test_name> --nocapture"
    echo -e "    3. Backtrace:              RUST_BACKTRACE=1 cargo test"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
fi

exit $rc
