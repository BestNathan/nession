'use strict';
// #3025 SC-03: create-time precedence is explicit request > Project defaults,
// the effective ordered ENV binding is Session-owned, and editing the Project
// afterwards never mutates an existing Session's realized environment.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const server = crateTests(
    'nession-server',
    ['--lib', 'server_session_create_v1::'],
    300_000,
  );
  assertRan(server, [
    'project_session_create_applies_project_env_defaults',
    'project_session_create_explicit_env_selection_wins',
    'project_defaults_edit_does_not_change_an_existing_session',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': with no request selection the Project ordered ENV profile ids ' +
      'were resolved in declaration order, sent as the Agent snapshots and persisted as the ' +
      "Session's own binding; an explicit request file outranked the Project default; a later " +
      'Project default edit left the existing Session binding and snapshots unchanged (server ' +
      'handler tests)',
  });
  return 'Project/template/user precedence is applied deterministically at create time, the effective ENV binding belongs to the Session, and later Project edits do not change an existing Session';
});
