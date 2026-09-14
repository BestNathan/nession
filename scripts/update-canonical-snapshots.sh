#!/usr/bin/env bash
# Generate or refresh canonical visual regression baselines (#561 Phase 7).
# Must match CI (Linux + Chromium). Prefer running in GitHub Actions or a Linux
# environment; darwin snapshots will not match CI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Building web UI"
(cd web && npm ci && npm run build)

echo "→ Building Rust server/agent"
cargo build -p nession-server -p nession-agent

# `=all` is required: a bare `--update-snapshots` means mode "changed", which
# still compares through maxDiffPixelRatio and only rewrites snapshots that FAIL
# tolerance — drift smaller than the ratio is skipped with no output at all.
echo "→ Updating Playwright snapshots (fixture-visual only, --update-snapshots=all)"
cd e2e
npm ci
npx playwright install chromium --with-deps
CI=true npx playwright test fixture-visual --update-snapshots=all

echo "→ Snapshots written to e2e/specs/__snapshots__/fixture-visual.spec.ts/"
echo "  Review diffs, commit, and open a PR to staging."
