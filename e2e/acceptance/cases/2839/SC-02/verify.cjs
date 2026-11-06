'use strict';
// #2839 SC-02: while two probes are in flight, one Agent re-registers with the
// same URL. The completed result for the replaced registration must be dropped
// (the successor keeps its fresh Unknown status), while the unchanged Agent's
// result still applies.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'probe_sweep::sc02_a_stale_probe_result_cannot_overwrite_a_successor_registration';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--test', 'integration', 'probe_sweep::sc02_'],
    300000,
  );
  assertRan(output, [TEST]);

  const measured = /#2839 SC-02 measured: ([^\n]+)/.exec(output);
  if (!measured) throw new Error('the SC-02 measurement line is missing');

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a real AgentRegistry held both probes until Agent A ' +
      're-registered with the same URL; after release, ' + measured[1] +
      ' — the stale result was counted and written nowhere, while the unchanged ' +
      'Agent received its matching result',
  });
  return 'A stale probe result cannot overwrite a successor registration, while unchanged registrations still settle';
});
