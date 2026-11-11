'use strict';
// #3181 SC-03: a Session-scoped grant is bounded to the digests its ready
// Managed context resolved. An unrelated digest/session is refused and the
// existing Project-scoped grant remains valid.
const { run, crateTests, assertRan, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests('nession-server', ['image::tests::', '--lib'], 600000);
  assertRan(server, [
    'image::tests::a_session_grant_is_bounded_by_its_managed_context_and_digest',
    'image::tests::a_grant_is_bound_to_its_project_and_digest',
  ]);
  const protocol = crateTests('nession-protocol', ['contracts::image::tests::', '--lib'], 300000);
  assertRan(protocol, [
    'contracts::image::tests::access_requires_exactly_one_consumer_and_keeps_project_compatibility',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a Session grant succeeded only for a digest in that Session’s ready ' +
      'Managed context; an unrelated digest and an unrelated Session were refused; the Project ' +
      'grant binding test remained green and the access contract requires exactly one consumer',
  });
  return 'A standalone Session obtains scoped access only to its allowed resolved Digests; unrelated or guessed access is rejected while Project access remains compatible';
});
