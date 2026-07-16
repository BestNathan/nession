#!/usr/bin/env bash
# Per-crate coverage threshold check for Rust workspace using cargo-llvm-cov
# Exit 0 if all crates meet their thresholds, exit 1 otherwise

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

echo -e "${YELLOW}→ Checking Rust test coverage by crate...${NC}"
echo ""

# Run llvm-cov with JSON output (much faster than tarpaulin)
JSON=$(cargo llvm-cov --workspace --json 2>/dev/null)

if [ -z "$JSON" ]; then
    echo -e "${RED}✗ cargo llvm-cov not installed or failed${NC}"
    echo -e "${RED}  Install: cargo install cargo-llvm-cov${NC}"
    exit 1
fi

HAS_ERROR=0

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

    if [ "$count" -eq 0 ]; then
        echo -e "${YELLOW}  ${crate}: no coverage data${NC}"
        continue
    fi

    coverage=$((covered * 100 / count))

    if [ $coverage -ge $threshold ]; then
        echo -e "${GREEN}  ✓ ${crate}: ${coverage}% (≥ ${threshold}%)  [${covered}/${count} lines]${NC}"
    else
        echo -e "${RED}  ✗ ${crate}: ${coverage}% (< ${threshold}%)  [${covered}/${count} lines]${NC}"
        HAS_ERROR=1
    fi
done

echo ""

if [ $HAS_ERROR -eq 1 ]; then
    echo -e "${RED}✗ Coverage check failed — some crates below threshold${NC}"
    exit 1
else
    echo -e "${GREEN}✓ All crates meet coverage thresholds${NC}"
    exit 0
fi
