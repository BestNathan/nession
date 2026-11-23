'use strict';
// #4249 SC-03: the same pinned GHCR artifact is reused after an Agent restart
// on the verified warm cache without re-download; a crashed mount consumer is
// adopted by the reopened MountManager and one physical mount serves a second
// Session execution; an unavailable peer falls back only to the authorized
// Server for the identical digest; corrupted bytes never become Ready; and
// cache/mount lease cleanup stays correct.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, targetSha, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const TEST = 'native::sc03_real_ghcr_pinned_artifact_restart_warm_cache_and_authorized_fallback';
const PINNED_INDEX = 'sha256:2bd0fe388655d48fd514431095bc52bfb1d319fedc4fd183feb5949e4fb73587';
const CHILD = process.arch === 'arm64'
  ? {
    manifest: 'sha256:ff76276ffff35570a40da8b436e7e031646932d4edf049ee58dcfaf6ca982718',
    layer: 'sha256:3b33564cb6788cc5d02e71484b0dd3d1f3ac012615b1a141e429bb799ef84c8b',
  }
  : {
    manifest: 'sha256:0a922f17a02b48d58b2c4595da9cef0aa0909891d9a232dc394e2738c88d580d',
    layer: 'sha256:7ad4db01530282b6c49e692a221cd6b87ba428448894385f7d2713c3a899c609',
  };

process.env.SANDBOX_EROFS_IMAGE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nession-4249-sc03-run-'),
);
const capabilities = probeCapabilities();
if (!capabilities.backend || !capabilities.erofs) {
  pending('The native mount capability is unavailable; the restart/fallback proof stays Pending', [
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
    assert.match(output, /^#4249 SC-03 measured: .*$/m, 'the measured evidence line is required');
    const facts = runtimeEvidence(output);
    assert.equal(facts.issue, 4249);
    assert.equal(facts.criterion, 'SC-03');
    assert.equal(facts.index_digest, PINNED_INDEX, 'the pinned #4160 Index identity must be held');
    assert.equal(facts.manifest_digest, CHILD.manifest);
    assert.equal(facts.layer_digest, CHILD.layer);
    assert.ok(Number(facts.cold_transfers) > 0, 'the cold prepare must transfer the closure');
    assert.equal(facts.restart_fetch_count, 0, 'the warm restart must not re-download');
    assert.equal(facts.restart_observation, 'verified');
    assert.match(
      String(facts.adopted_consumer),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(facts.one_physical_mount, true);
    assert.equal(facts.second_execution_gh_version, true);
    assert.equal(facts.mount_reclaimed_after_release, true);
    assert.equal(facts.peer_provenance, 'peer');
    assert.equal(facts.server_blob_gets_during_peer, 0);
    assert.equal(facts.fallback_provenance, 'server');
    assert.equal(facts.fallback_same_digest, true);
    assert.equal(facts.corrupted_layer_never_ready, true);
    assert.equal(facts.pin_protects_eviction, true);
    assert.ok(String(facts.kernel).length > 0, 'the runner kernel identity is required');
    evidence.push(
      { type: 'runtime', value: 'exact SHA ' + sha + ' on Linux kernel ' + facts.kernel + ': pinned GHCR Manifest ' + facts.manifest_digest + ' (EROFS ' + facts.layer_digest + ') prepared cold with ' + facts.cold_transfers + ' transfers, then reused after Agent restart with fetch_count=0 and a Verified observation' },
      { type: 'runtime', value: 'the crashed consumer ' + facts.adopted_consumer + ' was adopted by the reopened MountManager; one physical mount served a second `gh version` execution and was reclaimed after the last consumer released' },
      { type: 'runtime', value: 'the authorized peer served the exact published layer with zero Server blob bytes; after revocation the fallback went only to the authorized Server for the identical pinned digest' },
      { type: 'runtime', value: 'corrupted EROFS bytes never became Ready and the aggregate identity was not mount-ready; a pinned blob refused eviction until its pin released; capabilities: ' + capabilityLine(capabilities) },
    );
    return (
      'The pinned GHCR artifact survived Agent restart on the warm verified cache, adopted its ' +
      'crashed mount consumer, and fell back only to an authorized source for the identical digest'
    );
  });
}