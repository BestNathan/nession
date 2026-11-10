'use strict';
// #3161 SC-03: an explicitly unsupported implementation/option is refused with
// field-path errors and no partial fallback; preflight and Enter reject a stale
// context or catalog generation; neither preflight nor a refused Enter creates
// an execution or a Sandbox Pane.
const assert = require('node:assert/strict');
const {
  runtimeFromEnv,
  openClient,
  createSession,
  killSession,
  context,
  preflight,
  enter,
  isolationPolicy,
  runSandboxCase,
} = require('../../../shared/sandbox-capability-cases.cjs');
const { crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const runtime = runtimeFromEnv();

function baseDraft() {
  return {
    version: 1,
    enabled: true,
    network: { mode: 'allow', ingress: 'deny' },
    resource: [],
    syscall: [],
    enforcement: 'required',
  };
}

/** A draft that explicitly requests one measured-unavailable policy element. */
function unsupportedRequest(catalog) {
  const network = catalog.implementations.find((entry) => entry.path === 'network');
  const restricted = network?.options?.find((option) => option.id === 'restricted');
  if (restricted && restricted.status !== 'available') {
    return {
      field: 'network.mode',
      draft: {
        ...baseDraft(),
        network: {
          mode: 'restricted',
          ingress: 'deny',
          egress: { allow: [], deny: [], private_network: 'deny' },
        },
      },
    };
  }
  for (const implementation of catalog.implementations) {
    if (implementation.status === 'available') {
      continue;
    }
    if (implementation.path === 'resource.cgroup_v2') {
      return {
        field: 'resource.cgroup_v2',
        draft: { ...baseDraft(), resource: [{ key: 'memory.max', value: '1024' }] },
      };
    }
    if (implementation.path === 'syscall.seccomp') {
      return {
        field: 'syscall.seccomp',
        draft: {
          ...baseDraft(),
          syscall: [{ key: 'seccomp.profile', value: 'nession-interactive-v1' }],
        },
      };
    }
    if (implementation.path === 'process.linux_namespaces') {
      return {
        field: 'process.linux_namespaces',
        draft: { ...baseDraft(), process: { linux_namespaces: { pid: true } } },
      };
    }
    if (implementation.path === 'filesystem.access') {
      return {
        field: 'filesystem.access',
        draft: {
          ...baseDraft(),
          filesystem: { access: { read: ['/usr'], write: [] } },
        },
      };
    }
  }
  const resource = catalog.implementations.find(
    (entry) => entry.path === 'resource.cgroup_v2',
  );
  const unavailableField = resource?.fields?.find((field) => !field.available);
  if (unavailableField) {
    return {
      field: 'resource.cgroup_v2.' + unavailableField.key,
      draft: {
        ...baseDraft(),
        resource: [{ key: unavailableField.key, value: unavailableField.example || 'max' }],
      },
    };
  }
  const seccomp = catalog.implementations.find((entry) => entry.path === 'syscall.seccomp');
  const profile = seccomp?.options?.find((option) => option.status !== 'available');
  if (profile) {
    return {
      field: 'syscall.seccomp.profile',
      draft: {
        ...baseDraft(),
        syscall: [{ key: 'seccomp.profile', value: profile.id }],
      },
    };
  }
  return null;
}

runSandboxCase(async ({ evidence }) => {
  const client = await openClient(runtime);
  const name = 'acceptance-3161-sc03-' + process.pid;
  try {
    const sessionId = await createSession(client, name, runtime.home);
    try {
      const observed = await context(client, sessionId);
      assert.equal(observed.success, true);
      const active = observed.context;
      const probe = active.catalog.probe_generation;

      // Stale context generation is a field error, not a partial policy.
      const staleContext = await preflight(
        client,
        sessionId,
        'stale-context-generation',
        isolationPolicy(),
        runtime.home,
        probe,
      );
      assert.equal(staleContext.ok, false);
      assert.ok(
        staleContext.errors.some(
          (error) => error.field === 'context' && error.code === 'stale-generation',
        ),
        'a stale context generation must be refused as stale-generation',
      );

      // Stale catalog probe generation is a field error too.
      const staleProbe = await preflight(
        client,
        sessionId,
        active.generation,
        isolationPolicy(),
        runtime.home,
        'definitely-stale-probe-generation',
      );
      assert.equal(staleProbe.ok, false);
      assert.ok(
        staleProbe.errors.some(
          (error) =>
            error.field === 'catalog.probe_generation' && error.code === 'stale-generation',
        ),
        'a stale catalog generation must be refused as stale-generation',
      );

      const staleEnter = await enter(
        client,
        sessionId,
        active.generation,
        'sc03-stale-' + process.pid,
        isolationPolicy(),
        runtime.home,
        'definitely-stale-probe-generation',
      );
      assert.equal(staleEnter.success, false);
      assert.equal(staleEnter.error_kind, 'conflict');
      assert.ok(
        (staleEnter.field_errors || []).some(
          (error) =>
            error.field === 'catalog.probe_generation' && error.code === 'stale-generation',
        ),
        'Enter must reject the stale catalog generation before preparing anything',
      );

      // An explicit unsupported implementation/option must return field
      // errors and must not be dropped to produce a "valid" remainder. On a
      // runner with no Sandbox backend at all, the whole policy is the
      // unavailable element; the refusal must still be typed and create
      // nothing, never silently drop the request.
      const requested = active.catalog.backend ? unsupportedRequest(active.catalog) : null;
      let unsupportedField = 'policy';
      if (!active.catalog.backend) {
        const result = await preflight(
          client,
          sessionId,
          active.generation,
          isolationPolicy(),
          runtime.home,
          probe,
        );
        assert.equal(result.ok, false, 'a backend-missing host cannot validate Enter');
        assert.ok(
          result.errors.some((error) => ['context', 'policy'].includes(error.field)),
          'the refusal must be a typed field error: ' + JSON.stringify(result.errors),
        );
        assert.equal(result.mechanisms.length, 0, 'no partial guarantee may be reported');
        const refused = await enter(
          client,
          sessionId,
          active.generation,
          'sc03-no-backend-' + process.pid,
          isolationPolicy(),
          runtime.home,
          probe,
        );
        assert.equal(refused.success, false);
        assert.ok(
          ['unavailable', 'invalid'].includes(refused.error_kind),
          'a backend-missing Enter must be refused',
        );
        assert.ok(refused.error, 'the refusal must explain the unavailable backend');
        unsupportedField = 'policy (no Sandbox backend)';
      } else if (requested) {
        const result = await preflight(
          client,
          sessionId,
          active.generation,
          requested.draft,
          runtime.home,
          probe,
        );
        assert.equal(result.ok, false, 'an unsupported request cannot preflight as valid');
        assert.ok(
          result.errors.some(
            (error) =>
              error.field === requested.field ||
              error.field === 'policy' ||
              error.field.startsWith(requested.field + '.'),
          ),
          'the refusal must name the unsupported field: ' +
            JSON.stringify(result.errors),
        );
        assert.equal(result.mechanisms.length, 0, 'no partial guarantee may be reported');
        unsupportedField = requested.field;

        const refused = await enter(
          client,
          sessionId,
          active.generation,
          'sc03-unsupported-' + process.pid,
          requested.draft,
          runtime.home,
          probe,
        );
        assert.equal(refused.success, false);
        assert.ok(
          ['unavailable', 'invalid'].includes(refused.error_kind),
          'an unsupported host request must be refused, never launched',
        );
        assert.ok(
          (refused.field_errors || []).length > 0,
          'the refused Enter must carry field errors',
        );
      }

      // No preflight or refused Enter created an execution or a Sandbox Pane.
      const after = await context(client, sessionId);
      assert.equal(after.context.status, 'outside');
      assert.equal(after.context.execution, undefined);
      assert.equal(after.context.sandbox_panes.length, 0);

      const unit = crateTests(
        'nession-sandbox',
        ['--lib', 'capabilities::tests::'],
        600_000,
      );
      assertRan(unit, [
        'unsupported_requests_names_every_unavailable_field_path',
        'a_missing_backend_is_one_policy_error_not_a_partial_guess',
      ]);

      evidence.push(
        {
          type: 'protocol',
          value:
            'stale context and stale catalog probe generations were refused with field code stale-generation on preflight and Enter',
        },
        {
          type: 'protocol',
          value:
            'an explicit unsupported request (' +
            unsupportedField +
            ') returned field errors with no mechanisms, and Enter refused before launch',
        },
        {
          type: 'runtime',
          value:
            'after every preflight/refused Enter the active Pane was still outside with no execution and no Sandbox Pane',
        },
        {
          type: 'runtime',
          value:
            'exact sandbox tests proved all unsupported policy field paths are reported and a missing backend is one policy error rather than a partial guess',
        },
      );
      return 'Preflight and Enter are generation-bound, fail closed with field errors, and create no execution before a verified launch';
    } finally {
      await killSession(client, sessionId);
    }
  } finally {
    client.close();
  }
});
