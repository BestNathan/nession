'use strict';
// #3801 SC-02: waiting maps to working + input_required; an unsupported,
// unreadable or ambiguous Claude status is unknown and cannot be masked by the
// generic Shell claim; a Claude-named foreground alone is never working.
const { run, targetSha, cargoTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'a_bound_claude_pane_maps_busy_waiting_idle_and_releases_on_exit',
  'unbound_or_unsupported_claude_is_unknown_not_working',
  'the_foreground_name_alone_never_produces_working',
  'a_specialized_unknown_owner_blocks_the_generic_claim',
];

run(({ evidence }) => {
  const sha = targetSha();
  const output = cargoTests(['--lib', 'session::activity::'], 110000);
  assertRan(output, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      `exact SHA ${sha}: a verified waiting Claude mapped to working with ` +
      'attention input_required; an unbound PID and an unverified CLI version ' +
      'both mapped to unknown; the coordinator kept a specialized unknown owner ' +
      'ahead of the generic Shell working claim; the command name alone never ' +
      'produced working',
  });
  return 'Claude attention is orthogonal, and unverifiable Claude state stays unknown instead of Shell working';
});
