#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='parallel-gateway-contract'
GATE_NAME='Parallel public/private gateway policy and cross-repository cutover receipt'
GATE_COMMAND='node --test scripts/ci/site-registry/gateway-policy.test.mjs scripts/ci/site-registry/gateway-rollout.test.mjs scripts/ci/site-registry/retire-origin-ca.test.mjs && node scripts/ci/site-registry/gateway-policy.mjs check-fixture && node scripts/ci/site-registry/retire-origin-ca.mjs check-source'
GATE_SUCCESS='the versioned parallel entrypoints, exact public allowlist/paths, ownership, pinned-SHA policy artifact and cross-repo rollout/retirement receipts fail closed with no competing certificate or route owner'
GATE_FAILURE='a parallel-gateway policy, route fixture or rollout receipt escaped private/disabled/wildcard exposure, HK->SLB chaining, Higress TLS, stale revision or premature retirement rules'
GATE_REPAIR='repair the site-registry gateway policy/rollout owners and their negative fixtures; never weaken the reviewed topology or retirement evidence'
GATE_OWNER='scripts/ci/site-registry/gateway-policy.mjs + scripts/ci/site-registry/gateway-rollout.mjs + scripts/ci/site-registry/retire-origin-ca.mjs + docs/engineering/parallel-gateway-contract.md'

gate_check() {
  gate_require_command node "Install Node.js to verify the parallel gateway policy and rollout receipts." || return $?
  gate_run_invariant node --test \
    scripts/ci/site-registry/gateway-policy.test.mjs \
    scripts/ci/site-registry/gateway-rollout.test.mjs \
    scripts/ci/site-registry/retire-origin-ca.test.mjs
  gate_run_invariant node scripts/ci/site-registry/gateway-policy.mjs check-fixture
  gate_run_invariant node scripts/ci/site-registry/retire-origin-ca.mjs check-source
}

gate_main "$@"
