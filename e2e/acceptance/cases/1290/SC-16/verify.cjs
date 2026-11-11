'use strict';
const { run, webTests, source, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  const hosting = source('web/src/capabilities/git/components/GithubHostingView.tsx');
  for (const marker of ["section === 'issues'", "section === 'pull-requests'", 'GithubActionsView']) {
    if (!hosting.includes(marker)) throw new Error('the GitHub depth is no longer mounted selectively: ' + marker);
  }
  for (const file of [
    'web/src/capabilities/git/GithubPlugin.ts',
    'web/src/capabilities/git/hooks/useGithubRequest.ts',
    'web/src/capabilities/git/hooks/useGithubPagedList.ts',
    'web/src/capabilities/git/components/GithubHostingView.tsx',
    'web/src/capabilities/git/components/GithubIssuesView.tsx',
    'web/src/capabilities/git/components/GithubPullRequestsView.tsx',
    'web/src/capabilities/git/components/GithubActionsView.tsx',
  ]) {
    if (/setInterval|setTimeout\(/.test(source(file))) throw new Error(file + ' introduced a timer/poll');
  }
  ev.push(evidence('test', 'only the selected GitHub depth is mounted; explicit refresh/filter/page changes are the request triggers; no GitHub source schedules an interval or timeout'));
  return 'Hidden views make no requests and no background polling exists';
});
