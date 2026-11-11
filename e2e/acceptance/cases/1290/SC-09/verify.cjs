'use strict';
const { run, githubTests, webTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::client::tests', ['runtime::client::tests::workflows_group_the_latest_run_and_scope_the_runs_request_to_the_branch']);
  webTests('integration', 'src/capabilities/git/components/__tests__/integration/GithubHostingView.test.tsx', 'scopes Actions', 1);
  ev.push(evidence('runtime', 'workflow latest runs preserve queued/in_progress/completed/conclusion and disabled/no-runs states; repository and current-branch scopes issue different requests'));
  return 'Actions reads are bounded and preserve run status and explicit scope';
});
