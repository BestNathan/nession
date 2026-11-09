'use strict';
// #3022 SC-04: authorized blob streaming with exact Range/ETag semantics and
// explicit 403/404; a Project-A grant cannot read Project B's private digest.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { runCargoTests } = require('../../../shared/erofs-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = runCargoTests('nession-server', 'image::tests');
  assertRan(output, [
    'image::tests::a_grant_is_bound_to_its_project_and_digest',
    'image::tests::http_range_etag_and_authorization_are_exact',
    'image::tests::http_denies_foreign_projects_and_unknown_digests',
    'image::tests::http_invalid_range_is_416_with_the_entity_size',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': HTTP GET returned the exact bytes and digest/ETag headers; bytes=2-5 returned 206 Content-Range 2-5/12; a Project-A grant got 403 for Project-B digest; no token got 403; unknown digest got 404; bytes=99-100 got 416 with bytes */12',
  });
  return 'Authorized clients retrieve exact image bytes with Range/ETag and explicit 403/404, while a grant for Project A cannot access Project B private bytes by digest';
});
