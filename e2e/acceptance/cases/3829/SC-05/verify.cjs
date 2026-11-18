'use strict';
// #3829 SC-05 runtime half: Web's existing Claude browser tests and the shared
// conversation owner still pass, while the App composition's own tests prove
// it reaches the same Memory/MCP/Configuration/Transcript owners in the target
// checkout.
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  emitPass,
  emitFailure,
  runWebTestsWithNames,
} = require('../../../shared/session-env-binding-cases.cjs');

try {
  const { sha } = verifiedRuntime('SC-05');
  const webFiles = [
    'src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx',
  ];
  const webNames = [
    'opens on the conversation, and keeps configuration one section away',
    'keeps the browser heading on web and defers the app heading to AppPageHeader',
  ];
  const appFiles = [
    'src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeAppWorkspace.test.tsx',
  ];
  const appNames = [
    'reads a directory conversation without replacing the bound root, and Back restores it',
    'pushes a memory file and restores the list selection',
    'pushes Configuration files as one column and keeps the scope inside it',
    'pushes an MCP server and its inspected tool schema, with no second Back',
  ];
  const sharedFiles = [
    'src/shared/ai-conversation/__tests__/integration/ConversationView.test.tsx',
  ];
  const sharedNames = ['pushes the detail over the list on a narrow surface'];

  const webRan = runWebTestsWithNames(webFiles, webNames);
  const appRan = runWebTestsWithNames(appFiles, appNames);
  const sharedRan = runWebTestsWithNames(sharedFiles, sharedNames);

  emitPass(
    'Web kept its existing Claude presentation while App reached the shared conversation, Memory, MCP, Configuration and transcript owners, at the exact target SHA.',
    [
      { type: 'runtime', value: 'target_sha=' + sha + ' profile=full-stack-local' },
      {
        type: 'test',
        value: 'npm test ' + webRan.files.join(' ') + ': ' + webRan.names.join('; '),
      },
      {
        type: 'test',
        value: 'npm test ' + appRan.files.join(' ') + ': ' + appRan.names.join('; '),
      },
      {
        type: 'test',
        value: 'npm test ' + sharedRan.files.join(' ') + ': ' + sharedRan.names.join('; '),
      },
    ],
  );
} catch (error) {
  emitFailure(error);
}
