#!/usr/bin/env bash
# Static gate: the capsule tree must not use Tailwind numeric metrics or max-lg:
# forks. Enforcement is the eslint rule nession/no-capsule-magic-metrics, enabled
# globally in web/eslint.config.js; this script runs that rule over the capsule
# tree alone for a fast, scoped check.
#
# The path below is where this gate already failed silently once: it pointed at
# `src/session-first/capsule/**`, which no longer existed after the shell moved,
# and `--no-error-on-unmatched-pattern` turned "matched nothing" into a pass that
# still printed ✓. So the script now proves it matched files before trusting its
# own result. Do not re-add that flag.
#
# Usage:
#   ./scripts/check-design-tokens.sh
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/web"

CAPSULE_DIR="src/features/terminal/capsule"

# `|| true`: a missing tree must reach the guard below and print what to fix,
# instead of dying at this line under `set -e -o pipefail` with only find's error.
matched=$(find "$CAPSULE_DIR" -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null | wc -l | tr -d ' ' || true)
if [ "$matched" -eq 0 ]; then
  echo "✗ capsule tree matched no files under $CAPSULE_DIR"
  echo "  Fix: the capsule moved — update CAPSULE_DIR in scripts/check-design-tokens.sh"
  exit 1
fi

npx eslint "$CAPSULE_DIR/**/*.{ts,tsx}" \
  --report-unused-disable-directives \
  --max-warnings 0

echo "✓ check-design-tokens (capsule eslint gate, $matched files)"
