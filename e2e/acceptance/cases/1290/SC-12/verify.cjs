'use strict';
const { run, githubTests, webTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::client::tests::statuses_map', ['runtime::client::tests::statuses_map_to_distinct_codes']);
  githubTests('agent::tests::an_api_read_without_a_credential', ['agent::tests::an_api_read_without_a_credential_is_not_authenticated_and_makes_no_request']);
  githubTests('agent::tests::a_repository_without_a_github_remote', ['agent::tests::a_repository_without_a_github_remote_is_an_ok_no_remote_answer']);
  webTests('integration', 'src/capabilities/git/components/__tests__/integration/GithubHostingView.test.tsx', 'not-authenticated|rate-limit', 2);
  ev.push(evidence('runtime', 'missing client/credential, forbidden repo, rate limit, no remote, ambiguity and host denial produce distinct typed codes and separate UI states'));
  return 'GitHub failures are distinct typed outcomes, not one generic error';
});
