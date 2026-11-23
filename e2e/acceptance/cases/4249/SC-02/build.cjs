'use strict';
// #4249 SC-02 build: compile the integrated consumer-chain proof binary at the
// exact target SHA so the execution verifier spends its budget on the real
// GHCR import/mount/exec run, not on compilation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');
const { probeCapabilities, pending, capabilityLine } = require('../../../shared/sandbox-cases.cjs');

process.env.SANDBOX_EROFS_IMAGE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nession-4249-sc02-build-'),
);
const capabilities = probeCapabilities();
if (!capabilities.backend || !capabilities.erofs) {
  pending('The native mount capability is unavailable; the consumer-chain proof stays Pending', [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    checked(
      'cargo',
      ['test', '-p', 'nession-agent', '--test', 'toolchain_chain', '--no-run'],
      110000,
    );
    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': nession-agent toolchain_chain proof binary compiled',
    });
    return 'The integrated GHCR consumer-chain proof binary compiled at the exact target SHA';
  });
}