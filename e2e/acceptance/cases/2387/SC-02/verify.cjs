'use strict';

// Exact-SHA source-aligned Case for #2387 SC-02: with the Agent output consumer
// deliberately stalled under large tmux output, the ControlModeSession output
// handoff fails closed within its configured limits — no unbounded queue, no
// suspended forwarder, no healthy-looking stream after the loss.
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

  const deterministic = checked('cargo', [
    'test', '-p', 'nession-agent', '--lib',
    'tmux::control::tests::a_stalled_output_consumer_fails_closed_at_the_handoff_deadline',
  ], 120000) + checked('cargo', [
    'test', '-p', 'nession-agent', '--lib',
    'tmux::control::tests::a_full_output_queue_fails_closed_at_the_handoff_deadline',
  ], 120000);
  expectOk(deterministic, 'tmux::control::tests::a_stalled_output_consumer_fails_closed_at_the_handoff_deadline');
  expectOk(deterministic, 'tmux::control::tests::a_full_output_queue_fails_closed_at_the_handoff_deadline');

  const real = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::real_tmux_stalled_output_handoff_closes_in_bounded_time', '--', '--nocapture',
  ], 180000);
  expectOk(real, 'control_mode::real_tmux_stalled_output_handoff_closes_in_bounded_time');

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'a stalled Agent output consumer exhausts the aggregate handoff budget and the ControlModeSession output stream ends in bounded time, with the admitted backlog readable in order and no healthy-looking stall',
    evidence: [
      {type: 'runtime', value: 'tmux executable: ' + version},
      {type: 'runtime', value: 'deterministic byte-budget and full-queue deadline tests passed at exact checkout SHA ' + process.env.NESSION_ACCEPTANCE_TARGET_SHA},
      {type: 'runtime', value: 'real isolated tmux output flood with a stopped consumer closed the handoff within its configured limits'},
    ],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message || error).slice(-4400),
    evidence: [{type: 'runtime', value: 'bounded output handoff under a stalled consumer was not established'}],
  }) + '\n');
  process.exitCode = 1;
}
