'use strict';
// Exact-SHA source-aligned Case for #2307 SC-05: from the single Client source,
// output and authoritative size changes keep source order, and a capture/live
// straddle neither loses nor duplicates data.
const {
  run, targetSha, tmuxVersion, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const tmux = tmuxVersion();
  const integration = cargoTests(['--test', 'integration', 'control_mode::'], 300000);
  const passed = integration.match(/test result: ok\. (\d+) passed; 0 failed;/);
  if (!passed || Number(passed[1]) < 6) {
    throw new Error('real tmux Control Mode tests were not all executed: ' + integration.slice(-4000));
  }
  assertRan(integration, [
    'control_mode::the_bootstrap_capture_and_the_live_stream_join_exactly',
    'control_mode::a_peer_driven_resize_reaches_the_other_client',
    'control_mode::test_attach_and_receive_output',
    'control_mode::both_transports_deliver_equivalent_output_capture_and_resize_events',
  ]);
  const ordering = cargoTests([
    '--lib', 'tmux::client::tests::a_capture_is_published_in_stream_order_between_output',
  ], 120000);
  assertRan(ordering, [
    'tmux::client::tests::a_capture_is_published_in_stream_order_between_output',
  ]);
  evidence.push(
    { type: 'runtime', value: 'tmux executable: ' + tmux },
    { type: 'runtime', value: 'capture/live GAP-001..060 exactly-once join, peer-driven resize delivery, and attach output passed on real isolated tmux at exact SHA ' + sha },
    { type: 'runtime', value: 'the ordered event stream publishes pre-capture output, CaptureStarted, interleaved output, Capture and post-capture output in wire order' },
  );
  return 'Source-ordered output and layout events, with an exact capture/live join and no duplication';
});
