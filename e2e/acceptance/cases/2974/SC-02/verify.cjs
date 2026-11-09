'use strict';
// #2974 SC-02: an Agent restart over the same surviving tmux Session preserves
// that instance's valid Claude binding. The restart's first read of the durable
// instance identity must adopt the id the create delivered (otherwise it would
// look for a file no hook was ever told to write). The negative half follows:
// after that Session is deleted and the name recreated, a late write from the
// deleted instance's hook must not make the newer same-name Session resolve to
// the old conversation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

// Private tmux server and state directory: the restart is a fresh
// `SessionManager` over the same tmux Session, not a shared runner session.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2974-sc02-'));
const env = {
  NESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'),
  NESSION_HOME: path.join(dir, 'home'),
};

const TEST =
  'claude_session_context::tests::' +
  'an_agent_restart_preserves_the_binding_of_the_surviving_tmux_instance';

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const output = cargoTests(['--lib', TEST], 300000, env);
  assertRan(output, [TEST]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ' on ' + version + ': a fresh SessionManager over the surviving ' +
      'tmux Session resolved the valid binding and adopted the create-delivered instance id; ' +
      'after kill + same-name recreate, a delayed write from the deleted instance\'s binding ' +
      'file left the newer Session unbound (claude_session_context::tests, private socket + ' +
      'state dir)',
  });
  return 'An Agent restart preserves a surviving tmux instance\'s binding and a deleted instance cannot rebind a newer same-name Session';
});
