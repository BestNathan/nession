#!/usr/bin/env bash
set -euo pipefail

# move-screenshots.sh — relocate stray root-level PNG screenshots into the
# gitignored .playwright-mcp/screenshots/ directory.
#
# Playwright MCP's browser_take_screenshot saves to the CWD when given a bare
# filename, so screenshots can land in the repo root. This script moves them to
# the canonical, gitignored screenshots dir so they never leak into a commit.
# Run manually, or let the pre-commit hook invoke it.
#
# Usage: ./scripts/move-screenshots.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.playwright-mcp/screenshots"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

mkdir -p "$DEST"

moved=0
for png in "$ROOT"/*.png; do
  # A non-matching glob leaves the literal pattern — skip it.
  [ -e "$png" ] || continue

  name="$(basename "$png")"
  dest="$DEST/$name"

  # Collision → disambiguate with a timestamp suffix rather than overwrite.
  if [ -e "$dest" ]; then
    name="${name%.png}-$(date +%Y%m%d-%H%M%S).png"
    dest="$DEST/$name"
  fi

  mv "$png" "$dest"
  echo -e "${GREEN}✓${NC} ${YELLOW}$(basename "$png")${NC} → .playwright-mcp/screenshots/$name"
  moved=$((moved + 1))
done

if [ "$moved" -eq 0 ]; then
  echo "No stray PNGs in repo root."
else
  echo -e "${GREEN}Moved $moved PNG(s)${NC} to .playwright-mcp/screenshots/"
fi
