'use strict';
// #2514 SC-08 (runtime half): the sanitization runs before the Agent→Server
// hop and the web inspector renders command first, with unavailable metrics
// kept distinct from zero.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const {
  runProcessDiscoveryTests,
  runWebTests,
} = require('../../../shared/process-discovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  runProcessDiscoveryTests([
    'a_secret_flag_takes_the_next_argument_as_its_value',
    'a_secret_in_an_assignment_flag_is_redacted_but_the_flag_stays_readable',
    'url_userinfo_is_removed_before_the_agent_server_hop',
    'bearer_material_is_removed_wherever_it_appears',
    'display_is_bounded_and_says_so',
    'an_unreadable_command_is_not_an_empty_command',
    'sampled_metrics_keep_their_units_and_missing_ones_keep_their_reason',
  ]);
  const total = runWebTests([
    'src/product/agent/components/__tests__/integration/AgentProcesses.test.tsx',
    'src/product/agent/model/__tests__/unit/processSnapshot.test.ts',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha +
        ': secret flags, assignment values, URL userinfo and bearer material were replaced before the Agent→Server hop; display bounds were reported',
    },
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + total +
        ' inspector/model tests passed — command-first order, sanitized copy source, sampled zero versus unavailable, and an incomplete subtree metric staying unavailable',
    },
  );
  return 'The command is sanitized and bounded at the Agent boundary, and the inspector renders it first with unavailable metrics distinct from zero';
});
