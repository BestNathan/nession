'use strict';
// #4250 SC-03 (SCN-03): after the staged cutover the proprietary
// /images/blobs/{digest} route is unavailable to migrated clients, standard /v2/
// still serves approved complete closures and denies wrong principal/repository/
// forged digest, persistent Agent cache and active mounts are preserved, and a
// protected compatibility toggle restores only explicitly supported legacy
// clients without bypassing authorization.
//
// Staged delivery: the route-removal/rollback slice lands after the SC-02 parity
// receipt is accepted. Until the removal proof test exists in the source, this
// Case reports Pending (never a mock Pass); the slice that adds the proof also
// flips this Case to its real runtime assertion.
const { spawnSync } = require('node:child_process');
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TEST = 'sc03_legacy_route_removed_with_protected_rollback';
const MEASURED = /^#4250 SC-03 measured: .*$/m;
const PROOF_SOURCE = 'crates/nession-erofs/src/registry/service/tests.rs';

const probe = spawnSync('grep', ['-q', TEST, PROOF_SOURCE], { encoding: 'utf8' });
if (probe.status !== 0) {
  process.stdout.write(JSON.stringify({
    status: 'pending',
    summary: 'SC-03 stays Pending: the #4250 route-removal/rollback slice has not landed; the proprietary route remains mounted for the bounded compatibility window after the SC-02 parity cutover',
    evidence: [{
      type: 'blocked',
      value: 'the removed-route negative/rollback proof (' + TEST + ') is not yet present at this SHA; the staged removal slice follows the accepted SC-02 parity receipt',
    }],
  }) + '\n');
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    const output = crateTests(
      'nession-erofs',
      ['--lib', '--features', 'cache,registry,mount', TEST],
      600000,
    );
    assertRan(output, [TEST]);
    const measured = output.match(MEASURED);
    if (!measured) throw new Error('the SC-03 removed-route measurement line was not emitted');
    evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
    return 'SC-03: the proprietary route is unavailable to migrated clients, /v2/ serves approved closures and denies wrong principal/repository/forged digest, cache and mounts are preserved, and the protected toggle restores only supported legacy clients without bypassing authorization';
  });
}
