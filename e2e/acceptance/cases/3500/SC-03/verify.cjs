'use strict';
// #3500 SC-03: at the exact merged staging SHA, two distinct Manifests that
// share one EROFS Blob enter separate Sandbox Sessions with different Config
// Env and mount targets, the physical layer is shared by one mount and is not
// unmounted while a Session still consumes it, and an old Session stays pinned
// to its Manifest after the Tag moves. The Linux mount/lease proof runs the
// exact runtime test on the staging runner; the resolver/pinning proof runs the
// exact crate tests in the same checkout. No browser claim is made.
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

// The staging runner is Ubuntu; the composition helpers are not preinstalled.
// A failed install leaves the measured capability probe to report Pending.
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
    // The live Linux proof: one EROFS layer, two Sessions, distinct targets
    // and environment, one physical mount, no premature unmount.
    const output = runLinuxRuntimeTest(
      'one_layer_in_two_sessions_keeps_distinct_targets_and_environment_without_premature_unmount',
    );
    const facts = runtimeEvidence(output);
    assert.deepEqual(facts.targets, ['/opt/node', '/opt/rust']);
    assert.equal(facts.distinct_environment, true);
    assert.equal(facts.premature_unmount, false);
    assert.ok(facts.shared_layer_mounts >= 1, 'the shared layer mount was observed');

    // Two distinct Manifests over one EROFS Blob keep distinct Config Env and
    // targets, and the pinned old Manifest survives a Tag move.
    const agent = crateTests(
      'nession-agent',
      [
        'managed_session::tests::mount_default_and_override_rebase_the_toolchain_prepend_and_reach_the_composition',
      ],
      600_000,
    );
    assertRan(agent, [
      'managed_session::tests::mount_default_and_override_rebase_the_toolchain_prepend_and_reach_the_composition',
    ]);
    const pinned = crateTests(
      'nession-erofs',
      ['--features', 'catalog', 'image::tests::a_pinned_manifest_survives_a_tag_move'],
      600_000,
    );
    assertRan(pinned, ['image::tests::a_pinned_manifest_survives_a_tag_move']);
    const sharedPayload = crateTests(
      'nession-erofs',
      [
        '--features',
        'cache',
        'cache::fetch::tests::two_manifests_share_one_payload_download_and_one_physical_file',
      ],
      600_000,
    );
    assertRan(sharedPayload, [
      'cache::fetch::tests::two_manifests_share_one_payload_download_and_one_physical_file',
    ]);
    const sharedMount = crateTests(
      'nession-erofs',
      [
        '--features',
        'mount',
        'mount_manager::tests::two_consumers_of_one_layer_share_one_physical_mount',
      ],
      600_000,
    );
    assertRan(sharedMount, [
      'mount_manager::tests::two_consumers_of_one_layer_share_one_physical_mount',
    ]);

    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': two Sessions of one EROFS layer kept distinct targets ' +
        '(/opt/node and /opt/rust) and distinct Config Env, shared one physical FUSE mount, ' +
        'releasing the first Session left it mounted, and the last consumer unmounted it',
    });
    evidence.push({
      type: 'runtime',
      value:
        'two distinct Manifests shared one payload and one physical cache file; the pinned ' +
        'old Manifest still resolved after its Tag moved; mount leases are keyed on the EROFS ' +
        'Blob digest, not the Manifest digest',
    });
    return (
      'Two distinct Manifests over one EROFS Blob entered separate Sessions with different ' +
      'Env/targets without a duplicate physical mount or premature unmount, and the old ' +
      'Session remained pinned after the Tag moved'
    );
  });
}
