'use strict';
// #3387 SC-01: only the latest Project list read from the current transport
// generation may commit projects/error/loaded/loading. Deferred A/B requests
// prove a safe order instead of relying on timing.
const { run, targetSha, webVitest } = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/product/project/hooks/__tests__/integration/useProjects.test.tsx';
const TESTS = [
  'keeps the newer refresh when the older read succeeds late (#3387 SC-01)',
  'keeps the newer refresh when the older read fails late (#3387 SC-01)',
  'commits the newest empty list, the newest failure and a later retry (#3387 SC-01)',
  'a reply from a superseded transport cannot commit after reconnect (#3387 SC-01)',
  'an uninstalled transport leaves loading honest and ignores the old reply (#3387 SC-01)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a newer Project list refresh stayed authoritative while an older ' +
      'success and an older failure settled late; newest empty, newest failure, retry and ' +
      'loading stayed truthful; a superseded transport generation and an uninstalled transport ' +
      'could not commit their late replies',
  });
  return 'Only the latest Project list read from the current transport generation commits Project list state';
});
