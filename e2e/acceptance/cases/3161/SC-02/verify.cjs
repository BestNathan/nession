'use strict';
// #3161 SC-02: the catalog is produced from the real host probe, not from a
// frontend definition. On this runner the real Agent must report truthful
// per-implementation/per-option support (including backend-missing, which must
// never advertise `available`), keep a stable bound probe generation across
// reads, and reuse the measured cache until it is invalidated.
const assert = require('node:assert/strict');
const {
  runtimeFromEnv,
  openClient,
  createSession,
  killSession,
  context,
  runSandboxCase,
} = require('../../../shared/sandbox-capability-cases.cjs');
const { crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const PATH_SET = [
  'filesystem.access',
  'filesystem.composition',
  'network',
  'process.linux_namespaces',
  'resource.cgroup_v2',
  'syscall.seccomp',
];

const runtime = runtimeFromEnv();

runSandboxCase(async ({ evidence }) => {
  const client = await openClient(runtime);
  const name = 'acceptance-3161-sc02-' + process.pid;
  try {
    const sessionId = await createSession(client, name, runtime.home);
    try {
      const first = await context(client, sessionId);
      assert.equal(first.success, true, 'the real Agent must answer the context read');
      const catalog = first.context.catalog;
      assert.equal(catalog.catalog_version, 2, 'the Agent must report catalog v2');
      assert.equal(catalog.source, 'agent-host-probe');

      for (const path of PATH_SET) {
        const implementation = catalog.implementations.find((entry) => entry.path === path);
        assert.ok(implementation, 'the catalog must list the registered path ' + path);
        assert.ok(
          ['available', 'unavailable', 'unknown'].includes(implementation.status),
          'unexpected status for ' + path,
        );
        if (implementation.status === 'available') {
          assert.ok(
            !implementation.reason_code && !implementation.reason,
            path + ' must not carry an unavailable reason while available',
          );
        } else {
          assert.ok(
            implementation.reason_code,
            path + ' must carry a stable reason_code when not available',
          );
          assert.ok(implementation.reason, path + ' must carry a diagnostic reason');
        }
      }

      // A missing backend is measured, never guessed: nothing may claim
      // eligibility in that state.
      if (!catalog.backend) {
        assert.equal(catalog.status, 'unavailable');
        assert.equal(
          catalog.implementations.filter((entry) => entry.status === 'available').length,
          0,
          'a backend-missing catalog must not advertise any available implementation',
        );
      } else {
        assert.equal(catalog.status, 'available');
      }

      const network = catalog.implementations.find((entry) => entry.path === 'network');
      assert.ok(Array.isArray(network.options) && network.options.length > 0);
      for (const option of network.options) {
        assert.ok(
          ['allow', 'deny', 'restricted'].includes(option.id),
          'unexpected network option ' + option.id,
        );
      }

      if (catalog.platform === 'linux') {
        const seccomp = catalog.implementations.find((entry) => entry.path === 'syscall.seccomp');
        assert.ok(seccomp.options.length > 0, 'Linux must report its registered seccomp profile');
        const resource = catalog.implementations.find(
          (entry) => entry.path === 'resource.cgroup_v2',
        );
        assert.ok(Array.isArray(resource.fields));
        for (const field of resource.fields) {
          assert.ok(field.controller, 'a cgroup field must name its native controller');
          assert.ok(field.value_format, 'a cgroup field must carry its native value format');
        }
      }

      // The cached measured catalog is stable across reads (same probe facts).
      const second = await context(client, sessionId);
      assert.equal(second.context.catalog.probe_generation, catalog.probe_generation);
      assert.deepEqual(second.context.catalog.implementations, catalog.implementations);

      // The production mapping from measured Capabilities to the catalog is
      // covered by exact tests, including partial delegation and macOS paths.
      const measured = crateTests(
        'nession-sandbox',
        ['--lib', 'capabilities::tests::'],
        600_000,
      );
      assertRan(measured, [
        'the_catalog_lists_each_registered_path_with_measured_options',
        'a_partial_linux_host_only_offers_its_measured_options',
        'macos_reports_native_paths_unsupported_and_its_measured_network',
        'an_unavailable_backend_never_reports_a_usable_implementation',
        'the_probe_generation_changes_when_implementation_support_changes',
      ]);
      evidence.push(
        {
          type: 'runtime',
          value:
            'the real Agent reported catalog v2 with ' +
            catalog.implementations.length +
            ' registered paths; backend=' +
            (catalog.backend || 'none') +
            ' platform=' +
            catalog.platform,
        },
        {
          type: 'runtime',
          value: catalog.backend
            ? 'every unavailable implementation carried a stable reason_code on the measured ' +
              catalog.backend +
              ' backend'
            : 'a backend-missing host advertised no available implementation',
        },
        {
          type: 'protocol',
          value:
            'two authenticated context reads returned the same probe_generation and identical measured support (Agent cache)',
        },
        {
          type: 'runtime',
          value:
            'exact capability tests proved per-option availability, partial delegation, macOS platform rejection and probe-generation changes from measured Capabilities',
        },
      );
      return 'The Agent derives per-implementation support from the real measured host probe and reports unavailable states truthfully';
    } finally {
      await killSession(client, sessionId);
    }
  } finally {
    client.close();
  }
});
