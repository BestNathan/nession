#!/usr/bin/env bash
# Run cargo test and print only failures + summary + diagnostic guidance.
# Preserves cargo test exit code.
set -o pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

cargo test --workspace --color=always >"$tmp" 2>&1
rc=$?

# Print only FAILED lines and error lines, plus the final test result
grep -E '(FAILED|^error\[|^error:)' "$tmp" || true

if [ $rc -ne 0 ]; then
    # Count failures by crate to give targeted guidance.
    failures=$(grep -c 'FAILED' "$tmp" 2>/dev/null || echo 0)
    echo ""
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  ${failures} test(s) FAILED${NC}"
    echo ""
    echo -e "${YELLOW}  Debug tips:${NC}"
    echo -e "    1. Re-run a single test:  cargo test -p <crate> -- <test_name>"
    echo -e "    2. Show full output:       cargo test -p <crate> -- <test_name> --nocapture"
    echo -e "    3. Backtrace:              RUST_BACKTRACE=1 cargo test"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
fi

exit $rc
