const { runtimeFromEnv, verifyOnlineAgent } = require('../../../shared/protocol-online-agent.js');

async function main() {
  const result = await verifyOnlineAgent(runtimeFromEnv());
  result.summary = 'Protocol half of SC-14 observed the real Agent through the exact-SHA full-stack runtime.';
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: message,
    evidence: [{ type: 'protocol', value: 'SC-14 protocol assertion failed against real full-stack runtime' }],
  }) + '\n');
  process.exitCode = 1;
});
