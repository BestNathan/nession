'use strict';
// #2874 SC-02: with no concurrent newer report, an ordinary force-refresh must
// still remove obsolete Sessions for its Agent, persist the replacement set,
// and leave another Agent's rows untouched. Real SQLite database +
// SessionRegistry, followed by a fresh-registry reload.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'registry::session::tests::sc02_an_ordinary_refresh_replaces_only_its_agent_and_survives_reload';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--lib', 'registry::session::tests::sc02_'],
    300000,
  );
  assertRan(output, [TEST]);

  const measured = /#2874 SC-02 measured: ([^\n]+)/.exec(output);
  if (!measured) throw new Error('the SC-02 measurement line is missing');

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an ordinary refresh removed the obsolete Sessions and ' +
      'persisted its replacement — ' + measured[1] +
      '; a different Agent\'s Session rows and a fresh-registry reload were unchanged',
  });
  return 'An ordinary force-refresh replaces its Agent set without affecting other Agents';
});
