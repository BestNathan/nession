'use strict';
// #3829 SC-04 runtime half: a Session change retires the pushed stack and Raw
// state, and the directory's loading state is distinguishable from "no
// binding". Both execute in the target checkout at the exact SHA because the
// fixture can only present settled provider answers.
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  emitPass,
  emitFailure,
  runWebTestsWithNames,
} = require('../../../shared/session-env-binding-cases.cjs');

try {
  const { sha } = verifiedRuntime('SC-04');
  const files = [
    'src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeAppWorkspace.test.tsx',
  ];
  const names = [
    'shows the directory loading state instead of claiming no binding',
    'retires a pushed depth when the Session changes',
    'never labels a foreground Claude process as working activity',
  ];
  const ran = runWebTestsWithNames(files, names);
  emitPass(
    'Loading is not confused with no binding, a Session change retires pushed state, and no foreground-command observation becomes a work claim, at the exact target SHA.',
    [
      { type: 'runtime', value: 'target_sha=' + sha + ' profile=full-stack-local' },
      { type: 'test', value: 'npm test ' + files.join(' ') + ': ' + ran.names.join('; ') },
    ],
  );
} catch (error) {
  emitFailure(error);
}
