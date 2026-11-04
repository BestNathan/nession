'use strict';
// #2654 SC-05 (live half): the real Server + Agent own one Session's binding.
// The verifier uses only the canonical binding Units — no attach payload, no
// client apply/unset — and asks tmux what it actually holds.
const {
  emitFailure,
  emitPass,
  runtimeFromEnv,
  verifyLiveSessionBinding,
} = require('../../../shared/session-env-binding-cases.cjs');

(async () => {
  try {
    const runtime = runtimeFromEnv();
    const evidence = await verifyLiveSessionBinding(runtime);
    emitPass(
      'Exact-SHA full stack bound only the intended Session, materialized the ordered selection last-wins, ' +
      'kept it across a fresh client connection, restored removed keys, and deferred profile edits to Reapply.',
      [
        { type: 'runtime', value: 'target_sha=' + runtime.target_sha + ' profile=' + runtime.profile },
        ...evidence.map((value) => ({ type: 'protocol', value })),
      ],
    );
  } catch (error) {
    emitFailure(error);
  }
})();
