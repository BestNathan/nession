'use strict';

// Exact-SHA source-aligned Case for #2387 SC-04: a real isolated tmux burst
// against a stalled output consumer establishes the aggregate handoff budget
// and bounded recovery, and a healthy peer attachment on its own session keeps
// answering — the failure is scoped to the stalled stream.
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

  const real = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::real_tmux_stalled_output_handoff_closes_in_bounded_time', '--', '--nocapture',
  ], 180000);
  expectOk(real, 'control_mode::real_tmux_stalled_output_handoff_closes_in_bounded_time');

  // The existing peer-isolation burst test remains the healthy-source proof:
  // a stopped consumer on one attachment cannot affect another.
  const peer = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::event_ingress_budget_fails_closed_under_a_real_burst', '--', '--nocapture',
  ], 180000);
  expectOk(peer, 'control_mode::event_ingress_budget_fails_closed_under_a_real_burst');

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'a real isolated tmux burst with a stalled output consumer reaches the aggregate handoff budget and recovers in bounded time, while a healthy peer attachment on its own session keeps answering',
    evidence: [
      {type: 'runtime', value: 'tmux executable: ' + version},
      {type: 'runtime', value: 'real isolated tmux burst with a stopped consumer closed the handoff within its configured limits at exact checkout SHA ' + process.env.NESSION_ACCEPTANCE_TARGET_SHA},
      {type: 'runtime', value: 'the healthy peer attachment completed a command while the stalled stream failed closed'},
    ],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message || error).slice(-4400),
    evidence: [{type: 'runtime', value: 'real-burst handoff budget and peer isolation were not established'}],
  }) + '\n');
  process.exitCode = 1;
}
