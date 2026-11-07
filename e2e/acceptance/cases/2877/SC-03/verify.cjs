'use strict';
// #2877 SC-03: a provable current-subscription inconsistency emits at most one
// active Reconcile Required episode, carrying the correct binding/reason/head;
// ordinary lag and stale/foreign/malformed reports or retired notifications do
// not trigger recovery or leak current subscriber state.
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
  // A nested real-tmux test must not share the runtime's product tmux socket.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2877-sc03-'));
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const isolated = {
    NESESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'),
    NESESSION_HOME: path.join(dir, 'home'),
  };

  const agent = crateTests('nession-agent', ['--lib', AGENT_TEST], 300000, isolated);
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
      'exact SHA ' + sha + ': an ahead-of-issued claim opened exactly one episode and ' +
      'repeating it emitted nothing; a stale subscriber generation was ignored without ' +
      'disturbing the active episode; the real Relay notice named the current ' +
      'subscriber_generation, stream_epoch, reason, action, head_seq and retained floor',
  });
  return 'One active Reconcile Required episode per proven inconsistency; stale, foreign, duplicate and ordinary-lag reports stay silent';
});
