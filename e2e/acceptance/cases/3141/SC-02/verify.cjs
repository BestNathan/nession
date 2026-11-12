'use strict';
// #3141 SC-02: the real Agent discovers the declarative controller files its
// delegated child actually exposes. This is measured discovery, not the
// retired four-key allowlist; lifecycle/status/command interfaces never appear,
// and discovery neither mutates a foreign cgroup nor leaves its probe child.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  runtimeFromEnv,
  openClient,
  createSession,
  killSession,
  context,
  runSandboxCase,
} = require('../../../shared/sandbox-capability-cases.cjs');
const { crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities,
  pending,
  capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const capabilities = probeCapabilities();
const cgroup = capabilities.cgroup_v2;
if (!cgroup || !cgroup.fields || Object.keys(cgroup.fields).length === 0) {
  pending('This runner has no delegated child cgroup exposing configurable files', [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else {
  const retiredFourKeyList = ['cpu.max', 'memory.max', 'memory.oom.group', 'pids.max'];
  const runtime = runtimeFromEnv();
  runSandboxCase(async ({ evidence }) => {
    const client = await openClient(runtime);
    const name = 'acceptance-3141-sc02-' + process.pid;
    try {
      const sessionId = await createSession(client, name, runtime.home);
      try {
        const first = await context(client, sessionId);
        assert.equal(first.success, true, 'the real Agent must answer the context read');
        const resource = first.context.catalog.implementations.find(
          (entry) => entry.path === 'resource.cgroup_v2',
        );
        assert.ok(resource, 'the catalog must list resource.cgroup_v2');
        const fields = (resource.fields || []).map((field) => field.key);
        assert.ok(fields.length >= 4, 'discovery must expose the actual child files');
        assert.ok(fields.includes('memory.max'));
        if (cgroup.controllers.includes('memory')) {
          assert.ok(
            fields.includes('memory.high'),
            'a beyond-V1 memory controller file must be discovered',
          );
        }
        if (cgroup.controllers.includes('cpu')) {
          assert.ok(
            fields.includes('cpu.weight'),
            'a beyond-V1 cpu controller file must be discovered',
          );
        }
        for (const forbidden of [
          'cgroup.procs',
          'cgroup.threads',
          'cgroup.kill',
          'cgroup.freeze',
          'cgroup.subtree_control',
          'memory.stat',
          'memory.events',
          'memory.current',
          'memory.pressure',
          'memory.reclaim',
        ]) {
          assert.ok(!fields.includes(forbidden), forbidden + ' must never be offered');
        }
        assert.notDeepEqual(
          fields.slice().sort(),
          retiredFourKeyList,
          'the catalog must not regress to the synthetic four-key allowlist',
        );

        const weighted = (resource.fields || []).find((field) => field.key === 'cpu.weight');
        if (weighted) {
          assert.equal(typeof weighted.example, 'string');
          assert.equal(weighted.controller, 'cpu');
        }

        // Discovery must clean up its own probe child; it never enrolls a
        // process, so no live/foreign cgroup is mutated.
        assert.ok(
          !fs
            .readdirSync(cgroup.root)
            .some((entry) => entry.startsWith('.probe-')),
          'the capability probe removes its owned child cgroup',
        );
        const second = await context(client, sessionId);
        assert.deepEqual(
          second.context.catalog.implementations,
          first.context.catalog.implementations,
          'the measured catalog is stable across authenticated reads',
        );

        const measured = crateTests(
          'nession-sandbox',
          ['--lib', 'capabilities::tests::'],
          600_000,
        );
        assertRan(measured, [
          'macos_reports_native_paths_unsupported_and_its_measured_network',
          'an_unavailable_backend_never_reports_a_usable_implementation',
        ]);
        evidence.push(
          {
            type: 'runtime',
            value:
              'the real Agent discovered ' +
              fields.length +
              ' declarative controller files: ' +
              fields.join(', '),
          },
          {
            type: 'runtime',
            value:
              'cgroup.procs/threads/kill/freeze/subtree_control, read-only state and memory.reclaim were absent from the catalog',
          },
          {
            type: 'runtime',
            value:
              'discovery left no .probe- child behind and two authenticated reads returned identical measured fields',
          },
          {
            type: 'runtime',
            value:
              'exact tests proved macOS/backend-missing catalogs never claim a fabricated supported file set',
          },
        );
        return 'The Agent derives cgroup controller files from its real delegated child, not a synthetic allowlist, and reports unavailable states truthfully';
      } finally {
        await killSession(client, sessionId);
      }
    } finally {
      client.close();
    }
  });
}
