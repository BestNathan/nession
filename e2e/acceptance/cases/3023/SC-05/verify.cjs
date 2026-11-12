'use strict';
// #3023 SC-05: a controlled Kubernetes Pod-delete/recreate fixture on the same
// PVC is required to prove the blob survives and is reused. The trusted Case
// lanes have no Kubernetes runner, and creating an ephemeral kind cluster plus
// a bound PVC does not fit the 120-second verifier budget. The Issue explicitly
// allows leaving this criterion Pending rather than claiming live K8s proof.
//
// This Case is the formal executable obligation: it binds the exact staging SHA
// and records why no live proof exists. Replacing the pending verdict with a
// real fixture is the work of the isolated K8s Case runner, not this file.
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

try {
  const sha = targetSha();
  process.stdout.write(JSON.stringify({
    status: 'pending',
    summary:
      'SC-05 requires a controlled Kubernetes Pod-delete/recreate fixture binding the same PVC, ' +
      'but no trusted K8s Case lane exists and ephemeral cluster/PVC provisioning exceeds the ' +
      '120-second verifier budget; the Issue keeps this criterion Pending instead of claiming live proof',
    evidence: [{
      type: 'blocked',
      value:
        'exact staging SHA ' + sha + ': no Kubernetes runner in the trusted Case lanes; ' +
        'kind/PVC provisioning cannot complete within the canonical 120s verifier cap; ' +
        'the /data PVC contract is declared in GitOps and reviewed by SC-02, but this Case did not observe live Pod/PVC survival',
    }],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{ type: 'runtime', value: 'the exact staging SHA could not be bound for the SC-05 obligation' }],
  }) + '\n');
  process.exitCode = 1;
}
