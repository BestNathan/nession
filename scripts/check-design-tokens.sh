#!/usr/bin/env bash
# Static gate: session-first/capsule must not use Tailwind numeric metrics or max-lg:
# forks. Enforcement is implemented as eslint rule nession/no-capsule-magic-metrics;
# this script runs that rule over the capsule tree for a fast, scoped check.
#
# Usage:
#   ./scripts/check-design-tokens.sh
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/web"

npx eslint "src/session-first/capsule/**/*.{ts,tsx}" \
  --report-unused-disable-directives \
  --max-warnings 0 \
  --no-error-on-unmatched-pattern

echo "✓ check-design-tokens (capsule eslint gate)"
