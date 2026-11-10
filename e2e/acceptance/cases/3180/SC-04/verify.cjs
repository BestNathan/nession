'use strict';
// #3180 SC-04: an approved isolated Kubernetes fixture that deletes and
// recreates disposable Server/Agent Pods on an existing RWX PVC is required to
// prove the Blob and the Agent-specific cache survive without rebuilding or
// re-downloading a warm Digest. The trusted Case lanes have no Kubernetes
// runner, and kind plus a bound PVC does not fit the canonical 120-second
// verifier budget. The Issue explicitly keeps this criterion Pending rather
// than claiming live Kubernetes proof.
//
// This Case is the formal executable obligation: it binds the exact staging
// SHA and records why no live proof exists. Replacing the pending verdict with
// a real fixture is the work of an approved isolated K8s Case runner; #3023
// SC-05 later used a sealed one-time kind task observation for that proof.
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

try {
  const sha = targetSha();
  process.stdout.write(JSON.stringify({
    status: 'pending',
    summary:
      'SC-04 requires an isolated Kubernetes Pod delete/recreate fixture on an existing RWX PVC, ' +
      'but no trusted K8s Case lane exists and kind/PVC provisioning exceeds the 120-second ' +
      'verifier budget; the Issue keeps this criterion Pending instead of claiming live proof',
    evidence: [{
      type: 'blocked',
      value:
        'exact staging SHA ' + sha + ': no Kubernetes runner in the trusted Case lanes; ' +
        'kind/PVC provisioning cannot complete within the canonical 120s verifier cap; ' +
        'the rendered NFS PVC/PV/subPath contract is verified by the gitops-storage-contract ' +
        'Gate and SC-03, but this Case did not observe live Pod UID/PVC identity or byte survival',
    }],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{ type: 'runtime', value: 'the exact staging SHA could not be bound for the SC-04 obligation' }],
  }) + '\n');
  process.exitCode = 1;
}
