'use strict';
const { run, webTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  webTests('integration', 'src/capabilities/git/components/__tests__/integration/GitWorkspace.test.tsx', 'keeps local Git functional', 1);
  ev.push(evidence('runtime', 'with the GitHub provider answering not_authenticated, Changes/History/Branches/Worktrees remain mounted and usable; only the GitHub group reports the scoped failure'));
  return 'GitHub unavailability leaves the local Git capability functional';
});
