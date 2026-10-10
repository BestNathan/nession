'use strict';
// Source-aligned staging proof for #1556 SC-06. No GitHub write capability.
const { verify, selfTest } = require('../../../shared/agent-library-proof.cjs');
if (process.argv.includes('--self-test')) selfTest();
else verify('SC-06').then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
}).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({ status: 'fail', summary: message,
    evidence: [{ type: 'runtime', value: '1556/SC-06 exact-staging-SHA or external Provider proof failed' }] }) + '\n');
  process.exitCode = 1;
});
