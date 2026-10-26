'use strict';
// #2464 SC-03: reconnection does not falsely promote cut/fidelity/ACK, and
// the bootstrap/reconnect invariants hold in more than one pane state.
//
// This Case executes the source-aligned witnesses at the staging SHA: the
// real-tmux attach/reattach ordering, the atomic-epoch cut identity, and the
// renderer's bootstrap/fidelity/ACK tests. The P2P/Relay browser matrix stays
// with the selected E2E regressions owned by SC-04.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  run, targetSha, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');

function rendererContractTests() {
  const result = spawnSync(
    'npx',
    [
      'vitest', 'run',
      'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts',
    ],
    {
      cwd: path.join(root, 'web'),
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
    },
  );
  if (result.error) throw result.error;
  const output = String(result.stdout) + '\n' + String(result.stderr);
  // vitest colours its summary; compare against the plain text.
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (result.status !== 0 || !/Tests\s+\d+ passed/.test(plain)) {
    throw new Error('the renderer bootstrap/fidelity suite did not pass: ' + plain.slice(-3000));
  }
  return output;
}

run(({ evidence }) => {
  const sha = targetSha();
  // The real-tmux fixtures own their server; inheriting the Case runtime's
  // socket let it disappear between session creation and the first send-keys.
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2464-sc03-'));
  const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(socketDir, 'tmux.sock') };

  for (const name of [
    'server::a_plain_second_attach_sends_bootstrap_before_ok_when_asked',
    'server::a_plain_first_attach_sends_the_history_it_was_asked_for',
    'server::a_control_first_attach_names_an_atomic_epoch_start_cut',
    'server::a_plain_bootstrap_restores_a_caret_the_pane_left_on_an_empty_row',
  ]) {
    assertRan(cargoTests(['--test', 'integration', name], 300000, tmuxEnv), [name]);
  }
  fs.rmSync(socketDir, { recursive: true, force: true });

  rendererContractTests();

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha +
        ': real-tmux first and second attach keep bootstrap-before-ok ordering, CRLF history, mode/caret restoration and the atomic-epoch cut identity',
    },
    {
      type: 'renderer',
      value:
        'the controller suite keeps stream-baseline/fidelity/ACK semantics across bootstrap, replacement and dispose paths without claiming a full-VT repair',
    },
  );
  return 'Bootstrap and reattach neither promote cut/fidelity/ACK falsely nor lose history, and the renderer contracts hold for both a normal shell and a caret parked away from the text';
});
