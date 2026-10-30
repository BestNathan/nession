'use strict';
// #2514 SC-09 (runtime half): the resource scope model is PPID-ancestry only,
// deduplicated, includes the selected PID, and refuses to total a missing
// metric as zero.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { runWebTests } = require('../../../shared/process-discovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const total = runWebTests([
    'src/product/agent/model/__tests__/unit/processSnapshot.test.ts',
    'src/product/agent/components/__tests__/integration/AgentProcesses.test.tsx',
  ]);
  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': ' + total +
      ' model/inspector tests passed — PID+start identity, PPID-only subtree with a reparented worker excluded, ' +
      'sampled CPU above 100%, and an incomplete metric making the aggregate unavailable rather than zero',
  });
  return 'Resource scope is a deduplicated PPID subtree including the selected PID, and missing members make aggregates unavailable';
});
