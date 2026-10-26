'use strict';
// #2469 SC-02: one typed SDK owns every tmux command in production paths.
//
// At the merged staging SHA this Case proves three things together:
//   1. the executable socket/ownership gate finds no tmux spawn or invocation
//      outside the SDK's process owner;
//   2. the SDK's admin API creates, lists, proves the environment reached the
//      shell, and kills a session on one real isolated tmux server;
//   3. the Agent's SessionManager still creates/lists/kills through that API.
const {
  run, targetSha, checked, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  // 1. Static ownership. The gate is the canonical executable owner; a raw
  //    spawn outside `nession-tmux/src/process.rs` fails it.
  checked('./scripts/check-tmux-socket.sh', [], 120000);

  // 2. SDK admin API over a real isolated tmux server.
  const sdk = checked(
    'cargo',
    ['test', '-p', 'nession-tmux', '--test', 'real_tmux'],
    300000,
  );
  assertRan(sdk, ['admin_creates_lists_and_kills_a_real_isolated_session']);

  // 3. The Agent adapter still drives create/list/kill through the SDK.
  const agent = checked(
    'cargo',
    ['test', '-p', 'nession-agent', '--test', 'integration', 'tmux::'],
    300000,
  );
  assertRan(agent, ['tmux::test_create_and_kill_session']);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + version +
        ': the typed SDK created a session on one real isolated socket, listed it, proved its environment reached the shell, and killed it',
    },
    {
      type: 'static',
      value:
        'the tmux socket-isolation gate found no process construction or tmux invocation outside the SDK owner; the Agent manager drove the same typed operations',
    },
  );
  return 'Every production tmux command is owned by nession-tmux and the typed admin API manages a real isolated server end to end';
});
