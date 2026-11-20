'use strict';
// #4091 SC-02 (SCN-03 + SCN-04 identity/credential isolation): a denied
// principal/Session or Repository B cannot fetch Agent A's private Manifest/Blob
// through a direct peer pull or a forged digest/endpoint, while valid Repository A
// access works. Agent A's own P2P identity denies the distinct Server Token, so no
// global Server credential is reused across peers; grants are repository-scoped.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'peer_registry::tests::sc02_denied_principal_foreign_repo_forged_digest_and_no_global_credential';
const MEASURED = /^#4091 SC-02 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-agent', ['--lib', TEST], 600000);
  assertRan(output, [TEST]);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-02 identity/credential-isolation measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-02: denied principal/Session, foreign Repository B, forged digest and forged endpoint all fail closed against Agent A private closure; the distinct Server Token is denied (no global credential reuse); valid repository-scoped Repository A access fetches the pinned Manifest';
});
