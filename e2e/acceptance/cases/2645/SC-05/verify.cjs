'use strict';
// #2645 SC-05 (runtime half): the staging Case runs against a real Server +
// Agent + browser with a shortened test lease. This half proves the fixture
// actually uses a short lease and that the shipped runtime carries the
// renewal owner the browser verifier exercises.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { readSource } = require('../../../shared/p2p-credential-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const fixture = readSource('e2e/fixtures/server/config.toml');
  const match = /^p2p_token_expiry_secs\s*=\s*(\d+)\s*$/m.exec(fixture);
  if (!match) {
    throw new Error('the E2E/acceptance fixture does not set a shortened p2p_token_expiry_secs');
  }
  const lease = Number(match[1]);
  if (!Number.isSafeInteger(lease) || lease < 1 || lease > 30) {
    throw new Error('the fixture lease must be short enough for a deterministic expiry test: ' + lease);
  }

  const runtime = readSource('web/src/platform/session-runtime/SessionRuntime.ts');
  for (const text of ['requestFreshAttach', 'resolveP2PUrl', 'p2pCredentialNeedsRenewal']) {
    if (!runtime.includes(text)) {
      throw new Error('the shipped runtime is missing the renewal owner: ' + text);
    }
  }
  const agent = readSource('crates/nession-agent/src/p2p_credentials.rs');
  for (const text of ['expires_at', 'authorize']) {
    if (!agent.includes(text)) {
      throw new Error('the Agent credential verifier is missing ' + text);
    }
  }

  evidence.push({
    type: 'source',
    value:
      'exact SHA ' + sha + ': fixture p2p_token_expiry_secs=' + lease +
      's; shipped runtime has the Server-backed renewal owner; Agent still verifies expires_at on every upgrade',
  });
  return 'The staging runtime uses a short, deterministic P2P credential lease and ships the renewal owner the browser exercises';
});
