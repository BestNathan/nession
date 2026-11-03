'use strict';
// #2645 SC-02: renewal is single-flight, generation-fenced and bounded. The
// transport coalesces concurrent connect() calls onto one URL resolution; the
// runtime refuses a reply that belongs to a replaced attach or another
// Session. Both are deterministic unit proofs at the PR head.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { readSource, runWebTests } = require('../../../shared/p2p-credential-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const wsTests = runWebTests(
    ['src/platform/socket/__tests__/unit/WebSocketService.test.ts'],
    'coalesces concurrent connect',
  );
  const fenceTests = runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'fences a renewal',
  );

  const runtime = readSource('web/src/platform/session-runtime/SessionRuntime.ts');
  const service = readSource('web/src/platform/socket/WebSocketService.ts');
  const required = [
    [service, 'resolveUrl', 'pre-dial URL resolution hook'],
    [service, 'needsUrl', 'synchronous renewal gate'],
    [service, 'connectWithResolvedUrl', 'single-flight attempt path'],
    [runtime, 'credentialRefresh', 'single-flight renewal promise'],
    [runtime, 'credentialEpoch', 'renewal generation fence'],
    [runtime, "fresh.session_id !== this.config.sessionId", 'same-Session authority check'],
    [runtime, 'invalidateP2PCredential', 'fresh-attach invalidation'],
  ];
  for (const [source, text, label] of required) {
    if (!source.includes(text)) {
      throw new Error('missing ' + label + ' (' + text + ')');
    }
  }

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + (wsTests + fenceTests) +
        ' concurrency/fencing tests passed (one resolution for concurrent connects; a renewal resolving after a replacement attach is discarded)',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': renewal is single-flight and fenced by credentialEpoch; a foreign session_id is refused and a fresh attach invalidates the in-flight authority',
    },
  );
  return 'Concurrent attempts coalesce, and a stale, foreign or replaced-attach renewal cannot install an authority or overwrite its successor';
});
