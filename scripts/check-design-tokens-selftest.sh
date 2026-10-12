#!/usr/bin/env bash
# Inject known capsule design violations and prove the canonical ESLint rule
# rejects them. An unrelated tool/fixture failure is never negative evidence.
set -euo pipefail
TARGET="web/src/product/terminal/capsule/__zz_design_token_probe.tsx"
[ -d "$(dirname "$TARGET")" ] || { echo "fixture owner missing" >&2; exit 2; }
[ ! -e "$TARGET" ] || { echo "fixture path already exists; refusing overwrite" >&2; exit 2; }
LOG="$(mktemp /tmp/nession-design-negative.XXXXXX)"
cleanup() { rm -f "$TARGET" "$LOG"; }
trap cleanup EXIT

if ! ./scripts/check-design-tokens.sh >"$LOG" 2>&1; then
  echo "canonical design token baseline failed; negative probes cannot be trusted" >&2
  cat "$LOG" >&2
  exit 2
fi
passes=0
failures=0
probe() {
  local name="$1" body="$2" status=0
  printf '%s\n' "$body" >"$TARGET"
  ./scripts/check-design-tokens.sh >"$LOG" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    echo "MISSED: $name (invalid fixture accepted)" >&2
    failures=$((failures+1))
  elif ! grep -Fq '__zz_design_token_probe.tsx' "$LOG" ||
       ! grep -Fq 'nession/no-capsule-magic-metrics' "$LOG"; then
    echo "INVALID NEGATIVE: $name failed for an unrelated reason" >&2
    cat "$LOG" >&2
    failures=$((failures+1))
  else
    echo "detected: $name"
    passes=$((passes+1))
  fi
  rm -f "$TARGET"
}
probe "magic h-8/text-xs" 'export function Probe() { return <div className="h-8 text-xs" />; }'
probe "max-lg fork" 'export function Probe() { return <div className="max-lg:size-11" />; }'
probe "numeric sideOffset" 'export function Probe() { return <PopoverContent sideOffset={8} />; }'
[ "$failures" -eq 0 ] || { echo "negative fixtures failed: $failures" >&2; exit 1; }
if ! ./scripts/check-design-tokens.sh >"$LOG" 2>&1; then
  echo "design token baseline failed after fixture cleanup" >&2
  cat "$LOG" >&2
  exit 2
fi
echo "design-token fixtures: $passes known violations rejected and clean baseline preserved"
