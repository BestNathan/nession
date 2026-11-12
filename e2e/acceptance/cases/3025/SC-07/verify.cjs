'use strict';
// #3025 SC-07: a Project is readable and a first Session creatable before any
// Session exists; the create does not depend on a preexisting Session row.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const server = crateTests(
    'nession-server',
    ['--lib', 'server_project_'],
    300_000,
  );
  assertRan(server, [
    'project_list_is_empty_but_successful_with_zero_sessions',
  ]);

  const create = crateTests(
    'nession-server',
    ['--lib', 'server_session_create_v1::'],
    300_000,
  );
  assertRan(create, [
    'project_session_create_uses_the_declared_existing_location',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the authenticated Project list answered successfully while ' +
      'the Session set was empty, and a Project-aware create reached the Agent and returned ' +
      'the Session id without any preexisting Session row (server handler tests)',
  });
  return 'A Project is readable and usable to create the first Session while zero Sessions exist';
});
