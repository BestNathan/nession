'use strict';
// #2581 SC-07: one ordered PTY-bound input path across keyboard, mobile IME,
// semantic keys, paste and the relay/P2P input FIFO.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { webTests, requireText } = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const interaction = webTests([
    'src/platform/terminal-runtime/interaction/__tests__/integration/TerminalInteractionController.test.ts',
  ]);
  const ime = webTests([
    'src/platform/terminal-runtime/input/__tests__/integration/MobileImeInput.test.ts',
  ]);
  const chunking = webTests([
    'src/platform/terminal-runtime/__tests__/integration/inputChunking.test.ts',
  ]);

  if (interaction.passed < 10) { throw new Error('expected the interaction suite, got ' + interaction.passed); }
  if (ime.passed < 20) { throw new Error('expected the mobile IME suite, got ' + ime.passed); }
  if (chunking.passed < 3) { throw new Error('expected the input chunking suite, got ' + chunking.passed); }

  requireText('web/src/platform/terminal-runtime/interaction/TerminalInteractionController.ts', [
    'sendPtyBytes', 'sendText', 'sendSemanticKey', 'bindXtermOnData', 'TerminalInteractionPort',
  ]);

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': semantic keys, paste, committed IME text and Ctrl+D each reach the PTY once through one encoder; application cursor mode changes the arrow bytes' },
    { type: 'input', value: 'the interaction owner consumes the emulator port and binds one disposable onData subscription per activation' },
  );
  return 'Desktop keyboard, mobile IME, semantic keys and paste produce exactly one ordered PTY-bound input with the terminal mode deciding the bytes';
});
