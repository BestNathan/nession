#!/usr/bin/env bash
# Test inventory — count tests per layer.
#
# Purpose: guard large test migrations. Moving test files between layers must
# never LOSE tests, but neither CI nor the coverage gate would notice if it
# did: fewer tests does not turn CI red, and a coverage drop can be hidden by
# an exclude entry. So we assert the total explicitly.
#
# The invariant is TOTAL, not the per-layer numbers — layering deliberately
# moves tests between layers. Per-layer changes must be explainable by the
# migration plan; the total must not move at all.
#
# Usage:
#   ./scripts/test-inventory.sh              # print the inventory
#   ./scripts/test-inventory.sh --check N    # exit 1 unless total == N
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

cd "$(dirname "$0")/.."

# ── Rust ────────────────────────────────────────────────────────────────────
# Layer is decided by path and stays correct across the migration:
#   src/   → compiled into the lib target  → unit
#   tests/ → separate test binary          → integration
count_rust() {
    local dir_glob=$1 total=0
    while IFS= read -r f; do
        n=$(grep -cE '^\s*#\[(tokio::)?test\]' "$f" || true)
        total=$((total + n))
    done < <(find crates -path "$dir_glob" -name '*.rs')
    echo "$total"
}

RUST_UNIT=$(count_rust 'crates/*/src/*')
RUST_INT=$(count_rust 'crates/*/tests/*')

# ── Web ─────────────────────────────────────────────────────────────────────
# Post-migration the layer is in the path (__tests__/unit, __tests__/integration).
# Pre-migration neither directory exists yet, so those files land in
# "unclassified" — expected, and precisely why the checked invariant is the
# total rather than the per-layer split.
count_web() {
    local filter=$1 total=0
    while IFS= read -r f; do
        n=$(grep -cE "^\s*(it|test)\(" "$f" || true)
        total=$((total + n))
    done < <(eval "$filter")
    echo "$total"
}

WEB_ALL='find web/src -name "*.test.ts" -o -name "*.test.tsx"'
WEB_UNIT=$(count_web "$WEB_ALL | grep    '/__tests__/unit/'         || true")
WEB_INT=$(count_web  "$WEB_ALL | grep    '/__tests__/integration/'  || true")
WEB_UNCLASS=$(count_web "$WEB_ALL | grep -v -e '/__tests__/unit/' -e '/__tests__/integration/' || true")

# ── E2E ─────────────────────────────────────────────────────────────────────
if [ -d e2e/specs ]; then
    E2E=$(grep -rhcE "^\s*test\(" e2e/specs 2>/dev/null | paste -sd+ - | bc)
else
    E2E=0
fi

TOTAL=$((RUST_UNIT + RUST_INT + WEB_UNIT + WEB_INT + WEB_UNCLASS + E2E))

printf "%-22s %5s\n" "rust/unit"        "$RUST_UNIT"
printf "%-22s %5s\n" "rust/integration" "$RUST_INT"
printf "%-22s %5s\n" "web/unit"         "$WEB_UNIT"
printf "%-22s %5s\n" "web/integration"  "$WEB_INT"
[ "$WEB_UNCLASS" -gt 0 ] && \
    printf "%-22s %5s  ${YELLOW}(pre-migration, layer not yet in path)${NC}\n" \
        "web/unclassified" "$WEB_UNCLASS"
printf "%-22s %5s\n" "e2e"              "$E2E"
printf "%-22s %5s\n" "TOTAL"            "$TOTAL"

# ── Optional assertion ──────────────────────────────────────────────────────
if [ "${1:-}" = "--check" ]; then
    expected=${2:?--check needs an expected total}
    echo ""
    if [ "$TOTAL" -eq "$expected" ]; then
        echo -e "${GREEN}✓ total matches baseline ($expected)${NC}"
    else
        delta=$((TOTAL - expected))
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${RED}  ✗ total is ${TOTAL}, baseline is ${expected} (${delta:+$delta})${NC}"
        echo ""
        echo -e "${YELLOW}  A negative delta means tests were LOST in migration —${NC}"
        echo -e "${YELLOW}  a file moved but never wired into its new harness, or a${NC}"
        echo -e "${YELLOW}  vitest include glob that does not match where it landed.${NC}"
        echo -e "${YELLOW}  A positive delta is fine only if you added tests on purpose;${NC}"
        echo -e "${YELLOW}  update the baseline in the same commit that adds them.${NC}"
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        exit 1
    fi
fi
