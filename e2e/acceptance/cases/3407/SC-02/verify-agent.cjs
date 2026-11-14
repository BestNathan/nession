'use strict';
// #3407 SC-02 (Agent half): Project Location resolution validates the real
// host directory and the managed Workspace selection keeps its pinned lower.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests('nession-agent', ['--lib', 'tmux::sandbox_context::tests::']);
  assertRan(agent, [
    'tmux::sandbox_context::tests::a_project_location_must_be_a_real_canonical_directory',
    'tmux::sandbox_context::tests::a_symlinked_project_location_is_refused',
    'tmux::sandbox_context::tests::an_unknown_explicit_managed_workspace_is_refused',
    'tmux::sandbox_context::tests::a_managed_workspace_pins_its_project_lower_across_resolution',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Agent accepted only a real, canonical Project Location ' +
      'directory, refused a symlinked or missing location, refused a location combined with ' +
      'a Project EROFS lower, and persisted the managed Workspace lower pin across resolution',
  });
  return 'The Agent-side Project Location and managed-resolution rules are proven';
});
