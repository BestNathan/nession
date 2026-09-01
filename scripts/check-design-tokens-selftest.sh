#!/usr/bin/env bash
# Prove check-design-tokens / no-capsule-magic-metrics still detects violations.
set -uo pipefail

TARGET="web/src/session-first/capsule/__zz_design_token_probe.tsx"
pass=0
fail=0

cleanup() {
  rm -f "$TARGET"
}
trap cleanup EXIT

probe() {
  local name="$1" body="$2"
  printf '%s\n' "$body" >"$TARGET"
  if ./scripts/check-design-tokens.sh >/dev/null 2>&1; then
    echo "  ✗ MISSED: $name"
    fail=$((fail + 1))
  else
    echo "  ✓ detected: $name"
    pass=$((pass + 1))
  fi
  rm -f "$TARGET"
}

echo "→ design token probe must fail eslint capsule gate"

probe "h-8 text-xs" \
  'export function Probe() { return <div className="h-8 text-xs" />; }'

probe "max-lg fork" \
  'export function Probe() { return <div className="max-lg:size-11" />; }'

probe "numeric sideOffset" \
  'export function Probe() { return <PopoverContent sideOffset={8} />; }'

echo ""
if [ "$fail" -gt 0 ]; then
  echo "FAILED: $fail probe(s) not detected"
  exit 1
fi
echo "All $pass design-token probes detected ✓"
