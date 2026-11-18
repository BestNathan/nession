#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='cloudflare-site-dns-selftest'
GATE_NAME='Cloudflare site DNS provider fail-closed contract'
GATE_COMMAND='node --test scripts/ci/configure-cloudflare-site.test.mjs'
GATE_SUCCESS='bounded staging MCP site DNS planning/reconciliation and negative provider fixtures pass'
GATE_FAILURE='Cloudflare site provider escaped a registration, ownership, IP or mutation boundary'
GATE_REPAIR='fix scripts/ci/configure-cloudflare-site.mjs and preserve negative mock API fixtures'
GATE_OWNER='scripts/ci/configure-cloudflare-site.mjs'

gate_check() {
  gate_require_command node "Install Node.js to verify Cloudflare site DNS policy." || return $?
  gate_run_invariant node --test scripts/ci/configure-cloudflare-site.test.mjs
}
gate_main "$@"
