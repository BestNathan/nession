'use strict';
// #3022 SC-02: the default snapshot is shallow, single-branch, tagless, keeps a
// usable .git for developer actions, and embeds no credential material.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { runCargoTests } = require('../../../shared/erofs-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = runCargoTests('nession-erofs', 'git::tests');
  assertRan(output, [
    'git::tests::a_branch_snapshot_is_shallow_tagless_clean_and_committable',
    'git::tests::a_fixed_commit_is_fetched_exactly',
    'git::tests::a_missing_fixed_commit_fails_explicitly',
    'git::tests::credential_material_in_git_config_is_refused',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': a local bare-repo fixture cloned with file:// proves .git/shallow exists, tags are empty, git status/add/commit work, a fixed SHA resolves exactly, an unfetchable SHA fails explicitly, and planted credential config is refused',
  });
  return 'The default Git snapshot is shallow, single-branch and tagless, retains a usable .git for status/add/commit, and contains no credential material';
});
