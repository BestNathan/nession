#!/bin/bash
# scripts/check-legacy-frozen.sh
#
# Verifies that no new files have been added to legacy directories.
# Legacy directories are frozen during architecture migration (Phase 0-5).
#
# Exit codes:
#   0 - No new files in legacy directories
#   1 - New files detected in legacy directories
#
# Usage:
#   ./scripts/check-legacy-frozen.sh [base-ref]
#
# Arguments:
#   base-ref - Git ref to compare against (default: origin/staging)

set -euo pipefail

BASE_REF="${1:-origin/staging}"

# Legacy directories that are frozen
LEGACY_DIRS=(
  "web/src/components/"
  "web/src/hooks/"
  "web/src/session-first/"
  "web/src/explorer/"
)

# Allowed patterns (files that can be added to legacy dirs)
ALLOWED_PATTERNS=(
  "*.test.ts"
  "*.test.tsx"
  "*.spec.ts"
  "*.spec.tsx"
  "**/__tests__/**"
  "*.d.ts"
  "*/types.ts"
)

echo "🔍 Checking for new files in legacy directories..."
echo "   Base ref: $BASE_REF"

# Get list of added files compared to base ref
ADDED_FILES=$(git diff --name-only --diff-filter=A "$BASE_REF" HEAD 2>/dev/null || echo "")

if [ -z "$ADDED_FILES" ]; then
  echo "✅ No new files detected."
  exit 0
fi

VIOLATIONS=()

for file in $ADDED_FILES; do
  for legacy_dir in "${LEGACY_DIRS[@]}"; do
    if [[ "$file" == "$legacy_dir"* ]]; then
      # Check if file matches allowed patterns
      IS_ALLOWED=false
      for pattern in "${ALLOWED_PATTERNS[@]}"; do
        if [[ "$file" == $pattern ]]; then
          IS_ALLOWED=true
          break
        fi
      done

      # Allow components/ui/ (shadcn primitives)
      if [[ "$file" == "web/src/components/ui/"* ]]; then
        IS_ALLOWED=true
      fi

      if [ "$IS_ALLOWED" = false ]; then
        VIOLATIONS+=("$file")
      fi
      break
    fi
  done
done

if [ ${#VIOLATIONS[@]} -eq 0 ]; then
  echo "✅ No violations found."
  exit 0
fi

echo "❌ New files detected in legacy directories:"
echo ""
for file in "${VIOLATIONS[@]}"; do
  echo "   $file"
done
echo ""
echo "Legacy directories are frozen during architecture migration."
echo "New business logic should go to:"
echo "   - features/  (feature modules)"
echo "   - app/workbench/  (app shell and layout)"
echo ""
echo "See #650 for architecture migration plan."
exit 1
