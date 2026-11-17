'use strict';
// #3791 SC-02: build the standalone host and the test Server for this exact
// staging SHA. Kept separate so the 120 s per-verifier deadline is not spent
// compiling every target in one process.
const { run, targetSha, checked } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = checked('node', ['scripts/mcp-standalone-container.test.mjs', 'build-binary'], 100000);
  if (!output.includes('"status":"pass"')) {
    throw new Error('standalone MCP binary build did not report pass');
  }
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': cargo build -p nession-mcp -p nession-server completed for the isolated container Case',
  });
  return 'Built the standalone MCP host and test Server at the exact target SHA';
});
