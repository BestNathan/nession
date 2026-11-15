'use strict';
// #3407 SC-04 (Sandbox half): host-path ownership rules and the fail-closed
// EROFS/Overlay capability gate.
const { run, targetSha, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const sandbox = checked('cargo', ['test', '-p', 'nession-sandbox', '--lib', '--', '--nocapture'], 600000);
  assertRan(sandbox, [
    'exec::tests::an_agent_workspace_must_live_under_an_authorized_root',
    'exec::tests::a_project_location_is_external_but_must_be_a_canonical_directory',
    'policy::tests::a_project_location_workspace_cannot_carry_a_project_lower',
    'capabilities::tests::a_linux_composition_without_erofs_support_is_refused',
    'capabilities::tests::a_linux_workspace_image_without_overlay_support_is_refused',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': Agent-owned writable roots were constrained to the sandbox state ' +
      'or Agent Workspace root; a Project Location was external, canonical and protected from ' +
      'Agent-owned roots; a Project Location with a lower was refused; missing erofsfuse or ' +
      'fuse-overlayfs stayed a fail-closed UnsupportedPolicy',
  });
  return 'The Sandbox workspace ownership and EROFS/Overlay fail-closed rules are proven';
});
