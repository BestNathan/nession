'use strict';
// #2812 SC-03: normal creation with an Environment Binding still yields the
// requested geometry, the durable binding, and a discoverable/attachable
// Session. Failure recovery must not regress that path.
//
// The recovery module proves the whole outcome against an injected tmux whose
// session table is observable. The two real-tmux tests then prove the shipped
// path on a private socket: the created window is the requested width/height
// (not a client's), and the initial shell of a binding create receives the
// bound environment.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run,
  targetSha,
  crateTests,
  assertRan,
  tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

const SUCCESS =
  'tmux::manager::create_recovery_tests::' +
  'a_successful_create_with_a_binding_keeps_geometry_binding_and_discovery';
const GEOMETRY = 'tmux::manager::window_size_lock_tests::' +
  'create_session_does_not_lock_window_size';
const BINDING = 'tmux::manager::binding_create_tests::' +
  'create_with_binding_applies_the_environment_to_the_initial_shell';

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2812-sc03-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const success = crateTests('nession-agent', ['--lib', SUCCESS], 300000, tmuxEnv);
  assertRan(success, [SUCCESS]);

  const geometry = crateTests('nession-agent', ['--lib', GEOMETRY], 300000, tmuxEnv);
  assertRan(geometry, [GEOMETRY]);

  const binding = crateTests('nession-agent', ['--lib', BINDING], 300000, tmuxEnv);
  assertRan(binding, [BINDING]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a binding create applied resize-window -x 200 -y 60, ' +
        'recorded binding.json at revision 1, listed the Session as discoverable, ' +
        'and observed revision 1 through EnvManager',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + version + ': a real created Session reported ' +
        'the requested 200x60 window and left window-size at tmux\'s dynamic policy',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + version + ': a real binding create\'s initial ' +
        'shell answered with the bound variable (INITIAL:v) in its own pane',
    },
  );
  return 'Normal creation keeps the requested geometry, the durable binding, and a discoverable/attachable Session';
});
