'use strict';
// #2973 SC-01: two consecutive default Agent startups with no config and the
// same persistent state directory resolve the same nonempty Agent ID, and the
// second startup does not replace the persisted id with a freshly generated
// one. The Case executes the identity owner with the exact `AgentConfig::default()`
// both entrypoints use, against a real temporary state directory and its bytes.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TWO_DEFAULT_STARTS =
  'identity::tests::two_default_startups_with_one_state_directory_resolve_the_same_identity';
const ABSENT_REUSES_PERSISTED =
  'identity::tests::an_absent_config_id_reuses_the_persisted_identity';
const ABSENT_GENERATES_ONCE =
  'identity::tests::an_absent_config_id_generates_and_persists_once';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests('nession-agent', ['--lib', 'identity::tests'], 600000);
  assertRan(output, [TWO_DEFAULT_STARTS, ABSENT_REUSES_PERSISTED, ABSENT_GENERATES_ONCE]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': two consecutive AgentConfig::default() startups ' +
        'against one temporary state directory resolved the same nonempty ' +
        'identity, and the identity file bytes still held that id',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': with a valid persisted identity and no config id, ' +
        'resolution returned the persisted id and did not overwrite it',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': with no config id and no identity file, the first ' +
        'startup generated `agent-{uuid}` and persisted it; the second resolution ' +
        'returned the same id from the same file bytes',
    },
  );
  return 'Default-config Agent identity is stable across restarts and is persisted only once';
});
