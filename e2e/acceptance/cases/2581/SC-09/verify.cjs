'use strict';
// #2581 SC-09: Controller/Observer takeover and transport swap at the source
// boundary. The browser regression suites (terminal-io,
// terminal-consistency-faults, terminal-attach-bootstrap, attach-critical-path)
// carry the Issue's E2E evidence; this Case proves the wiring those flows use.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { webTests } = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const observer = webTests([
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts',
  ], { filter: 'observer follows tmux resize' });
  const adoption = webTests([
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts',
  ], { filter: 'adopt' });
  const displaced = webTests([
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts',
  ], { filter: 'displaced Controller' });
  const transportSwap = webTests([
    'src/product/terminal/components/__tests__/integration/TerminalViewport.test.tsx',
  ], { filter: 'transport-swap' });

  for (const [name, result] of [
    ['observer-follows-tmux', observer],
    ['takeover-adoption', adoption],
    ['displaced-controller', displaced],
    ['transport-swap', transportSwap],
  ]) {
    if (result.passed < 1) { throw new Error(name + ' did not run'); }
  }

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': a displaced observer follows the panes authoritative size, raises no passive resize, and adopts the measured viewport on takeover; a transport swap rewires without a second input subscription' },
    { type: 'browser', value: 'terminal-io, terminal-consistency-faults, terminal-attach-bootstrap and attach-critical-path remain the Issue E2E evidence on the same revision' },
  );
  return 'Desktop/mobile takeover and P2P/relay transport swaps keep one Controller/Observer authority, one input path and the same visible terminal state';
});
