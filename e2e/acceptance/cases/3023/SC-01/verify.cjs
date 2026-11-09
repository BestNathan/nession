'use strict';
// #3023 SC-01: effective cache location precedence, safe creation, and
// fail-closed rejection of an explicit ephemeral or unwritable directory.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { agentCacheTests } = require('../../../shared/erofs-cache-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const config = agentCacheTests('config::erofs_tests');
  assertRan(config, [
    'config::erofs_tests::an_explicit_toml_cache_path_wins_over_the_environment',
    'config::erofs_tests::the_environment_fills_an_absent_toml_path_and_home_wins_when_both_are_absent',
    'config::erofs_tests::relative_empty_and_parent_cache_paths_are_refused',
    'config::erofs_tests::a_relative_home_is_refused_rather_than_resolved_against_the_cwd',
  ]);
  const storage = agentCacheTests('erofs_cache::tests::an_');
  assertRan(storage, [
    'erofs_cache::tests::an_explicit_cache_on_a_tmpfs_fails_closed_and_an_implicit_one_is_a_dev_default',
    'erofs_cache::tests::an_unwritable_cache_directory_fails_closed',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': TOML > NESSION_EROFS_STORAGE_DIR > NESSION_HOME/erofs; absolute/non-parent validation; an explicit tmpfs path failed closed, an implicit development path did not claim durability, and an unwritable root was rejected',
  });
  return 'The Agent resolves an explicit or documented default EROFS cache directory, creates/validates it, and rejects inaccessible or unexpectedly ephemeral explicitly-declared storage with no container-layer/tmpfs fallback';
});
