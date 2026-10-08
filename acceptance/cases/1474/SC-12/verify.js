const { verifyInfrastructureCriterion } = require('../../../shared/infrastructure-contract.js');

try {
  process.stdout.write(JSON.stringify(verifyInfrastructureCriterion('SC-12')) + '\n');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: message,
    evidence: [{ type: 'runtime', value: 'SC-12 executable contract verification failed' }],
  }) + '\n');
  process.exitCode = 1;
}
