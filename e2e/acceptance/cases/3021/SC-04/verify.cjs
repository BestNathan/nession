'use strict';
// #3021 SC-04: a Server restart over the same database restores Project state,
// references and identities unchanged, and a legacy Session row (with no
// Project association) remains valid alongside it. The same migration also
// upgrades an old-format database without losing either.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const restart = crateTests(
    'nession-server',
    ['--lib', 'db::tests::project_'],
    300_000,
  );
  assertRan(restart, [
    'db::tests::project_crud',
    'db::tests::project_update_preserves_created_at_and_identity',
    'db::tests::project_state_survives_restart_without_reassigning_identity',
  ]);

  const legacy = crateTests(
    'nession-server',
    ['--lib', 'migration_from_old_db'],
    300_000,
  );
  assertRan(legacy, ['db::tests::migration_from_old_db']);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': reopening the SQLite file restored the same project_id, Git ' +
      'ref, two Existing Locations and image digest; the accompanying legacy Session row ' +
      'survived; an old-format database upgraded through m005 and served Project CRUD while ' +
      'keeping that Session valid (db tests)',
  });
  return 'A restart restores Project state and identity unchanged, and legacy Sessions without a Project association remain valid';
});
