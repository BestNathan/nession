'use strict';
const { run, githubTests, webTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::client::tests', ['runtime::client::tests::pulls_match_the_current_branch_by_exact_head_repository_and_ref']);
  webTests('integration', 'src/capabilities/git/components/__tests__/integration/GithubHostingView.test.tsx', 'renders Pull Requests', 1);
  ev.push(evidence('runtime', 'current-branch association requires selected and head repository owner/repo plus exact head.ref; fork heads do not match; detail is lazy and carries head/base/source'));
  return 'Pull Requests expose bounded summaries, exact branch relation and lazy full detail';
});
