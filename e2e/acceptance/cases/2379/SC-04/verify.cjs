'use strict';

// Exact-SHA source-aligned Case for #2379 SC-04: a stalled writer is bounded
// end to end, pending callers are resolved, and real isolated tmux Pipe/PTY
// lifecycle tests keep a healthy attachment answering.
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../../../..');

function checked(command, args, timeout) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
    env: {...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', RUSTC_WRAPPER: ''},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' failed (exit ' + result.status + '): ' +
      String(result.stderr || result.stdout).slice(-4500));
  }
  return String(result.stdout) + '\n' + String(result.stderr);
}

function expectOk(output, name) {
  if (!output.includes(name + ' ... ok')) {
    throw new Error('missing concrete assertion: ' + name + '\n' + output.slice(-4500));
  }
}

try {
  if (process.platform !== 'linux') throw new Error('Real tmux acceptance runs on Linux');
  const version = checked('tmux', ['-V'], 10000).trim();
  if (!/^tmux \d/.test(version)) throw new Error('unrecognised tmux executable: ' + version);

  const faults = checked('cargo', [
    'test', '-p', 'nession-agent', '--lib', 'tmux::client::tests::',
  ], 150000);
  for (const name of [
    'tmux::client::tests::a_command_admission_deadline_bounds_a_stalled_writer',
    'tmux::client::tests::close_is_bounded_with_a_stalled_writer',
    'tmux::client::tests::source_loss_completes_every_pending_waiter',
    'tmux::client::tests::a_cancelled_command_does_not_steal_the_next_reply',
  ]) {
    expectOk(faults, name);
  }

  const real = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration', 'control_mode::', '--', '--nocapture',
  ], 150000);
  const passed = real.match(/test result: ok\. (\d+) passed; 0 failed;/);
  if (!passed || Number(passed[1]) < 6) {
    throw new Error('real tmux Control Mode suite was not fully executed: ' + real.slice(-4500));
  }
  for (const name of [
    'control_mode::test_attach_and_receive_output',
    'control_mode::the_bootstrap_capture_and_the_live_stream_join_exactly',
    'control_mode::a_peer_driven_resize_reaches_the_other_client',
  ]) {
    expectOk(real, name);
  }

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'stalled-writer admission/close deadlines and pending-waiter completion are deterministic; real isolated tmux Pipe/PTY lifecycle keeps a healthy attachment answering',
    evidence: [
      {type: 'runtime', value: 'tmux executable: ' + version},
      {type: 'runtime', value: 'deterministic stalled-writer fault tests passed at exact checkout SHA ' + process.env.NESSION_ACCEPTANCE_TARGET_SHA},
      {type: 'runtime', value: 'real Control Mode Pipe/PTY tests passed: ' + passed[1] + ' (attach/output, capture/live join, peer resize)'},
    ],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message || error).slice(-4400),
    evidence: [{type: 'runtime', value: 'bounded writer lifecycle was not established'}],
  }) + '\n');
  process.exitCode = 1;
}
