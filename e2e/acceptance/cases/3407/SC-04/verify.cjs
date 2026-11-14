'use strict';
// #3407 SC-04: the selected managed Workspace is the durable writable storage;
// a Project source EROFS is its pinned lower; re-entry observes the same
// durable upper. A mismatched/missing lower, an external Project Location with
// a lower, and a non-Agent-owned writable directory are refused before any
// Native fallback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, crateTests, checked, assertRan,
} = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

try {
  checked('sudo', ['apt-get', 'update', '-qq'], 120000);
  checked(
    'sudo',
    ['apt-get', 'install', '-y', '-qq', 'erofs-utils', 'erofsfuse', 'fuse3', 'fuse-overlayfs'],
    300000,
  );
} catch (error) {
  console.error('could not install EROFS helpers: ' + error.message);
}

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-erofs-accept-'));
process.env.SANDBOX_EROFS_IMAGE_ROOT = imageRoot;
const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable, [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else if (!capabilities.erofs || !capabilities.erofs_overlay) {
  pending(
    'The runner cannot mount prepared EROFS images or merge a writable workspace overlay',
    [{ type: 'blocked', value: capabilityLine(capabilities) }],
  );
} else {
  run(({ evidence }) => {
    const sha = targetSha();

    const agent = crateTests('nession-agent', [
      '--lib',
      'sandbox_images::workspace_override_tests::',
    ]);
    assertRan(agent, [
      'sandbox_images::workspace_override_tests::a_managed_workspace_keeps_the_project_erofs_lower',
      'sandbox_images::workspace_override_tests::a_project_location_is_external_and_refuses_a_lower',
    ]);
    const pin = crateTests('nession-agent', [
      '--lib',
      'workspace_manager::tests::a_lower_digest_is_pinned_for_the_durable_upper',
    ]);
    assertRan(pin, [
      'workspace_manager::tests::a_lower_digest_is_pinned_for_the_durable_upper',
    ]);

    const server = crateTests('nession-server', [
      '--lib',
      'server::handler::tests::server_session_sandbox_v1::',
    ]);
    assertRan(server, [
      'server::handler::tests::server_session_sandbox_v1::preflight_managed_workspace_pins_the_project_source_image_as_lower',
      'server::handler::tests::server_session_sandbox_v1::enter_grants_the_project_source_image_for_a_managed_workspace',
    ]);

    const sandbox = checked('cargo', ['test', '-p', 'nession-sandbox', '--lib', '--', '--nocapture'], 600000);
    assertRan(sandbox, [
      'exec::tests::an_agent_workspace_must_live_under_an_authorized_root',
      'exec::tests::a_project_location_is_external_but_must_be_a_canonical_directory',
      'policy::tests::a_project_location_workspace_cannot_carry_a_project_lower',
      'capabilities::tests::a_linux_composition_without_erofs_support_is_refused',
      'capabilities::tests::a_linux_workspace_image_without_overlay_support_is_refused',
    ]);

    const output = runLinuxRuntimeTest(
      'a_managed_workspace_keeps_its_durable_upper_across_overlay_reentry',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.first_overlay, true, 'the first Enter must install the Overlay');
    assert.equal(facts.durable_upper_preserved, true, 'the sandbox write must land in the durable upper');
    assert.equal(facts.reentry_same_bytes, true, 're-entry must observe the same durable upper');
    assert.equal(facts.workspace_survived_cleanup, true, 'cleanup must release the lease, not bytes');
    assert.match(facts.project_lower_digest, /^sha256:[0-9a-f]{64}$/);

    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a managed Workspace directory was authorized outside the execution ' +
        'state directory and merged with project lower ' + facts.project_lower_digest + ' through ' +
        'fuse-overlayfs; a sandbox write landed in the durable upper; after cleanup and a second ' +
        'Enter the same bytes and the same Project lower were visible, and the managed directory ' +
        'survived; a changed/missing lower and an external Project Location with a lower were ' +
        'refused before preparation',
    });
    return 'A managed durable upper over a pinned Project EROFS lower survives re-entry and refuses changed/incompatible storage';
  });
}
