'use strict';
const { run, githubTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::remote::tests', [
    'runtime::remote::tests::upstream_remote_wins_over_origin',
    'runtime::remote::tests::origin_is_the_fallback_and_a_sole_remote_is_unambiguous',
    'runtime::remote::tests::two_github_remotes_without_origin_or_upstream_are_ambiguous',
    'runtime::remote::tests::requested_remote_is_re_resolved_and_a_stale_one_is_not_silently_replaced',
  ]);
  ev.push(evidence('runtime', 'upstream → origin → sole-remote fallback, fork/upstream identity, ambiguity and stale discovered-remote selection are executable'));
  return 'Branch upstream → origin → sole-remote fallback and discovered-remote selection are exact';
});
