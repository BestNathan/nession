'use strict';
// #3990 SC-02: after a controlled reconnect the Git capability cannot dispatch
// with the previous generation's contract version. Before the replacement
// socket delivers its own Agent list it refuses locally and sends nothing; a
// changed manifest then produces the truthful incompatibility; a supported
// manifest lets the call execute normally with the fresh version.
const { run, targetSha, webVitestFiles } = require('../../../shared/web-vitest-cases.cjs');

const RECONNECT = 'src/capabilities/git/__tests__/integration/GitProtocolReconnect.test.ts';
const GIT = 'src/capabilities/git/__tests__/unit/GitPlugin.test.ts';

const RECONNECT_TESTS = [
  'refuses a Git call after reconnect until the replacement socket delivers its own Agent list',
  'uses only the replacement manifest: changed versions refuse, supported versions execute',
];

const GIT_TESTS = [
  'names the resolved version when the target advertises one we speak',
  'refuses rather than sending unversioned when the target is not in the directory',
  'refuses locally when the target serves only versions we cannot read',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitestFiles([RECONNECT], RECONNECT_TESTS, { project: 'integration' });
  webVitestFiles([GIT], GIT_TESTS, { project: 'unit' });
  evidence.push({
    type: 'protocol',
    value:
      'exact SHA ' + sha + ': after reconnect and before the new list, gitStatus refused ' +
      'with "`a1` is not in the protocol directory yet" and no frame reached the ' +
      'replacement socket; a replacement list advertising git.status v1 then refused ' +
      'with the named no-common-version message; a replacement list advertising v2 sent ' +
      'contract_version=2 and resolved the response',
  });
  return 'the Git consumer dispatches only a version resolved from the current physical connection’s Agent snapshot';
});
