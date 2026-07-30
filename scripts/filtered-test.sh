#!/usr/bin/env bash
# Run cargo test and print failures + panic messages + summary.
# Preserves cargo test exit code.
set -o pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

cargo test --workspace --color=always >"$tmp" 2>&1
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
