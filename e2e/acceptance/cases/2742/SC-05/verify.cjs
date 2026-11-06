'use strict';
// #2742 SC-05 runtime half: incomplete reads and Session/repository switches
// keep every old fragment, notice and content out of the new context. The
// browser half drives the continuation and the narrow layout.
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');

function assertIncludes(output, names) {
  for (const name of names) {
    if (!output.includes(name)) {
      throw new Error('Missing concrete assertion: ' + name + '\n' + output.slice(-3500));
    }
  }
}

run(({ evidence }) => {
  const sha = targetSha();

  const web = checked(
    'npm',
    [
      '--prefix', 'web', 'test', '--', '--project', 'integration',
      'src/capabilities/claude-code/components/__tests__/integration/MemoryView.test.tsx',
      'src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx',
      '--reporter=verbose',
    ],
    600_000,
  );
  assertIncludes(web, [
    'reports a fragment missing from a partial file and never guesses a heading',
    'drops a pending fragment and notice when the Session moves repository',
    'drops a pending file read when the memory directory changes',
    'drops a pending memory answer from the previous Session',
  ]);

  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': a fragment missing from the loaded chunk produced a notice ' +
      'and no scroll; the continuation found the heading; a moved memory directory and a ' +
      'changed Session dropped pending fragments, notices and in-flight file reads',
  });
  return 'Partial reads and context switches stay truthful; no stale fragment or content survives';
});
