'use strict';
// #2469 SC-03: -C Pipe and -CC PTY preserve the same typed contract.
//
// At the merged staging SHA this Case proves, on the real tmux executable:
//   - both carriers attach to one private isolated socket and answer commands;
//   - non-UTF8 output is byte-exact through framing and the protocol layer;
//   - command/reply matching, tombstones, source-loss and capture ordering are
//     the typed client's, not a per-transport convention;
//   - ingress and admission are bounded and a stalled consumer fails closed;
//   - a missing tmux is an explicit error on both carriers, never a silent
//     fallback.
const {
  run, targetSha, checked, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();
  const os = checked('uname', ['-sm'], 10000).trim();

  const both = checked('cargo', ['test', '-p', 'nession-tmux'], 600000);
  assertRan(both, [
    'real_isolated_tmux_supports_pipe_and_pty_control_attachments',
    'a_real_pty_cc_attach_handshakes_and_answers_a_command',
    'a_missing_tmux_is_an_error_on_both_transports_and_never_a_fallback',
    'a_split_non_utf8_frame_is_preserved_byte_for_byte',
    'only_the_streams_own_framing_is_removed',
  ]);

  const contract = checked(
    'cargo',
    ['test', '-p', 'nession-tmux', '--lib', 'client::tests', '--', '--nocapture'],
    300000,
  );
  assertRan(contract, [
    'output_is_byte_exact_and_size_changes_are_deduplicated',
    'a_command_is_matched_to_its_response_block',
    'a_timeout_leaves_a_tombstone_so_the_next_command_gets_its_own_reply',
    'source_loss_fails_every_pending_command_and_is_stated',
    'a_capture_is_published_in_stream_order_between_output',
    'event_ingress_is_bounded_by_aggregate_bytes_and_releases_on_take',
    'a_full_event_queue_fails_closed_at_the_admission_deadline',
    'close_is_bounded_with_a_stalled_writer',
    'notification_shaped_body_lines_are_content_not_source_events',
  ]);

  const parser = checked(
    'cargo',
    ['test', '-p', 'nession-tmux', '--lib', 'parser::tests', '--', '--nocapture'],
    300000,
  );
  assertRan(parser, [
    'binary_output_preserves_invalid_utf8_across_the_protocol_layer',
    'record_delimiter_never_eats_pane_whitespace',
  ]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + os + ' with ' + version +
        ': both -C pipe and -CC PTY attached to one private isolated socket and answered typed commands',
    },
    {
      type: 'runtime',
      value:
        'non-UTF8 bytes survived framing and the protocol layer; command/reply matching, tombstones, source loss, capture ordering, bounded ingress and bounded close were proven by the typed client tests',
    },
    {
      type: 'runtime',
      value:
        'a missing tmux failed explicitly on both transports rather than falling back to the other carrier',
    },
  );
  return 'Both Control Mode carriers preserve the same byte-exact typed contract on real tmux, with bounded resources and explicit unsupported-variant failure';
});
