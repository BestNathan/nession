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
      ' Agent Workspace integration tests passed (current-Session-only forest, no Session/Pane UI, ' +
      'default-closed grouped Agent and Process details, scope-state persistence, offline/stale, ' +
      'App focus return, extension slot unchanged)',
  });
  return 'The Agent Workspace shows the current Session forest with default-closed grouped disclosures and no Session/Pane navigation';
});
