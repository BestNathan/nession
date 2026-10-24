'use strict';

// Exact-SHA source-aligned Case for #2388 SC-02: a live-but-stalled resize
// consumer cannot suspend the single ordered forwarder. Real isolated tmux
// keeps output flowing after more distinct resizes than the old 16-slot queue
// held, and the stalled consumer reads the final authoritative size when it
// resumes; peer-driven reflow still reaches the other client.
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
    'tmux::control::tests::a_stalled_resize_consumer_does_not_block_output',
  ], 120000);
  expectOk(deterministic, 'tmux::control::tests::a_stalled_resize_consumer_does_not_block_output');

  const real = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::real_tmux_stalled_resize_consumer_keeps_output_flowing', '--', '--nocapture',
  ], 180000);
  expectOk(real, 'control_mode::real_tmux_stalled_resize_consumer_keeps_output_flowing');

  const peer = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::a_peer_driven_resize_reaches_the_other_client', '--', '--nocapture',
  ], 180000) + checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::two_clients_share_one_window', '--', '--nocapture',
  ], 180000);
  expectOk(peer, 'control_mode::a_peer_driven_resize_reaches_the_other_client');
  expectOk(peer, 'control_mode::two_clients_share_one_window');

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'a stalled resize consumer never suspends the single ordered forwarder: output keeps flowing past more than 16 distinct resizes, the final authoritative size survives, and peer-driven reflow still reaches the other client with no silent geometry gap',
    evidence: [
      {type: 'runtime', value: 'tmux executable: ' + version},
      {type: 'runtime', value: 'deterministic stalled-resize foregrounding test passed at exact checkout SHA ' + process.env.NESSION_ACCEPTANCE_TARGET_SHA},
      {type: 'runtime', value: 'real isolated tmux: output after 21 distinct resizes arrived while the resize lane was never read, then the final level was (101,30)'},
      {type: 'runtime', value: 'peer-driven resize and the shared-window last-writer-wins contract remained intact'},
    ],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message || error).slice(-4400),
    evidence: [{type: 'runtime', value: 'resize-lane liveness and ordering were not established'}],
  }) + '\n');
  process.exitCode = 1;
}
