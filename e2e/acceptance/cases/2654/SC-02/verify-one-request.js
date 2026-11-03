'use strict';
// #2654 SC-02 (single-request half): the fixture observes one resulting
// revision, but only the owning hook proves Apply issues exactly one
// replace-whole request rather than a composition of per-profile mutations.
const {
  emitFailure,
  emitPass,
  runWebTestsWithNames,
  runtimeFromEnv,
} = require('../../../shared/session-env-binding-cases.cjs');

try {
  const runtime = runtimeFromEnv();
  const names = [
    'replace sends the whole ordered selection in one request',
    'applies one replace-whole request and returns to the Session view',
  ];
  const ran = runWebTestsWithNames(
    [
      'src/capabilities/env/hooks/__tests__/integration/useSessionEnvBinding.test.ts',
      'src/capabilities/env/hooks/__tests__/integration/useEnvironmentWorkspace.test.ts',
    ],
    names,
  );
  emitPass(
    'Exact-SHA hook tests prove Apply issues one replace-whole request and the draft closes on that answer.',
    [
      { type: 'runtime', value: 'target_sha=' + runtime.target_sha + ' profile=' + runtime.profile },
      { type: 'test', value: 'vitest ' + ran.files.join(',') + ': ' + ran.names.join('; ') },
    ],
  );
} catch (error) {
  emitFailure(error);
}
