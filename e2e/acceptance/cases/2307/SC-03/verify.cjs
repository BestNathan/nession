'use strict';
// Exact-SHA source-aligned Case for #2307 SC-03: valid arbitrary pane bytes
// arrive byte-identically (non-UTF-8, octal control bytes, split frames), and
// malformed/oversized frames and unknown notifications have bounded,
// intentional outcomes.
const {
  run, targetSha, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const client = cargoTests(['--lib', 'tmux::client::'], 300000);
  assertRan(client, [
    'tmux::client::tests::output_is_byte_exact_and_size_changes_are_deduplicated',
    'tmux::client::tests::a_capture_is_published_in_stream_order_between_output',
    'tmux::client::transport::tests::the_cc_terminal_framing_never_reaches_the_protocol_stream',
    'tmux::client::transport::tests::only_the_streams_own_framing_is_removed',
    'tmux::client::framing::tests::a_split_non_utf8_frame_is_preserved_byte_for_byte',
    'tmux::client::framing::tests::a_cancelled_read_keeps_its_prefix_until_the_newline',
    'tmux::client::framing::tests::a_truncated_record_is_a_frame_fault_not_a_shorter_record',
    'tmux::client::framing::tests::only_an_unparseable_known_tag_is_fatal',
  ]);
  evidence.push(
    { type: 'runtime', value: 'byte-exact non-UTF-8 and split-frame output, CR/ESC data preservation, and capture-body OSC-8 ST survival passed at exact SHA ' + sha },
    { type: 'runtime', value: 'truncated records fail closed as UnexpectedEof; unknown notifications stay forward compatible; a known-tag prefix alone is not that tag' },
  );
  return 'Arbitrary pane bytes are preserved byte-identically, and malformed/oversized/unknown records have the bounded #2300 outcomes';
});
