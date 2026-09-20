#!/usr/bin/env bash
set -euo pipefail

# check-codegen-drift.sh — the generated TypeScript must be what the Rust
# contracts say (#678 Phase 5).
#
# The design's rule for generated output is "deterministic; committed to Git;
# CI regenerate + diff". This is the regenerate + diff.
#
# ## Why a scratch directory rather than regenerating in place
#
# Regenerating over the committed tree and diffing with `git diff --exit-code`
# is the obvious form, and it has a failure mode worth avoiding: the check
# leaves the tree modified. The next run then diffs against a tree that is
# already regenerated, reports clean, and passes — while the committed files are
# still stale. A check that repairs the condition it is testing cannot report it
# twice.
#
# So the generator writes to a temporary directory and the two are compared.
# The working tree is not touched on either path.
#
# Usage: ./scripts/check-codegen-drift.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GENERATED="$ROOT/web/src/generated/protocol"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ ! -d "$GENERATED" ]; then
  echo -e "${RED}✗ $GENERATED does not exist${NC}"
  echo -e "${YELLOW}  Run: just codegen${NC}"
  exit 1
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

if ! (cd "$ROOT" && cargo run --quiet -p nession-protocol-codegen -- "$SCRATCH" >/dev/null); then
  echo -e "${RED}✗ the generator failed; nothing was compared${NC}"
  exit 1
fi

if diff -r -u "$GENERATED" "$SCRATCH" > /tmp/codegen-drift.diff 2>&1; then
  echo -e "${GREEN}✓ codegen drift check: generated bindings match the contracts${NC}"
  exit 0
fi

echo -e "${RED}CODEGEN_DRIFT${NC}"
echo -e "  committed: ${YELLOW}web/src/generated/protocol${NC}"
echo -e "  differs from what the Rust contracts currently produce."
echo ""
head -60 /tmp/codegen-drift.diff
echo ""
echo -e "${YELLOW}repair: run 'just codegen' and commit the result — do not edit the generated files by hand${NC}"
exit 1
