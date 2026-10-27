'use strict';
// #2469 SC-09: the guards that keep the boundary are executable and negative.
//
// At the merged staging SHA this Case proves:
//   - the tmux socket/ownership gate rejects raw spawns and its selftest runs
//     the planted violation;
//   - the protocol gate rejects a wire that bypasses the Protocol Kernel, and
//     its selftest runs the planted violation;
//   - the Agent handler-locality guard rejects Session state held in a
//     transport handler, with its own negative fixture;
//   - the SDK independence guard detects a planted Nession dependency/reference;
//   - the documented owner paths named by the architecture docs exist;
//   - the gate router's definitions still validate.
const fs = require('node:fs');
const path = require('node:path');
const {
  run, targetSha, checked, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');

run(({ evidence }) => {
  const sha = targetSha();

  const selftests = checked(
    './gates/run',
    [
      'tmux-socket-isolation-selftest',
      'protocol-integrity-selftest',
      'server-handler-locality-selftest',
      'detector-selftest-coverage',
    ],
    900000,
  );
  for (const gate of [
    'tmux-socket-isolation-selftest',
    'protocol-integrity-selftest',
    'server-handler-locality-selftest',
    'detector-selftest-coverage',
  ]) {
    if (!selftests.includes(gate)) {
      throw new Error('gate selftest did not run: ' + gate);
    }
  }

  // The live guards, not only their negative fixtures.
  checked('./gates/run', ['tmux-socket-isolation', 'protocol-integrity', 'server-handler-locality'], 600000);
  checked('./gates/run', ['--validate'], 120000);

  const independence = checked(
    'cargo',
    ['test', '-p', 'nession-tmux', '--test', 'independence', '--', '--nocapture'],
    300000,
  );
  assertRan(independence, [
    'the_manifest_has_no_nession_dependency',
    'the_manifest_guard_detects_a_planted_dependency',
    'the_source_and_tests_name_no_nession_crate',
    'the_source_guard_detects_a_planted_reference',
  ]);

  const owners = [
    'docs/architecture/agent-tmux-control-transport.md',
    'docs/design/terminal/multi-client-ownership.md',
    'crates/nession-agent/AGENTS.md',
    'crates/nession-tmux/src/process.rs',
    'crates/nession-tmux/src/ops.rs',
    'crates/nession-agent/src/tmux/control.rs',
    'scripts/check-tmux-socket.sh',
    'scripts/protocol-gate.mjs',
  ];
  for (const owner of owners) {
    if (!fs.existsSync(path.join(root, owner))) {
      throw new Error('documented owner path is missing: ' + owner);
    }
  }

  evidence.push(
    {
      type: 'static',
      value:
        'exact SHA ' + sha +
        ': tmux socket/ownership, protocol-integrity, handler-locality and detector-coverage selftests each ran their negative fixture',
    },
    {
      type: 'static',
      value:
        'the live tmux-socket, protocol and handler-locality guards passed; the gate router definitions validated',
    },
    {
      type: 'test',
      value:
        'the SDK independence guard caught a planted Nession dependency and source reference, and the documented owner paths exist',
    },
  );
  return 'Import, ownership, socket and protocol guards detect planted violations, keep their negative fixtures, and the documented owner paths resolve';
});
