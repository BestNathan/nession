#!/usr/bin/env bash
# Run vitest and filter out jsdom noise (canvas warnings, act() warnings,
# third-party ref warnings). Preserves vitest exit code.
set -o pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd web || {
    echo -e "${RED}✗ web/ directory not found — are you in the repo root?${NC}"
    exit 1
}

# Pre-flight: check node_modules exist.
if [ ! -d node_modules ]; then
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  ✗ node_modules/ not found in web/${NC}"
    echo -e "${YELLOW}  Fix: cd web && npm install${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi

FILTER='HTMLCanvasElement|not wrapped in act|Function components cannot be given refs'

if [ "${1:-}" = "--coverage" ]; then
  output=$(npx vitest run --coverage --reporter=default 2>&1)
  rc=$?
else
  output=$(npx vitest run --reporter=default 2>&1)
  rc=$?
fi

echo "$output" | grep -v -E "$FILTER" || true

if [ $rc -ne 0 ]; then
    # Detect common failure patterns and give targeted advice.
    echo ""
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    if echo "$output" | grep -q "ERR_MODULE_NOT_FOUND"; then
        echo -e "${RED}  ERR_MODULE_NOT_FOUND — missing npm dependencies${NC}"
        echo -e "${YELLOW}  Fix: cd web && npm install${NC}"
    elif echo "$output" | grep -q "Cannot find package"; then
        echo -e "${RED}  Package not found — missing npm dependency${NC}"
        echo -e "${YELLOW}  Fix: cd web && npm install${NC}"
    elif echo "$output" | grep -q "FAIL"; then
        failed_count=$(echo "$output" | grep -c "FAIL" 2>/dev/null || echo 0)
        echo -e "${RED}  ${failed_count} web test(s) FAILED${NC}"
        echo ""
        echo -e "${YELLOW}  Debug tips:${NC}"
        echo -e "    1. Re-run a single test:   cd web && npx vitest run -t '<test-name>'"
        echo -e "    2. Watch mode:              cd web && npx vitest"
        echo -e "    3. Coverage below threshold? Write more tests."
    else
        echo -e "${RED}  Web tests failed (exit code $rc)${NC}"
        echo -e "${YELLOW}  Run: cd web && npx vitest run${NC}"
    fi

    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
fi

exit $rc
