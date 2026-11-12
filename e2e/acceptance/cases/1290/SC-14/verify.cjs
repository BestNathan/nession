'use strict';
const { run, webTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  webTests('integration', 'src/capabilities/git/components/__tests__/integration/GitWorkspace.test.tsx', 'groups Repository and GitHub', 1);
  ev.push(evidence('test', 'the Git Workspace exposes Repository and GitHub groups; the Repository four-section list is not mounted as a GitHub depth and vice versa'));
  return 'Repository and GitHub are grouped without seven flat peer tabs';
});
