'use strict';
// #2464 SC-02: a retained renderer returns to the pane's buffer and caret.
//
// The Agent-side witness pins that the mode escapes state the alternate-screen
// selection in both directions (the pre-#2464 stream never said "leave"). The
// renderer witness drives the real web controller: a terminal already on the
// alternate screen receives a bootstrap that names the normal screen and is
// expected to end on it, with the stated caret — the state no text-only
// capture can repair.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  run, targetSha, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');

function webRetainedRendererTest() {
  const result = spawnSync(
    'npx',
    [
      'vitest', 'run',
      '-t', 'returns a retained renderer',
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
  if (result.status !== 0 || !/Tests\s+1 passed/.test(output)) {
    throw new Error('the retained-renderer test did not report a pass: ' + output.slice(-3000));
  }
  return output;
}

run(({ evidence }) => {
  const sha = targetSha();

  const direction =
    'server::bootstrap::tests::the_alternate_screen_selection_is_stated_in_both_directions';
  assertRan(cargoTests(['--lib', direction], 180000), [direction]);

  webRetainedRendererTest();

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha +
        ': the mode escapes state the pane\'s alternate-screen selection in both directions, so a retained renderer is told to leave a screen the application already left',
    },
    {
      type: 'renderer',
      value:
        'a terminal kept across transport replacement ended on the normal buffer with the bootstrap\'s text and caret after receiving the pane\'s buffer selection',
    },
  );
  return 'A retained renderer follows the pane\'s buffer selection and caret from the bootstrap instead of staying on a stale alternate screen';
});
