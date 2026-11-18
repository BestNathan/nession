'use strict';
// #3778 SC-02: an explicit Extension-manifest install updates the catalog
// atomically with an observable revision and, where the negotiated protocol
// supports it, a list-change notification. Ordinary catalog reads, calls and
// Session runtime work do not alter the Tool inventory, and the source-pinned
// static export catalog is independent of any runtime manifest.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3778-sc02');

  // A legacy session observes the explicit manifest install through
  // notifications/tools/list_changed and a new `_meta` catalog revision;
  // repeated lists, tool calls and a Session create leave the generation
  // unchanged. A stateless modern client sees the same revision.
  const live = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::catalog_revision_and_list_changed_are_explicit_and_runtime_state_does_not_churn'],
    900000,
    env,
  );
  assertRan(live, [
    'standalone::catalog_revision_and_list_changed_are_explicit_and_runtime_state_does_not_churn',
  ]);

  // The static Pages/Documents projection remains the Rust-owned baseline.
  const exportCatalog = crateTests(
    'nession-mcp',
    ['--lib', 'catalog::tests::'],
    600000,
    env,
  );
  assertRan(exportCatalog, [
    'catalog::tests::a_runtime_manifest_does_not_change_the_source_pinned_export_catalog',
    'catalog::tests::providers_are_enumerated_only_by_explicit_composition',
  ]);

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': installing a fixture Extension manifest advanced the observable tools/list catalogRevision and delivered notifications/tools/list_changed to a connected legacy session; a stateless modern client read the same advanced revision',
  });
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': repeated tools/list, tools/call and an ordinary Session create left the catalog revision and Tool inventory unchanged — runtime state is not a catalog event',
  });
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the source-pinned export catalog stayed the Rust-owned baseline Tools after a dynamic manifest was composed and advertised',
  });

  return 'Explicit manifest updates were observable through revision and legacy notification; ordinary runtime work did not churn the catalog; the static export source remained independent.';
});
