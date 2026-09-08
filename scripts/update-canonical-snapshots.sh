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

echo "→ Updating Playwright snapshots (fixture-visual only)"
cd e2e
npm ci
npx playwright install chromium --with-deps
CI=true npx playwright test fixture-visual --update-snapshots

echo "→ Snapshots written to e2e/specs/__snapshots__/fixture-visual.spec.ts/"
echo "  Review diffs, commit, and open a PR to staging."
