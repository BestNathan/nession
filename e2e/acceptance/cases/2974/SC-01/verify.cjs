'use strict';
// #2974 SC-01: a Claude binding is owned by the tmux Session instance, not its
// name. In an isolated tmux runtime (private socket, private state directory),
// Session A writes a real hook-format payload. A is killed, and B is created
// with the same tmux name. Before B's hook runs, B's binding query must yield
// no association to A — and a delayed write to A's binding file must not bind
// B either. B's own hook then binds B's conversation.
//
// The assertion is the production read path (`TmuxSessionContext::
// session_claude_binding`) over real tmux, not a name/path string comparison.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

// The Agent's tmux server and state directory are private to this Case, so the
// test binary can never reach the runner's shared stack or a developer's state.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2974-sc01-'));
const env = {
  NESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'),
  NESSION_HOME: path.join(dir, 'home'),
};

const TEST =
  'claude_session_context::tests::' +
  'a_recreated_session_of_the_same_name_does_not_inherit_the_deleted_sessions_binding';

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const output = cargoTests(['--lib', TEST], 300000, env);
  assertRan(output, [TEST]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ' on ' + version + ': Session A resolved the hook payload it ' +
      'wrote; after kill_session and a create of the same tmux name, B resolved no binding; ' +
      'a delayed write to A\'s binding file still left B unbound; B\'s own hook then bound ' +
      'B\'s conversation (claude_session_context::tests, private socket + state dir)',
  });
  return 'A recreated same-name Session does not inherit the deleted Session\'s Claude binding';
});
