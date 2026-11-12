'use strict';
// #3024 SC-01: the versioned filesystem execution input validates prepared
// local EROFS images, targets, digests, mount ordering and shadowing before any
// host mount exists. The proof is the exact-SHA contract/validation suites.
const { run, targetSha, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const contract = checked(
    'cargo',
    ['test', '-p', 'nession-protocol', '--lib', 'contracts::sandbox', '--', '--nocapture'],
    300000,
  );
  assertRan(contract, [
    'contracts::sandbox::v1::tests::an_erofs_composition_parses_and_round_trips',
    'contracts::sandbox::v1::tests::unknown_composition_fields_are_refused',
  ]);

  const policy = checked(
    'cargo',
    ['test', '-p', 'nession-sandbox', '--lib', '--', '--nocapture'],
    600000,
  );
  assertRan(policy, [
    'policy::tests::a_prepared_composition_compiles_and_sorts_its_toolchains',
    'policy::tests::composition_and_access_cannot_both_own_the_root',
    'policy::tests::malformed_composition_images_fail_closed',
    'policy::tests::duplicate_toolchain_targets_are_refused',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the contract refuses unknown composition fields; compile validates ' +
      'sha256 digests, absolute normalized source/target/write paths, /opt/<name> toolchain targets, ' +
      'deterministic target ordering, duplicate targets and the single-root owner before any mount',
  });
  return (
    'A prepared local EROFS mount input is validated independently of Project/Git/Server and ' +
    'malformed, conflicting, path-escaping or unchecked image requests are refused before user code executes'
  );
});
