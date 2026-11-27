#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='cloudflare-site-dns-selftest'
GATE_NAME='Site registry, split DNS and MCP-only exposure fail-closed contract'
GATE_COMMAND='node --test scripts/ci/site-registry/site-registry.test.mjs scripts/ci/configure-cloudflare-site.test.mjs scripts/ci/configure-adguard-dns.test.mjs scripts/ci/site-registry/edge-policy.test.mjs scripts/ci/site-registry/retire-origin-ca.test.mjs scripts/ci/issue-cloudflare-origin-ca.test.mjs scripts/ci/site-workflow-contract.test.mjs && node scripts/ci/site-registry/site-registry.mjs validate && node scripts/ci/site-registry/edge-policy.mjs check-fixture && node scripts/ci/site-registry/retire-origin-ca.mjs check-source && bash scripts/ci/site-dns-tunnel.sh self-test'
GATE_SUCCESS='bounded registry/provider/edge/retirement tests prove private-by-default identity, read-only plans, receipt-bound mutations, owned VPN lifecycle and no credential or plaintext publication'
GATE_FAILURE='the site contract escaped registry identity, visibility, ownership, plan-readiness, VPN lifecycle or certificate boundaries'
GATE_REPAIR='repair the site registry/provider/edge/retirement owner scripts and all negative mocked provider fixtures'
GATE_OWNER='scripts/ci/site-registry/site-registry.mjs + scripts/ci/configure-cloudflare-site.mjs + scripts/ci/configure-adguard-dns.mjs + scripts/ci/site-registry/edge-policy.mjs + scripts/ci/site-registry/retire-origin-ca.mjs + scripts/ci/site-dns-tunnel.sh'

gate_check() {
  gate_require_command node "Install Node.js to verify the site registry and DNS policy." || return $?
  gate_run_invariant node --test \
    scripts/ci/site-registry/site-registry.test.mjs \
    scripts/ci/configure-cloudflare-site.test.mjs \
    scripts/ci/configure-adguard-dns.test.mjs \
    scripts/ci/site-registry/edge-policy.test.mjs \
    scripts/ci/site-registry/retire-origin-ca.test.mjs \
    scripts/ci/issue-cloudflare-origin-ca.test.mjs \
    scripts/ci/site-workflow-contract.test.mjs
  gate_run_invariant node scripts/ci/site-registry/site-registry.mjs validate
  gate_run_invariant node scripts/ci/site-registry/edge-policy.mjs check-fixture
  gate_run_invariant node scripts/ci/site-registry/retire-origin-ca.mjs check-source
  gate_run_invariant bash scripts/ci/site-dns-tunnel.sh self-test
}
gate_main "$@"
