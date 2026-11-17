'use strict';
// #3791 SC-02: build the dedicated OCI image from the checked-out binary.
// A separate verifier keeps the Docker build inside its own deadline.
const { run, targetSha, checked } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = checked('node', ['scripts/mcp-standalone-container.test.mjs', 'build-image'], 100000);
  if (!output.includes('"status":"pass"')) {
    throw new Error('standalone MCP image build did not report pass');
  }
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': Dockerfile.mcp.prebuilt built with the architecture-matched nession-mcp binary',
  });
  return 'Built the dedicated standalone MCP image at the exact target SHA';
});
