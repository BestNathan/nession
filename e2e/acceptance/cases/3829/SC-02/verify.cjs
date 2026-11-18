'use strict';
// #3829 SC-02 runtime half: the App MCP resource reaches a server detail and a
// tool-schema depth under the same one-Back hierarchy, proven in the target
// checkout because the browser fixture does not model the MCP wire. The same
// run re-proves that every transcript record, including malformed JSON, keeps
// its Raw action.
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  emitPass,
  emitFailure,
  runWebTestsWithNames,
} = require('../../../shared/session-env-binding-cases.cjs');

try {
  const { sha } = verifiedRuntime('SC-02');
  const files = [
    'src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeAppWorkspace.test.tsx',
  ];
  const names = [
    'pushes an MCP server and its inspected tool schema, with no second Back',
    'pushes every transcript record, and Raw from a malformed record stays readable',
  ];
  const ran = runWebTestsWithNames(files, names);
  emitPass(
    'The App MCP server and tool-schema depths push and leave through the one shell Back, and every transcript record keeps Raw, at the exact target SHA.',
    [
      { type: 'runtime', value: 'target_sha=' + sha + ' profile=full-stack-local' },
      { type: 'test', value: 'npm test ' + files.join(' ') + ': ' + ran.names.join('; ') },
    ],
  );
} catch (error) {
  emitFailure(error);
}
