'use strict';
// #2877 SC-02: a valid monotonic parser Progress advances only the matching
// subscriber's credited issued prefix without a response; a duplicate, older
// subscription generation, foreign peer, unverified renderer or a claim beyond
// the subscriber's actually issued frontier never advances or contaminates
// another subscription.
//
// The Agent unit test drives the authenticated verdict over two peers; the
// Relay integration test sends a real browser progress notification to a real
// Agent through the Server and observes that nothing answers it.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENT_TEST =
  'progress_is_response_less_and_only_an_actionable_current_inconsistency_opens_one_episode';
const RELAY_TEST =
  'relay_forwards_progress_without_a_reply_and_returns_the_current_subscriptions_notice';

run(({ evidence }) => {
  const sha = targetSha();
  // The Case runtime's own tmux server belongs to the product stack; a nested
  // real-tmux test must create its sessions on a socket it owns.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2877-sc02-'));
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const isolated = {
    NESESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'),
    NESESSION_HOME: path.join(dir, 'home'),
  };

  const agent = crateTests(
    'nession-agent',
    ['--lib', AGENT_TEST],
    300000,
    isolated,
  );
  assertRan(agent, [AGENT_TEST]);

  const relay = crateTests(
    'nession-server',
    ['--test', 'integration', RELAY_TEST],
    300000,
    isolated,
  );
  assertRan(relay, [RELAY_TEST]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Agent recorded a valid contiguous parser prefix only ' +
      'for the exact socket/subscription/epoch/renderer; duplicate, stale-generation, ' +
      'stale-epoch, stale-renderer and ahead-of-issued claims did not advance or ' +
      'contaminate any cursor, and a real Relayed progress notification produced no reply',
  });
  return 'Only the matching subscriber’s actually issued prefix can advance; every invalid, stale, duplicate or foreign claim is refused without a reply';
});
