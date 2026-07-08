#!/usr/bin/env bash
set -euo pipefail

# bump-version.sh — bump Nession version in Cargo.toml + web/package.json
# Usage: ./scripts/bump-version.sh <minor|patch>

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

die() { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
ok()  { echo -e "${GREEN}✓${NC} $*"; }

# ── Validate argument ────────────────────────────────────────────────
BUMP="${1:-}"
if [ "$BUMP" != "minor" ] && [ "$BUMP" != "patch" ]; then
  echo "Usage: $0 <minor|patch>"
  echo ""
  echo "  minor  0.x.0  — new feature, behavior change"
  echo "  patch  0.x.y  — bug fix, small tweak"
  exit 1
fi

# ── Read current versions ────────────────────────────────────────────
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

RUST_VER=$(grep -m1 '^version' "$ROOT/Cargo.toml" | sed 's/.*"\(.*\)".*/\1/')
WEB_VER=$(grep '"version"' "$ROOT/web/package.json" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')

[ -z "$RUST_VER" ] && die "Could not read version from Cargo.toml"
[ -z "$WEB_VER" ]  && die "Could not read version from web/package.json"

if [ "$RUST_VER" != "$WEB_VER" ]; then
  die "Version mismatch: Cargo.toml=$RUST_VER, package.json=$WEB_VER"
fi

CURRENT="$RUST_VER"

# ── Calculate new version ────────────────────────────────────────────
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"

# ── Update files ─────────────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/version = \"${CURRENT}\"/version = \"${NEW}\"/" "$ROOT/Cargo.toml"
  sed -i '' "s/\"version\": \"${CURRENT}\"/\"version\": \"${NEW}\"/"  "$ROOT/web/package.json"
else
  sed -i "s/version = \"${CURRENT}\"/version = \"${NEW}\"/" "$ROOT/Cargo.toml"
  sed -i "s/\"version\": \"${CURRENT}\"/\"version\": \"${NEW}\"/"  "$ROOT/web/package.json"
fi

ok "Bumped version: ${CURRENT} → ${NEW}"
ok "Updated: Cargo.toml"
ok "Updated: web/package.json"
