#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$root/catalog-plan.mjs" self-test
bash -n "$root/catalog-run.sh"
test -f "$root/catalog-plan.mjs"
echo 'catalog scripts self-test: PASS'
