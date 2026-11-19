#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='cloudflare-site-dns-selftest'
GATE_NAME='Cloudflare site DNS and Origin CA fail-closed contract'
GATE_COMMAND='node --test scripts/ci/configure-cloudflare-site.test.mjs scripts/ci/issue-cloudflare-origin-ca.test.mjs'
GATE_SUCCESS='bounded staging MCP DNS and Origin CA tests prove no unscoped or plaintext publication'
GATE_FAILURE='Cloudflare site provider escaped a registration, key, DNS or certificate boundary'
GATE_REPAIR='repair site DNS and Origin CA owner scripts and all negative mocked provider fixtures'
GATE_OWNER='scripts/ci/configure-cloudflare-site.mjs'

gate_check() {
  gate_require_command node "Install Node.js to verify Cloudflare site DNS policy." || return $?
  gate_run_invariant node --test scripts/ci/configure-cloudflare-site.test.mjs scripts/ci/issue-cloudflare-origin-ca.test.mjs
}
gate_main "$@"
