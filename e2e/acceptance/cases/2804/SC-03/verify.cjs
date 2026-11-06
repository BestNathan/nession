'use strict';
// #2804 SC-03: two tracked Sessions, a failed enumeration, then a real removal
// of only one. The failure publishes nothing; the eventual snapshot deletes
// only the Session that actually disappeared, and the Server's real cleanup
// path acts on gone alone.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const SELECTIVE =
  'sync::session_watcher::enumeration_failure::' +
  'a_failed_enumeration_does_not_hide_selective_session_removal';
const SERVER_BINDING =
  'server::handler::tests::server_agent_session_update_v1::' +
  'a_non_gone_update_keeps_the_desired_environment_binding';

run(({ evidence }) => {
  const sha = targetSha();

  const selective = crateTests('nession-agent', ['--lib', SELECTIVE], 600000);
  assertRan(selective, [SELECTIVE]);

  const binding = crateTests('nession-server', ['--lib', SERVER_BINDING], 600000);
  assertRan(binding, [SERVER_BINDING]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': with "dev" and "api" tracked, a forced ' +
        'list_sessions Err published nothing and kept both; the next successful ' +
        'Ok(["api"]) emitted gone for "dev" only and left "api" tracked',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the Server clears the desired Environment Binding ' +
        'only through the gone path, so the survivor keeps its binding',
    },
  );
  return 'A failed enumeration never hides a real removal: only the Session that truly disappeared is deleted and unbound';
});
