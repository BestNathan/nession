'use strict';
const { assert, inspect, test, proof } = require('../../../shared/acceptance-source-cases.cjs');
proof(({ evidence, sha }) => {
  const workflow = inspect('.github/workflows/agent-sc-acceptance.yml');
  assert.match(workflow, /node scripts\/acceptance-sources\.mjs stage/);
  assert.match(workflow, /2026-11-09T05:00:00Z/);
  assert.match(workflow, /acceptance_sources != null/);
  assert.match(workflow, /contains\("gitops:"\)/);
  assert.match(workflow, /ACCEPTANCE_STAGE.*pre-merge/);
  const output = test(['scripts/acceptance-sources.mjs', 'self-test']);
  assert.match(output, /source materialization, drift and citation fixtures passed/);
  evidence.push({ type: 'runtime', value: 'exact main SHA ' + sha +
    ': main-owned router prioritizes structured sources; historical pre-merge GitOps comment/archive compatibility is cutoff-bounded and source selftests pass' });
  return 'Main workflow routes structured source staging without losing historical GitOps behavior';
});
