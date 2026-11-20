'use strict';
// #4166 SC-02: after the injected DELETE failure is removed, a later sweep
// reclaims the same still-expired Session and its binding, while a distinct
// active Session and its binding remain untouched. The test uses a real SQLite
// database + SessionRegistry + EnvService with a controlled BEFORE DELETE
// trigger fault that is dropped before the retry.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'server::orphan_sweep::tests::retry_after_a_delete_failure_reclaims_only_the_stale_session';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--lib', 'server::orphan_sweep::tests::retry_after_a_delete_failure_'],
    300000,
  );
  assertRan(output, [TEST]);

  const measured = /#4166 SC-02 measured: ([^\n]+)/.exec(output);
  if (!measured) throw new Error('the SC-02 measurement line is missing');

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the first sweep failed its conditional DELETE and ' +
      'changed nothing; after the fault was removed the same 48-hour-old recovering ' +
      'Session was re-selected and reclaimed with its binding — ' + measured[1] +
      '; a distinct active Session and its binding were untouched',
  });
  return 'After a failed DELETE, a retry reclaims the same stale Session and binding without affecting another Session';
});
