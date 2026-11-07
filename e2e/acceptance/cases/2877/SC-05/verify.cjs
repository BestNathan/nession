'use strict';
// #2877 SC-05: direct P2P and Relay share identity/recovery semantics across a
// route swap, transport loss, a stale notice, two subscribers (one slow) and
// credit-capacity pressure; recovery remains possible when a pre-close notice
// cannot be delivered, with no global producer stall.
//
// The two subscriber/credit tests use real per-subscriber ledgers; the Server
// test drives the real Relay forwarding function; the Web tests drive the exact
// relay proof, route replacement and transport-loss recovery. No nested
// full-stack process is started inside the Case runtime.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { webVitestFiles } = require('../../../shared/web-vitest-cases.cjs');

const SERVER_TEST =
  'a_progress_notification_is_forwarded_unchanged_to_the_agent';
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
const RELAY_FILE = 'src/product/terminal/__tests__/unit/terminalServer.test.ts';
const RELAY_TESTS = [
  'sends the negotiated response-less progress notification on its own wire (#2877)',
  'routes a strict current-subscription notice by session and drops malformed ones',
];

run(({ evidence }) => {
  const sha = targetSha();

  const relay = crateTests('nession-server', ['--lib', SERVER_TEST], 300000);
  assertRan(relay, [SERVER_TEST]);

  for (const test of AGENT_TESTS) {
    const agent = crateTests('nession-agent', ['--lib', test], 300000);
    assertRan(agent, [test]);
  }

  webVitestFiles([RUNTIME_FILE], RUNTIME_TESTS, { project: 'unit' });
  webVitestFiles([RELAY_FILE], RELAY_TESTS, { project: 'unit' });

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': P2P and Relay carried the same Agent-minted subscription ' +
      'identity; a route swap retired the old generation so its notice could not start ' +
      'recovery, while the fresh binding did; two subscribers kept independent credit ' +
      '(one stalled did not consume the other), capacity pressure failed only the ' +
      'affected subscriber, a lost transport re-began the relay and requested history, ' +
      'and the Relay forwarded the wire unchanged without stalling the producer',
  });
  return 'Direct P2P and Relay share identity and recovery semantics; slow/stale/retired subscriptions are isolated and transport loss still recovers';
});
