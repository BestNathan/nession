'use strict';
// #2804 SC-01: an incremental poll whose tmux enumeration fails is not an
// observed empty Session list. The real watcher publishes no `gone`, keeps its
// previous snapshot, and converges on the next successful query; the real
// Server handler keeps a Session's desired Environment Binding for every
// non-`gone` update and clears it only on a genuine `gone`.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const INCREMENTAL =
  'sync::session_watcher::enumeration_failure::' +
  'a_failed_enumeration_in_an_incremental_poll_sends_no_gone_and_keeps_tracking';
const HEARTBEAT =
  'sync::heartbeat::tests::' +
  'a_failed_enumeration_skips_the_heartbeat_instead_of_reporting_zero_sessions';
const SERVER_BINDING =
  'server::handler::tests::server_agent_session_update_v1::' +
  'a_non_gone_update_keeps_the_desired_environment_binding';
const OPS_BOUNDARY = 'a_failed_list_sessions_is_an_error_not_an_empty_session_list';

run(({ evidence }) => {
  const sha = targetSha();

  const incremental = crateTests('nession-agent', ['--lib', INCREMENTAL], 600000);
  assertRan(incremental, [INCREMENTAL]);

  const heartbeat = crateTests('nession-agent', ['--lib', HEARTBEAT], 600000);
  assertRan(heartbeat, [HEARTBEAT]);

  const binding = crateTests('nession-server', ['--lib', SERVER_BINDING], 600000);
  assertRan(binding, [SERVER_BINDING]);

  // The owner below the watcher must keep the distinction too: a real non-zero
  // tmux exit is an Err, not an observed-empty session list.
  const ops = crateTests('nession-tmux', ['--lib', OPS_BOUNDARY], 600000);
  assertRan(ops, [OPS_BOUNDARY]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': with one tracked Session, a forced list_sessions ' +
        'Err produced zero outbox frames (no gone), tracked_sessions() retained ' +
        '"dev", and a later successful Ok([]) emitted exactly one gone',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the real server.agent.session-update handler kept ' +
        'the desired Environment Binding for a non-gone update and cleared it only ' +
        'when a genuine gone arrived',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a failed enumeration skipped the heartbeat instead ' +
        'of publishing a fabricated zero-session count',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the tmux owner returned Err for a real non-zero ' +
        'list-sessions exit ("lost server"), so the watcher cannot mistake it ' +
        'for an observed empty snapshot',
    },
  );
  return 'A failed incremental enumeration publishes no gone and preserves the Session and its desired binding; genuine deletion still converges';
});
