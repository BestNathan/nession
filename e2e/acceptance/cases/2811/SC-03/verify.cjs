'use strict';
// #2811 SC-03: no attach path dials an Agent without the scoped Server-issued
// credential, and an absent credential or exhausted candidates produce a
// bounded actionable error instead of a false attach success. The credential-
// negative fixture needs a scripted Server: the real Server always mints a P2P
// credential, so it cannot produce the absence this criterion forbids.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'attach_route::sc03_forced_p2p_without_a_credential_never_dials_the_agent',
  'attach_route::sc03_auto_attach_reports_a_bounded_error_when_candidates_and_relay_fail',
];

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-cli',
    ['--test', 'integration', 'sc03_'],
    300000,
  );
  assertRan(output, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a scripted Server answered the P2P attach plan without a ' +
      'connection credential; forced P2P failed naming the missing credential with a ' +
      'tripwire listener observing zero Agent connections, and auto preserved that reason ' +
      'while also carrying the Server relay refusal — no false attach success',
  });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': with one refused candidate, one malformed candidate and an ' +
      'unavailable relay, auto returned a bounded error in under 15 seconds naming both ' +
      'exhausted candidates and the relay sentence; the tripwire recorded exactly one dial ' +
      'and its request line carried the Server-issued credential',
  });
  return 'No uncredentialed Agent dial; absent credential and exhausted candidates fail bounded and actionable';
});
