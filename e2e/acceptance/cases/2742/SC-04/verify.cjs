'use strict';
// #2742 SC-04 runtime half: the link resolver's refusal classes and the
// provider's authoritative read containment both still hold. The browser half
// drives the same refusals through the production MemoryView.
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');

function assertIncludes(output, names) {
  for (const name of names) {
    if (!output.includes(name)) {
      throw new Error('Missing concrete assertion: ' + name + '\n' + output.slice(-3000));
    }
  }
}

run(({ evidence }) => {
  const sha = targetSha();

  const rust = checked(
    'cargo',
    ['test', '-p', 'nession-claude-code', '--lib', 'memory', '--', '--nocapture'],
    300_000,
  );
  assertIncludes(rust, [
    'agent::tests::memory_reads_are_bounded_and_cannot_escape_the_memory_directory',
  ]);

  const links = checked(
    'npm',
    [
      '--prefix', 'web', 'test', '--', '--project', 'unit',
      'src/capabilities/claude-code/__tests__/unit/memoryLink.test.ts',
      '--reporter=verbose',
    ],
    300_000,
  );
  assertIncludes(links, [
    'refuses traversal above the memory root but allows stepping through it',
    'refuses absolute paths, backslashes, queries and unsafe schemes',
    'refuses unlisted, non-Markdown, malformed and empty targets',
  ]);

  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': provider memory reads stayed bounded inside the memory ' +
      'directory; link resolution refused traversal, absolute paths, queries, unsafe ' +
      'schemes and unlisted/non-Markdown targets while allowing a normalised in-root path',
  });
  return 'Unsafe targets cannot trigger a read, and the provider containment still holds';
});
