'use strict';

// Exact-SHA source-aligned Case for #2378 SC-02: prove that tmux command
// output is framed as body even when a captured pane line begins with `%`.
// The deterministic client tests cover the framing; the real isolated tmux
// test proves the measured tmux 3.6b wire behavior on the release checkout.
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

  const unit = checked('cargo', [
    'test', '-p', 'nession-agent', '--lib',
    'tmux::client::tests::a_response_body_preserves_leading_and_embedded_empty_lines',
  ], 120000) + checked('cargo', [
    'test', '-p', 'nession-agent', '--lib',
    'tmux::client::tests::percent_prefixed_body_lines_are_content_not_notifications',
  ], 120000);
  expectOk(unit, 'tmux::client::tests::a_response_body_preserves_leading_and_embedded_empty_lines');
  expectOk(unit, 'tmux::client::tests::percent_prefixed_body_lines_are_content_not_notifications');

  const real = checked('cargo', [
    'test', '-p', 'nession-agent', '--test', 'integration',
    'control_mode::real_tmux_capture_preserves_percent_prefixed_pane_lines', '--', '--nocapture',
  ], 120000);
  expectOk(real, 'control_mode::real_tmux_capture_preserves_percent_prefixed_pane_lines');

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'tmux output is framed as body: empty lines and %-prefixed pane lines are preserved by the typed client and by a real isolated tmux capture',
    evidence: [
      {type: 'runtime', value: 'tmux executable: ' + version},
      {type: 'runtime', value: 'deterministic Client framing tests passed at exact checkout SHA ' + process.env.NESSION_ACCEPTANCE_TARGET_SHA},
      {type: 'runtime', value: 'real isolated tmux capture preserved %hello, %begin fake, %end fake, %%percent and the attachment stayed usable'},
    ],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message || error).slice(-4400),
    evidence: [{type: 'runtime', value: '%-prefixed capture-body framing was not established'}],
  }) + '\n');
  process.exitCode = 1;
}
