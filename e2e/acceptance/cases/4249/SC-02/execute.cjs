'use strict';
// #4249 SC-02: the same real published GHCR gh-2.105.0 artifact is imported
// through the authorized Server Catalog revision, prepared over /v2/ into the
// verified Agent cache, mounted by the shared MountManager under Host RootFS
// and executed (`gh version`) inside an isolated Session execution — with no
// Host/Agent rootfs mutation and no unauthorized artifact access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, targetSha, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const TEST = 'native::sc02_real_ghcr_gh_toolchain_imports_mounts_and_executes_in_sandbox';
const PINNED_INDEX = 'sha256:2bd0fe388655d48fd514431095bc52bfb1d319fedc4fd183feb5949e4fb73587';
const CHILD = process.arch === 'arm64'
  ? {
    manifest: 'sha256:ff76276ffff35570a40da8b436e7e031646932d4edf049ee58dcfaf6ca982718',
    config: 'sha256:328004ec220c20790167264686e7e94a44695a5e771cbbafc91be9a8c1988816',
    layer: 'sha256:3b33564cb6788cc5d02e71484b0dd3d1f3ac012615b1a141e429bb799ef84c8b',
  }
  : {
    manifest: 'sha256:0a922f17a02b48d58b2c4595da9cef0aa0909891d9a232dc394e2738c88d580d',
    config: 'sha256:32f71d5b1b7cb58cc03144d0d2970d054cf4746607202562020c14256d3d805c',
    layer: 'sha256:7ad4db01530282b6c49e692a221cd6b87ba428448894385f7d2713c3a899c609',
  };

process.env.SANDBOX_EROFS_IMAGE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nession-4249-sc02-run-'),
);
const capabilities = probeCapabilities();
if (!capabilities.backend || !capabilities.erofs) {
  pending('The native mount capability is unavailable; the consumer-chain proof stays Pending', [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    const output = checked(
      'cargo',
      ['test', '-p', 'nession-agent', '--test', 'toolchain_chain', TEST, '--', '--ignored', '--exact', '--nocapture'],
      110000,
      { NESSION_SANDBOX_BRIDGE_BIN: path.resolve('target/debug/nession-sandbox-bridge') },
    );
    assertRan(output, [TEST]);
    assert.match(output, /^#4249 SC-02 measured: .*$/m, 'the measured evidence line is required');
    const facts = runtimeEvidence(output);
    assert.equal(facts.issue, 4249);
    assert.equal(facts.criterion, 'SC-02');
    assert.equal(facts.index_digest, PINNED_INDEX, 'the pinned #4160 Index identity must be held');
    assert.equal(facts.manifest_digest, CHILD.manifest);
    assert.equal(facts.config_digest, CHILD.config);
    assert.equal(facts.layer_digest, CHILD.layer);
    assert.ok(
      String(facts.gh_version).startsWith('gh version 2.105.0'),
      'the executed tool must be the published gh 2.105.0: ' + facts.gh_version,
    );
    assert.equal(facts.backend, 'linux-bwrap');
    assert.match(
      String(facts.execution_id),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(facts.toolchain_target, '/opt/gh');
    assert.equal(facts.path_prepend, '/opt/gh/bin');
    assert.equal(facts.toolchain_readonly, true);
    assert.equal(facts.host_rootfs_unchanged, true);
    assert.equal(facts.unauthorized_principal_denied, true);
    assert.equal(facts.foreign_repository_denied, true);
    assert.equal(facts.mount_reclaimed_after_cleanup, true);
    assert.ok(String(facts.kernel).length > 0, 'the runner kernel identity is required');
    evidence.push(
      { type: 'runtime', value: 'exact SHA ' + sha + ' on Linux kernel ' + facts.kernel + ': pinned GHCR Index ' + facts.index_digest + ' imported through the authorized Server Catalog revision (Manifest ' + facts.manifest_digest + ', Config ' + facts.config_digest + ', EROFS ' + facts.layer_digest + ')' },
      { type: 'runtime', value: 'Session-bound /v2/ prepare reached Verified in the identity-namespaced Agent cache; the shared MountManager mounted the exact layer under Host-root ' + facts.toolchain_target + ' with PATH prepend ' + facts.path_prepend },
      { type: 'runtime', value: 'isolated linux-bwrap execution ' + facts.execution_id + ' ran `' + facts.gh_version + '`; the toolchain mount and Host root stayed read-only and the Host sentinel bytes were unchanged' },
      { type: 'runtime', value: 'denied principal 403 and foreign repository 404 on the real artifact projection; the physical mount was reclaimed after the last consumer; capabilities: ' + capabilityLine(capabilities) },
    );
    return (
      'The real published GHCR gh toolchain traveled the authorized Catalog -> /v2/ grant -> ' +
      'verified cache -> shared EROFS mount -> Host-root Session execution chain and ran gh version'
    );
  });
}