'use strict';
// #2654 SC-01 (no-Session half): the fixture route always selects a Session,
// so the profile-first no-Session flow is proven by the layout test that owns
// it, executed against the exact target checkout.
const {
  emitFailure,
  emitPass,
  runWebTestsWithNames,
  runtimeFromEnv,
} = require('../../../shared/session-env-binding-cases.cjs');

try {
  const runtime = runtimeFromEnv();
  const names = ['without a Session, lays navigator and the profile-first empty detail'];
  const ran = runWebTestsWithNames(
    ['src/app/experiences/web/__tests__/integration/EnvWebLayout.test.tsx'],
    names,
  );
  emitPass(
    'Exact-SHA Web layout test proves the no-Session flow stays profile-first with no fabricated Session status.',
    [
      { type: 'runtime', value: 'target_sha=' + runtime.target_sha + ' profile=' + runtime.profile },
      { type: 'test', value: 'vitest ' + ran.files.join(',') + ': ' + ran.names.join('; ') },
    ],
  );
} catch (error) {
  emitFailure(error);
}
