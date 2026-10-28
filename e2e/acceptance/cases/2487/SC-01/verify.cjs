'use strict';
// #2487 SC-01: one fixed column count holds for a live Session across Web/App,
// foreground takeover and resize; the PTY and local xterm agree on cols and
// only rows change with usable height.
//
// Evidence at the exact merged SHA:
//   - real Agent + isolated tmux: a new Session is created at the canonical
//     width, a second client cannot change it, an authorized resize changes
//     rows only, and the attach reply states the width;
//   - the shared client configuration is one module used by both experiences
//     (the App is the same bundle), with the sizing/fit unit tests;
//   - the controller integration tests prove the local grid uses the stated
//     width and an observer adopts the Agent's width instead of its own build
//     value.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');
const {
  root, stripAnsi, passedTests, requireText,
} = require('../../../shared/terminal-sizing-cases.cjs');

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2487-sc01-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

function webTests(args) {
  const result = spawnSync(
    'npm',
    ['--prefix', 'web', 'test', '--', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 300000,
      env: { ...process.env, RUSTC_WRAPPER: '' },
    },
  );
  const output = stripAnsi(String(result.stdout || '') + '\n' + String(result.stderr || ''));
  if (result.status !== 0) {
    throw new Error('Web tests failed (exit ' + result.status + '): ' + output.slice(-4000));
  }
  return output;
}

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const fixed = cargoTests(
    ['--test', 'integration',
      'server::integration_new_session_uses_configured_columns_and_clamps_resize'],
    300000,
    tmuxEnv,
  );
  assertRan(fixed, [
    'server::integration_new_session_uses_configured_columns_and_clamps_resize',
  ]);

  const attach = cargoTests(
    ['--test', 'integration',
      'server::integration_attach_keeps_session_columns_and_applies_rows'],
    300000,
    tmuxEnv,
  );
  assertRan(attach, [
    'server::integration_attach_keeps_session_columns_and_applies_rows',
  ]);

  // The Web and App are one bundle and one configuration module. The emitted
  // value is the canonical column count; no separate mobile columns knob.
  requireText('web/src/platform/terminal-runtime/terminalConfig.ts', [
    'DEFAULT_TERMINAL_COLS = 96',
    'readTerminalClientConfig',
  ]);
  const configTests = webTests([
    '--project', 'unit',
    'src/platform/terminal-runtime/__tests__/unit/terminalConfig.test.ts',
    'src/platform/terminal-runtime/__tests__/unit/sizing.test.ts',
  ]);
  if (!/Test Files\s+2 passed/.test(configTests) || (passedTests(configTests) ?? 0) < 13) {
    throw new Error('the shared-config/sizing tests did not run: ' + configTests.slice(-3000));
  }

  // The local grid: stated width wins over the build value; an observer
  // follows the Agent's geometry rather than its own viewport.
  const controllerTests = webTests([
    '--project', 'integration',
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts',
  ]);
  if ((passedTests(controllerTests) ?? 0) < 63) {
    throw new Error('the terminal controller tests did not run: ' + controllerTests.slice(-3000));
  }

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + version + ': a real Agent/tmux Session kept one column count ' +
        'across creation, a second attach with a different width and an authorized resize; only rows ' +
        'changed and the attach reply stated the column count',
    },
    {
      type: 'test',
      value:
        'the Web/App shared terminalConfig emitted the canonical columns; the fit/sizing unit tests ' +
        'and the 63 controller integration tests passed, including stated-width render and observer ' +
        'adoption of the Agent-stated width',
    },
  );
  return 'One fixed column count holds across Web/App and the running Agent/tmux Session; only rows follow the active viewport';
});
