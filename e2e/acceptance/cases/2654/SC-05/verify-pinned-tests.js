'use strict';
// #2654 SC-05 (recovery half): Agent reconnect re-reports the durable binding,
// and the Server keeps the replace/reapply/legacy-adapter rules. These are the
// canonical #170 tests, executed against the exact target checkout with the
// Case's isolated NESSION_HOME and tmux socket.
const {
  emitFailure,
  emitPass,
  runTargetCheckoutTests,
  runtimeFromEnv,
} = require('../../../shared/session-env-binding-cases.cjs');

try {
  const runtime = runtimeFromEnv();
  const result = runTargetCheckoutTests(runtime);
  emitPass(
    'Exact-SHA #170 tests prove Agent reconnect re-reports the surviving binding and the Server owns ' +
    'replace/reapply/legacy translation for one Session.',
    [
      { type: 'runtime', value: 'target_sha=' + runtime.target_sha + ' profile=' + runtime.profile },
      { type: 'test', value: 'cargo test nession-agent: ' + result.agentTest },
      { type: 'test', value: 'cargo test nession-server: ' + result.serverTests.join('; ') },
    ],
  );
} catch (error) {
  emitFailure(error);
}
