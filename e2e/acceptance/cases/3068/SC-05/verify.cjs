'use strict';
const { assert, inspect, test, proof } = require('../../../shared/acceptance-source-cases.cjs');
proof(({ evidence, sha }) => {
  const output = test(['scripts/acceptance-sources.mjs', 'self-test']);
  assert.match(output, /citation fixtures passed/);
  const prompt = inspect('scripts/lib/agent/prompt/templates/acceptance/v4/system.hbs');
  assert.match(prompt, /does not prove publication to Pages/);
  const source = inspect('scripts/acceptance-sources.mjs');
  assert.match(source, /must have an Agent Acceptance Plan/);
  const plan = inspect('scripts/acceptance-plan.mjs');
  assert.match(plan, /method/);
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha +
    ': Case-method SC cannot declare an Agent source; prompt explicitly rejects source-only Pages/Knowledge/GitOps publication proof' });
  return 'The Agent file input cannot replace Case-method public delivery or runtime evidence';
});
