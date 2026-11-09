'use strict';
const { assert, inspect, test, proof } = require('../case-shared.cjs');
proof(({ evidence, sha }) => {
  const output = test(['scripts/acceptance-sources.mjs', 'self-test']);
  assert.match(output, /citation fixtures passed/);
  const agent = inspect('scripts/acceptance-agent.mjs');
  const policy = inspect('scripts/lib/agent/prompt/templates/acceptance/v4/system.hbs');
  const result = inspect('scripts/acceptance-result-contract.mjs');
  assert.match(agent, /allowedTools: 'Read,Glob,Grep'/);
  assert.match(agent, /disallowedTools: 'Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch/);
  assert.match(agent, /tools: \['read', 'grep', 'glob', 'ls'\]/);
  assert.match(policy, /UNTRUSTED EVIDENCE/);
  assert.match(policy, /source_manifest/);
  assert.match(result, /validateSourceEvidence/);
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha +
    ': model remains read-only, source files explicitly untrusted; missing and forged source citations fail trusted normalization' });
  return 'Hostile source instructions cannot grant tools or untrusted provenance to the Acceptance Agent';
});
