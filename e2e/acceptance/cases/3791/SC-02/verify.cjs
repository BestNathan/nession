'use strict';
// #3791 SC-02: isolated container protocol/security proof. The container has
// no Server/Agent process; it mounts the documented read-only config and
// reaches a separately started test Server over the canonical /ws route.
const { run, targetSha, checked } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = checked('node', ['scripts/mcp-standalone-container.test.mjs', 'verify'], 100000);
  const line = output.split('\n').find((part) => part.trim().startsWith('{"status":"pass"'));
  if (!line) throw new Error('standalone MCP container verification did not report pass');
  const result = JSON.parse(line);
  for (const item of result.evidence) {
    evidence.push({ type: 'runtime', value: 'staging ' + sha + ': ' + item.value });
  }
  return 'Isolated MCP container preserves authentication, Host/Origin policy, the canonical Server route and fail-closed startup';
});
