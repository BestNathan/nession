#!/usr/bin/env bash
# Per-crate coverage threshold check for Rust workspace
# Exit 0 if all crates meet their thresholds, exit 1 otherwise

set -euo pipefail

#  Colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Coverage thresholds per crate (percentage) ──────────────────────────
# Core crates target 80%+ but currently at 74-79% (excluding main.rs).
# Thresholds set slightly below current to prevent regression; raise
# over time as coverage improves.
declare -A THRESHOLDS=(
    ["crates/nession-common"]=80
    ["crates/nession-agent"]=75
    ["crates/nession-server"]=70
    ["crates/nession-cli"]=40
)

HAS_ERROR=0

echo -e "${YELLOW}→ Checking Rust test coverage by crate...${NC}"
echo ""

# Run tarpaulin and capture output
OUTPUT=$(cargo tarpaulin --workspace 2>&1)

# Parse coverage per crate
for crate_path in "${!THRESHOLDS[@]}"; do
    threshold=${THRESHOLDS[$crate_path]}

    # Extract coverage for this crate from the summary section
    # Format: "|| crates/nession-xxx/src/file.rs: 123/456 +0.00%"
    # Exclude main.rs (binary entry points, hard to unit test)
    crate_lines=$(echo "$OUTPUT" | grep -A 100 "Tested/Total Lines:" | grep "^|| ${crate_path}/" | grep -v "/main.rs:")
    crate_coverage=$(echo "$crate_lines" | grep -oE '[0-9]+/[0-9]+')

    total_covered=0
    total_lines=0

    for cov in $crate_coverage; do
        covered=${cov%/*}
        lines=${cov#*/}
        total_covered=$((total_covered + covered))
        total_lines=$((total_lines + lines))
    done

    if [ $total_lines -eq 0 ]; then
        echo -e "${YELLOW}  ${crate_path}: no coverage data${NC}"
        continue
    fi

    coverage=$((total_covered * 100 / total_lines))

    if [ $coverage -ge $threshold ]; then
        echo -e "${GREEN}  ✓ ${crate_path}: ${coverage}% (≥ ${threshold}%)${NC}"
    else
        echo -e "${RED}  ✗ ${crate_path}: ${coverage}% (< ${threshold}%)${NC}"
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
