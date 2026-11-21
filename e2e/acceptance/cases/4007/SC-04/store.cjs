'use strict';
// #4007 SC-04: the Agent joins the summary from its own store by the listed
// instance identity, without touching tmux or creating metadata. Listing is
// read-only, and an unreadable identity is reported as unavailable.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--lib', 'session::metadata'],
    110000,
    isolatedTmuxEnv('nession-4007-sc04-store'),
  );
  assertRan(out, [
    'session::metadata::tests::the_list_summary_reads_by_instance_without_initializing_metadata',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-agent at exact SHA ' +
      sha +
      ': the list summary was read by instance identity without initializing ' +
      'tmux state or metadata, no identity meant a confirmed revision-0 record, ' +
      'and an invalid/unreadable identity became unavailable',
  });
  return 'List summaries are read-only, identity-keyed and truthfully unavailable on failure';
});
