#!/usr/bin/env bash
# Verify the test suite is safe to run concurrently.
#
# Every test binary is launched twice at the same time and BOTH runs must pass.
# This catches state shared between runs rather than between tests:
#   - a hardcoded listen port                    → "Address already in use"
#   - a database path built from wall-clock time plus a per-process counter
#     (two processes starting in the same second produce the same path)
#                                                → "database is locked", or
#                                                  "UNIQUE constraint failed:
#                                                   seaql_migrations.version"
#   - fixed filenames in the shared system temp dir, where one run's cleanup
#     deletes the file another run still needs
#
# It matters because this repo's workflow keeps several git worktrees, and CI can
# run while a developer runs tests locally. Shared state makes those runs fight
# each other, producing failures that look random and are hard to reproduce —
# the third case above is a race that a single run passes every time.
#
# Usage:
#   ./scripts/check-test-concurrency.sh          # build, then check every binary
#   ./scripts/check-test-concurrency.sh <path>   # check one binary
#   TIMEOUT_SECS=300 ./scripts/check-test-concurrency.sh

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Per-binary wall-clock budget for one concurrent pair.
TIMEOUT_SECS=${TIMEOUT_SECS:-180}

run_pair() {
    local bin="$1"
    local a b rc_a rc_b
    a=$(mktemp)
    b=$(mktemp)

    "$bin" >"$a" 2>&1 &
    local pid_a=$!
    "$bin" >"$b" 2>&1 &
    local pid_b=$!

    # Watchdog: a wedged test must not hang the whole check.
    (
        sleep "$TIMEOUT_SECS"
        kill -9 $pid_a $pid_b 2>/dev/null
    ) &
    local watchdog=$!

    wait $pid_a
    rc_a=$?
    wait $pid_b
    rc_b=$?
    kill $watchdog 2>/dev/null
    wait $watchdog 2>/dev/null

    if [[ $rc_a -eq 0 && $rc_b -eq 0 ]]; then
        echo -e "  ${GREEN}✓${NC} $(basename "$bin")"
        rm -f "$a" "$b"
        return 0
    fi

    echo -e "  ${RED}✗${NC} $(basename "$bin")  (exit $rc_a / $rc_b)"
    grep -hE 'FAILED|panicked|Address already in use|database is locked|UNIQUE constraint' \
        "$a" "$b" | head -20 | sed 's/^/      /'
    rm -f "$a" "$b"
    return 1
}

if [[ $# -ge 1 ]]; then
    run_pair "$1"
    exit $?
fi

echo -e "${YELLOW}→ Building test binaries...${NC}"
# Restrict to target/debug/deps/**. `cargo test --no-run` also reports the real
# `nession`, `nession-agent` and `nession-server` executables, and launching
# those would start actual servers that never exit.
mapfile -t bins < <(
    cargo test --workspace --no-run --message-format=json 2>/dev/null |
        sed -n 's/.*"executable":"\([^"]*\)".*/\1/p' |
        grep '/deps/' | sort -u
)

if [[ ${#bins[@]} -eq 0 ]]; then
    echo -e "${RED}  ✗ no test binaries found — did 'cargo test --no-run' fail?${NC}" >&2
    exit 1
fi

echo -e "${YELLOW}→ Running each binary twice concurrently (${#bins[@]} found)...${NC}"
failed=0
checked=0
for bin in "${bins[@]}"; do
    if [[ ! -x $bin ]]; then
        # Never skip silently: an unchecked binary must be visible.
        echo -e "  ${YELLOW}!${NC} $(basename "$bin") — not executable, NOT checked"
        continue
    fi
    checked=$((checked + 1))
    run_pair "$bin" || failed=$((failed + 1))
done

echo ""
echo "checked ${checked}/${#bins[@]} binaries"
if [[ $failed -eq 0 ]]; then
    echo -e "${GREEN}All checked binaries are concurrency-safe ✓${NC}"
    exit 0
fi
echo -e "${RED}${failed} binary/binaries collided when run concurrently${NC}"
echo -e "${YELLOW}Fix: bind \"127.0.0.1:0\" instead of a fixed port, and give each"
echo -e "server or test its own tempfile::tempdir() instead of a shared name in"
echo -e "the system temp dir.${NC}"
exit 1
