'use strict';
// Exact-SHA source-aligned Case for #2307 SC-02: both Control Mode transports
// handshake, run commands and deliver equivalent typed pane output, capture
// and resize events on real isolated tmux; the -CC terminal framing and the
// negative launch/early-death paths are explicit; -C remains the default.
const {
  run, targetSha, tmuxVersion, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  if (process.platform !== 'linux') throw new Error('real tmux transport parity runs on Linux');
  const tmux = tmuxVersion();

  const parity = cargoTests([
    '--test', 'integration',
    'control_mode::both_transports_deliver_equivalent_output_capture_and_resize_events',
  ], 300000);
  if (!/test result: ok\. 1 passed; 0 failed;/.test(parity)) {
    throw new Error('both-transport parity test did not run at this SHA: ' + parity.slice(-4000));
  }
  assertRan(parity, [
    'control_mode::both_transports_deliver_equivalent_output_capture_and_resize_events',
  ]);

  const transport = cargoTests(['--lib', 'tmux::client::transport::tests'], 300000);
  assertRan(transport, [
    'tmux::client::transport::tests::a_real_pty_cc_attach_handshakes_and_answers_a_command',
    'tmux::client::transport::tests::a_missing_tmux_is_an_error_on_both_transports_and_never_a_fallback',
    'tmux::client::transport::tests::a_cc_child_that_exits_immediately_is_a_lost_source',
    'tmux::client::transport::tests::a_pipe_child_that_exits_immediately_is_a_lost_source',
  ]);

  const selection = cargoTests([
    '--lib', 'tmux::control::tests::the_transport_selection_keeps_pipe_as_the_default',
  ], 120000);
  assertRan(selection, [
    'tmux::control::tests::the_transport_selection_keeps_pipe_as_the_default',
  ]);

  evidence.push(
    { type: 'runtime', value: 'tmux executable: ' + tmux },
    { type: 'runtime', value: '-C and -CC handshake, input, %output, capture and resize parity passed on real isolated tmux at exact SHA ' + sha },
    { type: 'runtime', value: '-CC real PTY DCS/ST/CRLF handshake and command reply passed; missing binary errors on both transports; child death is SourceLost; the default stays -C' },
  );
  return 'Both transports deliver equivalent typed output/capture/resize on real isolated tmux, and the -CC/negative/default paths are explicit';
});
