'use strict';
const { run, githubTests, webTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::client::tests::workflows_group', ['runtime::client::tests::workflows_group_the_latest_run_and_scope_the_runs_request_to_the_branch']);
  webTests('integration', 'src/capabilities/git/components/__tests__/integration/GithubHostingView.test.tsx', 'scopes Actions', 1);
  ev.push(evidence('runtime', 'repository-wide and current-branch runs are separate requests; another branch\'s success is not presented as the current branch\'s'));
  return 'Actions latest-run scope is explicit and branch-correct';
});
