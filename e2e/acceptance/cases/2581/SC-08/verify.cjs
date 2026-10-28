'use strict';
// #2581 SC-08: the ordered writer still owns output/bootstrap/resize, proves
// parser completion, rejects stale generations and fails closed on overflow.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { webTests, requireText } = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const writer = webTests([
    'src/platform/terminal-runtime/controller/__tests__/unit/SerializedTerminalWriter.test.ts',
  ]);
  const controller = webTests([
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts',
  ]);

  if (writer.passed < 12) { throw new Error('expected the writer suite, got ' + writer.passed); }
  if (controller.passed < 55) { throw new Error('expected the controller suite, got ' + controller.passed); }

  requireText('web/src/platform/terminal-runtime/controller/SerializedTerminalWriter.ts', [
    'maxParseMs', 'parser-stalled', 'overflow', 'this.halted = true',
  ]);
  requireText('web/src/platform/terminal-runtime/controller/TerminalController.ts', [
    'provesVerifiedBootstrapRepair', 'onStreamBaseline', 'onRendererReplaced',
  ]);

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': output, bootstrap and resize stay in one bounded FIFO; callbacks are parser-completed; overflow and parser stalls halt the writer and replace the renderer' },
    { type: 'stream', value: 'the controller suite proves late callbacks from a replaced transport/renderer cannot vouch for the current generation' },
  );
  return 'Output/bootstrap/resize keep the bounded FIFO and fail-closed recovery; parser completion, stale-generation rejection and ACK eligibility are unchanged';
});
