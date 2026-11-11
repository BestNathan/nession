'use strict';
// #2848 SC-02: a Session that remains recovering and stale beyond retention is
// still reclaimed with its Environment Binding, and a different Session is not
// touched. The test uses a real SQLite database + SessionRegistry + EnvService.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'server::orphan_sweep::tests::sc02_a_genuinely_stale_session_is_reclaimed_without_touching_another';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--lib', 'server::orphan_sweep::tests::sc02_'],
    300000,
  );
  assertRan(output, [TEST]);

  const measured = /#2848 SC-02 measured: ([^\n]+)/.exec(output);
  if (!measured) throw new Error('the SC-02 measurement line is missing');

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': one 48-hour-old recovering Session was selected while a ' +
      'different active Session was not — ' + measured[1] +
      '; the stale Session and its binding were reclaimed, while the other Session ' +
      'and its binding were untouched',
  });
  return 'A genuinely stale recovering Session and its binding are reclaimed without affecting another Session';
});
