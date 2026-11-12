'use strict';
const { run, githubTests, webTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::client::tests', [
    'runtime::client::tests::issues_filters_pr_shaped_records_and_honours_the_next_link',
    'runtime::client::tests::issue_detail_returns_the_full_body_and_rejects_a_pr_shaped_number',
  ]);
  webTests('integration', 'src/capabilities/git/components/__tests__/integration/GithubHostingView.test.tsx', 'fetches a detail lazily|filters Issues', 2);
  ev.push(evidence('runtime', 'Issue summaries filter PR-shaped records, expose explicit continuation, and only a selected row requests the full Markdown detail through the sanitizer'));
  return 'Issues list/detail are bounded, scoped, lazy and safely rendered';
});
