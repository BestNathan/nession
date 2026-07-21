#!/usr/bin/env bash
# Run vitest and filter out jsdom noise (canvas warnings, act() warnings,
# third-party ref warnings). Preserves vitest exit code.
set -o pipefail

cd web || exit 1

FILTER='HTMLCanvasElement|not wrapped in act|Function components cannot be given refs'

if [ "${1:-}" = "--coverage" ]; then
  npx vitest run --coverage --reporter=default 2>&1 | grep -v -E "$FILTER"
else
  npx vitest run --reporter=default 2>&1 | grep -v -E "$FILTER"
fi
