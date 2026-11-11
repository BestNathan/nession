'use strict';
const { run, webTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  webTests('integration', 'src/capabilities/git/hooks/__tests__/integration/useGithubRequest.test.tsx', 'drops a response from the previous Session|supersede an older in-flight read', 2);
  ev.push(evidence('test', 'an older Session/remote generation cannot publish, and a manual Refresh supersedes an older in-flight read'));
  return 'Identity changes cannot publish stale in-flight GitHub results';
});
