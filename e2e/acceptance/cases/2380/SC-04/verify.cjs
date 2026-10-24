'use strict';

// Exact-SHA source-aligned Case for #2380 SC-04: a real tmux burst with a
// stopped consumer reaches the bounded aggregate byte budget, fails closed
// with a stated source loss, and leaves a healthy peer attachment unaffected.
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
    'test', '-p', 'nession-agent', '--lib', 'tmux::client::tests::',
  ], 150000);
  for (const name of [
    'tmux::client::tests::event_ingress_is_bounded_by_aggregate_bytes_and_releases_on_take',
    'tmux::client::tests::an_event_larger_than_the_budget_fails_closed',
    'tmux::client::tests::a_stalled_consumer_fails_closed_at_the_admission_deadline',
  ]) {
    expectOk(deterministic, name);
  }

  const real = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::event_ingress_budget_fails_closed_under_a_real_burst', '--', '--nocapture',
  ], 120000);
  expectOk(real, 'control_mode::event_ingress_budget_fails_closed_under_a_real_burst');

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'aggregate-byte ingress admission and its stalled-consumer disposition are deterministic; a real isolated tmux burst fails closed at the budget and a healthy peer remains answerable',
    evidence: [
      {type: 'runtime', value: 'tmux executable: ' + version},
      {type: 'runtime', value: 'deterministic byte-budget/overload tests passed at exact checkout SHA ' + process.env.NESSION_ACCEPTANCE_TARGET_SHA},
      {type: 'runtime', value: 'real isolated tmux burst with a stopped consumer produced a stated SourceLost and the peer answered refresh-client'},
    ],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message).slice(-4400),
    evidence: [{type: 'runtime', value: 'aggregate-byte ingress bound was not established'}],
  }) + '\n');
  process.exitCode = 1;
}
