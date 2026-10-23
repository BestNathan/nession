'use strict';
// Exact-SHA source-aligned Case for #2307 SC-04: concurrent commands receive
// their own tmux %end/%error result in wire order, and timeout, source loss or
// a late reply cannot misdeliver a response to a later caller.
const {
  run, targetSha, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const matcher = cargoTests(['--lib', 'tmux::client::tests'], 300000);
  assertRan(matcher, [
    'tmux::client::tests::a_command_is_matched_to_its_response_block',
    'tmux::client::tests::the_welcome_block_answers_no_command_even_when_one_is_already_queued',
    'tmux::client::tests::concurrent_commands_are_resolved_in_wire_order_with_interleaved_output',
    'tmux::client::tests::an_error_block_reports_tmuxs_own_message',
    'tmux::client::tests::a_timeout_leaves_a_tombstone_so_the_next_command_gets_its_own_reply',
    'tmux::client::tests::source_loss_fails_every_pending_command_and_is_stated',
    'tmux::client::tests::the_pending_queue_is_bounded_and_the_bound_fails_closed',
  ]);
  evidence.push(
    { type: 'runtime', value: 'wire-order matching, %error bodies, timeout tombstones, source-loss rejection and the bounded pending queue passed at exact SHA ' + sha },
    { type: 'runtime', value: 'a late reply is consumed by its own tombstone; the next caller never receives it' },
  );
  return 'Concurrent commands resolve against their own replies in wire order, and timeout/loss/late replies cannot misdeliver';
});
