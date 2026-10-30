'use strict';
// #2514 SC-06 (runtime half): the existing Agent Workspace still renders its
// detail view and the new contextual Sessions & Processes section; the
// component suites prove the session focus, error/offline, refresh and
// unavailable states independently of the live run.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { runWebTests } = require('../../../shared/process-discovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const total = runWebTests([
    'src/product/agent/patterns/__tests__/integration/AgentDetail.test.tsx',
    'src/product/agent/components/__tests__/integration/AgentProcesses.test.tsx',
  ]);
  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': ' + total +
      ' Agent Workspace integration tests passed (drill-down, session focus, offline, stale refresh, extension slot unchanged)',
  });
  return 'The Agent Workspace composition still owns its detail view and the contextual Sessions & Processes section passes its component contracts';
});
