'use strict';
// #2877 SC-05: direct P2P and Relay share identity/recovery semantics across a
// route swap, transport loss, a stale notice, two subscribers (one slow) and
// credit-capacity pressure; recovery remains possible when a pre-close notice
// cannot be delivered, with no global producer stall.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { webVitestFiles } = require('../../../shared/web-vitest-cases.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RELAY_TEST =
  'relay_forwards_progress_without_a_reply_and_returns_the_current_subscriptions_notice';
const AGENT_TESTS = [
  'progress_credit_is_per_subscriber_and_one_peer_cannot_contaminate_another',
  'one_stalled_subscriber_cannot_consume_anothers_credit',
  'legacy_slow_peer_is_independent_and_never_opted_in_by_transport_dequeue',
];

const RUNTIME_FILE = 'src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts';
const RUNTIME_TESTS = [
  'uses the response-less Relay progress notification only when the forwarded proof states it (#2877)',
  'ignores a stale or foreign reconcile notice and degrades when replay cannot prove continuity (#2877)',
  're-begins exactly once across connected -> connecting -> connected (recoverable loss cycle)',
  'states the loss when a re-attach lands on a renderer with no parsed capture (#2194)',
];

run(({ evidence }) => {
  const sha = targetSha();
  // The nested real-tmux test owns its socket, never the runtime's product one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2877-sc05-'));
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const isolated = {
    NESESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'),
    NESESSION_HOME: path.join(dir, 'home'),
  };

  const relay = crateTests(
    'nession-server',
    ['--test', 'integration', RELAY_TEST],
    300000,
    isolated,
  );
  assertRan(relay, [RELAY_TEST]);

  for (const test of AGENT_TESTS) {
    const agent = crateTests('nession-agent', ['--lib', test], 300000, isolated);
    assertRan(agent, [test]);
  }

  webVitestFiles([RUNTIME_FILE], RUNTIME_TESTS, { project: 'unit' });

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': P2P and Relay carried the same Agent-minted subscription ' +
      'identity; a route swap retired the old generation so its notice could not start ' +
      'recovery, while the fresh binding did; two subscribers kept independent credit ' +
      '(one stalled did not consume the other), capacity pressure failed only the ' +
      'affected subscriber, a lost transport re-began the relay and requested history, ' +
      'and no path stalled the producer',
  });
  return 'Direct P2P and Relay share identity and recovery semantics; slow/stale/retired subscriptions are isolated and transport loss still recovers';
});
