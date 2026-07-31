#!/usr/bin/env bash
# Per-crate coverage threshold check for Rust workspace using cargo-llvm-cov
# Exit 0 if all crates meet their thresholds, exit 1 otherwise
#
# Usage:
#   ./scripts/check-coverage.sh                 # Check all crates
#   ./scripts/check-coverage.sh crate1 crate2   # Check only specified crates

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Coverage thresholds per crate (line coverage percentage) ────────────
# Core crates: 80%+ target
# CLI: lower threshold (excluded commands not testable)
declare -A THRESHOLDS=(
    ["nession-common"]=80
    ["nession-agent"]=80
    ["nession-server"]=80
    ["nession-cli"]=40
)

# ── Fix instructions per crate ──────────────────────────────────────────
declare -A FIX_HINTS=(
    ["nession-common"]="Add unit tests in crates/nession-common/src/ (inline #[cfg(test)] modules)."
    ["nession-agent"]="Add unit tests in crates/nession-agent/src/. Run: cargo test -p nession-agent"
    ["nession-server"]="Add unit tests in crates/nession-server/src/. Run: cargo test -p nession-server"
    ["nession-cli"]="CLI coverage target is 40%. Add tests in crates/nession-cli/."
)

# Filter to specified crates if arguments provided
if [ $# -gt 0 ]; then
    declare -A FILTERED
    for arg in "$@"; do
        if [ -n "${THRESHOLDS[$arg]+x}" ]; then
            FILTERED[$arg]=${THRESHOLDS[$arg]}
        fi
    done
    unset THRESHOLDS
    declare -A THRESHOLDS
    for key in "${!FILTERED[@]}"; do
        THRESHOLDS[$key]=${FILTERED[$key]}
    done
    if [ ${#THRESHOLDS[@]} -eq 0 ]; then
        echo -e "${YELLOW}→ No matching crates to check, skipping coverage${NC}"
        exit 0
    fi
fi

echo -e "${YELLOW}→ Checking Rust test coverage by crate...${NC}"
echo ""

# ── Pre-flight: check dependencies ──────────────────────────────────────

# Check jq
if ! command -v jq &>/dev/null; then
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  ✗ 'jq' is not installed — required to parse coverage JSON${NC}"
    echo -e "${YELLOW}  Fix: brew install jq${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi

# Build list of -p flags
PACKAGE_FLAGS=""
for crate in "${!THRESHOLDS[@]}"; do
    PACKAGE_FLAGS="$PACKAGE_FLAGS -p $crate"
done

# Run llvm-cov with JSON output on just the target crates.
# bash ≥5.0 exits on $(failing_cmd) with set -e (unlike bash 3.2 on macOS),
# so we temporarily disable errexit around cargo llvm-cov.
# stderr is saved so we can diagnose failures on CI.
COV_STDERR=$(mktemp)
set +e
# Skip PTY/tmux timing-sensitive tests that are too slow under LLVM
    # instrumentation.  They pass fine with plain `cargo test`.
    SKIP_FLAGS="--skip terminal_io --skip full_chain"
    JSON=$(cargo llvm-cov $PACKAGE_FLAGS --json -- $SKIP_FLAGS 2>"$COV_STDERR")
set -e

if [ -z "$JSON" ]; then
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  ✗ cargo llvm-cov not installed or failed to run${NC}"
    if [ -s "$COV_STDERR" ]; then
        echo -e "${YELLOW}  ── last 20 lines of stderr ──${NC}"
        tail -60 "$COV_STDERR" | while IFS= read -r line; do
            echo -e "  ${YELLOW}| ${line}${NC}"
        done
    fi
    echo -e "${YELLOW}  Fix: cargo install cargo-llvm-cov${NC}"
    echo -e "${YELLOW}       rustup component add llvm-tools-preview${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    rm -f "$COV_STDERR"
    exit 1
fi
rm -f "$COV_STDERR"

HAS_ERROR=0
BELOW_THRESHOLD=()

# Parse coverage per crate using jq
for crate in "${!THRESHOLDS[@]}"; do
    threshold=${THRESHOLDS[$crate]}

    # Sum lines/covered across all files in this crate (excluding main.rs)
    result=$(echo "$JSON" | jq -r --arg crate "$crate" '
        [.data[0].files[]
         | select(.filename | contains("/crates/" + $crate + "/"))
         | select(.filename | endswith("/main.rs") | not)]
        | {
            covered: (map(.summary.lines.covered) | add // 0),
            count: (map(.summary.lines.count) | add // 0)
          }
        | if .count > 0 then "\(.covered) \(.count)" else "0 0" end
    ')

    covered=$(echo "$result" | awk '{print $1}')
    count=$(echo "$result" | awk '{print $2}')

    # Guard against empty values from jq parsing failures
    if [ -z "$count" ] || [ "$count" -eq 0 ]; then
        echo -e "${YELLOW}  ${crate}: no coverage data — test binary may not have produced coverage${NC}"
        continue
    fi

    coverage=$((covered * 100 / count))

    if [ $coverage -ge $threshold ]; then
        echo -e "${GREEN}  ✓ ${crate}: ${coverage}% (≥ ${threshold}%)  [${covered}/${count} lines]${NC}"
    else
        gap=$((threshold - coverage))
        hint=${FIX_HINTS[$crate]:-"Add tests for this crate."}
        echo -e "${RED}  ✗ ${crate}: ${coverage}% (< ${threshold}%)  [${covered}/${count} lines, need ~${gap}% more]${NC}"
        echo -e "${RED}     Fix: ${hint}${NC}"
        HAS_ERROR=1
        BELOW_THRESHOLD+=("$crate")
    fi
done

echo ""

if [ $HAS_ERROR -eq 1 ]; then
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  ✗ Coverage check FAILED${NC}"
    echo ""
    echo -e "${YELLOW}  Crates below threshold: ${BELOW_THRESHOLD[*]}${NC}"
    echo ""
    echo -e "${YELLOW}  How to fix:${NC}"
    echo -e "    1. Write unit tests for uncovered code in the failing crate(s)."
    echo -e "    2. Run coverage locally: cargo llvm-cov -p <crate> --html"
    echo -e "    3. Open target/llvm-cov/html/index.html to see uncovered lines."
    echo -e "    4. Add tests, re-run: ./scripts/check-coverage.sh"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
else
    echo -e "${GREEN}✓ All crates meet coverage thresholds${NC}"
    exit 0
fi
