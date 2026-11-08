'use strict';
// #2973 SC-02: an explicitly configured, different nonempty `agent_id` still
// overrides the persisted identity, and subsequent starts with that explicit
// config remain stable. This is the negative control for the SC-01 fix: making
// absence mean "reuse persisted" must not demote an operator override.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const EXPLICIT_WINS =
  'identity::tests::resolve_when_config_differs_config_wins_and_overwrites';
const NO_FILE_USES_EXPLICIT =
  'identity::tests::resolve_when_no_file_creates_and_uses_config_value';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests('nession-agent', ['--lib', 'identity::tests'], 600000);
  assertRan(output, [EXPLICIT_WINS, NO_FILE_USES_EXPLICIT]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': an explicit `new-agent` config id overrode the ' +
        'persisted `old-agent`, rewrote the identity file, and the next start ' +
        'with the same explicit config resolved `new-agent` unchanged',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': with no identity file, an explicit config id was ' +
        'persisted and resolved exactly as configured',
    },
  );
  return 'Explicit configured agent identity still overrides persisted state and remains stable';
});
