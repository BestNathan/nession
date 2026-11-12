'use strict';
const { run, webTests, requires, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  webTests('integration', 'src/app/__tests__/integration/useCapsuleCapability.test.tsx', 'does not offer Git as a Terminal projection', 1);
  webTests('unit', 'src/app/__tests__/unit/capsulePresence.test.ts', 'does not list Git as a Terminal projection', 1);
  requires('web/src/app/capsuleProjections.ts', ['CAPSULE_PROJECTIONS']);
  const projections = require('../../../shared/github-context-cases.cjs').source('web/src/app/capsuleProjections.ts');
  if (projections.includes('gitProjection')) throw new Error('the legacy Git Terminal projection is still registered');
  ev.push(evidence('test', 'Git is absent from the Terminal projection registry; the existing Workspace capsule Git entry opens the Git Workspace directly, with no Peek or extra surface'));
  return 'Selecting Git opens the Git Workspace directly without a Git Peek';
});
