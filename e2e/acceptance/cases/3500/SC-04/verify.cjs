'use strict';
// #3500 SC-04: at the exact merged staging SHA, an unsupported image platform,
// a missing mount proposal, an untrusted/overlapping target, a missing
// executable directory and a failed image dependency all refuse before a
// Sandbox Pane can run user code. Every refusal is an actionable preflight/
// Enter error; none degrades to a Native execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, checked, crateTests, assertRan, targetSha,
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

    // The live Linux proof: the declared executable directory is absent from
    // the mounted toolchain. Prepare refuses before a Pane, process or record
    // exists; there is no Native fallback.
    const output = runLinuxRuntimeTest(
      'a_missing_prepend_directory_fails_before_any_process_launches',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.missing_prepend_refused, true);
    assert.equal(facts.record_written, false);

    const policies = crateTests(
      'nession-sandbox',
      [
        'policy::tests::',
      ],
      600_000,
    );
    assertRan(policies, [
      'policy::tests::unsafe_path_prepends_and_untrusted_targets_fail_closed',
      'policy::tests::dangerous_image_environment_variables_fail_closed',
      'policy::tests::execution_owned_image_variables_are_dropped_not_applied',
      'policy::tests::malformed_image_environment_defaults_fail_closed',
      'policy::tests::equal_precedence_tool_defaults_must_agree_and_resolve_deterministically',
    ]);
    const failedDependency = crateTests(
      'nession-sandbox',
      ['linux::erofs::tests::a_digest_mismatch_is_refused_before_mounting'],
      600_000,
    );
    assertRan(failedDependency, [
      'linux::erofs::tests::a_digest_mismatch_is_refused_before_mounting',
    ]);
    const agentTarget = crateTests(
      'nession-agent',
      ['managed_session::tests::a_toolchain_without_a_target_or_mount_default_fails_closed'],
      600_000,
    );
    assertRan(agentTarget, [
      'managed_session::tests::a_toolchain_without_a_target_or_mount_default_fails_closed',
    ]);
    const agentEnv = crateTests(
      'nession-agent',
      ['managed_session::tests::a_protected_image_environment_variable_fails_before_any_launch'],
      600_000,
    );
    assertRan(agentEnv, [
      'managed_session::tests::a_protected_image_environment_variable_fails_before_any_launch',
    ]);
    const resolver = crateTests(
      'nession-erofs',
      ['--features', 'catalog', 'image::usage::tests::escapes_and_malformed_prepends_are_refused'],
      600_000,
    );
    assertRan(resolver, ['image::usage::tests::escapes_and_malformed_prepends_are_refused']);
    const platform = crateTests(
      'nession-erofs',
      [
        '--features',
        'catalog',
        'image::resolve::tests::an_incompatible_platform_fails_before_any_mount_could_be_attempted',
      ],
      600_000,
    );
    assertRan(platform, [
      'image::resolve::tests::an_incompatible_platform_fails_before_any_mount_could_be_attempted',
    ]);

    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a missing io.nession.path.prepend executable directory was ' +
        'refused during prepare before any Pane, process or execution record existed',
    });
    evidence.push({
      type: 'runtime',
      value:
        'an incompatible image platform, a missing mount proposal, absolute/.. /untrusted ' +
        'targets, reserved image environment variables and a digest-mismatched dependency all ' +
        'failed closed with typed errors; no path fell back to Native',
    });
    return (
      'Unsupported Image platform, missing mount target, untrusted/overlapping target, absent ' +
      'executable directory and failed dependency all refused before launch without a Native ' +
      'fallback'
    );
  });
}
