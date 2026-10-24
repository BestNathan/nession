'use strict';

// Exact-SHA source-aligned Case for #2300 SC-03: execute the actual Rust
// ControlModeSession integration suite against a real isolated tmux server.
// The fixture uses a private -S socket and shell PTY, never a mock or user
// tmux process. Do not conflate this with Browser Parser Applied proof:
// the separate terminal-consistency-faults E2E owns that invariant.
const fs = require('node:fs');
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
try {
  if (process.platform !== 'linux') throw new Error('Real PTY acceptance runs on Linux');
  if (!fs.existsSync(path.join(root,'crates/nession-agent/tests/integration/control_mode.rs'))) {
    throw new Error('canonical ControlModeSession integration source not found');
  }
  const version = checked('tmux', ['-V'], 10000).trim();
  if (!/^tmux \d/.test(version)) throw new Error('unrecognised tmux executable: ' + version);
  const output = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::', '--', '--nocapture',
  ], 110000);
  const passed = output.match(/test result: ok\. (\d+) passed; 0 failed;/);
  if (!passed || Number(passed[1]) < 6) {
    throw new Error('Real tmux tests were not all executed: ' + output.slice(-4500));
  }
  for (const name of [
    'test_attach_and_receive_output',
    'the_bootstrap_capture_and_the_live_stream_join_exactly',
    'a_peer_driven_resize_reaches_the_other_client',
  ]) {
    if (!output.includes('control_mode::' + name + ' ... ok')) {
      throw new Error('Missing concrete real-tmux assertion: ' + name);
    }
  }
  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'Real isolated tmux/PTY ControlModeSession attach, output, capture/live barrier and resize tests passed',
    evidence: [
      {type: 'runtime', value: 'tmux executable: ' + version},
      {type: 'runtime', value: 'ControlModeSession tests passed: ' + passed[1] + ' at exact checkout SHA ' + process.env.NESSION_ACCEPTANCE_TARGET_SHA},
      {type: 'runtime', value: 'Verified actual PTY attach/output; capture/live GAP-001..060 exactly-once join; peer resize notification'},
    ],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message || error).slice(-4400),
    evidence: [{type: 'runtime', value: 'Real tmux PTY/ControlModeSession integration did not establish SC-03'}],
  }) + '\n');
  process.exitCode = 1;
}
