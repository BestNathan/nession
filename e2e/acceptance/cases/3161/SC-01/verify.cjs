'use strict';
// #3161 SC-01: the catalog's vNext shape is typed, versioned and generated.
// The Rust contract owns the closed status/reason vocabularies and the
// per-implementation/per-option entries; the committed Web bindings are the
// generated projection, not a hand-written second schema.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run, checked, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const contract = crateTests('nession-protocol', ['--lib', 'contracts::sandbox'], 600_000);
  assertRan(contract, [
    'the_implementation_catalog_separates_paths_and_options',
    'an_unmeasured_catalog_lists_every_registered_path_as_unknown',
    'an_old_catalog_projection_parses_as_unmeasured_not_unsupported',
    'implementation_entries_refuse_unknown_fields_and_statuses',
    'the_context_snapshot_round_trips_and_never_invents_inside',
  ]);

  const generatedPath = path.join(
    'web',
    'src',
    'generated',
    'protocol',
    'core',
    'server-session-sandbox-context',
    'v1.ts',
  );
  const generated = fs.readFileSync(generatedPath, 'utf8');
  for (const needle of [
    'SandboxImplementationStatus = "available" | "unavailable" | "unknown"',
    'SandboxUnsupportedReason = "platform_unsupported" | "backend_missing" | "kernel_feature_missing" | "controller_not_delegated" | "permission_denied" | "profile_unavailable" | "implementation_not_built" | "not_probed" | "timeout"',
    'catalog_version: number',
    'implementations: Array<SandboxImplementationSupport>',
    'export type SandboxOptionSupport',
  ]) {
    assert.ok(generated.includes(needle), 'generated binding is missing: ' + needle);
  }

  const integrity = checked('node', ['scripts/protocol-gate.mjs'], 90_000);
  assert.ok(integrity.length > 0, 'the protocol integrity check produced no output');

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact contract tests passed: closed implementation status/reason vocabularies, unknown default compatibility and closed unknown-field parsing',
    },
    {
      type: 'runtime',
      value:
        'committed generated TS contains catalog_version, typed implementations/options and the stable status/reason unions',
    },
    {
      type: 'runtime',
      value:
        'node scripts/protocol-gate.mjs exited 0 on the target SHA; the committed generated binding is the typed projection of the Rust contract',
    },
  );
  return 'The typed per-implementation catalog is versioned, generated and has no second hand-written schema';
});
