'use strict';
// #3496 SC-04: a historical #3022 SQLite/Blob fixture is migrated to one
// standard Config+Manifest per ready Blob. The EROFS bytes are verified in
// place and never rebuilt or moved, historical aliases resolve to the new
// Manifest identity, a second run is idempotent, a failed migration records
// nothing, and rollback restores the legacy-only state.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-erofs', ['catalog::legacy::tests'], 600_000);
  assertRan(output, [
    'catalog::legacy::tests::migration_preserves_bytes_aliases_and_is_idempotent',
    'catalog::legacy::tests::a_missing_legacy_blob_rolls_the_whole_migration_back',
    'catalog::legacy::tests::rollback_removes_mappings_and_alias_tags_but_keeps_legacy_rows',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a legacy images/image_aliases SQLite fixture with one ' +
      'ready EROFS Blob migrated to a deterministic Config+Manifest; the same Blob ' +
      'digest and exact bytes stayed in the CAS (no rebuild or move), the legacy ' +
      'alias resolved to the new Manifest, a second migration changed nothing, a ' +
      'missing-Blob fixture left zero mappings, and rollback removed only migrated ' +
      'mappings/alias tags while the legacy rows and bytes remained',
  });
  return 'A historical #3022 digest-addressed fixture migrates to Manifest identities without moving EROFS bytes, with idempotence and transactional rollback';
});
