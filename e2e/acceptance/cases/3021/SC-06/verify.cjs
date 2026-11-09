'use strict';
// #3021 SC-06: authorized Project list and detail reads return stable
// identities and references with zero Sessions present, require no implicit
// Session/Agent binding, and fail closed when unauthorized.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const list = crateTests(
    'nession-server',
    ['--lib', 'server_project_list_v1'],
    300_000,
  );
  assertRan(list, [
    'project_list_requires_auth',
    'project_list_is_empty_but_successful_with_zero_sessions',
    'project_list_returns_stable_identities_created_elsewhere',
  ]);

  const get = crateTests(
    'nession-server',
    ['--lib', 'server_project_get_v1'],
    300_000,
  );
  assertRan(get, [
    'project_get_requires_auth',
    'project_get_reports_not_found_without_a_session',
    'project_get_returns_the_same_identity_and_references_across_reads',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': with an empty Session registry, two Project identities were ' +
      'listed and read back identically twice, including an offline Agent location; a ' +
      'missing identity reported not_found; unauthenticated list/get failed closed ' +
      '(server handler tests)',
  });
  return 'Authorized list/detail reads return stable identities and references with zero Sessions and no implicit Agent or Session binding';
});
