'use strict';
// #2848 SC-01: a stale recovering row is selected, the Agent restores the
// Session before the destructive boundary, and the resumed sweep leaves the
// live Server Session, its persisted row and its desired Environment Binding
// intact. The test uses a real SQLite database + SessionRegistry + EnvService,
// loading the stale row the way a Server restart does.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'server::orphan_sweep::tests::sc01_a_restored_session_and_its_binding_survive_a_stale_selection';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--lib', 'server::orphan_sweep::tests::sc01_'],
    300000,
  );
  assertRan(output, [TEST]);

  const measured = /#2848 SC-01 measured: ([^\n]+)/.exec(output);
  if (!measured) throw new Error('the SC-01 measurement line is missing');

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a 48-hour-old recovering row was selected, then the ' +
      'same Session was restored to active before the sweep resumed — ' + measured[1] +
      '; the live registry entry, the persisted row and the desired Environment ' +
      'Binding all survived the stale selection',
  });
  return 'A restored Session and its Environment Binding survive a stale sweep selection';
});
