'use strict';
// #4166 SC-01: a deterministic SQLite error on the conditional DELETE must
// leave the still-expired recovering Session in both the live registry and
// SQLite, retain its desired Environment Binding, and reclaim nothing. The
// test uses a real SQLite database + SessionRegistry + EnvService with a
// controlled BEFORE DELETE trigger fault.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'server::orphan_sweep::tests::delete_failure_keeps_the_stale_session_in_the_live_registry';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--lib', 'server::orphan_sweep::tests::delete_failure_'],
    300000,
  );
  assertRan(output, [TEST]);

  const measured = /#4166 SC-01 measured: ([^\n]+)/.exec(output);
  if (!measured) throw new Error('the SC-01 measurement line is missing');

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a 48-hour-old recovering row was selected, then the ' +
      'conditional DELETE was forced to fail at SQLite — ' + measured[1] +
      '; the live registry entry, the persisted row and the desired Environment ' +
      'Binding all survived and no reclamation was reported',
  });
  return 'A failed conditional DELETE preserves the recovering Session in the live registry, SQLite and its Environment Binding';
});
