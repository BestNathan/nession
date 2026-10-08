const { runtimeFromEnv, verifyOnlineAgent } = require('../../../shared/protocol-online-agent.js');

async function main() {
  const result = await verifyOnlineAgent(runtimeFromEnv());
  result.summary =
    'Protocol-only verifier authenticated to the real Server and observed the real Agent registration without launching Playwright.';
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack || error.message : String(error)) + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: error instanceof Error ? error.message : String(error),
    evidence: [{ type: 'protocol', value: 'protocol verifier reached a concrete assertion failure' }],
  }) + '\n');
  process.exitCode = 1;
});
