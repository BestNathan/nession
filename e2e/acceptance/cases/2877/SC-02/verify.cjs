'use strict';
// #2877 SC-02: a valid monotonic parser Progress advances only the matching
// subscriber's credited issued prefix without a response; a duplicate, older
// subscription generation, foreign peer, unverified renderer or a claim beyond
// the subscriber's actually issued frontier never advances or contaminates
// another subscription.
//
// The Agent test drives authenticated verdicts over two subscribers. The
// Server test drives the real Relay forwarding function with a recording
// stream, proving the progress wire reaches the Agent unchanged. Both are
// tmux-free, so the Case does not nest a second full stack inside the runtime.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const AGENT_TEST =
  'progress_is_response_less_and_only_an_actionable_current_inconsistency_opens_one_episode';
const SERVER_TEST =
  'a_progress_notification_is_forwarded_unchanged_to_the_agent';

run(({ evidence }) => {
  const sha = targetSha();

  const agent = crateTests('nession-agent', ['--lib', AGENT_TEST], 300000);
  assertRan(agent, [AGENT_TEST]);

  const relay = crateTests('nession-server', ['--lib', SERVER_TEST], 300000);
  assertRan(relay, [SERVER_TEST]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Agent recorded a valid contiguous parser prefix only ' +
      'for the exact socket/subscription/epoch/renderer; duplicate, stale-generation, ' +
      'stale-epoch, stale-renderer and ahead-of-issued claims did not advance or ' +
      'contaminate any cursor, and the Relay forwarding function delivered the ' +
      'response-less progress frame to the Agent unchanged with no synthesized reply',
  });
  return 'Only the matching subscriber’s actually issued prefix can advance; every invalid, stale, duplicate or foreign claim is refused without a reply';
});
